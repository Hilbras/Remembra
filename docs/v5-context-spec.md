# V5 Context API Contract (Draft)

Status: implementation contract for the first V5 vertical slice. V4.9 APIs
remain unchanged; this document describes the additive `context` capability.

## Request

```ts
memory.context({
  query?: string,
  scope?: string,
  maxTokens?: number,       // default 4000, hard maximum 100000
  limit?: number,            // candidate cap, default 100, maximum 100
  includeArchived?: boolean,
  includeExpired?: boolean,
  includeFuture?: boolean,
  includeQuarantined?: boolean
});
```

The request uses the same trusted host context and visibility policy as
`search`. A client cannot provide an agent identity, tenant identity, owner,
or access field to elevate a context request.

## Response

```ts
{
  memories: Array<Omit<Memory, "embedding">>,
  context: string,
  tokenCount: number,
  retrievalMetadata: {
    query: string,
    scope?: string,
    maxTokens: number,
    tokenCounter: string,
    candidateCount: number,
    selectedCount: number,
    omittedCount: number,
    explanations?: RetrievalExplanation[]
  }
}
```

`context` is a deterministic, human-readable serialization of selected
memories. `memories` contains the complete selected memory objects, including
provenance and trust metadata. The token budget applies to the serialized
`context` string; metadata is bounded separately by the HTTP response limit.

The default counter is a conservative deterministic estimator. A host may
inject a provider-specific counter; its identifier is returned in metadata.
The context string never exceeds `maxTokens` under the active counter.

## Selection rules

1. Reuse the existing retrieval ranking and hard visibility filters.
2. Consider at most `limit` ranked candidates (100 by default).
3. Render candidates in rank order.
4. Include a candidate only when the complete rendered item fits the remaining
   budget.
5. Skip oversized candidates and report them through `omittedCount`; never
   truncate a memory into an ambiguous instruction.
6. Return an empty context rather than violating the budget.

The operation is read-only and does not change trust, lifecycle, or retrieval
metadata. A future policy layer may add reranking/diversity controls, but it
must not weaken the hard budget or visibility gates.

## Transports

- HTTP: `POST /api/v1/context`
- TypeScript SDK: `Remembra.context(...)`
- MCP: `memory_context` in the V5 manifest, returning JSON text like the
  existing structured batch tool.

Authentication, request-size limits, rate limits, and trusted agent resolution
are identical to the corresponding search route. Context selection happens
after authorization; no candidate is serialized before it passes visibility
checks.

## Errors and limits

- Invalid input: `400` / `INVALID_INPUT` where the transport supports codes.
- Unauthorized: existing HTTP auth behavior.
- Context budget: integer `1..100000`; invalid values fail closed.
- Candidate limit: integer `1..100`; no unbounded retrieval expansion.
- Provider/embedding failure: existing bounded fail-open retrieval behavior;
  the context remains usable from keyword results.
- Cancellation: request `AbortSignal`/disconnect propagates to retrieval and
  embedding work.

## Compatibility

The existing `search` response and all V4.9 store/update/delete/MCP contracts
remain unchanged. The context API is additive and can be introduced before V5
storage or tenant schema changes.
