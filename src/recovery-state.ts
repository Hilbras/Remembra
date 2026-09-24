export type RecoveryState = "Healthy" | "Degraded" | "Recovering" | "Failed" | "ReadOnly";
export type RecoveryEvent = "ready" | "degraded" | "storage_error" | "recovery_started" | "read_only" | "failed";

/**
 * Deterministic readiness transitions. Explicit recovery/verification events
 * may move a failed/read-only service back into an operational state; an
 * ordinary storage error never silently upgrades a terminal state.
 */
export function transitionRecoveryState(current: RecoveryState, event: RecoveryEvent): RecoveryState {
  switch (event) {
    case "ready":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "storage_error":
      return current === "Failed" || current === "ReadOnly" ? current : "Degraded";
    case "recovery_started":
      return "Recovering";
    case "read_only":
      return "ReadOnly";
    case "failed":
      return "Failed";
    default:
      return current;
  }
}

export function recoveryStateForStorage(input: {
  ok: boolean;
  readOnly?: boolean;
  recovering?: boolean;
}): RecoveryState {
  if (input.recovering) return "Recovering";
  if (input.readOnly) return "ReadOnly";
  return input.ok ? "Healthy" : "Failed";
}
