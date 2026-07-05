# Manual test plan — thrift-ledger-worker

Node/npm were unavailable in the authoring environment, so `wrangler dev` could not
be run there. Run this once the toolchain is present. All commands assume the worker
is running locally on the default `wrangler dev` port (usually `http://localhost:8787`).

## Setup

```sh
cd worker
npm install
cp .dev.vars.example .dev.vars     # APP_TOKEN="local-dev-token", TEST_MODE="1"
npx wrangler dev
```

With `TEST_MODE=1` the processor returns a canned draft ~2 s after job creation —
no Anthropic key needed and no network cost. Set a real `ANTHROPIC_API_KEY` and
remove `TEST_MODE` to exercise the real path.

Base URL below: `http://localhost:8787`. Token: `local-dev-token`.

---

## 1. CORS preflight (no auth required)

```sh
curl -i -X OPTIONS http://localhost:8787/jobs \
  -H "Origin: https://spencertrabbold.github.io" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type, authorization"
```
**Expect:** `204`, and headers:
- `Access-Control-Allow-Origin: https://spencertrabbold.github.io`
- `Access-Control-Allow-Methods: POST, GET, DELETE, OPTIONS`
- `Access-Control-Allow-Headers: content-type, authorization`

Repeat with `-H "Origin: http://localhost:4517"` → same allow-origin echoed back.
Repeat with `-H "Origin: https://evil.example"` → **no** `Access-Control-Allow-Origin`
header (origin not echoed).

## 2. Auth 401

```sh
curl -i -X POST http://localhost:8787/jobs \
  -H "content-type: application/json" \
  -d '{"payload":{"brand":"Nike"}}'
```
**Expect:** `401 {"error":"unauthorized"}` (no/blank token).

```sh
curl -i -X POST http://localhost:8787/jobs \
  -H "authorization: Bearer wrong-token" \
  -H "content-type: application/json" \
  -d '{"payload":{"brand":"Nike"}}'
```
**Expect:** `401`.

## 3. POST → GET happy path (TEST_MODE)

```sh
# create
curl -s -X POST http://localhost:8787/jobs \
  -H "authorization: Bearer local-dev-token" \
  -H "content-type: application/json" \
  -d '{"payload":{"brand":"Patagonia","category":"fleece jacket","size":"M","condition":"Excellent","costPaid":8,"hasPhoto":true}}'
```
**Expect:** `{"id":"<uuid>","status":"pending"}`.

```sh
# immediately after: still pending
curl -s -H "authorization: Bearer local-dev-token" \
  "http://localhost:8787/jobs?ids=<uuid>"
```
**Expect:** `{"jobs":[{"id":"<uuid>","status":"pending","createdAt":"..."}]}`.

Wait ~3 s, poll again:
```sh
curl -s -H "authorization: Bearer local-dev-token" \
  "http://localhost:8787/jobs?ids=<uuid>"
```
**Expect:** `status:"done"`, a `draft` with `title`, `description`,
`suggestedPrice`, and all four `platforms.{poshmark,ebay,mercari,depop}` strings,
plus `finishedAt` and `meta.testMode:true`.

## 4. Unknown ids

```sh
curl -s -H "authorization: Bearer local-dev-token" \
  "http://localhost:8787/jobs?ids=not-a-real-id,<uuid>"
```
**Expect:** the bogus id → `{"id":"not-a-real-id","status":"unknown"}`; the real one
returns its record.

## 5. DELETE

```sh
curl -s -X DELETE -H "authorization: Bearer local-dev-token" \
  "http://localhost:8787/jobs?ids=<uuid>"
```
**Expect:** `{"deleted":["<uuid>"]}`. A subsequent GET for that id → `status:"unknown"`.

## 6. Real Anthropic path (optional, costs money)

Set a real `ANTHROPIC_API_KEY` in `.dev.vars` and **remove** `TEST_MODE`. Repeat
step 3. The job stays `pending` for 1–3 min while web-search research runs, then
flips to `done` with a real draft (or `failed` with a message on refusal/timeout).
`meta.continuations` reflects any pause_turn loops; `meta.elapsedMs` the wall time.

## 7. Method/route negatives

- `curl -i http://localhost:8787/other -H "authorization: Bearer local-dev-token"`
  → `404 {"error":"not found"}`.
- `curl -i -X PUT http://localhost:8787/jobs -H "authorization: Bearer local-dev-token"`
  → `405`.
- `POST /jobs` with a body missing `payload` → `400 {"error":"missing payload"}`.

---

## Static-review checklist (compensating for no local run)

- [x] Auth: constant-time-ish compare, length-guarded; empty `APP_TOKEN` denies all.
- [x] CORS: allowed origins echoed only when matched; preflight answered pre-auth;
      `Vary: Origin` set.
- [x] DO migration uses `new_sqlite_classes` (free-plan requirement).
- [x] Alarm scheduled 1 ms out on create; `alarm()` catches all errors → persists
      `failed` (avoids paid-call auto-retry storms).
- [x] Anthropic body byte-for-byte matches index.html (model, max_tokens, tools,
      output_config.effort+format, schema, prompt); no direct-browser header.
- [x] pause_turn loop ≤3 continuations; max_tokens/refusal → failed; 529/5xx/network
      retried twice (10s/30s) within the ~8 min budget.
- [x] Parse prefers terminal last-text-block, falls back to accumulated brace-scan;
      validation mirrors `draftLooksBroken` (price 0<p<=500, title<120, platforms>=25).
- [x] 7-day lazy expiry on GET; DELETE purges via `deleteAll()`.
- [x] `.dev.vars` gitignored; no secret values committed.
