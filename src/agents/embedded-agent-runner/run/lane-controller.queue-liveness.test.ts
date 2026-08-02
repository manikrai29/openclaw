import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  getAgentRunContext,
  registerAgentRunContext,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
  sweepStaleRunContexts,
} from "../../../infra/agent-events.js";
import {
  clearCommandLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { RunEmbeddedAgentParams } from "./params.js";

const CONTEXT_TTL_MS = 30 * 60 * 1000;
const SESSION_LANE = "queued-run-context-session";
const GLOBAL_LANE = "queued-run-context-global";

function createRunController(overrides: Partial<RunEmbeddedAgentParams> = {}) {
  let lifecycleGeneration = getAgentEventLifecycleGeneration();
  let params: RunEmbeddedAgentParams & { sessionFile: string } = {
    lifecycleGeneration,
    prompt: "queued run",
    runId: "healthy-queued-run",
    sessionFile: "/tmp/queued-run.jsonl",
    sessionId: "queued-session",
    timeoutMs: 60_000,
    workspaceDir: "/tmp",
    ...overrides,
  };
  const controller = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => params,
    globalLane: GLOBAL_LANE,
    initialQueuedLifecycleGeneration: lifecycleGeneration,
    sessionLane: SESSION_LANE,
    setLifecycleGeneration: (updated) => {
      lifecycleGeneration = updated;
    },
    setParams: (updated) => {
      params = updated;
    },
  });
  return { controller, params };
}

async function waitForQueuedLane(lane: string): Promise<void> {
  for (let turn = 0; turn < 10 && getCommandLaneSnapshot(lane).queuedCount === 0; turn++) {
    await Promise.resolve();
  }
  expect(getCommandLaneSnapshot(lane).queuedCount).toBe(1);
}

beforeEach(() => {
  resetAgentEventsForTest();
  resetCommandQueueStateForTest();
});

afterEach(() => {
  resetAgentEventsForTest();
  resetCommandQueueStateForTest();
  vi.restoreAllMocks();
});

describe("queued embedded run context liveness", () => {
  test.each([
    { blockedLane: SESSION_LANE, queue: "session" },
    { blockedLane: GLOBAL_LANE, queue: "global" },
  ])(
    "retains a healthy run past the context TTL while the $queue lane is full",
    async ({ blockedLane }) => {
      const registeredAt = 1_000;
      const admissionAt = registeredAt + CONTEXT_TTL_MS + 1;
      const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const { controller, params } = createRunController();

      registerAgentRunContext(params.runId, {
        agentId: "main",
        isControlUiVisible: false,
        lifecycleGeneration,
        registeredAt,
        sessionKey: "agent:main:subagent:queued",
      });
      registerAgentRunContext("abandoned-run", {
        lifecycleGeneration,
        registeredAt,
        sessionKey: "agent:main:subagent:abandoned",
      });
      setCommandLaneConcurrency(blockedLane, 0);

      const run = controller.enqueueSession(() =>
        controller.enqueueGlobal(async () => ({}) as EmbeddedAgentRunResult),
      );

      try {
        await waitForQueuedLane(blockedLane);

        clock.mockReturnValue(admissionAt);
        expect(sweepStaleRunContexts()).toBe(1);
        expect(getAgentRunContext("abandoned-run")).toBeUndefined();
        expect(getAgentRunContext(params.runId)).toMatchObject({ lifecycleGeneration });

        setCommandLaneConcurrency(blockedLane, 1);
        await run;
        expect(getAgentRunContext(params.runId)).toMatchObject({
          agentId: "main",
          isControlUiVisible: false,
          lastActiveAt: admissionAt,
          registeredAt,
          sessionKey: "agent:main:subagent:queued",
        });

        clock.mockReturnValue(admissionAt + CONTEXT_TTL_MS);
        expect(sweepStaleRunContexts()).toBe(0);

        clock.mockReturnValue(admissionAt + CONTEXT_TTL_MS + 1);
        expect(sweepStaleRunContexts()).toBe(1);
        expect(getAgentRunContext(params.runId)).toBeUndefined();
      } finally {
        setCommandLaneConcurrency(blockedLane, 1);
        await run.catch(() => {});
      }
    },
  );

  test.each([
    { blockedLane: SESSION_LANE, queue: "session" },
    { blockedLane: GLOBAL_LANE, queue: "global" },
  ])(
    "releases $queue queue ownership immediately when a waiting run is aborted",
    async ({ blockedLane }) => {
      const registeredAt = 1_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
      const abort = new AbortController();
      const { controller, params } = createRunController({ abortSignal: abort.signal });
      registerAgentRunContext(params.runId, {
        lifecycleGeneration: params.lifecycleGeneration,
        registeredAt,
      });
      setCommandLaneConcurrency(blockedLane, 0);
      const run = controller.enqueueSession(() =>
        controller.enqueueGlobal(async () => ({}) as EmbeddedAgentRunResult),
      );

      try {
        await waitForQueuedLane(blockedLane);
        clock.mockReturnValue(registeredAt + CONTEXT_TTL_MS + 1);
        expect(sweepStaleRunContexts()).toBe(0);

        abort.abort(new Error("queued run canceled"));
        expect(getCommandLaneSnapshot(blockedLane).queuedCount).toBe(1);
        expect(sweepStaleRunContexts()).toBe(1);
        expect(getAgentRunContext(params.runId)).toBeUndefined();

        setCommandLaneConcurrency(blockedLane, 1);
        await expect(run).rejects.toThrow("queued run canceled");
      } finally {
        setCommandLaneConcurrency(blockedLane, 1);
        await run.catch(() => {});
      }
    },
  );

  test.each([
    { blockedLane: SESSION_LANE, queue: "session" },
    { blockedLane: GLOBAL_LANE, queue: "global" },
  ])(
    "releases $queue queue ownership when pending lane work is cleared",
    async ({ blockedLane }) => {
      const registeredAt = 1_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
      const { controller, params } = createRunController();
      registerAgentRunContext(params.runId, {
        lifecycleGeneration: params.lifecycleGeneration,
        registeredAt,
      });
      setCommandLaneConcurrency(blockedLane, 0);
      const run = controller.enqueueSession(() =>
        controller.enqueueGlobal(async () => ({}) as EmbeddedAgentRunResult),
      );

      await waitForQueuedLane(blockedLane);
      clock.mockReturnValue(registeredAt + CONTEXT_TTL_MS + 1);
      expect(sweepStaleRunContexts()).toBe(0);

      expect(clearCommandLane(blockedLane)).toBe(1);
      await expect(run).rejects.toThrow();
      expect(sweepStaleRunContexts()).toBe(1);
      expect(getAgentRunContext(params.runId)).toBeUndefined();
    },
  );

  test("releases ownership when a custom queue rejects admission synchronously", () => {
    const registeredAt = 1_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    const { controller, params } = createRunController({
      enqueue: () => {
        throw new Error("custom lane rejected admission");
      },
    });
    registerAgentRunContext(params.runId, {
      lifecycleGeneration: params.lifecycleGeneration,
      registeredAt,
    });

    expect(() =>
      controller.enqueueSession(() =>
        controller.enqueueGlobal(async () => ({}) as EmbeddedAgentRunResult),
      ),
    ).toThrow("custom lane rejected admission");

    clock.mockReturnValue(registeredAt + CONTEXT_TTL_MS + 1);
    expect(sweepStaleRunContexts()).toBe(1);
    expect(getAgentRunContext(params.runId)).toBeUndefined();
  });

  test("rebinds queued foreground work after its retired context expires", async () => {
    const registeredAt = 1_000;
    const admissionAt = registeredAt + CONTEXT_TTL_MS + 1;
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    const { controller, params } = createRunController({ trigger: "user" });
    registerAgentRunContext(params.runId, {
      lifecycleGeneration: params.lifecycleGeneration,
      registeredAt,
    });
    setCommandLaneConcurrency(GLOBAL_LANE, 0);
    const run = controller.enqueueSession(() =>
      controller.enqueueGlobal(async () => ({}) as EmbeddedAgentRunResult),
    );

    try {
      await waitForQueuedLane(GLOBAL_LANE);
      clock.mockReturnValue(admissionAt);
      expect(sweepStaleRunContexts()).toBe(0);

      const replacementGeneration = rotateAgentEventLifecycleGeneration();
      expect(sweepStaleRunContexts()).toBe(1);
      expect(getAgentRunContext(params.runId)).toBeUndefined();

      setCommandLaneConcurrency(GLOBAL_LANE, 1);
      await run;
      expect(getAgentRunContext(params.runId)).toMatchObject({
        lifecycleGeneration: replacementGeneration,
        lastActiveAt: admissionAt,
        sessionId: params.sessionId,
      });

      clock.mockReturnValue(admissionAt + CONTEXT_TTL_MS);
      expect(sweepStaleRunContexts()).toBe(0);
    } finally {
      setCommandLaneConcurrency(GLOBAL_LANE, 1);
      await run.catch(() => {});
    }
  });

  test("rejects queued background work from a retired lifecycle", async () => {
    const registeredAt = 1_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    const { controller, params } = createRunController({ trigger: "cron" });
    registerAgentRunContext(params.runId, {
      lifecycleGeneration: params.lifecycleGeneration,
      registeredAt,
    });
    setCommandLaneConcurrency(GLOBAL_LANE, 0);
    const run = controller.enqueueSession(() =>
      controller.enqueueGlobal(async () => ({}) as EmbeddedAgentRunResult),
    );

    try {
      await waitForQueuedLane(GLOBAL_LANE);
      rotateAgentEventLifecycleGeneration();
      clock.mockReturnValue(registeredAt + CONTEXT_TTL_MS + 1);
      expect(sweepStaleRunContexts()).toBe(1);

      setCommandLaneConcurrency(GLOBAL_LANE, 1);
      await expect(run).rejects.toThrow("stale gateway lifecycle");
      expect(getAgentRunContext(params.runId)).toBeUndefined();
    } finally {
      setCommandLaneConcurrency(GLOBAL_LANE, 1);
      await run.catch(() => {});
    }
  });
});
