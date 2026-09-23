# Multi-agent memory

Remembra can retain attribution and scope memories for autonomous agents. This
feature is **opt-in**: existing applications keep their current behavior unless
agent mode is explicitly enabled.

## Trust boundary

`agentId` is attribution metadata, not authentication. Remembra does not trust
a caller-provided `agentId` by default.

An application that enables agent mode must:

1. authenticate the caller using its existing auth mechanism;
2. establish the agent identity from trusted server-side state;
3. pass that identity to `MemoryService` as an `AgentContext`;
4. include the agent's allowed project/council/task scopes in that context;
5. never accept an unverified identity directly from a public request body or
   query parameter.

The HTTP server can receive a trusted identity through an application-supplied
resolver. A proxy header is acceptable only when the proxy removes any
client-supplied copy and sets the header itself.

## Memory attribution

Agent-created memories may record this provenance:

```json
{
  "sourceType": "agent",
  "agentId": "researcher-01",
  "agentType": "researcher",
  "agentVersion": "1.4.0",
  "sessionId": "session-18",
  "conversationId": "conversation-7",
  "taskId": "task-42",
  "runId": "run-103"
}
```

The store preserves `agentId`, `agentType`, `agentVersion`, `conversationId`,
`taskId`, and `runId` in both file and SQLite backends.

A trusted service context can also include `councilId`, `taskId`, and an
explicit `scopes` array. The conventional scopes `agent:<agentId>`,
`council:<councilId>`, and `task:<taskId>` are derived automatically. A
non-global memory is not readable through a direct id unless its scope is in
that context.

## Ownership and visibility

| Field | Values | Default |
|---|---|---|
| `owner` | `user`, `agent`, `project`, `organization`, `global` | `agent` for agent provenance; otherwise `global` |
| `access` | `private`, `shared`, `global` | `REMEMBRA_DEFAULT_ACCESS`, or `global` |

When `REMEMBRA_AGENT_MODE=1` is set (or the service receives
`agentMode: true`):

- `global` memories are readable by every caller;
- `shared` memories are readable by identified agents and remain subject to
  normal scope isolation;
- `private` memories are readable only by the agent recorded in provenance;
- a caller without a trusted agent context sees only `global` memories;
- an inaccessible direct memory id returns `NOT_FOUND`, not a distinct
  authorization error, to avoid disclosing that the id exists.

The policy applies to search, list, direct reads, updates, lifecycle changes,
relationships, history, and deletion. It is a memory-visibility policy, not a
replacement for transport authentication.

## Council conventions

Use the existing scope mechanism to form council memories. No special memory
type is required.

| Purpose | Recommended scope | Memory type |
|---|---|---|
| Agent-local working memory | `agent:coder` | `observation` |
| Shared council decision | `council:research` | `decision` |
| Shared task state | `task:task-42` | `fact` or `decision` |

A council decision is a normal `decision` stored at
`scope: "council:<council-name>"`. It is visible only to searches for that
scope (plus the normal global memories), which prevents one council from
mixing another council's state.

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `REMEMBRA_AGENT_MODE` | `0` | Enables fail-closed agent visibility policy. |
| `REMEMBRA_DEFAULT_ACCESS` | `global` | Default access for newly stored memories. |
