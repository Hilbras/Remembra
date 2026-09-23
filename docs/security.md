# Security & Trust Model

Remembra v3.1.0 hardening notes — what's protected, what's a trust decision,
and how to deploy safely.

## Trust model

```
┌─ Trusted ─────────────────────────────────────────────┐
│  You / your MCP clients (OpenCode, Claude Code, ...)  │
│  The LLM you configure for digest/merge               │
│  Files under REMEMBRA_HOME (local filesystem trust)   │
└───────────────────────────────────────────────────────┘
┌─ Semi-trusted ────────────────────────────────────────┐
│  Transcripts passed to memory_digest                  │
│  Anyone holding your REMEMBRA_API_KEY                 │
└───────────────────────────────────────────────────────┘
┌─ Untrusted ───────────────────────────────────────────┐
│  Network peers (if HTTP is exposed)                   │
│  Memory content written by other users of shared AI   │
└───────────────────────────────────────────────────────┘
```

### Role memories are instructions — the prompt-injection surface

`role` memories always surface (+1000) and are meant to be **followed**, not
merely recalled. That is the feature — and the risk:

- **Via MCP**: whoever can call `memory_store` in your session is already the
  agent you're running. No additional boundary is crossed.
- **Via HTTP**: anyone with your API key can plant a global `role` that every
  future session will receive as an instruction.

**Rules:**
1. Never expose HTTP without `REMEMBRA_API_KEY` (enforced — see below).
2. Treat the API key as root access to your assistant's standing instructions.
3. Audit roles periodically: `memory_list { type: "role", includeArchived: true }`.
4. If you ingest transcripts from other people (shared ChatGPT GPT, public bot),
   remember the digest LLM can extract `role` items from *their* text — review
   before trusting a multi-user deployment.

Retrieved memories should be treated as **data with provenance**, not commands
— but Remembra cannot enforce how the consuming model interprets them.

## Enforced protections (3.1.0)

| Protection | Mechanism |
|------------|-----------|
| **Directory traversal (P0)** | Scopes containing `..` rejected by Zod (`StoreInput`/`DigestInput`) + `fileFor()` re-verifies the resolved path stays under `REMEMBRA_HOME` (defense in depth) |
| **Default-deny HTTP** | Without `REMEMBRA_API_KEY`: binds `127.0.0.1` only. Non-loopback `REMEMBRA_HOST` without a key → **refuses to start** |
| **Timing-safe auth** | API keys compared with `crypto.timingSafeEqual` |
| **Body size limit** | 10 MiB default (`REMEMBRA_MAX_BODY`), `413` on excess — pre-checks `Content-Length` and enforces while streaming |
| **Digest validation** | `DigestInput` Zod schema on both MCP and HTTP paths |
| **Atomic writes** | temp file + `rename()` (POSIX-atomic) — no half-written memories after a crash |
| **ID collisions** | 12-hex IDs (2⁴⁸) + existence check on store |
| **Content-Length** | Set on every response |

## Deployment checklist

```bash
# Local (safe default — loopback, key optional)
remembra --http

# Public (ChatGPT etc.) — key is mandatory
export REMEMBRA_API_KEY="$(openssl rand -hex 32)"
export REMEMBRA_HOST=0.0.0.0
remembra --http
# → put TLS in front (Caddy/nginx/cloudflared). Remembra speaks plain HTTP.
```

- [ ] `REMEMBRA_API_KEY` set with a long random value (≥32 bytes)
- [ ] TLS terminator in front for any non-loopback exposure
- [ ] `REMEMBRA_HOME` lives on a filesystem you back up (there is **no built-in
      backup yet** — the files are the only copy)
- [ ] Periodic `memory_list {type: "role"}` audit
- [ ] LLM/embedding keys scoped to least privilege

## Known non-goals (current version)

- **No multi-tenancy** — one store per installation; scope isolates *projects*,
  not *users*. Never share one instance between mutually untrusting users.
- **No encryption at rest** — files are plaintext markdown (by design: you can
  read and edit them). Use filesystem-level encryption if needed.
- **No PII redaction** — what you store is what's written to disk.
- **No write locking / journal** — single-writer assumption; concurrent writers
  from multiple machines are unsupported (atomic writes protect against crashes,
  not interleaving).
- **No built-in backup/export** — planned; until then, back up `REMEMBRA_HOME`
  with your normal file backup (it's plain files, `rsync`/git all work).
