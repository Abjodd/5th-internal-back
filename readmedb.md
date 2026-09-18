# readmedb — what's in the database

This is a map of every MongoDB collection this backend uses: what it's called, what's actually stored in it, who reads/writes it, and why it's shaped the way it is. It's generated from the current Mongoose models in `models/`, `db.js`, and the routes that touch each collection — if a model changes, this file should be updated alongside it.

## Connection

- **Driver**: Mongoose 8, connected in `db.js`.
- **Default URI**: `mongodb://localhost:27017/fifth_avenue_internal` — overridden by the `MONGO_URI` environment variable in production (Atlas).
- **`strictQuery: false`** is set deliberately: almost every schema below is `strict: false` (documents carry fields — `brandId`, `deleted`, `client`, etc. — that aren't declared in the schema), and `strictQuery: true` would silently strip those fields out of query filters, making a filtered query match everything.
- One database holds every collection listed below, plus one GridFS bucket (see "File & binary storage" at the end).

## How to read this file

Each collection below is documented as:
- **Model / collection** — the Mongoose model name and the actual MongoDB collection name (they often differ).
- **What it stores** — the real shape of a document, in plain terms.
- **Written by / read by** — which app and routes touch it.
- **Notes** — anything load-bearing: gotchas, deliberate omissions, non-obvious relationships.

Most schemas are declared `{ strict: false }`. That's a deliberate pattern in this codebase, not an oversight — the frontend objects (a campaign, a client, a finding) are stored close to as-is rather than kept in lockstep with a rigid schema, so the fields listed for those collections are "what's actually written today," not a hard contract.

---

## Internal platform accounts

### `User` → collection `users`
Internal team accounts (founder, pcm, cm, am, ea, accounts_head, accounts_exec) — who can log into the Founder Summary admin app.
- `_id` (e.g. `"u1"`), `username` (login email), `name`, `role`, `teamId` (links to campaign ownership via `amId`/`cmId`/`eaId`), `title`.
- `avatar` (initials fallback), plus `avatarImage: {data, contentType}` and `avatarUpdatedAt` — an optional profile photo stored **inline** on the document (downscaled to 256px client-side before upload, ~20-30KB). Never returned by list routes; served from its own `GET …/:id/avatar` route instead.
- `hashKey` — sha256 of the password. **Plaintext passwords are never stored.**
- `deleted` / `deletedAt` — soft delete. A deleted user is hidden from lists and blocked from logging in, but the document is kept so it can be restored by hand.
- Written/read by `routes/auth.js`.

### `BrandCredential` → collection `brand_credentials`
Login credentials for the **client-facing portal**, one per brand contact.
- `_id` (e.g. `"bc_fb_1"`), `brandId` (→ `Client._id`), `username` (login email), `name`, `title`, `avatar` + the same inline `avatarImage`/`avatarUpdatedAt` photo pair as `User`.
- `hashKey` — sha256 of the password, same convention as `User`.
- `firstLoginAt` — set on the very first successful login; absent means the contact has never signed in.
- `deleted` / `deletedAt` — same soft-delete pattern as `User`.
- Managed from the founder-only Auth page; the client portal's login checks these documents via `POST /api/auth/portal-login`.

---

## Clients, campaigns & creators

### `Client` → collection `clients`
One document per brand — the core account record everything else (`Campaign`, `Finding`, `MarketWatchItem`, `NewsletterItem`, `AccountQuestions`) hangs off of via `brandId`/`clientId`.
- `_id` (e.g. `"fb"`), `name`, `website`, `faavi` (a score), `phase`, `pkg` (package/plan), `consultant`, `auditAge`, `lastScanned`, `confidence`.
- `profile` — an arbitrary nested object (deeply nested channel/recommendation data from the frontend's `CompanyOverview` view); stored as `Mixed` rather than mirrored field-by-field.
- `openRecs`, `openTasks`, `activeProjects` — dashboard counters.
- The brand's logo uses the same inline `avatarImage`/`avatarUpdatedAt` pair described above, served from `GET /api/clients/:id/avatar`.
- **Gotcha**: the brand's initials field (`init` in the frontend) is deliberately **not** declared on this schema. `init` collides with a reserved Mongoose document method (`Document.prototype.init`, used internally during hydration) — declaring it breaks every non-`.lean()` read/save of a `Client`. It still round-trips fine because the schema is `strict: false`; just read it with `doc.get("init")`, never `doc.init`, and never query/save a `Client` without `.lean()`.

### `Campaign` → collection `campaigns`
The center of the internal app — one document per client campaign, covering brief, roster, timeline and the finance pipeline.
- `_id` (e.g. `"c1"`), `name`, `client` (denormalized display name), `brandId` (→ `Client._id`), `service`, `region`.
- `stage` — an unconstrained string tracking the **finance** pipeline only (`draft → brief_locked → team_assigned → po_raised → advance_received → invoice_raised → payment_done`). There is **no separate execution/delivery stage stored** — delivery status is always derived at read time from the `creators[]` roster, so it can never disagree with it.
- `budget`, `creatorBudget`, `numReq`, `deliverablesPerCreator` — `budget`/`creatorBudget` being `null` vs `0` is meaningful (not-yet-agreed vs. agreed-at-zero); there's deliberately no separate "pending" flag for this.
- `start`, `end`, `amId`, `cmId`, `eaId` (ownership), `brief` (Mixed), `briefStatus`, `bmNote`, `cmNote`, `genRounds`, `sentToClient`, `internalNotes`, `timeline` (array of Mixed events).
- `creators[]` — array of **campaign-specific** records only (fee, status, concept/demo/live, tracking, invoiceNo, …). The creator's actual profile (name, handle, platform, followers, …) is **not** duplicated here — it's split out to the `Creator` collection and hydrated back in on read (see `creatorSync.js`). `creatorIds[]` is a parallel array of `Creator._id` values kept in step with `creators[]` so campaigns can be queried by creator without scanning the embedded array.
- **Gotcha**: the schema must **not** set `_id: false` — combined with the explicit `_id: {type: String}` path (needed to keep readable ids like `"c1"`), that combination breaks Mongoose's id casting on `findById`/`findByIdAndUpdate`, so PATCHes (like moving a campaign's pipeline stage) silently stop persisting. This was a real bug once; don't reintroduce it.

### `Creator` → collection `creators`
The single directory of creator profiles — the source of truth `Campaign.creators[]` entries point back into.
- `_id` — dedupe key, the creator's lower-cased handle (or name if no handle).
- `name`, `handle`, `platform`, `igUrl`, `followers`/`avgLikes` (stored as compact display strings like `"820K"`, not raw numbers), `avgER`, `niche`, `state`, `languages[]`, `phone`.
- `payType`, `payId` — how/where they're paid.
- `managedBy` — `"fifthavenue"` or `"general"` (default). Whether they're managed **by a vendor** is a separate fact, held entirely in `vendorId` — it isn't a value of `managedBy`.
- `personalDetails` — nested object: `pan`, `email`, `address`, `bankName`, `bankAccount`, `bankBranch`, `ifsc`, `upiId`.
- Inline profile photo (`avatarImage`/`avatarUpdatedAt`), same contract as `User`/`Client` — never in list responses, served from its own route.
- **Derived, not stored**: "where this creator has worked" is computed at read time from `Campaign.creatorIds`, so it's never stale.

### `CreatorDocument` → collection `creator_documents`
Signed agreements between the company and a directly-managed creator.
- `_id`, `creatorId` (→ `Creator._id`, indexed), `title` (defaults to the uploaded filename), `file: {data, contentType, size}` (PDF bytes stored inline), `uploadedAt`, `uploadedBy`.
- Kept as its own collection (not a field on `Creator`) so a re-signed agreement doesn't overwrite the version that was in force for past invoices.

### `Vendor` → collection `vendors`
Agencies/talent managers who invoice on a creator's behalf.
- `_id` — a slug of the vendor's name (unique — a duplicate name 409s instead of creating an indistinguishable second row).
- `name`, `contact` (the actual point of contact), `phone`, `email`, `gstin`, `pan`, `address`.
- `payType` (`"net_banking"` | `"upi"`), `bankName`, `bankAccount`, `bankBranch`, `ifsc`, `upiId`, `notes`.
- **Derived, not stored**: the roster of creators assigned to a vendor is read off `Creator.vendorId` at request time, not kept here.
- Plain CRUD via the generic factory (see "Generic Billing CRUD collections" below).

### `Finding` → collection `findings`
One document per audit finding shown on the Audit Centre page.
- `_id` (e.g. `"fb-aeo-1"`), `clientId` (→ `Client._id`, indexed), `channel` (`"aeo"`, `"seo"`, `"meo"`, …), `cat` (`"auto"` | `"manual"`), `sev` (critical/high/medium/low), `pri`, `imp`, `eff`, `conf` (scoring fields), `status` (open/develop/task/monitor/ignored), `title`, `finding`, `insight`, `recommendation`.

---

## Insights (client portal) feature

These back the client portal's Insights tab (Questions, Trending, Market Watch, Newsletter).

### `AccountQuestions` → collection `accountquestions`
A brand's answers to four fixed prompts (What Worked / What Didn't Work / Next Actions / Areas to Improve), filled in by hand by the internal team.
- `_id` — **same value as `Client._id`** (one document per brand, not a growing log — each save is an upsert, not an insert).
- `whatWorked`, `whatDidntWork`, `nextActions`, `areasToImprove`, `updatedAt`.
- Written via `PATCH /api/account-questions/:brandId` (internal app); read via `GET /api/portal/questions` (client portal).

### `TrendingItem` → collection `trendingitems`
One shared "Trending" shelf — **not** per brand; every client portal sees the exact same feed (scoping this per-brand was tried and explicitly dropped).
- `_id`, `kind` (`"reel"` | `"note"`), `url` (for a reel), `text` (for a note), `author` (who on the internal team added it), `createdAt`.
- For a reel, `media` (`Mixed`, not declared in the schema on purpose) holds a **one-time** snapshot fetched from HikerAPI at creation — this is the only external-API credit this row ever costs; it's never re-fetched. `media.ok === false` or a missing `media` means the fetch failed or predates this behavior, and the client falls back to a plain "Open on Instagram" card.
- Written via the internal app's `/api/trending` routes; read via `GET /api/portal/trending`.

### `MarketWatchItem` → collection `marketwatchitems`
Same shape as `TrendingItem`, but **per brand** — the one thing Trending explicitly isn't.
- `_id`, `brandId` (→ `Client._id`, indexed), `kind` (`"reel"` | `"note"`), `url`, `text`, `author`, `createdAt`, and the same one-time `media` snapshot for reels.
- Written via the internal app's `/api/market-watch` routes; read via `GET /api/portal/market-watch`, scoped to the requesting brand.

### `NewsletterItem` → collection `newsletteritems`
One PDF newsletter upload per brand — every upload is kept (unlike Trending/Market Watch, nothing here gets overwritten).
- `_id`, `brandId` (→ `Client._id`, indexed), `title` (defaults to the uploaded filename), `file: {data, contentType, size}` (PDF bytes inline, 2MB cap enforced in `newsletterStore.js`/`pdfUpload.js`), `uploadedAt`, `author`.
- List queries always project `file` away (`OMIT_FILE`); the PDF bytes are served from their own byte-serving route.
- Written via `POST /api/newsletter` (internal); read via `GET /api/portal/newsletter` + `GET /api/portal/newsletter/:id/file`.
- **Security note**: the portal's file-serving route filters by `_id` **and** `brandId` in the same query (`findOne`, not `findById`) — a guessed id belonging to a different brand's PDF 404s instead of leaking it.

### `NewsCache` → collection `newscaches`
A durable cache of an externally-fetched RSS feed — currently just the "influencer marketing" industry news feed behind Market Watch's Latest News list.
- `_id` — the feed's key, e.g. `"influencer-marketing"` (one document per feed).
- `items[]` — each `{title, link, source, image, publishedAt}` (`image` is a best-effort `og:image`/`twitter:image` scraped from the article).
- `fetchedAt` — last successful fetch; the feed is re-fetched when this is older than the 30-minute TTL.
- Stored in Mongo (not process memory) specifically so a deploy/crash/idle-instance recycle doesn't turn "refetch every 30 minutes" into "refetch on every cold start."

### `ReelCache` → collection `reel_cache`
A durable, TTL'd cache of fetched Instagram post data, shared by both Trending and Market Watch reels (and anything else that resolves a reel URL).
- `_id` — the Instagram post URL itself (natural key — the same post reachable via `/p/`, `/reel/`, or `/reels/` all collapse to one entry per literal URL used).
- `reel` (`Mixed`) — the processed snapshot, or `null` if the post fetched fine but had nothing renderable. `null` is a real, distinct answer from "never fetched" (which is simply the document not existing).
- `fetchedAt` — last **successful** fetch (freshness is measured only against this, so a run of failures never makes a stale doc look current). `attemptedAt` / `lastError` — last attempt of any kind, so a permanently dead post gets retried on a backoff instead of every single pass.
- `poster: {data, contentType}` + `posterUpdatedAt` — the post's poster frame, copied and stored **as bytes owned by us**, not just a link to Instagram's CDN. Unlike the video/thumbnail URLs (which are signed and expire — video ~32h, poster ~106h), a copied JPEG never expires, so a post fetched once stays correct forever without a refresh job.
- `code` — the Instagram shortcode, lifted out of `reel` so the poster-serving route can look a document up by it (the collection's own `_id` — a full URL — isn't safe to put in a path segment).
- Indexes: `{fetchedAt: 1}` (the refresh job's "oldest first" query) and a sparse `{code: 1}` (the poster route's lookup; sparse because older rows predate `code` being stored).
- **Why this matters**: this used to be a plain in-memory `Map`, which meant every deploy/crash/cold-start silently re-spent a HikerAPI credit per post. Moving it into Mongo is what makes "one fetch per post, ever" actually true.

---

## Inbound requests (public-facing forms)

Three near-identical "founder inbox" collections, one per public form. All are `strict: false` so the corresponding landing page can send extra fields without a schema change, and none scope by brand — they're the founder's own triage queues.

### `ClientRequest` → collection `client_requests`
Brand sign-ups from the public "Start a project" landing page.
- `_id` (e.g. `"cr1"`), `name`, `role`, `contact` (single combined email-or-phone field), `organisation`, `headquarters`, `goal` (free text).
- No status field — every row here is by definition still pending, and the row is deleted entirely once login credentials are generated for it (see `routes/clientRequests.js`).

### `CreatorRequest` → collection `creator_requests`
Applications from the public "Apply as a creator" form.
- `_id` (e.g. `"crq1"`), `name`, `handle`, `platform`, `email`, `phone`, `state`, `followers` (self-reported band, e.g. `"10K–50K"`), `niche[]`, `languages[]`, `status` (`new` | `reviewed` | `contacted` | `archived`, default `"new"`).
- Field names deliberately mirror `Creator` so an approved application can be promoted straight into the `creators` directory without remapping.

### `CareerRequest` → collection `career_requests`
Job applications from the public Careers page.
- `_id` (e.g. `"car1"`), `name`, `email`, `roleId` (the opening's id at time of application — openings live in frontend code and can be retired later), `roleTitle` (**stored alongside** `roleId` rather than resolved from it, so a request survives its opening being removed), `link` (portfolio/LinkedIn), `note`, `status` (same `new`/`reviewed`/`contacted`/`archived` vocabulary as `CreatorRequest`).

---

## Generic Billing CRUD collections

Six collections share one route factory (`registerCrudRoutes` in `server.js`) that just does list/create/patch/delete, optionally filtered by `?brandId=`. Their Mongoose schemas declare **only** `_id` (`strict: false` for everything else), so the actual field shape on any document is whatever the Billing UI happened to send when it was created — there's no server-side schema enforcement beyond "must have an id."

| Model | Collection | Route | Used for |
|---|---|---|---|
| `Invoice` | `invoices` | `/api/invoices` | Invoice metadata rows (see also the GridFS-backed PDF bytes below — this collection holds the row shown in Billing/Influencers, not the file itself) |
| `Expense` | `expenses` | `/api/expenses` | Logged expenses |
| `PurchaseOrder` | `purchase_orders` | `/api/purchase-orders` | Purchase orders raised |
| `ClientPO` | `client_pos` | `/api/client-pos` | POs received from a client |
| `Quote` | `quotes` | `/api/quotes` | Quotes issued |
| `RegistryEntry` | `registry_entries` | `/api/registry` | General ledger/registry rows |
| `Vendor` | `vendors` | `/api/vendors` | (documented above under Clients/Campaigns — uses the same generic factory) |

All six support `?brandId=` filtering server-side (matched against a `brandId` field on the document, if present).

---

## Scheduler bookkeeping

### `JobRun` → collection `job_runs`
One row per named scheduled job (see `scheduler.js`), used purely so a **missed** run can be detected.
- `_id` — the job's own name, e.g. `"post-metrics-refresh"`.
- `lastRunAt` — when it last completed, successfully or not.
- `lastResult` (`Mixed`) — the job's own summary object, kept so "why is this chart empty" can be diagnosed without shell access to rotated server logs.
- **Why it exists**: the scheduler is in-process and arms a single timer for the next run; a restart (deploy, crash, idle-instance recycle) silently drops whatever was due. With `lastRunAt` persisted, the scheduler can compare against what was actually due and catch up on boot instead of just arming a timer for the next occurrence and losing that day.
- Deliberately **not** a `RegistryEntry` — that collection is user-facing data behind `/api/registry`; this is internal scheduler bookkeeping and has no business appearing there.

---

## File & binary storage

Two different strategies are used in this codebase, on purpose:

**Inline on the document** (small files, ≤ a few MB) — used for:
- Profile photos (`User`, `BrandCredential`, `Client`, `Creator`) — downscaled to ~20-30KB client-side before upload, capped at 2MB server-side (`avatarStore.js`).
- Reel poster frames (`ReelCache.poster`).
- Newsletter PDFs (`NewsletterItem.file`, 2MB cap).
- Signed creator agreements (`CreatorDocument.file`).

These are stored as `{data: Buffer, contentType: String, ...}` directly on the owning document. At this size, inline beats a separate collection or GridFS: no join, no second round trip to render, and no orphaned file left behind when the parent record is hard-deleted. Every **list** query for these collections explicitly projects the bytes away (`OMIT_AVATAR`, `OMIT_FILE`, `OMIT_POSTER`, etc.) so a list response doesn't balloon in size; the actual bytes are served from a dedicated, cacheable `GET …/:id/…` route instead.

**GridFS** (generated files, can exceed the 16MB document limit) — used for exactly one thing:
- **`invoice_pdfs` bucket** (`invoice_pdfs.files` / `invoice_pdfs.chunks` collections) — rendered invoice PDFs (`routes/invoicePdf.js`, built with `pdfkit`). Kept in the same database as everything else so PDFs survive a redeploy, and named distinctly from the `invoices` metadata collection so the two stay obviously separate (e.g. when inspecting the database directly in Compass). Files are looked up by `metadata.invoiceNo`, with a `filename` fallback (`<invoiceNo>.pdf`) for files written before that metadata existed. Regenerating an invoice's PDF replaces the previous file for that `invoiceNo`.

---

## Quick collection index

| Collection (Mongo name) | Model | Scope |
|---|---|---|
| `users` | User | internal accounts |
| `brand_credentials` | BrandCredential | client-portal logins |
| `clients` | Client | brands |
| `campaigns` | Campaign | campaigns |
| `creators` | Creator | creator directory |
| `creator_documents` | CreatorDocument | signed agreements |
| `vendors` | Vendor | billing agencies |
| `findings` | Finding | audit findings |
| `accountquestions` | AccountQuestions | Insights → Questions (per brand) |
| `trendingitems` | TrendingItem | Insights → Trending (shared) |
| `marketwatchitems` | MarketWatchItem | Insights → Market Watch (per brand) |
| `newsletteritems` | NewsletterItem | Insights → Newsletter (per brand) |
| `newscaches` | NewsCache | cached external news feed |
| `reel_cache` | ReelCache | cached Instagram post data |
| `client_requests` | ClientRequest | inbound brand sign-ups |
| `creator_requests` | CreatorRequest | inbound creator applications |
| `career_requests` | CareerRequest | inbound job applications |
| `invoices` | Invoice | billing (generic CRUD) |
| `expenses` | Expense | billing (generic CRUD) |
| `purchase_orders` | PurchaseOrder | billing (generic CRUD) |
| `client_pos` | ClientPO | billing (generic CRUD) |
| `quotes` | Quote | billing (generic CRUD) |
| `registry_entries` | RegistryEntry | billing (generic CRUD) |
| `job_runs` | JobRun | scheduler bookkeeping |
| `invoice_pdfs.files` / `.chunks` | — (GridFS) | rendered invoice PDF bytes |

*(Generated from the models in `backend/models/`, `backend/db.js`, and their routes — last updated 2026-09-17. If you add, rename, or reshape a collection, update this file in the same change.)*
