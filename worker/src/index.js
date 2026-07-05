/* ===========================================================================
 * Thrift Ledger Worker — SPE-25
 * ---------------------------------------------------------------------------
 * Accepts AI listing-generation jobs, runs the full web-search research
 * server-side (detached from the phone), and persists the result for pickup.
 *
 * ARCHITECTURE (see README.md for the doc-verified decision):
 *   - The top-level Worker is a thin HTTP front door: auth + CORS + routing.
 *   - Each job is owned by a SQLite-backed Durable Object (JobRunner), keyed by
 *     the job id. On POST /jobs the front door creates the job row and schedules
 *     an immediate DO alarm; the alarm handler runs the long Anthropic call.
 *   - DO alarm handlers get up to 15 min of WALL-CLOCK time and only ~30s of
 *     *active CPU* — awaiting a long streaming fetch does NOT burn CPU time, so a
 *     1–5 min Anthropic call is safe. (ctx.waitUntil is NOT used for the long job;
 *     its lifetime cap is far too short for a multi-minute call.)
 *   - DO storage gives read-your-writes, so GET /jobs sees a freshly-written
 *     result with no eventual-consistency window.
 * ===========================================================================*/

const ALLOWED_ORIGINS = new Set([
  "https://spencertrabbold.github.io",
  "http://localhost:4517",
]);

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/* ------------------------------- CORS --------------------------------- */

function corsHeaders(origin) {
  const h = {
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
  }
  return h;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

/* --------------------------- constant-time auth ------------------------ */

// Constant-time-ish compare so a token guess can't be timed. Compares length
// first (unavoidable early-out) then XORs every byte.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function isAuthed(request, env) {
  const header = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const token = m[1];
  const expected = env.APP_TOKEN || "";
  if (!expected) return false; // no token configured => deny everything
  return timingSafeEqual(token, expected);
}

/* ------------------------------ routing -------------------------------- */

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("origin") || "";
    const url = new URL(request.url);

    // CORS preflight — answer before auth (browsers strip Authorization on OPTIONS).
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname !== "/jobs") {
      return json({ error: "not found" }, 404, origin);
    }

    if (!isAuthed(request, env)) {
      return json({ error: "unauthorized" }, 401, origin);
    }

    try {
      if (request.method === "POST") return await handlePost(request, env, origin);
      if (request.method === "GET") return await handleGet(request, env, origin);
      if (request.method === "DELETE") return await handleDelete(request, env, origin);
    } catch (err) {
      return json({ error: "server error", detail: String(err && err.message || err) }, 500, origin);
    }

    return json({ error: "method not allowed" }, 405, origin);
  },
};

/* Resolve the Durable Object stub for a given job id. We key the DO *by the job
 * id string* so every request for that job lands on the same object. */
function runnerFor(env, id) {
  const doId = env.JOB_RUNNER.idFromName(id);
  return env.JOB_RUNNER.get(doId);
}

async function handlePost(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400, origin);
  }
  const payload = body && body.payload;
  if (!payload || typeof payload !== "object") {
    return json({ error: "missing payload" }, 400, origin);
  }

  const id = crypto.randomUUID();
  const stub = runnerFor(env, id);
  // Forward to the DO to create the row + schedule the alarm. The DO returns the
  // initial status record immediately; the heavy work happens later in alarm().
  const res = await stub.fetch("https://do/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, payload }),
  });
  const rec = await res.json();
  return json(rec, res.status, origin);
}

async function handleGet(request, env, origin) {
  const idsParam = new URL(request.url).searchParams.get("ids") || "";
  const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return json({ jobs: [] }, 200, origin);

  const jobs = await Promise.all(
    ids.map(async (id) => {
      try {
        const stub = runnerFor(env, id);
        const res = await stub.fetch("https://do/get");
        if (res.status === 404) return { id, status: "unknown" };
        const rec = await res.json();
        return rec;
      } catch {
        return { id, status: "unknown" };
      }
    })
  );
  return json({ jobs }, 200, origin);
}

async function handleDelete(request, env, origin) {
  const idsParam = new URL(request.url).searchParams.get("ids") || "";
  const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
  const deleted = [];
  await Promise.all(
    ids.map(async (id) => {
      try {
        const stub = runnerFor(env, id);
        await stub.fetch("https://do/delete", { method: "DELETE" });
        deleted.push(id);
      } catch {
        /* ignore individual failures */
      }
    })
  );
  return json({ deleted }, 200, origin);
}

/* ===========================================================================
 * JobRunner Durable Object
 * ===========================================================================*/

export class JobRunner {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storage = state.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/create") return this.create(request);
    if (url.pathname === "/get") return this.getRecord();
    if (url.pathname === "/delete") return this.remove();
    return new Response("not found", { status: 404 });
  }

  async create(request) {
    const { id, payload } = await request.json();
    const now = Date.now();
    const record = {
      id,
      status: "pending",
      createdAt: new Date(now).toISOString(),
    };
    await this.storage.put("record", record);
    await this.storage.put("payload", payload);
    // Kick off detached processing ASAP. The alarm handler owns the long call —
    // it survives well beyond the originating HTTP request's lifetime.
    await this.storage.setAlarm(now + 1);
    return new Response(
      JSON.stringify({ id, status: "pending" }),
      { status: 202, headers: { "content-type": "application/json" } }
    );
  }

  async getRecord() {
    const record = await this.storage.get("record");
    if (!record) return new Response("not found", { status: 404 });
    // Lazy auto-expire: purge jobs older than 7 days on read.
    if (isExpired(record)) {
      await this.storage.deleteAll();
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(publicView(record)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async remove() {
    await this.storage.deleteAll();
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // The detached worker. Wall-clock budget up to 15 min (alarm limit); we cap the
  // job at ~8 min ourselves. Awaiting the Anthropic fetch does not burn CPU time.
  async alarm() {
    const record = await this.storage.get("record");
    const payload = await this.storage.get("payload");
    if (!record || record.status !== "pending" || !payload) return;

    const startedAt = Date.now();
    try {
      const { draft, meta } = await runJob(payload, this.env, startedAt);
      const done = {
        ...record,
        status: "done",
        draft,
        finishedAt: new Date().toISOString(),
        meta,
      };
      await this.storage.put("record", done);
    } catch (err) {
      const failed = {
        ...record,
        status: "failed",
        error: (err && err.message) ? String(err.message) : "Generation failed.",
        finishedAt: new Date().toISOString(),
        meta: (err && err.meta) || { elapsedMs: Date.now() - startedAt },
      };
      await this.storage.put("record", failed);
    }
  }
}

function isExpired(record) {
  const created = Date.parse(record.createdAt || "");
  if (isNaN(created)) return false;
  return Date.now() - created > SEVEN_DAYS_MS;
}

// Shape returned to the app: never leak the raw stored payload.
function publicView(record) {
  const out = {
    id: record.id,
    status: record.status,
    createdAt: record.createdAt,
  };
  if (record.finishedAt) out.finishedAt = record.finishedAt;
  if (record.status === "done") out.draft = record.draft;
  if (record.status === "failed") out.error = record.error;
  if (record.meta) out.meta = record.meta;
  return out;
}

/* ===========================================================================
 * Job processing — replicates index.html's Anthropic contract EXACTLY.
 * ===========================================================================*/

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MODEL = "claude-opus-4-8";
const API_EFFORT = "medium";
const API_MAX_CONTINUATIONS = 3; // pause_turn continuations
const PER_JOB_BUDGET_MS = 8 * 60 * 1000; // ~8 min overall per-job budget
const UPSTREAM_MAX_RETRIES = 2; // 529/5xx/network: retry twice
const BACKOFFS_MS = [10000, 30000]; // 10s, then 30s

const PLATFORMS = ["poshmark", "ebay", "mercari", "depop"];
const CONDITION_LABELS = {
  NWT: "New With Tags",
  Excellent: "Excellent",
  Good: "Good",
  Fair: "Fair",
};

// JSON schema — mirrors LISTING_OUTPUT_CONFIG.format in index.html EXACTLY.
// No numeric/length constraints (unsupported by structured outputs; would 400).
const LISTING_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      suggestedPrice: { type: "number" },
      platforms: {
        type: "object",
        properties: {
          poshmark: { type: "string" },
          ebay: { type: "string" },
          mercari: { type: "string" },
          depop: { type: "string" },
        },
        required: ["poshmark", "ebay", "mercari", "depop"],
        additionalProperties: false,
      },
    },
    required: ["title", "description", "suggestedPrice", "platforms"],
    additionalProperties: false,
  },
};

function itemDescriptor(payload) {
  const parts = [];
  if (payload.brand) parts.push("Brand: " + payload.brand);
  if (payload.category) parts.push("Category/type: " + payload.category);
  if (payload.size) parts.push("Size: " + payload.size);
  if (payload.condition)
    parts.push("Condition: " + (CONDITION_LABELS[payload.condition] || payload.condition));
  parts.push("Seller paid: $" + (Number(payload.costPaid) || 0).toFixed(2) + " to acquire it");
  // The app sends `hasPhoto` (boolean); index.html's buildPrompt checks `payload.photo`.
  // Emit the identical line whenever a photo exists.
  if (payload.hasPhoto || payload.photo)
    parts.push("A photo of the item is available to the seller (the item is pictured).");
  return parts.join("\n");
}

// The web-search variant of the prompt (server-side always uses web search).
function buildPrompt(payload) {
  const priceTask =
    "1. Use web search to research current sold/asking prices for comparable items on\n" +
    "   Poshmark, eBay, Mercari, and Depop before setting suggestedPrice. Pick a single\n" +
    "   suggested list price that is competitive but not underpriced.";
  return [
    "You are an expert secondhand-clothing reseller writing marketplace listings.",
    "",
    "ITEM DETAILS:",
    itemDescriptor(payload),
    "",
    "TASK:",
    priceTask,
    "2. Write a compelling title and description.",
    "3. Write four platform-specific listing texts, each tuned to that platform's culture:",
    "   - poshmark: chatty and friendly, include relevant #hashtags, put the size in the title-like opener.",
    "   - ebay: keyword-stuffed, searchable, include item specifics (brand, size, type, condition, color/material if inferable).",
    "   - mercari: concise and to the point.",
    "   - depop: lowercase, casual, trend-aware, include #hashtags.",
    "",
    "OUTPUT RULES (STRICT):",
    "- Write all text using actual characters — real emoji (😊 not unicode escape codes), real punctuation.",
    "- Never write escape sequences like \\u, \\t, \\n as visible text. No tabs. No markdown.",
    "- Titles must be plain product titles under 80 characters — never explanations, notes,",
    "  or fragments of your research.",
    "",
    "RESPOND WITH ONLY a single JSON object, no prose, no markdown fences, matching EXACTLY:",
    "{",
    '  "title": string,',
    '  "description": string,',
    '  "suggestedPrice": number,',
    '  "platforms": { "poshmark": string, "ebay": string, "mercari": string, "depop": string }',
    "}",
  ].join("\n");
}

function buildApiBody(messages) {
  return {
    model: ANTHROPIC_MODEL,
    max_tokens: 8000,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }],
    output_config: { effort: API_EFFORT, format: LISTING_FORMAT },
    messages,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One POST to /v1/messages. Retries 529/5xx/network twice with 10s/30s backoff
// (staying inside the per-job budget). Throws a friendly Error on terminal
// failure. NO anthropic-dangerous-direct-browser-access header (server-side).
async function apiRequest(env, body, startedAt) {
  let lastErr = null;
  for (let attempt = 0; attempt <= UPSTREAM_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = BACKOFFS_MS[attempt - 1] || 30000;
      if (Date.now() - startedAt + backoff > PER_JOB_BUDGET_MS) {
        throw fail("The AI took too long researching prices. Try again.");
      }
      await sleep(backoff);
    }
    let res;
    try {
      res = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY || "",
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = fail("Couldn't reach Anthropic — try again.");
      continue; // network error: retry
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw fail("The AI returned an unreadable response. Try again.");
      }
    }
    // Non-OK. Read body so a caller could inspect a 400 (we don't do the
    // format/effort fallback dance here — server-side we control the request and
    // always send a valid body).
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {}
    if (res.status === 529 || (res.status >= 500 && res.status < 600)) {
      lastErr = fail("Anthropic is busy — try again.");
      continue; // retry 5xx/529
    }
    // 4xx (auth, rate limit, bad request): terminal.
    throw fail(apiErrorMessage(res.status), { apiStatus: res.status, apiBody: bodyText.slice(0, 500) });
  }
  throw lastErr || fail("The AI request failed. Try again.");
}

function apiErrorMessage(status) {
  if (status === 401) return "API key looks invalid.";
  if (status === 429) return "Rate limited — wait a minute and retry.";
  if (status === 529 || (status >= 500 && status < 600)) return "Anthropic is busy — try again.";
  return "The AI request failed (HTTP " + status + "). Try again.";
}

function fail(message, extra) {
  const err = new Error(message);
  if (extra) Object.assign(err, extra);
  return err;
}

// Run the pause_turn continuation loop. Returns { terminal, accumulated,
// continuations }. Throws on terminal error stop_reasons (max_tokens/refusal).
async function runApiLoop(env, messages, startedAt) {
  const accumulated = [];
  let response = null;
  let continuations = 0;

  for (let attempt = 0; attempt <= API_MAX_CONTINUATIONS; attempt++) {
    if (Date.now() - startedAt >= PER_JOB_BUDGET_MS) {
      throw fail("The AI took too long researching prices. Try again.");
    }
    response = await apiRequest(env, buildApiBody(messages), startedAt);

    if (response && Array.isArray(response.content)) {
      for (const b of response.content) accumulated.push(b);
    }

    const stop = response && response.stop_reason;
    if (stop === "pause_turn") {
      if (attempt >= API_MAX_CONTINUATIONS) {
        throw fail("The AI took too long researching prices. Try again.");
      }
      messages.push({ role: "assistant", content: response.content });
      continuations++;
      continue;
    }
    if (stop === "max_tokens") throw fail("The AI response was cut off. Try again.");
    if (stop === "refusal") throw fail("The AI declined to generate this listing.");
    break; // end_turn or other terminal
  }

  if (!response || !Array.isArray(response.content)) {
    throw fail("The AI returned no listing. Try again.");
  }
  return { terminal: response, accumulated, continuations };
}

/* ------------------------ parsing (mirrors index.html) ------------------ */

function looksLikeListing(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  return "title" in obj || "suggestedPrice" in obj || (obj.platforms && typeof obj.platforms === "object");
}

// Collect every TOP-LEVEL parseable {...} and prefer the last listing-shaped one.
function extractLastJsonObject(s) {
  let bestListing = null;
  let bestAny = null;
  let scanFrom = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{" || i < scanFrom) continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = s.slice(i, j + 1);
          try {
            const obj = JSON.parse(candidate);
            if (obj && typeof obj === "object" && !Array.isArray(obj)) {
              bestAny = obj;
              if (looksLikeListing(obj)) bestListing = obj;
              scanFrom = j + 1;
            }
          } catch {}
          break;
        }
      }
    }
  }
  return bestListing || bestAny;
}

function parseResponse(input) {
  let text;
  if (Array.isArray(input)) {
    text = input
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  } else {
    text = input;
  }
  if (typeof text !== "string" || !text.trim()) throw fail("Empty response from AI.");
  let s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let obj = extractLastJsonObject(s);
  if (!obj) {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw fail("AI response wasn't JSON.");
    try {
      obj = JSON.parse(s.slice(start, end + 1));
    } catch {
      throw fail("Couldn't parse the AI's JSON.");
    }
  }
  if (!obj || typeof obj !== "object") throw fail("AI returned no listing.");
  if (!obj.platforms || typeof obj.platforms !== "object") obj.platforms = {};
  return obj;
}

function lastTextBlock(response) {
  if (!response || !Array.isArray(response.content)) return null;
  for (let i = response.content.length - 1; i >= 0; i--) {
    const b = response.content[i];
    if (b && b.type === "text" && typeof b.text === "string") return b.text;
  }
  return null;
}

/* ------------------------ validation (mirrors index.html) --------------- */

// Sanity gate: title non-empty AND price 0<p<=500 AND title <120 chars, plus a
// basic per-platform length floor. Mirrors draftLooksBroken() in index.html.
function draftLooksBroken(draft) {
  if (!draft || typeof draft !== "object") return true;
  const title = typeof draft.title === "string" ? draft.title : "";
  const desc = typeof draft.description === "string" ? draft.description : "";
  if (title.trim() === "") return true;
  if (title.length > 120) return true;
  const GARBAGE = ["<", "code_execution", "$ range", "Poshmark, and eBay", "http", "search result"];
  for (const g of GARBAGE) if (title.indexOf(g) !== -1) return true;
  if (desc.trim().length < 20 && title.trim().length < 8) return true;
  const plats = draft.platforms || {};
  for (const p of PLATFORMS) {
    const v = plats[p];
    if (typeof v !== "string" || v.trim().length < 25) return true;
  }
  const price = Number(draft.suggestedPrice);
  if (isNaN(price) || price <= 0 || price > 500) return true;
  return false;
}

/* ------------------------------- driver -------------------------------- */

// TEST_MODE canned draft — used when env.TEST_MODE === "1" so wrangler dev can
// exercise POST->GET without calling Anthropic. MUST be unset in production.
function mockDraft(payload) {
  const brand = payload.brand || "Unbranded";
  const cat = payload.category || "item";
  const size = payload.size || "OS";
  const condLabel = CONDITION_LABELS[payload.condition] || payload.condition || "Good";
  const cost = Number(payload.costPaid) || 0;
  const price = Math.max(12, Math.round(cost * 3)) - 0.01;
  return {
    title: brand + " " + cat + " Size " + size + " " + condLabel,
    description:
      "[TEST DRAFT] " + condLabel + " " + brand + " " + cat + " in size " + size +
      ". Great secondhand find, pictured as-is. Smoke-free. Bundle to save on shipping!",
    suggestedPrice: price,
    platforms: {
      poshmark: "Size " + size + " " + brand + " " + cat + "! Super cute, bundle & save! #" + brand.toLowerCase().replace(/\W+/g, "") + " #poshmark #thrifted",
      ebay: brand + " " + cat + " Size " + size + " " + condLabel + " condition, fast shipping, brand new listing item specifics included",
      mercari: brand + " " + cat + ", size " + size + ", " + condLabel + " condition. Ships next day, no returns.",
      depop: "test " + brand.toLowerCase() + " " + cat.toLowerCase() + " size " + size.toLowerCase() + " dm for bundles #vintage #y2k #thrifted",
    },
  };
}

// Run one full generation attempt (loop + parse + validate). Returns a draft or
// throws. `meta` is attached to the thrown error / returned object by the caller.
async function generateOnce(payload, env, startedAt) {
  const messages = [{ role: "user", content: buildPrompt(payload) }];
  const { terminal, accumulated, continuations } = await runApiLoop(env, messages, startedAt);

  // Precise parse: structured outputs always ride along, so when the terminal
  // response ended cleanly the schema-constrained JSON is the LAST text block.
  let draft = null;
  let extractionPath = null;
  if (terminal && terminal.stop_reason === "end_turn") {
    const finalText = lastTextBlock(terminal);
    if (finalText != null) {
      try {
        draft = parseResponse(finalText);
        extractionPath = "structured-final-block";
      } catch {
        draft = null;
      }
    }
  }
  if (!draft) {
    draft = parseResponse(accumulated); // may throw
    extractionPath = "accumulated-fallback";
  }

  if (draftLooksBroken(draft)) {
    throw fail("The AI returned an invalid listing. Try again.");
  }
  return {
    draft,
    meta: {
      stopReason: (terminal && terminal.stop_reason) || null,
      continuations,
      extractionPath,
    },
  };
}

// Full job: TEST_MODE short-circuit, else generate with ONE whole-generation
// retry on parse/validation failure (mirrors index.html's retry-once rule).
async function runJob(payload, env, startedAt) {
  if (env.TEST_MODE === "1") {
    await sleep(2000);
    const draft = mockDraft(payload);
    return {
      draft,
      meta: { stopReason: "end_turn", continuations: 0, elapsedMs: Date.now() - startedAt, testMode: true },
    };
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { draft, meta } = await generateOnce(payload, env, startedAt);
      return { draft, meta: { ...meta, elapsedMs: Date.now() - startedAt } };
    } catch (err) {
      lastErr = err;
      // Only retry parse/validation-class failures once, and only if budget remains.
      if (attempt === 0 && Date.now() - startedAt < PER_JOB_BUDGET_MS - 60000) continue;
      break;
    }
  }
  // Attach meta to the error so the DO can persist elapsed time.
  if (lastErr && !lastErr.meta) lastErr.meta = { elapsedMs: Date.now() - startedAt };
  throw lastErr || fail("Generation failed.");
}
