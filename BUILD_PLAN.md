# Thrift Ledger — Build Plan

Derived from the Linear tickets on the **Spencer Trabbold** team (SPE-5 … SPE-18), 2026-07-04.
(SPE-1–4 are Linear's default onboarding issues and are excluded.)

Now live in Linear as the [Thrift Ledger project](https://linear.app/spencer-trabbold/project/thrift-ledger-4faebe8f3cc0)
with six milestones matching the phases below, blocking relations matching the dependency
graph, and owner labels (`AI agent` / `Human`). SPE-9's on-device verification half was
split into its own Human ticket, SPE-18.

## What we're building

A mobile-first, single-page app for Alissa's thrift-flipping business, published as a
shareable artifact she installs on her iPhone home screen. Core loop:

**Photo → AI-generated listing (Poshmark / eBay / Mercari / Depop) → edit → post via
one-tap links → mark sold (single or bundle) → profit dashboard.**

Persistence is `window.storage`, scoped privately to her device/account. AI listing
generation calls Claude with web search enabled to research comparable resale prices.

## Key product decisions baked into the tickets

- **Bundle profit is tracked at the bundle level** — total sale − total cost of bundled
  items − one fee. It is *not* split back across individual items (SPE-13).
- **Sale price defaults to the suggested/listed price but is always editable** — she
  negotiates (SPE-12).
- **"Not Listing" items stay in total spend** but leave the active inventory view (SPE-11).
- **AI drafts are starting points, never final** — every generated field is editable
  inline before saving/copying (SPE-8).
- **Photos are compressed client-side** before storing (SPE-6) — important given
  `window.storage` size limits.

## Phases

### Phase 1 — Foundation (blocks everything)
| Ticket | Work |
|---|---|
| SPE-5 | Data model & storage schema: item record (photo, category, brand, size, condition, cost paid, status, generated listing content, per-platform text, sold info, bundle grouping) + `window.storage` wiring |

Design the schema to cover *all* downstream tickets now: status enum includes
`listed / sold / not-listing` (SPE-11), sold info includes price/platform/fee/date
(SPE-12), and bundle grouping exists from day one (SPE-13) so no migration later.

### Phase 2 — Intake & AI listing pipeline
| Ticket | Work | Depends on |
|---|---|---|
| SPE-6 | New Item intake: photo capture/upload, category/brand/size/condition, cost paid, client-side photo compression | SPE-5 |
| SPE-7 | AI listing generation: photo + details → Claude w/ web search → title, description, suggested price, 4 platform-specific texts | SPE-6 |
| SPE-8 | All generated fields editable inline before copy/save | SPE-7 |
| SPE-9 | "Go to [Platform]" buttons: poshmark.com/create-listing, ebay.com/sl/sell, mercari.com/sell, Depop equivalent (behind an editable URL map) | SPE-7 |

### Phase 3 — Inventory management
| Ticket | Work | Depends on |
|---|---|---|
| SPE-10 | Inventory tab: thumbnails, key details, status badges (Listed / Sold / Not Listing) | SPE-6 |
| SPE-11 | "Not Listing" status: stays in total spend, exits active inventory | SPE-10 |

### Phase 4 — Sales & money
| Ticket | Work | Depends on |
|---|---|---|
| SPE-12 | Mark as Sold (single): editable sale price defaulting to suggested, platform sold on, platform fee; profit computed on confirm | SPE-10 |
| SPE-13 | Bundle sales: multi-select → one total price + one fee → bundle-level profit | SPE-12 |
| SPE-14 | Dashboard: total spent, revenue, fees, net profit, listed vs sold counts, recent sales with per-sale/per-bundle profit | SPE-12, SPE-13 |

### Phase 5 — Persistence hardening
| Ticket | Work |
|---|---|
| SPE-15 | Verify all item + sale data survives reloads via `window.storage`, private to Alissa's device/account |

Runs as a verification pass across everything built above; storage wiring itself lands in Phase 1.

### Phase 6 — Human-in-the-loop verification & launch
| Ticket | Owner | Work |
|---|---|---|
| SPE-18 | Human | Tap each platform button on Alissa's iPhone with real apps installed; confirm deep-link landing spots (split out of SPE-9) |
| SPE-16 | Human | Full E2E QA with Alissa on her phone — listing quality, pricing quality, speed vs. her current workflow, dashboard math |
| SPE-17 | Human | Publish artifact link + Safari "Add to Home Screen" |

## Dependency graph

```
SPE-5 ── SPE-6 ─┬─ SPE-7 ─┬─ SPE-8 ─────────────────────┐
                │         └─ SPE-9 ── SPE-18 ───────────┤
                └─ SPE-10 ─┬─ SPE-11 ───────────────────┤
                           └─ SPE-12 ─ SPE-13 ─ SPE-14 ─ SPE-15 ─┴─ SPE-16 ─ SPE-17
```

## Suggested build order (single developer / agent)

1. SPE-5 → 2. SPE-6 → 3. SPE-10 (get the see-your-stuff loop working early)
4. SPE-7 → 5. SPE-8 → 6. SPE-9 buttons
7. SPE-12 → 8. SPE-11 → 9. SPE-13 → 10. SPE-14
11. SPE-15 verification → 12. SPE-18 device check + SPE-16 QA → 13. SPE-17 ship

Rationale: intake + inventory first gives Alissa something visible fast and creates the
data the AI and sales flows consume; sales/dashboard math lands together so the dashboard
is testable the moment profit data exists; human steps batch at the end since they all
need her actual iPhone.

## Risks / watch items

- **`window.storage` size limits vs. photos** — compression (SPE-6) is load-bearing;
  decide max resolution/quality early and test with ~50 items.
- **Platform deep links are unverifiable until a real device test** (SPE-9) — build the
  buttons behind an easily-editable URL map so fixes after device testing are one-liners.
- **Bundle math** — bundle-level profit means per-item profit is undefined for bundled
  items; the dashboard (SPE-14) must show per-bundle rows, not fake per-item splits.
- **AI listing quality is the make-or-break** (SPE-16) — the whole app only beats her
  current workflow if drafts are good; budget iteration time on the SPE-7 prompt.
