export type RecoveryState = "Healthy" | "Degraded" | "Recovering" | "Failed" | "ReadOnly";
export type RecoveryEvent = "ready" | "verified" | "degraded" | "storage_error" | "recovery_started" | "read_only" | "failed";

/**
 * Deterministic readiness transitions. An ordinary probe may establish initial
 * readiness or preserve an existing state, but only an explicit verification
 * event may clear Failed/ReadOnly. An ordinary storage error never silently
 * upgrades a terminal state.
 */
export function transitionRecoveryState(current: RecoveryState, event: RecoveryEvent): RecoveryState {
  switch (event) {
    case "ready":
      return current === "Recovering" ? "Healthy" : current;
    case "verified":
      return "Healthy";
    case "degraded":
      return current === "Failed" || current === "ReadOnly" ? current : "Degraded";
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
