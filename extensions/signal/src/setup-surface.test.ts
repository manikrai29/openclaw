import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  runSetupWizardPrepare,
  type WizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signalSetupPlugin } from "./channel.setup.js";
import { installSignalCli } from "./install-signal-cli.js";
import { signalSetupWizard } from "./setup-surface.js";
import { linkSignalCliAccount } from "./signal-cli-link.js";

vi.mock("openclaw/plugin-sdk/setup-tools", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/setup-tools")>();
  return { ...original, detectBinary: vi.fn() };
});
vi.mock("./install-signal-cli.js", () => ({ installSignalCli: vi.fn() }));
vi.mock("./signal-cli-link.js", () => ({
  linkSignalCliAccount: vi.fn(),
}));

const detectBinaryMock = vi.mocked(detectBinary);
const installSignalCliMock = vi.mocked(installSignalCli);
const linkSignalCliAccountMock = vi.mocked(linkSignalCliAccount);

function createConfig(account?: string) {
  return {
    channels: {
      signal: {
        ...(account ? { account } : {}),
        transport: {
          kind: "managed-native" as const,
          cliPath: "/opt/signal-cli",
          configPath: "~/.local/share/signal-cli",
        },
      },
    },
  };
}

function createQrPrompter(params?: {
  confirmValues?: boolean[];
  qrCode?: WizardPrompter["qrCode"];
}) {
  const confirmValues = [...(params?.confirmValues ?? [false, true])];
  return createTestWizardPrompter({
    confirm: vi.fn(async () => confirmValues.shift() ?? false),
    qrCode: params?.qrCode ?? vi.fn(async () => true),
  });
}

beforeEach(() => {
  detectBinaryMock.mockReset();
  detectBinaryMock.mockResolvedValue(true);
  installSignalCliMock.mockReset();
  linkSignalCliAccountMock.mockReset();
  linkSignalCliAccountMock.mockResolvedValue({
    ok: true,
    associatedAccount: "+15555550123",
  });
});

describe("signalSetupWizard QR linking", () => {
  it("persists the linked account through the production lazy setup proxy", async () => {
    const qrCode = vi.fn(async () => true);
    const note = vi.fn(async () => undefined);
    const text = vi.fn(async () => "unexpected manual input");
    linkSignalCliAccountMock.mockImplementationOnce(async ({ onLinkUri }) => {
      await onLinkUri(
        "sgnl://linkdevice?uuid=test&pub_key=test",
        Promise.resolve(),
        1_800_000_120_000,
      );
      return { ok: true, associatedAccount: "+15555550123" };
    });
    const result = await runSetupWizardConfigure({
      configure: createPluginSetupWizardConfigure(signalSetupPlugin),
      cfg: createConfig(),
      prompter: {
        ...createQrPrompter({ qrCode }),
        note,
        text,
      },
      options: {
        allowSignalInstall: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    });

    expect(result.cfg.channels?.signal?.account).toBe("+15555550123");
    expect(qrCode).toHaveBeenCalledOnce();
    expect(text).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it("uses the generic QR prompt and returns the linked account to setup", async () => {
    const qrCode = vi.fn(async () => true);
    const beforePersistentEffect = vi.fn(async () => undefined);
    const abortController = new AbortController();
    const result = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: createConfig(),
      accountId: "default",
      prompter: createQrPrompter({ qrCode }),
      options: {
        allowSignalInstall: true,
        beforePersistentEffect,
        abortSignal: abortController.signal,
      },
    });

    expect(linkSignalCliAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cliPath: "/opt/signal-cli",
        configPath: "~/.local/share/signal-cli",
        signal: abortController.signal,
      }),
    );
    const onLinkUri = linkSignalCliAccountMock.mock.calls[0]?.[0].onLinkUri;
    await onLinkUri?.(
      "sgnl://linkdevice?uuid=test&pub_key=test",
      Promise.resolve(),
      1_800_000_120_000,
    );
    expect(qrCode).toHaveBeenCalledWith({
      title: "Signal account linking",
      message:
        "On your phone, open Signal > Settings > Linked devices, scan this code, approve the device, then choose Continue.",
      text: "sgnl://linkdevice?uuid=test&pub_key=test",
      dismissed: expect.any(Promise),
      expiresAtMs: 1_800_000_120_000,
    });
    expect(beforePersistentEffect).toHaveBeenCalledOnce();
    expect(result).toEqual({
      credentialValues: {
        signalNumber: "+15555550123",
        signalLinkedAccount: "true",
        signalLinkCompleted: "true",
      },
    });
  });

  it("waits for signal-cli when Continue is chosen before linking finishes", async () => {
    const note = vi.fn(async () => undefined);
    let finishLink!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishLink = resolve;
    });
    linkSignalCliAccountMock.mockImplementationOnce(async ({ onLinkUri }) => {
      await onLinkUri("sgnl://linkdevice?uuid=test&pub_key=test", completion, Date.now() + 120_000);
      return { ok: true, associatedAccount: "+15555550123" };
    });

    const resultPromise = runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: createConfig(),
      accountId: "default",
      prompter: { ...createQrPrompter(), note },
      options: { allowSignalInstall: true },
    });

    await vi.waitFor(() => expect(linkSignalCliAccountMock).toHaveBeenCalledOnce());
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishLink();
    await expect(resultPromise).resolves.toEqual({
      credentialValues: {
        signalNumber: "+15555550123",
        signalLinkedAccount: "true",
        signalLinkCompleted: "true",
      },
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("does not change terminal, configured-account, or missing-binary setup when linking is declined", async () => {
    const terminalResult = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: createConfig(),
      prompter: createTestWizardPrompter({ confirm: vi.fn(async () => false) }),
      options: { allowSignalInstall: true },
    });
    expect(terminalResult).toBeUndefined();
    expect(linkSignalCliAccountMock).not.toHaveBeenCalled();

    const configuredResult = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: createConfig("+15555550123"),
      prompter: createQrPrompter({ confirmValues: [false, false] }),
      options: { allowSignalInstall: true },
    });
    expect(linkSignalCliAccountMock).not.toHaveBeenCalled();
    expect(configuredResult).toBeUndefined();

    detectBinaryMock.mockResolvedValue(false);
    await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: createConfig(),
      prompter: createQrPrompter({ confirmValues: [false] }),
      options: { allowSignalInstall: true },
    });
    expect(linkSignalCliAccountMock).not.toHaveBeenCalled();
  });

  it("persists a manually entered number after a link failure", async () => {
    linkSignalCliAccountMock.mockResolvedValue({ ok: false, error: "Link request timed out" });
    const note = vi.fn(async () => undefined);
    const text = vi.fn(async () => "+15555550199");
    const result = await runSetupWizardConfigure({
      configure: createPluginSetupWizardConfigure(signalSetupPlugin),
      cfg: createConfig(),
      prompter: { ...createQrPrompter(), note, text },
      options: {
        allowSignalInstall: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    });

    expect(result.cfg.channels?.signal?.account).toBe("+15555550199");
    expect(text).toHaveBeenCalledOnce();
    expect(note).toHaveBeenCalledWith("Link request timed out", "Signal account linking");
  });

  it("prompts for the account number when signal-cli omits it after linking", async () => {
    const note = vi.fn(async () => undefined);
    const text = vi.fn(async () => "+15555550199");
    linkSignalCliAccountMock.mockResolvedValueOnce({ ok: true });

    const result = await runSetupWizardConfigure({
      configure: createPluginSetupWizardConfigure(signalSetupPlugin),
      cfg: createConfig(),
      prompter: { ...createQrPrompter(), note, text },
      options: {
        allowSignalInstall: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    });

    expect(result.cfg.channels?.signal?.account).toBe("+15555550199");
    expect(text).toHaveBeenCalledOnce();
    expect(note).toHaveBeenCalledOnce();
    expect(note).toHaveBeenCalledWith(
      "signal-cli linked successfully, but OpenClaw could not identify the linked account. Enter its Signal number to finish setup.",
      "Signal account linking",
    );
  });

  it("does not commit linked-account markers after setup is cancelled", async () => {
    const abortController = new AbortController();
    const cancelled = new Error("setup cancelled");
    linkSignalCliAccountMock.mockImplementationOnce(async () => {
      abortController.abort(cancelled);
      return { ok: true, associatedAccount: "+15555550123" };
    });

    await expect(
      runSetupWizardPrepare({
        prepare: signalSetupWizard.prepare,
        cfg: createConfig(),
        accountId: "default",
        prompter: createQrPrompter(),
        options: { allowSignalInstall: true, abortSignal: abortController.signal },
      }),
    ).rejects.toBe(cancelled);
  });

  it("does not start linking when the persistent-effect guard rejects", async () => {
    const blocked = new Error("inference authorization failed");
    await expect(
      runSetupWizardPrepare({
        prepare: signalSetupWizard.prepare,
        cfg: createConfig(),
        prompter: createQrPrompter(),
        options: {
          allowSignalInstall: true,
          beforePersistentEffect: vi.fn(async () => {
            throw blocked;
          }),
        },
      }),
    ).rejects.toBe(blocked);
    expect(linkSignalCliAccountMock).not.toHaveBeenCalled();
  });

  it("persists an installed CLI path and linked account through the production proxy", async () => {
    detectBinaryMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    installSignalCliMock.mockResolvedValue({ ok: true, cliPath: "/managed/signal-cli" });
    const result = await runSetupWizardConfigure({
      configure: createPluginSetupWizardConfigure(signalSetupPlugin),
      cfg: createConfig(),
      prompter: createQrPrompter({ confirmValues: [true, true] }),
      options: {
        allowSignalInstall: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    });

    expect(linkSignalCliAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({ cliPath: "/managed/signal-cli" }),
    );
    expect(result.cfg.channels?.signal?.transport).toMatchObject({
      cliPath: "/managed/signal-cli",
    });
    expect(result.cfg.channels?.signal?.account).toBe("+15555550123");
  });

  it("continues with the existing CLI when an optional update fails", async () => {
    const note = vi.fn(async () => undefined);
    installSignalCliMock.mockResolvedValue({ ok: false, error: "Homebrew update failed" });

    const result = await runSetupWizardConfigure({
      configure: createPluginSetupWizardConfigure(signalSetupPlugin),
      cfg: createConfig(),
      prompter: { ...createQrPrompter({ confirmValues: [true, true] }), note },
      options: {
        allowSignalInstall: true,
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    });

    expect(note).toHaveBeenCalledWith("Homebrew update failed", "Signal");
    expect(linkSignalCliAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({ cliPath: "/opt/signal-cli" }),
    );
    expect(result.cfg.channels?.signal?.account).toBe("+15555550123");
  });

  it("links a new named account without changing its configured sibling", async () => {
    linkSignalCliAccountMock.mockResolvedValueOnce({
      ok: true,
      associatedAccount: "+15555550444",
    });
    const cfg = {
      channels: {
        signal: {
          defaultAccount: "default",
          accounts: {
            default: {
              account: "+15555550123",
              transport: {
                kind: "managed-native" as const,
                cliPath: "/opt/signal-cli",
                configPath: "~/.local/share/signal-cli",
              },
            },
            work: {
              transport: {
                kind: "managed-native" as const,
                cliPath: "/opt/signal-cli",
                configPath: "~/.local/share/signal-cli",
              },
            },
          },
        },
      },
    };

    const result = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg,
      accountId: "work",
      prompter: createQrPrompter(),
      options: { allowSignalInstall: true },
    });

    expect(linkSignalCliAccountMock).toHaveBeenCalledOnce();
    expect(result).toEqual({
      credentialValues: {
        signalNumber: "+15555550444",
        signalLinkedAccount: "true",
        signalLinkCompleted: "true",
      },
    });
  });

  it("finishes setup when signal-cli completes before the QR is acknowledged", async () => {
    const qrCode = vi.fn(async (params: Parameters<NonNullable<WizardPrompter["qrCode"]>>[0]) => {
      await params.dismissed;
      return true;
    });
    linkSignalCliAccountMock.mockImplementationOnce(async ({ onLinkUri }) => {
      await onLinkUri(
        "sgnl://linkdevice?uuid=test&pub_key=test",
        Promise.resolve(),
        Date.now() + 120_000,
      );
      return { ok: true, associatedAccount: "+15555550123" };
    });

    const result = await runSetupWizardPrepare({
      prepare: signalSetupWizard.prepare,
      cfg: createConfig(),
      accountId: "default",
      prompter: createQrPrompter({ qrCode }),
      options: { allowSignalInstall: true },
    });

    expect(qrCode).toHaveBeenCalledOnce();
    expect(result).toEqual({
      credentialValues: {
        signalNumber: "+15555550123",
        signalLinkedAccount: "true",
        signalLinkCompleted: "true",
      },
    });
  });
});
