type AgentRunQueueLeaseContext = {
  lifecycleGeneration?: string;
  lastActiveAt?: number;
};

type AgentRunQueueLeaseState<TContext extends AgentRunQueueLeaseContext> = {
  runContextById: Map<string, TContext>;
  queuedRunContextLeases?: WeakMap<TContext, number>;
  lifecycleGeneration: string;
};

/** Protects the exact queued context without extending a recycled run's lifetime. */
export function retainAgentRunContextQueueLease<TContext extends AgentRunQueueLeaseContext>(
  state: AgentRunQueueLeaseState<TContext>,
  runId: string,
  lifecycleGeneration: string,
): ((outcome: "admitted" | "abandoned") => void) | undefined {
  const context = state.runContextById.get(runId);
  if (
    !context ||
    context.lifecycleGeneration !== lifecycleGeneration ||
    state.lifecycleGeneration !== lifecycleGeneration
  ) {
    return undefined;
  }

  const leases = (state.queuedRunContextLeases ??= new WeakMap<TContext, number>());
  leases.set(context, (leases.get(context) ?? 0) + 1);
  let released = false;

  return (outcome) => {
    if (released) {
      return;
    }
    released = true;
    const remaining = (leases.get(context) ?? 0) - 1;
    if (remaining > 0) {
      leases.set(context, remaining);
    } else {
      leases.delete(context);
    }

    // A recycled run id or rotated lifecycle must not inherit the old queue's activity.
    if (
      outcome === "admitted" &&
      state.runContextById.get(runId) === context &&
      context.lifecycleGeneration === lifecycleGeneration &&
      state.lifecycleGeneration === lifecycleGeneration
    ) {
      context.lastActiveAt = Date.now();
    }
  };
}
