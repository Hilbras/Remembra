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

`role`/`instruction` memories always surface (+1000) **within their scope** —
when their `trust` is at least `trusted` — and are meant
to be **followed**, not merely recalled. That is the feature — and the risk:

- **Via MCP**: whoever can call `memory_store` in your session is already the
  agent you're running. No additional boundary is crossed.
- **Via HTTP**: anyone with your API key can plant a global `role` that every
  future session will receive as an instruction.
- **Cross-project**: roles scoped to another project do *not* surface in your
  searches (isolation, enforced since 3.6.0) — the residual vector is a
  `global` role, which reaches every scope by design.

**Rules:**
1. Never expose HTTP without `REMEMBRA_API_KEY` (enforced — see below).
2. Treat the API key as root access to your assistant's standing instructions.
3. Audit standing guidance periodically:
   `memory_list { type: "role", includeArchived: true }` — and the same for
   `type: "instruction"`.
4. If you ingest transcripts from other people (shared ChatGPT GPT, public bot),
   remember the digest LLM can extract `role`/`instruction` items from *their*
   text. Since 4.1.0 they land `unverified` — listed and searchable, but they
   never earn the +1000 boost until approved (dashboard **Approve** or
   `memory_update { trust }`) — still review before trusting a multi-user
   deployment.

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
| **Advisory locking** | `<root>/.remembra.lock` (`O_EXCL`) + in-process FIFO — cross-process writes serialize; stale locks (dead pid / older than `REMEMBRA_LOCK_STALE_MS`) are stolen; a fresh lock with this process's own pid is treated as a live sibling instance and waited on; waiters fail with typed `LOCK_TIMEOUT` (HTTP 423) |
| **Crash recovery** | one-time pass on first access: removes orphaned `*.tmp`, reconciles ids left in both active+archived trees by an interrupted archive/revive |
| **Structured errors** | every actionable failure has a stable code (`INVALID_INPUT`, `LOCK_TIMEOUT`, `LLM_ERROR`, …) mapped to HTTP statuses / MCP `[CODE]` prefixes |
| **ID collisions** | UUIDv7 ids (4.1.0) — unique from entropy, no existence scan |
| **Content-Length** | Set on every response |
| **Metrics auth (3.7.0)** | `GET /metrics` sits *after* the API-key check — counters and latencies never leak without the key (`/health` stays exempt for readiness probes) |
| **PII redaction (3.8.0, opt-in)** | `REMEMBRA_REDACT=1` strips emails, Luhn-valid card numbers, SSNs, phone numbers and high-entropy secrets at the *ingest layer* (`memory_store`, digest items, merge output) — raw patterns never reach disk, embeddings, or export snapshots |
| **Encryption at rest (3.8.0, opt-in)** | `REMEMBRA_ENCRYPT_KEY` → AES-256-GCM per file; reading an encrypted file without the key fails **loudly** (`ENCRYPTED_NO_KEY`, HTTP 503, `/health` 503) — never warn-skipped as if the data didn't exist |
| **Web UI static routes (4.0.0)** | `/` + `/ui/*` serve a fixed extension whitelist (`.html/.css/.js/.map`) with decode-then-containment path checks inside `dist/ui`, regular files only, `nosniff`, and a **CSP with no `unsafe-inline`** (`default-src 'none'`, same-origin scripts/styles/API only). The shell is unauthenticated like `/health` (it holds no data — every API call the page makes still carries the key); `REMEMBRA_UI=0` disables serving entirely |

## Web dashboard (4.0.0)

`remembra --http` also serves the UI at `/`. The trust split:

- **The shell is static, trusted bytes** — HTML/CSS/JS from your own install,
  served from one whitelisted root with a path-containment check; traversal
  attempts (`..`, `%2e%2e`, absolute, NUL) and non-whitelisted extensions all
  land on a generic 404. It carries **no memory data** — opening `/` on a
  keyed server works without a key, exactly like `/health`.
- **Data stays behind the key** — the page prompts for `REMEMBRA_API_KEY` and
  sends it on every API call (`x-api-key`, same header the Custom GPT uses).
  The key lives in **`sessionStorage`**: per-tab, discarded when the tab
  closes, never written to disk or `localStorage`.
- **CSP as the backstop** — no inline scripts or styles anywhere in the
  shell, `script-src 'self'` / `style-src 'self'` / `connect-src 'self'`, so
  injected markup can't execute and the page can only talk to your server.
- **Off switch** — `REMEMBRA_UI=0` serves no UI routes at all (pure API
  server), useful for public deployments that never want the dashboard.

Full page-by-page guide: [ui.md](ui.md).

## Encryption at rest (opt-in, 3.8.0)

Plain markdown stays the default (you can read and edit your memories —
that's the point). Setting a key flips storage to ciphertext:

```bash
export REMEMBRA_ENCRYPT_KEY="$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')"
remembra encrypt    # migrate the existing tree (memories + history) in place
remembra --http     # from here on, writes are AES-256-GCM
```

| | |
|---|---|
| **Format** | `RMBENC1 │ nonce(12) │ tag(16) │ ciphertext` per file — AES-256-GCM via `node:crypto`, zero dependencies, random nonce per write, same `.md` names (detected by magic bytes) |
| **Key** | 64 hex chars (32 bytes) used directly — no KDF needed for a high-entropy symmetric key. *Not* a human passphrase |
| **Mixed trees** | Plain files stay readable while the key is set, and `remembra decrypt` reverses the migration — both directions are idempotent |
| **Fail-loud** | Encrypted file + missing/wrong key → `ENCRYPTED_NO_KEY` (HTTP 503, MCP `[ENCRYPTED_NO_KEY]`, `/health` 503). GCM auth failure makes a wrong key indistinguishable from tampering |
| **What it protects** | At-rest exfiltration: stolen backups, copied `~/.remembra`, a leaked git history of the directory |
| **What it does not** | A runtime attacker on your machine can read the env of the process holding the key — this is not a substitute for OS disk encryption & process isolation; and files stop being human-readable (decrypt first: unset the key after `remembra decrypt`) |

Export snapshots (`remembra export`) contain **decrypted** JSON — they are
protected by file permissions like any other backup.

## PII redaction (opt-in, 3.8.0)

```bash
export REMEMBRA_REDACT=1
```

Everything that enters storage — `memory_store` calls, every digest-extracted
item, and merge output — runs through a pattern filter first:

| Matches | Placeholder | Guard against false positives |
|---------|-------------|------------------------------|
| Emails | `<EMAIL>` | — |
| Card numbers (13–19 digits) | `<CARD>` | must pass the **Luhn** check |
| SSNs (`123-45-6789`) | `<SSN>` | dashed format only |
| Phone numbers | `<PHONE>` | separators required, 10–15 digits — dates (`2026-09-23`, 8 digits) and versions (`3.6.0`) never match |
| Provider tokens (`sk-…`, `ghp_…`, `AKIA…`) + ≥40-char high-entropy blobs | `<SECRET>` | generic blobs must contain a digit (long English words survive) |

Properties:

- **Irreversible by design** — the original bytes are not kept anywhere;
  before enabling, assume anything redacted is gone from future exports too.
- **Not a compliance control** — regex covers the common shapes; names,
  addresses in free prose, and anything the patterns miss are untouched.
  Treat it as belt-and-braces on top of not feeding PII to your LLM providers.
- The **extraction LLM still sees the raw transcript** (it must, to
  understand it) — redaction guards what Remembra *stores*, not what your
  `REMEMBRA_LLM` provider receives. Use `memory_store` (not digest) for
  content you must not send to a third-party model.

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
- [ ] `REMEMBRA_HOME` lives on a filesystem you back up — use
      `remembra export <file>.json` for portable snapshots (or `rsync`/git the
      directory)
- [ ] Periodic `memory_list {type: "role"}` / `{type: "instruction"}` audit
- [ ] LLM/embedding keys scoped to least privilege
- [ ] Consider `REMEMBRA_REDACT=1` before storing content derived from other
      people's data (redaction is irreversible — decide once, up front)
- [ ] Consider `REMEMBRA_ENCRYPT_KEY` when the store leaves your machine
      (backups, shared filesystems) — generate 32 random bytes, store the key
      in your secret manager, run `remembra encrypt`

## Known non-goals (current version)

- **No multi-tenancy** — one store per installation; scope isolates *projects*,
  not *users*. Never share one instance between mutually untrusting users.
- **Single-writer assumption per store, now cross-process safe** — mutations
  take an advisory lockfile (`O_EXCL`, stale-steal, typed `LOCK_TIMEOUT`), so
  an MCP server, the `remembra maintain` CLI, and a session digest can run
  against one store concurrently on one machine. Network filesystems with
  unreliable `O_EXCL` semantics are untested; `remembra export` for backups
  across machines.
- Encryption-at-rest and PII redaction are **off by default** (both since
  3.8.0, both opt-in above) — defaults keep files human-readable and
  byte-faithful to what you stored.
