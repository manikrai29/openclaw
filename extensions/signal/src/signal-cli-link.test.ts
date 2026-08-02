import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { linkSignalCliAccount } from "./signal-cli-link.js";

const runCommandMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandWithTimeout: runCommandMock,
}));

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
};

type CommandOptions = {
  signal: AbortSignal;
  killProcessTree: boolean;
  onOutputChunk: (chunk: Buffer, stream: "stdout" | "stderr") => void;
};

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

function createDeferredCommand() {
  let resolve!: (result: CommandResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<CommandResult>((resolveResult, rejectResult) => {
    resolve = resolveResult;
    reject = rejectResult;
  });
  runCommandMock.mockReturnValueOnce(promise);
  return { resolve, reject };
}

function commandOptions(): CommandOptions {
  const options = runCommandMock.mock.calls.at(-1)?.[1] as CommandOptions | undefined;
  if (!options) {
    throw new Error("expected command options");
  }
  return options;
}

function emitStdout(text: string) {
  commandOptions().onOutputChunk(Buffer.from(text), "stdout");
}

beforeEach(() => {
  runCommandMock.mockReset();
});

describe("linkSignalCliAccount", () => {
  it("streams the upstream link URI and forces plain-text output", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const command = createDeferredCommand();
    const onLinkUri = vi.fn(async () => undefined);
    const resultPromise = linkSignalCliAccount({
      cliPath: "/opt/openclaw/signal-cli",
      configPath: "~/.local/share/signal-cli",
      onLinkUri,
    });

    emitStdout("sgnl://linkdevice?uuid=test&pub_");
    emitStdout("key=test\nAssociated with: +15555550123\n");
    command.resolve(commandResult());

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      associatedAccount: "+15555550123",
    });
    expect(runCommandMock).toHaveBeenCalledWith(
      [
        "/opt/openclaw/signal-cli",
        "--config",
        path.join(os.homedir(), ".local/share/signal-cli"),
        "--output",
        "plain-text",
        "link",
        "-n",
        "OpenClaw",
      ],
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        killProcessTree: true,
        onOutputChunk: expect.any(Function),
      }),
    );
    expect(onLinkUri).toHaveBeenCalledWith(
      "sgnl://linkdevice?uuid=test&pub_key=test",
      expect.any(Promise),
      1_800_000_120_000,
    );
    vi.useRealTimers();
  });

  it("waits for QR presentation to finish before completing setup", async () => {
    const command = createDeferredCommand();
    let releasePresentation!: () => void;
    const presentation = new Promise<void>((resolve) => {
      releasePresentation = resolve;
    });
    const resultPromise = linkSignalCliAccount({
      cliPath: "signal-cli",
      onLinkUri: async (_uri, completion) => {
        await expect(completion).resolves.toBeUndefined();
        await presentation;
      },
    });

    emitStdout("sgnl://linkdevice?uuid=test&pub_key=test\n");
    command.resolve(commandResult());

    let completed = false;
    void resultPromise.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    releasePresentation();
    await expect(resultPromise).resolves.toMatchObject({ ok: true });
  });

  it("returns bounded signal-cli errors and rejects success without a link URI", async () => {
    const failedCommand = createDeferredCommand();
    const failurePromise = linkSignalCliAccount({
      cliPath: "signal-cli",
      onLinkUri: vi.fn(async () => undefined),
    });
    failedCommand.resolve(commandResult({ code: 1, stderr: "x".repeat(2_000) }));
    const failure = await failurePromise;
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.error).toHaveLength(2_000);
    }

    const missingUriCommand = createDeferredCommand();
    const missingUriPromise = linkSignalCliAccount({
      cliPath: "signal-cli",
      onLinkUri: vi.fn(async () => undefined),
    });
    missingUriCommand.resolve(commandResult());
    await expect(missingUriPromise).resolves.toEqual({
      ok: false,
      error: "signal-cli link finished without producing a device-link QR code.",
    });
  });

  it("terminates the signal-cli process tree when presentation fails", async () => {
    const command = createDeferredCommand();
    const presentationFailure = linkSignalCliAccount({
      cliPath: "signal-cli",
      onLinkUri: async () => {
        throw new Error("client disconnected");
      },
    });
    emitStdout("sgnl://linkdevice?uuid=test&pub_key=test\n");
    await vi.waitFor(() => expect(commandOptions().signal.aborted).toBe(true));
    expect(commandOptions().killProcessTree).toBe(true);
    command.resolve(
      commandResult({ code: null, signal: "SIGTERM", killed: true, termination: "signal" }),
    );
    await expect(presentationFailure).resolves.toEqual({
      ok: false,
      error: "Signal account linking stopped: client disconnected",
    });
  });

  it("lets signal-cli own provisioning and post-approval deadlines", async () => {
    vi.useFakeTimers();
    const command = createDeferredCommand();
    const resultPromise = linkSignalCliAccount({
      cliPath: "signal-cli",
      onLinkUri: vi.fn(async () => undefined),
    });
    emitStdout("sgnl://linkdevice?uuid=test&pub_key=test\n");
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(commandOptions().signal.aborted).toBe(false);
    command.resolve(commandResult());
    await expect(resultPromise).resolves.toMatchObject({ ok: true });
    vi.useRealTimers();
  });

  it("keeps cancellation owned until the whole process tree stops", async () => {
    const command = createDeferredCommand();
    const abortController = new AbortController();
    const resultPromise = linkSignalCliAccount({
      cliPath: "signal-cli",
      signal: abortController.signal,
      onLinkUri: vi.fn(async () => undefined),
    });

    abortController.abort();

    expect(commandOptions().signal.aborted).toBe(true);
    expect(commandOptions().killProcessTree).toBe(true);
    let completed = false;
    void resultPromise.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    command.resolve(
      commandResult({ code: null, signal: "SIGTERM", killed: true, termination: "signal" }),
    );
    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: "Signal account linking was cancelled.",
    });
  });

  it("preserves cancellation when the process runner reports a shutdown error", async () => {
    const command = createDeferredCommand();
    const abortController = new AbortController();
    const resultPromise = linkSignalCliAccount({
      cliPath: "signal-cli",
      signal: abortController.signal,
      onLinkUri: vi.fn(async () => undefined),
    });

    abortController.abort();
    command.reject(new Error("kill EPERM"));

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: "Signal account linking was cancelled.",
    });
  });

  it("returns an error when signal-cli cannot start", async () => {
    const command = createDeferredCommand();
    const resultPromise = linkSignalCliAccount({
      cliPath: "/missing/signal-cli",
      onLinkUri: vi.fn(async () => undefined),
    });
    command.reject(new Error("spawn ENOENT"));

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: "Could not start signal-cli: spawn ENOENT",
    });
  });
});
