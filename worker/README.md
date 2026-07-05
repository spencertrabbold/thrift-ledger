# Thrift Ledger Worker (SPE-25)

A Cloudflare Worker that runs Thrift Ledger's AI listing-generation jobs
**detached from the phone**. The app (an installed iOS home-screen web app) used to
call the Anthropic API directly from the browser, but iOS freezes a backgrounded
page and kills the in-flight fetch — so the 1–3 minute web-search research died
whenever the user switched apps. This worker accepts a job, runs the full research
server-side regardless of the phone's state, and stores the result for pickup.

---

## Architecture decision — Durable Object + alarm (SQLite-backed)

**Chosen primitive: a SQLite-backed Durable Object whose `alarm()` handler runs the
long Anthropic call.** Considered alternatives in the required order:

### 1. Cloudflare Workflows — viable but a worse fit here
- Available on the **Free plan** (docs: Workflows overview — "Available on Free and
  Paid plans").
- Free-plan limits (docs:
  <https://developers.cloudflare.com/workflows/reference/limits/>): **CPU time per
  step = 10 ms**, wall-clock per step = *unlimited*, max 1,024 steps, `step.sleep`
  up to 365 days, **completed-instance retention = 3 days**, 100 concurrent
  instances. A long `fetch` inside a step is fine (only CPU counts against the
  10 ms), so the multi-minute Anthropic call itself is not the problem.
- Why not chosen: Workflow state is **not a queryable job store** — you still need
  KV or a DO to answer `GET /jobs?ids=...`, and Workflows add a second moving part
  (instance lifecycle, per-step result-size limits, replay semantics on retry that
  can re-invoke non-idempotent steps). For a single detached call + a polled result,
  a DO does both jobs (run + store) with less surface area.

### 2. Durable Object + alarm — chosen
- **Free-plan availability:** SQLite-backed Durable Objects are available on the
  Workers **Free** plan; **only the SQLite storage backend** is available there
  (docs: <https://developers.cloudflare.com/durable-objects/platform/limits/> and the
  DO overview). The `wrangler` migration therefore uses `new_sqlite_classes` (not
  `new_classes`).
- **Alarm handler is exactly the right execution context for a detached job**
  (docs: <https://developers.cloudflare.com/durable-objects/api/alarms/>): alarms
  "provide a mechanism to guarantee that operations within a Durable Object will
  complete **without relying on incoming requests to keep the Durable Object
  alive**." So the long call survives after the originating HTTP request returns.
- **Duration limits are sufficient** (docs:
  <https://developers.cloudflare.com/durable-objects/platform/limits/>):
  - Alarm handler **wall-clock limit = 15 minutes**.
  - CPU time = **30 s** default (resets per request/alarm). Crucially, **wall time
    includes network I/O and waiting; CPU time measures active processing only** —
    so awaiting a 1–5 minute streaming `fetch` to Anthropic does **not** burn CPU
    time and is safe. We self-cap each job at **~8 min** wall-clock, well under 15.
- **Storage: DO storage (not KV).** DO storage gives **read-your-writes** — a
  `GET /jobs` immediately after the alarm writes "done" sees the result with no
  eventual-consistency window. KV on the free tier would work for this polling
  pattern (its ~60 s eventual-consistency is acceptable), but DO storage avoids the
  window entirely and keeps job data co-located with the object that produced it.
  We key each DO **by the job id** (`idFromName(id)`), so each job is an isolated
  object holding its own `record` + `payload` rows.

### Why not `ctx.waitUntil` alone
`ctx.waitUntil` extends the lifetime of the **triggering request's** context, but
that lifetime is far too short for a multi-minute Anthropic call — the runtime can
evict the invocation once the response has been returned, and the extension is not a
15-minute budget. The DO **alarm** is the documented primitive for work that must
"complete without relying on incoming requests to keep the Durable Object alive"
(alarms docs, above). We schedule the alarm 1 ms out on job creation and return the
job id immediately; the alarm then owns the long call.

### Alarm auto-retry note
Alarm handlers have **guaranteed at-least-once execution and are auto-retried on an
uncaught exception** (exponential backoff, up to 6 retries — alarms docs). To avoid
6 pointless re-runs of a *paid* Anthropic call on a genuine failure (e.g. the model
refuses), the `alarm()` handler **catches all errors and persists a `failed`
record** instead of throwing. Retries therefore only ever fire on truly unexpected
infra errors, which is the desired safety net.

---

## Endpoints

Base URL after deploy: **`https://thrift-ledger-worker.<account-subdomain>.workers.dev`**
(the `<account-subdomain>` is shown by `wrangler deploy` and in the dashboard).

All endpoints are JSON and require
`Authorization: Bearer <APP_TOKEN>` (checked against the `APP_TOKEN` secret with a
constant-time-ish compare). Missing/wrong token → **401**.

CORS: allowed origins are exactly `https://spencertrabbold.github.io` and
`http://localhost:4517`; methods `POST, GET, DELETE, OPTIONS`; headers
`content-type, authorization`. Preflight (`OPTIONS`) is answered before auth.

### `POST /jobs`
Create a job and kick off detached processing.

Request body:
```json
{ "payload": { "brand": "...", "category": "...", "size": "...",
               "condition": "Good", "costPaid": 8, "hasPhoto": true } }
```
`condition` is one of `NWT | Excellent | Good | Fair` (falls back to the raw string).
`hasPhoto` maps to index.html's `payload.photo` truthiness — when true, the prompt
gets the "a photo is available" line, identical to the app.

Response (immediate): `202`
```json
{ "id": "d6f8...uuid", "status": "pending" }
```

### `GET /jobs?ids=id1,id2,...`
Poll one or more jobs.
```json
{ "jobs": [
  { "id": "...", "status": "pending", "createdAt": "2026-07-05T..." },
  { "id": "...", "status": "done", "draft": { "title": "...", "description": "...",
      "suggestedPrice": 24.99, "platforms": { "poshmark": "...", "ebay": "...",
      "mercari": "...", "depop": "..." } },
    "createdAt": "...", "finishedAt": "...",
    "meta": { "stopReason": "end_turn", "continuations": 1, "elapsedMs": 92000 } },
  { "id": "...", "status": "failed", "error": "The AI declined ...", "createdAt": "...",
    "finishedAt": "...", "meta": { "elapsedMs": 4000 } },
  { "id": "unknown-id", "status": "unknown" }
] }
```
Statuses: `pending | done | failed | unknown`. Unknown ids (never created, deleted,
or expired) → `status: "unknown"`.

### `DELETE /jobs?ids=id1,id2,...`
Cleanup after the app has consumed results.
```json
{ "deleted": ["id1", "id2"] }
```
Jobs also **auto-expire lazily**: any job older than 7 days is purged the next time
it is read (`GET`).

---

## Job processing — replicates the app's Anthropic contract exactly

- `POST https://api.anthropic.com/v1/messages`
- Headers: `x-api-key` (from `ANTHROPIC_API_KEY` secret), `anthropic-version: 2023-06-01`,
  `content-type: application/json`. **No** `anthropic-dangerous-direct-browser-access`
  (server-side now).
- Body: model `claude-opus-4-8`, `max_tokens: 8000`,
  `tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }]`,
  `output_config: { effort: "medium", format: { type: "json_schema", schema: <listing schema> } }`,
  and the expert-reseller prompt (web-search comparable pricing across
  Poshmark/eBay/Mercari/Depop; platform-native texts; real characters only; titles
  <80 chars; JSON-only output). The schema and prompt are copied verbatim from
  index.html's `LISTING_OUTPUT_CONFIG` and `buildPrompt(payload, /*useWebSearch*/ true)`.
- **pause_turn:** continue up to 3 times, appending the assistant content each time.
- **max_tokens / refusal** stop_reasons → job `failed` with a clear message.
- **529 / 5xx / network:** retry twice with 10 s then 30 s backoff (inside the
  per-job budget). 4xx (401/429/400) is terminal.
- **Parse:** when structured outputs are in effect and the terminal response ended
  `end_turn`, the JSON is the **last text block** of the terminal response —
  parsed directly; otherwise fall back to a brace-scan over all accumulated blocks.
- **Validate:** title non-empty, title <120 chars, each platform text ≥25 chars,
  `0 < suggestedPrice ≤ 500`, plus the garbage-title heuristics from index.html. On
  parse/validation failure the **whole generation retries once**, then `failed`.
- **Per-job budget ≈ 8 min** wall-clock (checked before each continuation / retry /
  backoff).
- **Stored result:** `{ status, draft | error, createdAt, finishedAt,
  meta: { stopReason, continuations, elapsedMs } }` in DO storage.

---

## Secrets & bindings

Declared in `wrangler.jsonc`:
- Durable Object binding `JOB_RUNNER` → class `JobRunner` (migration `v1`,
  `new_sqlite_classes`).

**Secrets (values NEVER committed anywhere):**
- `ANTHROPIC_API_KEY` — the Anthropic API key.
- `APP_TOKEN` — the bearer token the app must send.

Set them **either** via CLI:
```sh
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put APP_TOKEN
```
**or** via the dashboard:
**Workers & Pages → thrift-ledger-worker → Settings → Variables and Secrets → Add**
(add each as an **encrypted** secret variable), then **Deploy**.

`TEST_MODE` is a plain var, not a secret. Leave it **unset in production**; when set
to `"1"` (local `.dev.vars` only) the processor returns a canned draft after ~2 s
instead of calling Anthropic.

---

## Local development & testing

> **Note:** Node/npm were not available in the build environment where this worker
> was authored, so `wrangler dev` could not be executed here. See `test.md` for the
> full manual test plan to run once the toolchain is present. The worker is plain
> ESM JavaScript with **no build step**, so it runs directly under `wrangler dev`
> and `wrangler deploy`.

```sh
cd worker
npm install
cp .dev.vars.example .dev.vars   # edit values; TEST_MODE=1 for a canned draft
npx wrangler dev
```
Then exercise the endpoints (examples in `test.md`): POST → GET happy path (with
`TEST_MODE=1`), 401 auth, CORS preflight, unknown ids, DELETE.

---

## Deploy (commands for the orchestrator)

```sh
cd worker
npm install                       # installs wrangler locally
npx wrangler login                # one-time browser auth
npx wrangler deploy               # deploys the Worker + creates the DO migration v1

# secrets (or set them in the dashboard as above):
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put APP_TOKEN
```

After deploy, `wrangler` prints the URL
`https://thrift-ledger-worker.<account-subdomain>.workers.dev`. Configure the app to
POST jobs there with the `APP_TOKEN` bearer. Ensure **`TEST_MODE` is not set** in
production (Settings → Variables and Secrets).
