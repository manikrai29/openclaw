import { StringDecoder } from "node:string_decoder";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { resolveSignalCliConfigPath } from "./signal-cli-config-path.js";

type SignalCliLinkResult = { ok: true; associatedAccount?: string } | { ok: false; error: string };

type SignalCliLinkCompletion = Promise<void>;

const SIGNAL_LINK_URI_PREFIX = "sgnl://linkdevice?";
// Wizard notes become system-agent history, so keep dependency diagnostics well below the
// repository's per-item model-context budget while retaining the actionable stderr tail.
const SIGNAL_LINK_ERROR_OUTPUT_LIMIT = 2_000;
const SIGNAL_LINK_PENDING_LINE_LIMIT = 8 * 1024;
const SIGNAL_CLI_LINK_QR_TIMEOUT_MS = 120_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signalCliArgs(configPath: string | undefined): string[] {
  return configPath?.trim() ? ["--config", resolveSignalCliConfigPath(configPath)] : [];
}

export async function linkSignalCliAccount(params: {
  cliPath: string;
  configPath?: string;
  signal?: AbortSignal;
  onLinkUri: (
    uri: string,
    completion: SignalCliLinkCompletion,
    expiresAtMs: number,
  ) => Promise<void>;
}): Promise<SignalCliLinkResult> {
  if (params.signal?.aborted) {
    return { ok: false, error: "Signal account linking was cancelled." };
  }

  const commandAbort = new AbortController();
  let displayError: string | undefined;
  let displayPromise = Promise.resolve();
  let linkUriSeen = false;
  let associatedAccount: string | undefined;
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((complete) => {
    resolveCompletion = complete;
  });
  const stopWithError = (error: string) => {
    if (displayError) {
      return;
    }
    displayError = error;
    resolveCompletion();
    commandAbort.abort();
  };
  const abort = () => stopWithError("Signal account linking was cancelled.");
  params.signal?.addEventListener("abort", abort, { once: true });

  const stdoutDecoder = new StringDecoder("utf8");
  let pendingStdout = "";
  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!linkUriSeen && trimmed.startsWith(SIGNAL_LINK_URI_PREFIX)) {
      linkUriSeen = true;
      displayPromise = Promise.resolve()
        .then(
          async () =>
            await params.onLinkUri(trimmed, completion, Date.now() + SIGNAL_CLI_LINK_QR_TIMEOUT_MS),
        )
        .catch((error: unknown) => {
          stopWithError(`Signal account linking stopped: ${errorMessage(error)}`);
        });
      return;
    }
    const associatedMatch = /^Associated with:\s*(\+\d{5,15})$/iu.exec(trimmed);
    if (associatedMatch?.[1]) {
      associatedAccount = associatedMatch[1];
    }
  };
  const consumeStdout = (text: string) => {
    pendingStdout = `${pendingStdout}${text}`.slice(-SIGNAL_LINK_PENDING_LINE_LIMIT);
    const lines = pendingStdout.split(/\r?\n/u);
    pendingStdout = lines.pop() ?? "";
    for (const line of lines) {
      processLine(line);
    }
  };

  try {
    // This repository-owned runner is the lifecycle owner: cancellation terminates wrapped
    // launchers and their descendants before returning, including on Windows.
    const result = await runCommandWithTimeout(
      [
        params.cliPath,
        ...signalCliArgs(params.configPath),
        "--output",
        "plain-text",
        "link",
        "-n",
        "OpenClaw",
      ],
      {
        signal: commandAbort.signal,
        killProcessTree: true,
        outputCapture: { stdout: "discard", stderr: "tail" },
        maxOutputBytes: { stdout: 8 * 1024, stderr: SIGNAL_LINK_ERROR_OUTPUT_LIMIT },
        onOutputChunk: (chunk, stream) => {
          if (stream === "stdout") {
            consumeStdout(stdoutDecoder.write(chunk));
          }
        },
      },
    );
    consumeStdout(stdoutDecoder.end());
    if (pendingStdout) {
      processLine(pendingStdout);
    }
    resolveCompletion();
    await displayPromise;

    if (displayError) {
      return { ok: false, error: displayError };
    }
    if (result.code !== 0) {
      return {
        ok: false,
        error:
          result.stderr.trim() ||
          `signal-cli link exited with ${result.signal ? `signal ${result.signal}` : `code ${result.code ?? "unknown"}`}.`,
      };
    }
    if (!linkUriSeen) {
      return {
        ok: false,
        error: "signal-cli link finished without producing a device-link QR code.",
      };
    }
    return { ok: true, ...(associatedAccount ? { associatedAccount } : {}) };
  } catch (error) {
    resolveCompletion();
    await displayPromise;
    if (displayError) {
      return { ok: false, error: displayError };
    }
    return { ok: false, error: `Could not start signal-cli: ${errorMessage(error)}` };
  } finally {
    params.signal?.removeEventListener("abort", abort);
  }
}
