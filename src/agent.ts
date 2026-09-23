import {
  Memory,
  MemoryAccess,
  MemoryOwner,
  Provenance,
} from "./types.js";

/**
 * Identity attached by the embedding application after it has authenticated
 * the caller. This is deliberately not parsed from a public HTTP header by
 * default: a header alone is not an authentication mechanism.
 */
export interface AgentContext {
  agentId: string;
  agentType?: string;
  agentVersion?: string;
  councilId?: string;
  taskId?: string;
  conversationId?: string;
  runId?: string;
}

/** The ownership inferred for a new memory when the caller omits it. */
export function defaultOwner(provenance: Provenance): MemoryOwner {
  return provenance.sourceType === "agent" ? "agent" : "global";
}

/** The configured default access; invalid configuration safely falls back to global. */
export function defaultAccess(): MemoryAccess {
  const configured = MemoryAccess.safeParse(process.env.REMEMBRA_DEFAULT_ACCESS);
  return configured.success ? configured.data : "global";
}

/**
 * Agent-mode read policy.
 *
 * Global memories remain available to every identified agent. Shared memories
 * are available to identified agents and remain subject to the normal scope
 * filter. Private memories are available only to their creating agent. In
 * fail-closed agent mode, a missing context sees global memories only.
 *
 * Callers must establish AgentContext themselves; this function is a policy
 * layer, not an identity provider.
 */
export function canReadMemory(
  memory: Memory,
  context: AgentContext | undefined,
  agentMode: boolean,
): boolean {
  if (!agentMode) return true;
  if ((memory.access ?? "global") === "global") return true;
  if (!context) return false;
  if ((memory.access ?? "global") === "shared") return true;
  return memory.access === "private" && memory.provenance.agentId === context.agentId;
}
