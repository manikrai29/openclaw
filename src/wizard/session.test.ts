// Wizard session tests cover session creation and state transitions.

import { describe, expect, test, vi } from "vitest";
import { QR_PNG_DATA_URL_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/qr.js";
import { WizardSession, wizardStepAwaitsInput, type WizardStep } from "./session.js";

const QR_TEXT = "https://example.test/pair";
const QR_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const qrImageMocks = vi.hoisted(() => ({
  renderQrPngDataUrlWithinLimit: vi.fn(async () => QR_DATA_URL),
}));

vi.mock("../media/qr-image.js", () => ({
  renderQrPngDataUrlWithinLimit: qrImageMocks.renderQrPngDataUrlWithinLimit,
}));

function noteRunner() {
  return new WizardSession(async (prompter) => {
    await prompter.note("Welcome");
    const name = await prompter.text({ message: "Name" });
    await prompter.note(`Hello ${name}`);
  });
}

describe("WizardSession", () => {
  test.each([
    ["select", undefined, true],
    ["multiselect", undefined, true],
    ["text", undefined, true],
    ["confirm", undefined, true],
    ["action", "client", true],
    ["action", "gateway", false],
    ["note", undefined, false],
    ["progress", undefined, false],
  ] as const satisfies ReadonlyArray<
    readonly [WizardStep["type"], WizardStep["executor"], boolean]
  >)("classifies whether %s/%s awaits user input", (type, executor, expected) => {
    expect(wizardStepAwaitsInput({ id: "step", type, executor })).toBe(expected);
  });

  test("steps progress in order", async () => {
    const session = noteRunner();

    const first = await session.next();
    expect(first.done).toBe(false);
    expect(first.step?.type).toBe("note");

    const secondPeek = await session.next();
    expect(secondPeek.step?.id).toBe(first.step?.id);

    if (!first.step) {
      throw new Error("expected first step");
    }
    await session.answer(first.step.id, null);

    const second = await session.next();
    expect(second.done).toBe(false);
    expect(second.step?.type).toBe("text");

    if (!second.step) {
      throw new Error("expected second step");
    }
    await session.answer(second.step.id, "Peter");

    const third = await session.next();
    expect(third.step?.type).toBe("note");

    if (!third.step) {
      throw new Error("expected third step");
    }
    await session.answer(third.step.id, null);

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("done");
  });

  test("plain output is a client note with plain format", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.plain?.('{"ok":true}');
    });

    const first = await session.next();
    if (!first.step) {
      throw new Error("expected plain note");
    }
    expect(first.step.type).toBe("note");
    expect(first.step.message).toBe('{"ok":true}');
    expect(first.step.format).toBe("plain");
    await session.answer(first.step.id, null);
    const done = await session.next();
    expect(done.done).toBe(true);
  });

  test("attaches an explicit browser destination to the next client step", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.openUrl?.("https://provider.example/oauth?state=state-1");
      await prompter.text({ message: "Paste the redirect URL" });
    });

    const first = await session.next();
    expect(first.step?.externalUrl).toBe("https://provider.example/oauth?state=state-1");
    expect(first.step?.type).toBe("text");
    if (!first.step) {
      throw new Error("expected provider sign-in step");
    }
    await session.answer(first.step.id, "http://localhost/callback?code=done");
    expect((await session.next()).status).toBe("done");
  });

  test("carries device-code presentation without parsing provider prose", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.openUrl?.("https://provider.example/device");
      await prompter.deviceCode?.({
        title: "Provider sign-in",
        code: "ABCD-1234",
        expiresInMinutes: 15,
        message: "Enter this one-time code in your browser.",
      });
    });

    const first = await session.next();
    expect(first.step).toMatchObject({
      type: "note",
      title: "Provider sign-in",
      message:
        "Enter this one-time code in your browser.\nCode: ABCD-1234\nCode expires in 15 minutes. Never share it.",
      externalUrl: "https://provider.example/device",
      deviceCode: {
        code: "ABCD-1234",
        expiresInMinutes: 15,
        message: "Enter this one-time code in your browser.",
      },
    });
  });

  test("renders caller-supplied text as a QR image only for capable hosts", async () => {
    let acknowledged: boolean | undefined;
    const expiresAtMs = Date.now() + 60_000;
    const supported = new WizardSession(
      async (prompter) => {
        acknowledged = await prompter.qrCode?.({
          title: "Link a device",
          message: "Scan this QR code, then continue.",
          text: QR_TEXT,
          expiresAtMs,
        });
      },
      { supportsQrCode: true },
    );

    const prompt = await supported.next();
    expect(prompt.step).toMatchObject({
      type: "select",
      title: "Link a device",
      message: "Scan this QR code, then continue.",
      options: [{ value: true, label: "Continue" }],
      initialValue: true,
      qrDataUrl: QR_DATA_URL,
      qrExpiresAtMs: expiresAtMs,
      executor: "client",
    });
    expect(qrImageMocks.renderQrPngDataUrlWithinLimit).toHaveBeenCalledWith(
      QR_TEXT,
      QR_PNG_DATA_URL_MAX_LENGTH,
    );
    if (!prompt.step) {
      throw new Error("expected QR acknowledgement step");
    }
    await supported.answer(prompt.step.id, true);
    expect(prompt.step.qrDataUrl).toBeUndefined();
    expect((await supported.next()).status).toBe("done");
    expect(acknowledged).toBe(true);

    let unsupportedHasQr = true;
    const unsupported = new WizardSession(async (prompter) => {
      unsupportedHasQr = typeof prompter.qrCode === "function";
    });
    expect((await unsupported.next()).status).toBe("done");
    expect(unsupportedHasQr).toBe(false);
  });

  test("rejects an invalid owner-supplied QR expiry", async () => {
    const session = new WizardSession(
      async (prompter) => {
        await prompter.qrCode?.({
          title: "Link a device",
          message: "Scan this QR code, then continue.",
          text: QR_TEXT,
          expiresAtMs: Number.POSITIVE_INFINITY,
        });
      },
      { supportsQrCode: true },
    );

    await expect(session.next()).resolves.toMatchObject({
      done: true,
      status: "error",
      error: expect.stringContaining("expiresAtMs must be a non-negative safe integer"),
    });
  });

  test("dismisses an active QR when its owner operation settles", async () => {
    const onQrPresentationOwnerSettled = vi.fn();
    let dismiss!: () => void;
    const dismissed = new Promise<void>((resolve) => {
      dismiss = resolve;
    });
    const session = new WizardSession(
      async (prompter) => {
        await prompter.qrCode?.({
          title: "Link a device",
          message: "Scan this QR code, then continue.",
          text: QR_TEXT,
          dismissed,
        });
        await prompter.text({ message: "Next step" });
      },
      { supportsQrCode: true, onQrPresentationOwnerSettled },
    );

    const prompt = await session.next();
    if (!prompt.step) {
      throw new Error("expected QR acknowledgement step");
    }
    const deliveredStep = prompt.step;
    expect(deliveredStep.qrDataUrl).toBe(QR_DATA_URL);
    expect(session.hasOwnedQrPresentation()).toBe(true);

    dismiss();
    await Promise.resolve();
    const next = await session.next();

    expect(deliveredStep.qrDataUrl).toBeUndefined();
    expect(onQrPresentationOwnerSettled).toHaveBeenCalledWith(deliveredStep.id);
    expect(next.step).toMatchObject({ type: "text", message: "Next step" });
    expect(session.hasOwnedQrPresentation()).toBe(false);
    await expect(session.answer(deliveredStep.id, true)).resolves.toBeUndefined();
    await expect(session.answer(deliveredStep.id, true)).rejects.toThrow("wizard: no pending step");
    if (!next.step) {
      throw new Error("expected next wizard step");
    }
    await session.answer(next.step.id, "done");
    await session.whenSettled();
    expect(session.hasOwnedQrPresentation()).toBe(false);
  });

  test("reports QR owner settlement after the client already acknowledged", async () => {
    const onQrPresentationOwnerSettled = vi.fn();
    let settleOwner!: () => void;
    const owner = new Promise<void>((resolve) => {
      settleOwner = resolve;
    });
    const session = new WizardSession(
      async (prompter) => {
        await prompter.qrCode?.({
          title: "Link a device",
          message: "Scan this QR code, then continue.",
          text: QR_TEXT,
          dismissed: owner,
        });
      },
      { supportsQrCode: true, onQrPresentationOwnerSettled },
    );

    const prompt = await session.next();
    if (!prompt.step) {
      throw new Error("expected QR acknowledgement step");
    }
    await session.answer(prompt.step.id, true);
    await session.whenSettled();
    expect(onQrPresentationOwnerSettled).not.toHaveBeenCalled();

    settleOwner();
    await Promise.resolve();
    expect(onQrPresentationOwnerSettled).toHaveBeenCalledWith(prompt.step.id);
  });

  test("retires an expired QR while its external owner operation keeps running", async () => {
    let settleOwner!: () => void;
    const owner = new Promise<void>((resolve) => {
      settleOwner = resolve;
    });
    let acknowledged: boolean | undefined;
    const session = new WizardSession(
      async (prompter) => {
        acknowledged = await prompter.qrCode?.({
          title: "Link a device",
          message: "Scan this QR code, then continue.",
          text: QR_TEXT,
          dismissed: owner,
        });
        await owner;
      },
      { supportsQrCode: true },
    );

    const prompt = await session.next();
    if (!prompt.step) {
      throw new Error("expected QR acknowledgement step");
    }
    const deliveredStep = prompt.step;

    expect(session.expireOwnedQrPresentation(deliveredStep.id)).toBe(true);
    await vi.waitFor(() => expect(acknowledged).toBe(true));

    expect(deliveredStep.qrDataUrl).toBeUndefined();
    expect(session.hasExternalQrPresentationOwner()).toBe(true);
    await expect(session.answer(deliveredStep.id, true)).resolves.toBeUndefined();

    settleOwner();
    await session.whenSettled();
    expect(session.getStatus()).toBe("done");
  });

  test("dismisses an active QR and surfaces an owner operation rejection", async () => {
    let rejectOwner!: (error: Error) => void;
    const dismissed = new Promise<void>((_resolve, reject) => {
      rejectOwner = reject;
    });
    const session = new WizardSession(
      async (prompter) => {
        await prompter.qrCode?.({
          title: "Link a device",
          message: "Scan this QR code, then continue.",
          text: QR_TEXT,
          dismissed,
        });
      },
      { supportsQrCode: true },
    );

    const prompt = await session.next();
    if (!prompt.step) {
      throw new Error("expected QR acknowledgement step");
    }
    const deliveredStep = prompt.step;

    rejectOwner(new Error("link failed"));
    await Promise.resolve();
    const result = await session.next();

    expect(deliveredStep.qrDataUrl).toBeUndefined();
    expect(result).toMatchObject({
      done: true,
      status: "error",
      error: expect.stringContaining("link failed"),
    });
    await expect(session.answer(deliveredStep.id, true)).resolves.toBeUndefined();
  });

  test("reports QR rendering failures before presenting a wizard step", async () => {
    qrImageMocks.renderQrPngDataUrlWithinLimit.mockRejectedValueOnce(
      new Error("QR rendering failed"),
    );
    const session = new WizardSession(
      async (prompter) => {
        await prompter.qrCode?.({
          title: "Link a device",
          message: "Scan this QR code, then continue.",
          text: QR_TEXT,
        });
      },
      { supportsQrCode: true },
    );

    const result = await session.next();
    expect(result).toMatchObject({
      done: true,
      status: "error",
      error: expect.stringContaining("QR rendering failed"),
    });
  });

  test("invalid answers throw", async () => {
    const session = noteRunner();
    const first = await session.next();
    await expect(session.answer("bad-id", null)).rejects.toThrow(/wizard: no pending step/i);
    if (!first.step) {
      throw new Error("expected first step");
    }
    await session.answer(first.step.id, null);
  });

  test("keeps a validated text step pending after an invalid answer", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({
        message: "Port",
        validate: (value) => (value === "18789" ? undefined : "Enter the expected port"),
      });
    });

    const first = await session.next();
    if (!first.step) {
      throw new Error("expected text step");
    }
    await expect(session.answer(first.step.id, "banana")).resolves.toBe("Enter the expected port");
    expect(session.getStatus()).toBe("running");
    expect((await session.next()).step?.id).toBe(first.step.id);

    await session.answer(first.step.id, "18789");
    expect((await session.next()).status).toBe("done");
  });

  test("rejects non-scalar text answers before validation and resolution", async () => {
    let resolved: string | undefined;
    const session = new WizardSession(async (prompter) => {
      resolved = await prompter.text({
        message: "Token",
        validate: (value) => (value.length > 0 ? undefined : "Token is required"),
      });
    });

    const first = await session.next();
    if (!first.step) {
      throw new Error("expected text step");
    }
    await expect(session.answer(first.step.id, ["token"])).resolves.toBe(
      "wizard: text answer must be a scalar value",
    );
    expect((await session.next()).step?.id).toBe(first.step.id);

    await session.answer(first.step.id, "token");
    expect((await session.next()).status).toBe("done");
    expect(resolved).toBe("token");
  });

  test("cancel marks session and unblocks", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({ message: "Name" });
    });

    const step = await session.next();
    expect(step.step?.type).toBe("text");

    session.cancel();

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("cancelled");
    expect(session.signal.aborted).toBe(true);
  });

  test("cancel scrubs QR bytes from an already delivered step", async () => {
    const session = new WizardSession(
      async (prompter) => {
        await prompter.qrCode?.({
          title: "Link a device",
          message: "Scan this QR code, then continue.",
          text: QR_TEXT,
        });
      },
      { supportsQrCode: true },
    );

    const prompt = await session.next();
    if (!prompt.step) {
      throw new Error("expected QR acknowledgement step");
    }
    const deliveredStep = prompt.step;
    expect(deliveredStep.qrDataUrl).toBe(QR_DATA_URL);

    expect(session.cancel()).toBe(true);

    expect(deliveredStep.qrDataUrl).toBeUndefined();
    expect((await session.next()).status).toBe("cancelled");
  });

  test("refuses cancellation after the durable commit point", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = new WizardSession(async () => {
      await gate;
    });

    session.lockCancellation();
    expect(session.cancel()).toBe(false);
    expect(session.getStatus()).toBe("running");
    expect(session.signal.aborted).toBe(false);

    finish();
    expect((await session.next()).status).toBe("done");
  });

  test("expires an abandoned interactive session", async () => {
    vi.useFakeTimers();
    try {
      const session = new WizardSession(
        async (prompter) => {
          await prompter.text({ message: "Name" });
        },
        { timeoutMs: 1_000 },
      );

      expect((await session.next()).step?.type).toBe("text");
      await vi.advanceTimersByTimeAsync(1_000);

      const done = await session.next();
      expect(done.status).toBe("cancelled");
      expect(session.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a runner finishing after cancellation cannot overwrite cancelled state", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = new WizardSession(async () => {
      await gate;
    });

    session.cancel();
    finish();
    await Promise.resolve();

    expect((await session.next()).status).toBe("cancelled");
  });

  test("does not lose terminal completion when the last answer finishes the runner immediately", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({ message: "Token" });
    });

    const first = await session.next();
    expect(first.step?.type).toBe("text");
    if (!first.step) {
      throw new Error("expected first step");
    }

    await session.answer(first.step.id, "ok");
    await Promise.resolve();

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("done");
  });

  test("forwards sensitive flag to the emitted text step", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({ message: "API key", sensitive: true });
      await prompter.text({ message: "Username" });
    });

    const sensitiveStep = (await session.next()).step;
    expect(sensitiveStep?.type).toBe("text");
    expect(sensitiveStep?.sensitive).toBe(true);
    if (!sensitiveStep) {
      throw new Error("expected sensitive step");
    }
    await session.answer(sensitiveStep.id, "fake-key-aa11");

    const plainStep = (await session.next()).step;
    expect(plainStep?.type).toBe("text");
    expect(plainStep?.sensitive).toBeUndefined();
    if (!plainStep) {
      throw new Error("expected plain step");
    }
    await session.answer(plainStep.id, "alice");
  });

  test("bridges confirm, progress updates, and notes in order", async () => {
    let markInitialUpdateQueued!: () => void;
    const initialUpdateQueued = new Promise<void>((resolve) => {
      markInitialUpdateQueued = resolve;
    });
    let releaseHalfway!: () => void;
    const halfway = new Promise<void>((resolve) => {
      releaseHalfway = resolve;
    });
    let releaseDone!: () => void;
    const done = new Promise<void>((resolve) => {
      releaseDone = resolve;
    });
    const session = new WizardSession(async (prompter) => {
      await prompter.confirm({ message: "Download model?", initialValue: false });
      const progress = prompter.progress("Starting download");
      progress.update("Downloading model... 10%");
      markInitialUpdateQueued();
      await halfway;
      progress.update("Downloading model... 50%");
      await done;
      progress.stop("Model downloaded");
      await prompter.note("Ready to use", "Prepared");
    });

    const confirm = await session.next();
    expect(confirm.step).toMatchObject({
      type: "confirm",
      message: "Download model?",
      initialValue: false,
    });
    if (!confirm.step) {
      throw new Error("expected confirm step");
    }
    await session.answer(confirm.step.id, true);
    await initialUpdateQueued;

    expect(await session.next()).toMatchObject({
      step: {
        type: "progress",
        message: "Starting download",
        executor: "gateway",
      },
    });

    expect(await session.next()).toMatchObject({
      step: { type: "progress", message: "Downloading model... 10%" },
    });

    const halfwayStep = session.next();
    releaseHalfway();
    expect(await halfwayStep).toMatchObject({
      step: { type: "progress", message: "Downloading model... 50%" },
    });

    const doneStep = session.next();
    releaseDone();
    const completedProgress = await doneStep;
    expect(completedProgress).toMatchObject({
      step: { type: "progress", message: "Model downloaded" },
    });
    if (!completedProgress.step) {
      throw new Error("expected completed progress step");
    }
    await expect(session.answer(completedProgress.step.id, undefined)).resolves.toBeUndefined();

    expect(await session.next()).toMatchObject({
      step: { type: "note", title: "Prepared", message: "Ready to use" },
    });
  });
});
