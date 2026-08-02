// Signal plugin module implements setup surface behavior.
import {
  createSetupTranslator,
  createDetectedBinaryStatus,
  setSetupChannelEnabled,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import { listSignalAccountIds, resolveSignalAccount } from "./accounts.js";
import { installSignalCli } from "./install-signal-cli.js";
import {
  createSignalCliPathTextInput,
  SIGNAL_LINKED_ACCOUNT_INPUT_KEY,
  SIGNAL_LINK_COMPLETED_INPUT_KEY,
  signalCompletionNote,
  signalDmPolicy,
  signalNumberTextInput,
} from "./setup-core.js";
import { linkSignalCliAccount } from "./signal-cli-link.js";

const t = createSetupTranslator();

const channel = "signal" as const;
const configuredLabel = t("wizard.channels.statusConfigured");
const unconfiguredLabel = t("wizard.channels.statusNeedsSetup");
const managedStatus = createDetectedBinaryStatus({
  channelLabel: "Signal",
  binaryLabel: "signal-cli",
  configuredLabel,
  unconfiguredLabel,
  configuredHint: t("wizard.channels.statusSignalCliFound"),
  unconfiguredHint: t("wizard.channels.statusSignalCliMissing"),
  configuredScore: 1,
  unconfiguredScore: 0,
  resolveConfigured: ({ cfg, accountId }) =>
    accountId
      ? resolveSignalAccount({ cfg, accountId }).configured
      : listSignalAccountIds(cfg).some(
          (resolvedAccountId) =>
            resolveSignalAccount({ cfg, accountId: resolvedAccountId }).configured,
        ),
  resolveBinaryPath: ({ cfg, accountId }) => {
    const transport = resolveSignalAccount({ cfg, accountId }).transport;
    return transport.kind === "managed-native" ? transport.cliPath : "signal-cli";
  },
  detectBinary,
});

export const signalSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    ...managedStatus,
    resolveStatusLines: async (params) => {
      if (resolveSignalAccount(params).transport.kind === "managed-native") {
        return (await managedStatus.resolveStatusLines?.(params)) ?? [];
      }
      return [`Signal: ${params.configured ? configuredLabel : unconfiguredLabel}`];
    },
    resolveSelectionHint: async (params) => {
      if (resolveSignalAccount(params).transport.kind === "managed-native") {
        return await managedStatus.resolveSelectionHint?.(params);
      }
      return params.configured ? configuredLabel : unconfiguredLabel;
    },
    resolveQuickstartScore: async (params) => {
      if (resolveSignalAccount(params).transport.kind === "managed-native") {
        return await managedStatus.resolveQuickstartScore?.(params);
      }
      return params.configured ? 1 : 0;
    },
  },
  prepare: async ({ cfg, accountId, credentialValues, runtime, prompter, options }) => {
    if (!options?.allowSignalInstall) {
      return undefined;
    }
    const transport = resolveSignalAccount({ cfg, accountId }).transport;
    if (transport.kind !== "managed-native") {
      return undefined;
    }
    let currentCliPath =
      (typeof credentialValues.cliPath === "string" ? credentialValues.cliPath : undefined) ??
      (transport.kind === "managed-native" ? transport.cliPath : undefined) ??
      "signal-cli";
    let cliDetected = await detectBinary(currentCliPath);
    const existingCliDetected = cliDetected;
    const wantsInstall = await prompter.confirm({
      message: cliDetected ? t("wizard.signal.reinstallPrompt") : t("wizard.signal.installPrompt"),
      initialValue: !cliDetected,
    });
    const preparedCredentialValues: Record<string, string> = {};
    if (wantsInstall) {
      try {
        await options?.beforePersistentEffect?.();
        const result = await installSignalCli(runtime);
        if (result.ok && result.cliPath) {
          currentCliPath = result.cliPath;
          cliDetected = true;
          preparedCredentialValues.cliPath = result.cliPath;
          await prompter.note(`Installed signal-cli at ${result.cliPath}`, "Signal");
        } else if (!result.ok) {
          cliDetected = existingCliDetected;
          await prompter.note(result.error ?? "signal-cli install failed.", "Signal");
        }
      } catch (error) {
        cliDetected = existingCliDetected;
        await prompter.note(`signal-cli install failed: ${String(error)}`, "Signal");
      }
    }

    const presentQrCode = prompter.qrCode;
    if (!cliDetected || !presentQrCode) {
      return Object.keys(preparedCredentialValues).length > 0
        ? { credentialValues: preparedCredentialValues }
        : undefined;
    }
    const configPath = transport.configPath;
    const wantsLink = await prompter.confirm({
      message: "Link this signal-cli installation to Signal now?",
      initialValue: true,
    });
    if (!wantsLink) {
      return Object.keys(preparedCredentialValues).length > 0
        ? { credentialValues: preparedCredentialValues }
        : undefined;
    }

    await options?.beforePersistentEffect?.();
    const linkResult = await linkSignalCliAccount({
      cliPath: currentCliPath,
      ...(configPath ? { configPath } : {}),
      ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
      onLinkUri: async (uri, completion, expiresAtMs) => {
        const confirmed = await presentQrCode({
          title: "Signal account linking",
          message:
            "On your phone, open Signal > Settings > Linked devices, scan this code, approve the device, then choose Continue.",
          text: uri,
          dismissed: completion,
          expiresAtMs,
        });
        if (!confirmed) {
          throw new Error("Signal account linking was not confirmed.");
        }
        // The child-process owner reports the concrete signal-cli result after this callback
        // releases. Waiting here prevents Continue from interrupting post-approval registration.
        await completion;
      },
    });
    if (!linkResult.ok) {
      await prompter.note(linkResult.error, "Signal account linking");
      return Object.keys(preparedCredentialValues).length > 0
        ? { credentialValues: preparedCredentialValues }
        : undefined;
    }
    options?.abortSignal?.throwIfAborted();
    preparedCredentialValues[SIGNAL_LINK_COMPLETED_INPUT_KEY] = "true";
    if (linkResult.associatedAccount) {
      preparedCredentialValues.signalNumber = linkResult.associatedAccount;
      preparedCredentialValues[SIGNAL_LINKED_ACCOUNT_INPUT_KEY] = "true";
    } else {
      await prompter.note(
        "signal-cli linked successfully, but OpenClaw could not identify the linked account. Enter its Signal number to finish setup.",
        "Signal account linking",
      );
    }
    return { credentialValues: preparedCredentialValues };
  },
  credentials: [],
  textInputs: [
    createSignalCliPathTextInput(async ({ cfg, accountId, currentValue }) => {
      if (resolveSignalAccount({ cfg, accountId }).transport.kind !== "managed-native") {
        return false;
      }
      return !(await detectBinary(currentValue ?? "signal-cli"));
    }),
    signalNumberTextInput,
  ],
  completionNote: signalCompletionNote,
  dmPolicy: signalDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
