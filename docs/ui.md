# Web Dashboard

Added in **4.0.0** (v4). Remembra's `--http` mode serves a complete web UI
from the same binary — no extra server, no framework, no bundled dependency.

```bash
REMEMBRA_API_KEY="your-secret" remembra --http
# open http://localhost:8787/
```

## What's on it

| Page | What you can do |
|------|-----------------|
| **Memories** (`#/memories`) | Debounced search (`/memories/search`), type filter over all **11 types**/scope/archived, 20-per-page pagination, rows with type badge, first line, tags, importance, age, and an **`unverified` trust badge** when one needs approval. `+ New` opens the form. |
| **Detail** (`#/memories/:id`) | Full content, metadata grid (scope, importance, confidence, **trust chip + Approve button**, provenance, **retention**, **version**, last validated, source, timestamps), tag chips, **typed relations + backlinks** with kind chips and a kind selector on the link picker, **Archive/Revive**, **Delete** (confirm dialog), and a lazy **History** panel rendering unified diffs (green `+` / red `-` / dim context, current version open) with supersession reasons. |
| **New / Edit** (`#/new`, `#/edit/:id`) | Type (all 11), content, scope (moving scope = moving the file), tags, importance 1–5, confidence, source, **retention mode** — plus a **trust** select when editing — via `POST /memories` / `PUT /memories/:id`. |
| **Roles & instructions** (`#/roles`) | Auditor for `type: "role"` **and** `type: "instruction"` with an instructions-first warning banner — review standing guidance like system prompts, and approve digest-extracted ones from their detail pages. |
| **Graph** (`#/graph`) | Force-directed canvas of typed relation edges (repulsion + springs, up to 500 nodes): **drag** to re-arrange, **click** a node to open it, legend of the types actually present, role/instruction nodes gold-ringed. |
| **Digest** (`#/digest`) | Paste a transcript, set scope/source, run the LLM extraction (`POST /memories/digest`); result shows extracted/stored/skipped/merged with links to the new memories. Errors hint at the `REMEMBRA_LLM` setup when no provider is configured. |
| **Ops** (`#/ops`) | Health card (status/version/uptime/storage/cache), six stat tiles — requests, errors, **p95 latency** (computed client-side from the Prometheus histogram buckets), searches, stores, cache hit % — with 5-minute sparklines, plus **Run maintain**, **Export** (downloads the snapshot JSON), and **Import** (file picker → `POST /import`). |

The header has the `+ New` button, the **API-key button** (🔑), and the
**theme toggle** (◐). The sidebar footer polls `/health` every 15 s
(`v…` / `degraded` / `offline`).

## Theming

- **Dark by default**, gold (`#d4af37`) accent on near-black — active nav,
  primary buttons (dark text on gold), focus rings, sparklines, brand mark.
- **Light mode** via the header toggle; the choice persists in
  `localStorage` (`remembra.theme`). The first paint follows
  `data-theme="dark"` in the HTML, so there is no flash of the wrong theme.
- Everything is **CSS custom properties** (`--bg`, `--surface`, `--gold`, …)
  swapped under `:root[data-theme="light"]` — system font stack, no web
  fonts, responsive down to mobile (sidebar goes off-canvas),
  `prefers-reduced-motion` respected.

## Authentication

Same trust split as the API ([security.md](security.md#web-dashboard-400)):

- The **shell and assets are unauthenticated** (like `/health`) — they are
  static bytes from your install and contain **no memory data**.
- **Every data call carries the key.** The page prompts for it when a request
  returns `401` (or via the 🔑 button) and keeps it in **`sessionStorage`** —
  per-tab, gone when the tab closes, never persisted to disk.
- An unkeyed (loopback-only) server needs no key: the prompt never appears.

## Security properties

| | |
|---|---|
| **CSP** | HTML responses ship `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; … frame-ancestors 'none'` — no inline script/style exists in the shell at all, so injected markup cannot execute, and the page can only fetch your own server. |
| **Static whitelist** | Only `.html`/`.css`/`.js`/`.map` extensions are served, from a single root (`dist/ui/`); anything else 404s before touching the FS. |
| **Path containment** | The decoded path is resolved and must sit strictly inside the UI root — traversal attempts (`..`, `%2e%2e`, `%2f` tricks, absolute paths, NUL) all land on a generic `404`, verified by the pen tests in `src/test/ui.test.ts`. |
| **Headers** | `X-Content-Type-Options: nosniff` on everything, correct MIME types, `cache-control: no-cache`. |
| **Off switch** | `REMEMBRA_UI=0` → `/` and `/ui/*` stop serving entirely (pure API server). |
| **Metrics** | UI requests are counted under the low-cardinality route label `ui` (`data_io` for `/snapshot`,`/import`). |

## Architecture & build

- **Hand-written TypeScript compiled by the existing `tsc`** (`module:
  Node16`, DOM libs) → native ES modules in `dist/ui/` — one module graph,
  no bundler, no framework, no runtime dependencies beyond the two the server
  already has.
- `src/ui/index.html` + `src/ui/styles.css` are copied to `dist/ui/` by
  `scripts/copy-ui.mjs`, so the build is `tsc && node scripts/copy-ui.mjs`
  (`npm run build`).
- Served files: `GET /` → `index.html`; `GET /ui/<path>` → assets
  (`app.js`, `dom.js`, `api.js`, `pages/*.js`, `styles.css`).
- Rendering builds DOM nodes exclusively — user content always lands in
  `textContent`, never `innerHTML` (memory content is data, not markup).
- Page lifecycle: hash router in `app.ts`; long-lived pages (Ops polling,
  Graph animation loop) register a cleanup callback the router runs on every
  navigation, so no interval or `requestAnimationFrame` outlives its page.

## Development

```bash
npm run build   # tsc + copy HTML/CSS into dist/ui
npm test        # includes the static-route pen test + auth-boundary tests
node dist/index.js --http   # then open http://127.0.0.1:8787/
```

Source layout:

```
src/ui/
├── index.html      # shell: nav, header, SVG sprite, no inline script/style
├── styles.css      # design tokens + components (dark default, light override)
├── app.ts          # router, theme, key prompt, health poll, shell wiring
├── api.ts          # typed fetch client (key in sessionStorage)
├── dom.ts          # h()/icon()/toast()/confirmModal() helpers
└── pages/          # list, detail, edit, roles, graph, digest, ops
```
