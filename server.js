import express from "express";
import cors from "cors";
// Only for the health route's DB ping — every query here goes through a model.
import mongoose from "mongoose";
import { connectDB } from "./db.js";
import Campaign from "./models/Campaign.js";
import Invoice from "./models/Invoice.js";
import invoicePdfRoutes from "./routes/invoicePdf.js";
import authRoutes from "./routes/auth.js";
import creatorRoutes from "./routes/creators.js";
import { keyOf, splitCreatorsForStorage, hydrateCampaignCreators } from "./creatorSync.js";
import { carryTrackingHistory } from "./trackingHistory.js";
import clientRequestRoutes from "./routes/clientRequests.js";
import creatorRequestRoutes from "./routes/creatorRequests.js";
import careerRequestRoutes from "./routes/careerRequests.js";
import Expense from "./models/Expense.js";
import PurchaseOrder from "./models/PurchaseOrder.js";
import ClientPO from "./models/ClientPO.js";
import Quote from "./models/Quote.js";
import RegistryEntry from "./models/RegistryEntry.js";
import Vendor from "./models/Vendor.js";
import { fetchInstagramProfile } from "./instagramfetchhiker.js";
import { fetchYouTubeChannel } from "./youtubeFetch.js";
import { fetchPostMetrics, RAW_MEDIA } from "./postMetrics.js";
import { getClientReels, refreshAllReels, cacheReelFromMedia, warmReels, getReelPoster, backfillPosters, fetchReelSnapshot } from "./portalReels.js";
import { startScheduler } from "./scheduler.js";
import { refreshAllPostMetrics } from "./refreshPostMetrics.js";
import Client from "./models/Client.js";
import Finding from "./models/Finding.js";
import TrendingItem from "./models/TrendingItem.js";
// Brand logos ride the same machinery as user profile photos — see avatarStore.js
// for why images live inline on the document and are served from their own route.
import { withAvatar, serveAvatar, OMIT_AVATAR, toBuffer } from "./avatarStore.js";
import { suggestLogo } from "./faviconFetch.js";
const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
    // Cache the CORS preflight for 24h. Without this the `cors` package sends
    // no Access-Control-Max-Age, so Chrome falls back to its 5-second default
    // and re-preflights almost every call — the frontends were paying two
    // round trips per request (an OPTIONS beside every GET/POST) on a link
    // where each trip costs ~150-250ms. 86400 is the ceiling Chrome honours.
    maxAge: 86400,
  })
);

app.use(express.json({ limit: "5mb" }));

// ── Feature route modules (see routes/) ─────────────────────────────────────
// invoicePdf: POST/GET /api/invoices/:invoiceNo/pdf — pdfkit render + GridFS storage
// auth:       /api/auth/login, /api/auth/portal-login, /api/users, /api/brand-credentials
// creators:   /api/creators — creator directory aggregated across campaigns
// clientReqs: /api/client-requests — brand landing-page signups (founder inbox)
// creatorReqs:/api/creator-requests — creator applications (founder inbox)
// NOTE: mounted before registerCrudRoutes("/api/invoices") below so the more
// specific /pdf routes win over the generic /api/invoices/:id matchers.
app.use(invoicePdfRoutes);
app.use(authRoutes);
app.use(creatorRoutes);
app.use(clientRequestRoutes);
app.use(creatorRequestRoutes);
app.use(careerRequestRoutes);

// Generic CRUD route factory for the simple Billing collections — they're
// all "list everything / create / patch by id", optionally filtered by
// ?brandId=, so one factory avoids repeating the same 4 routes 6 times.
function registerCrudRoutes(basePath, Model) {
  app.get(basePath, async (req, res) => {
    try {
      const q = {};
      if (req.query.brandId) q.brandId = req.query.brandId;
      const docs = await Model.find(q).lean();
      res.json(docs.map(({ _id, ...rest }) => ({ id: _id, ...rest })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(basePath, async (req, res) => {
    try {
      const body = req.body;
      if (!body.id) return res.status(400).json({ error: "id is required" });
      const doc = await Model.create({ ...body, _id: body.id });
      const { _id, ...rest } = doc.toObject();
      res.status(201).json({ id: _id, ...rest });
    } catch (err) {
      // This catch is what the whole route was missing. Express 4 does not
      // catch a rejected promise from an async handler, so a duplicate _id
      // escaped as an unhandledRejection and Node killed the process — one bad
      // request took the API down for everyone. 11000 is Mongo's duplicate-key
      // code; the unique index on _id stays the single source of truth.
      if (err.code === 11000) return res.status(409).json({ error: "A record with this id already exists." });
      res.status(500).json({ error: err.message });
    }
  });

  app.patch(`${basePath}/:id`, async (req, res) => {
    try {
      const updated = await Model.findByIdAndUpdate(
        req.params.id,
        { $set: req.body },
        { new: true }
      ).lean();
      if (!updated) return res.status(404).json({ error: "not found" });
      const { _id, ...rest } = updated;
      res.json({ id: _id, ...rest });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete(`${basePath}/:id`, async (req, res) => {
    try {
      await Model.findByIdAndDelete(req.params.id);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

registerCrudRoutes("/api/invoices", Invoice);
registerCrudRoutes("/api/expenses", Expense);
registerCrudRoutes("/api/purchase-orders", PurchaseOrder);
registerCrudRoutes("/api/client-pos", ClientPO);
registerCrudRoutes("/api/quotes", Quote);
registerCrudRoutes("/api/registry", RegistryEntry);
// Vendors (Creators › Vendors) — plain CRUD like the rest: the creators
// assigned to one are read off Creator.vendorId, never stored here.
registerCrudRoutes("/api/vendors", Vendor);

// Insights → Trending (internal-authored) — the internal Founder Summary page
// reads/writes this; the client portal reads a separate, universal,
// un-scoped copy at GET /api/portal/trending below (this shelf is
// deliberately the same for every brand, not per-client like the rest of the
// portal). Hand-written rather than registerCrudRoutes only because PATCH
// needs the same id-remap the GET/POST below do.
//
// A reel is a link the internal team pastes in by hand — there is nothing to
// discover, but there IS something to look up: what the post actually looks
// like. POST below spends exactly one HikerAPI credit per reel, at save time,
// and stores the result on the row (see fetchReelSnapshot in portalReels.js).
// That single snapshot is what the client renders from (GET
// /api/portal/trending) — nothing is ever re-fetched for a reel after this:
// no nightly refresh, no refetch on PATCH, no fetch on the client. A private,
// deleted, or otherwise unreadable link just stores with no snapshot and the
// client shows a plain "Open on Instagram" card for it instead.
app.get("/api/trending", async (req, res) => {
  try {
    const docs = await TrendingItem.find({}).sort({ createdAt: -1 }).lean();
    res.json(docs.map(({ _id, ...rest }) => ({ id: _id, ...rest })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/trending", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.id) return res.status(400).json({ error: "id is required" });
    // One HikerAPI credit, spent here and only here: a reel's snapshot is
    // fetched once, at the moment it's saved, and never again. See
    // fetchReelSnapshot's own doc comment in portalReels.js.
    const media = body.kind === "reel" && body.url
      ? await fetchReelSnapshot(body.url)
      : undefined;
    const doc = {
      _id: body.id,
      kind: body.kind,
      url: body.url || null,
      text: body.text || null,
      author: body.author || null,
      createdAt: new Date(),
      ...(media ? { media } : {}),
    };
    const created = await TrendingItem.create(doc);
    const { _id, ...rest } = created.toObject();
    res.status(201).json({ id: _id, ...rest });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A record with this id already exists." });
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/trending/:id", async (req, res) => {
  try {
    const updated = await TrendingItem.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true },
    ).lean();
    if (!updated) return res.status(404).json({ error: "not found" });
    const { _id, ...rest } = updated;
    res.json({ id: _id, ...rest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/trending/:id", async (req, res) => {
  try {
    await TrendingItem.findByIdAndDelete(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Campaigns ────────────────────────────────────────────────────────────────

// GET /api/campaigns — list all campaigns
app.get("/api/campaigns", async (req, res) => {
  try {
    const q = { deleted: { $ne: true } };
    if (req.query.client)  q.client  = req.query.client;
    if (req.query.stage)   q.stage   = req.query.stage;
    if (req.query.brandId) q.brandId = req.query.brandId;
    const campaigns = await Campaign.find(q).lean();
    await hydrateCampaignCreators(campaigns);
    res.json(campaigns.map(({ _id, ...rest }) => ({ id: _id, ...rest })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/campaigns/brand-scope?teamId=t5 — the brandIds behind the campaigns
// one team member is on, and nothing else.
//
// The app shell's brand filter needs exactly this list on EVERY page, for every
// assignment-scoped role, so that it stops offering brands whose campaigns the
// user cannot open. It was answering that question with GET /api/campaigns —
// which returns every full campaign document AND runs hydrateCampaignCreators,
// a join across the creators collection per campaign. Fetching all of that on
// every route, to fill one dropdown, is the wrong order of magnitude by a wide
// margin.
//
// `distinct` does the whole job in the database and returns a handful of
// strings. Registered ahead of the parameterised /api/campaigns/:id routes so
// "brand-scope" is never read as an id.
app.get("/api/campaigns/brand-scope", async (req, res) => {
  try {
    const teamId = String(req.query.teamId || "").trim();
    // ?all=1 — every brand that has at least one live campaign, whoever owns
    // it. A different question from the teamId scope below ("brands I can
    // reach"), and the app shell asks both: a company-wide role can reach every
    // brand but should still not be offered a filter for one with nothing to
    // show. Same `distinct`, no ownership clause.
    if (req.query.all === "1") {
      return res.json((await Campaign.distinct("brandId", { deleted: { $ne: true } })).filter(Boolean));
    }
    // No teamId means nothing is assignable to this user, which is an empty
    // scope — NOT "show everything". Company-wide roles never call this: the
    // client skips the request entirely (see reachableBrandIds).
    if (!teamId) return res.json([]);
    const brandIds = await Campaign.distinct("brandId", {
      deleted: { $ne: true },
      $or: [{ createdBy: teamId }, { amId: teamId }, { cmId: teamId }, { eaId: teamId }],
    });
    res.json(brandIds.filter(Boolean));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Denormalized creator_ids on a campaign — the same dedupe key the creators
// directory keys on (keyOf, from creatorSync.js), so the mapping stays a
// queryable index into the creators collection without ever drifting.
const creatorIdsOf = (creators) =>
  [...new Set((creators || []).map((cr) => cr.creatorId || keyOf(cr)).filter(Boolean))];

// POST /api/campaigns — create a new campaign
// Body is the full campaign object (id, name, client, ... as built in onCreate)
app.post("/api/campaigns", async (req, res) => {
  try {
    const c = req.body;
    if (!c.id) return res.status(400).json({ error: "id is required" });
    const creators = await splitCreatorsForStorage(c.creators);
    const doc = await Campaign.create({ ...c, _id: c.id, creators, creatorIds: creatorIdsOf(creators) });
    const [hydrated] = await hydrateCampaignCreators([doc.toObject()]);
    const { _id, ...rest } = hydrated;
    res.status(201).json({ id: _id, ...rest });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A campaign with this id already exists." });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/campaigns/:id — partial update (brief, creators, stage, etc.)
// When `creators` is touched, profile fields (name, handle, followers, ...)
// are split out to the creators directory before saving — see creatorSync.js.
app.patch("/api/campaigns/:id", async (req, res) => {
  try {
    const patch = { ...req.body };
    if ("creators" in patch) {
      // The browser sends creators[] without tracking.history — it has no
      // reason to carry it — so writing the request straight through would
      // wipe the series on every save. Merge it back from the stored document
      // first, extending it with whatever this request reports.
      const prior = await Campaign.findById(req.params.id, { creators: 1 }).lean();
      patch.creators = carryTrackingHistory(prior?.creators || [], patch.creators);
      patch.creators = await splitCreatorsForStorage(patch.creators);
      patch.creatorIds = creatorIdsOf(patch.creators);
    }
    const updated = await Campaign.findByIdAndUpdate(
      req.params.id,
      { $set: patch },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: "not found" });
    const [hydrated] = await hydrateCampaignCreators([updated]);
    const { _id, ...rest } = hydrated;
    res.json({ id: _id, ...rest });

    // A save is the moment a live post URL first exists in the system. Fetching
    // its media here — once, off the response path — is what lets the client
    // portal's shelf be a pure database read and still show a reel the minute
    // it is delivered, instead of on the brand's own page load or up to a day
    // later. Same one call per post either way; only the timing moves.
    // Not awaited, never throws: a campaign save must not wait on Instagram.
    // `hydrated`, not `patch`: splitCreatorsForStorage moves profile fields
    // (handle among them) out to the creators directory, so the roster we just
    // wrote no longer carries the handle warmReels uses as a fallback username.
    // The hydrated copy has it rejoined.
    if ("creators" in patch) warmReels(hydrated.creators, hydrated.name);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/campaigns/:id?actor=NAME[&purge=1] — two different acts.
//
// Default (archive): the doc stays in Mongo with deleted:true, so every list
// query hides it but it can be restored by hand. The deletion is appended to
// the campaign's timeline as the audit trail.
//
// ?purge=1: the document is removed. There is no undo and no timeline to
// append to afterwards, which is why the two are separate parameters rather
// than one "delete" that quietly does whichever.
//
// Auto-generated creator expenses go with it. They are derived from the
// roster (creatorExpensePlan in 5th-internal-front lib/campaign.js) and keyed
// EXP-<campaignId>-<rosterRowId>, so once the campaign is gone they are
// unreachable rows that still count toward Billing's totals.
//
// The OTHER billing collections (invoices, client POs, vendor POs, quotes) are
// cascaded by the caller, which already does exactly that for both modes — see
// onDeleteCampaign in 5th-internal-front. This deleteMany is the safety net for
// callers that don't, and is a no-op when they have: an orphan expense is the
// one row Billing does not hide on its own, so it would keep inflating
// committed spend and the approval queue forever.
app.delete("/api/campaigns/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const actor = req.query.actor || "Unknown";

    if (req.query.purge === "1") {
      const campaign = await Campaign.findByIdAndDelete(id).lean();
      if (!campaign) return res.status(404).json({ error: "not found" });
      const { deletedCount } = await Expense.deleteMany({ campaign: id });
      console.log(`[campaigns] purged ${id} by ${actor} (+${deletedCount} expenses)`);
      return res.json({ purged: true, expensesDeleted: deletedCount });
    }

    const date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    const archived = await Campaign.findByIdAndUpdate(id, {
      $set: { deleted: true, deletedAt: new Date() },
      $push: { timeline: { date, event: "Campaign archived", actor } },
    }).lean();
    if (!archived) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Client Portal (read-only) ────────────────────────────────────────────────
// GET /api/portal/campaigns?brand=BRANDID — one brand's campaigns, with
// everything internal stripped before it leaves the building.
//
// Campaign fields are a denylist: money the client shouldn't see (creator
// fees, creator budget), staff assignments and notes, and internal bookkeeping.
const CAMPAIGN_PRIVATE = [
  "creatorBudget", "amId", "bmId", "cmId", "eaId", "brandId",
  "internalNotes", "amNote", "bmNote", "cmNote",
  "genRounds", "sentToClient", "timeline",
  // Internal identifiers with no meaning to a client: who created the campaign
  // (a staff teamId), the denormalized creator index, and the soft-delete
  // bookkeeping that every query already filters on.
  "createdBy", "creatorIds", "deleted", "deletedAt",
  // The fee's AMOUNT is the brand's to see; the rate it was agreed at is not —
  // read against the base budget it gives away the creator-pool split.
  "agencyFeePct",
];

// Creator fields are an ALLOWLIST, deliberately — the opposite of the campaign
// rule above, and the difference matters.
//
// Campaign and Creator are both `strict: false`, so a denylist here would make
// every field anyone ever adds public by default. That is not hypothetical:
// once creator profiles moved into their own collection, hydrateCampaignCreators
// began merging the full profile — including `personalDetails` (PAN, bank
// account number, IFSC, UPI id) — onto each campaign's creators[] on read. The
// old denylist named `fee, phone, payType, payId, dbId` but not
// `personalDetails`, so every client with a portal login was being served their
// creators' bank and tax details in the JSON payload. The portal UI never
// rendered them (see mapping.js toViewCreator), which is exactly why it went
// unnoticed — the data was one devtools Network tab away the whole time.
//
// Add to this list only after checking the field is safe for a brand to read.
const CREATOR_PUBLIC = [
  // identity / audience — what the brand is buying
  "name", "handle", "platform", "igUrl", "followers", "avgLikes", "avgER",
  "niche", "state", "languages",
  // campaign-specific workflow the portal renders
  // `numDeliverables` is how many posts this creator owes — the brand is
  // buying it, so it belongs in the client's view of the roster. `live` now
  // carries a postUrls[] array alongside the postUrl the portal reads today;
  // both travel under the one key.
  "status", "concept", "demo", "live", "tracking", "deliverables", "numDeliverables",
  // `collab` — "collab" | "non_collab" | null. Whether the post goes up as a
  // paid collaboration carrying the brand's own handle, or on the creator's
  // account alone. Safe for a brand to read, and more than safe: it is a term
  // of the deal they are paying for, and the internal app makes it a
  // precondition of locking the creator's fee for exactly that reason.
  "collab",
  // The brand's own yes/no on this creator, made in the portal — who called it
  // and when. Written by the decision route below; the portal reads it back to
  // say "you approved this on the 2nd" rather than just showing the status the
  // call produced.
  "brandDecision",
];

// Renamed on the way out, which is why it is not in the allowlist above: a
// roster carries `cost` (what we pay — never leaves the building, it is half
// the margin) and `clientCost` (what the brand is charged). The portal knows
// one figure and calls it `cost`, so clientCost → cost.
//
// Unpriced stays absent rather than 0 — the brand's breakdown leaves that
// creator out instead of listing them as free.
const withClientCost = (safe, cr) => {
  const v = cr?.clientCost;
  if (v == null || v === "") return safe;
  const n = Number(v);
  return Number.isFinite(n) ? { ...safe, cost: n } : safe;
};

// The roster row's own key, renamed on the way out.
//
// `_id` here is a string the internal app mints on shortlist ("cr_1730_x7f")
// — not an ObjectId, meaningless outside this roster. The portal needs a
// stable handle to comment against the right creator; an array index breaks on
// reorder and a handle is absent on hand-added creators. Renamed to `ref` so
// nothing downstream mistakes it for a document id it could look up.
const withRosterRef = (safe, cr) => {
  const id = cr?._id;
  return id ? { ...safe, ref: String(id) } : safe;
};

// ── Whose campaigns ─────────────────────────────────────────────────────────
// Portal reads are scoped by brandId, the stable id every campaign carries.
// They used to be scoped by `Campaign.client`, a copy of the brand's display
// name — which is left empty when a brand is created alongside its first
// campaign, and goes stale when a brand is renamed. Either way the brand's
// portal silently showed nothing at all.
//
// Takes ?brand=<brandId> (what the portal sends) or ?client=<name> (older
// callers). Null when no such brand exists.
async function resolveBrandScope({ brand, client } = {}) {
  const id = String(brand || "").trim();
  const name = String(client || "").trim();
  const doc = id ? await Client.findById(id, { name: 1 }).lean()
    : name ? await Client.findOne({ name }, { name: 1 }).lean()
    : null;
  return doc ? { id: String(doc._id), name: doc.name } : null;
}

/** Answers the request and returns false when the brand doesn't resolve. */
function requireBrandScope(res, scope) {
  if (scope) return true;
  res.status(400).json({ error: "a known brand or client query param is required" });
  return false;
}

// ── What counts ─────────────────────────────────────────────────────────────
// Which campaigns a brand's NUMBERS come from. Not which they SEE — they see
// all of them, because planned work belongs on their board. But a budget that
// is still being arranged must not move a figure they are asked to trust.
//
// Finance and delivery are two separate tracks, so a campaign can have creators
// posting while its invoice is still out. Either track can admit it:
//   · finance reached invoice_raised or later, or
//   · a post is live AND the money is real (budget set, someone priced).
//
// That second guard is what keeps out a campaign like BAU — eight posts live,
// nobody priced — which would otherwise render a bill of ₹0.
//
// Mirrored by countsInMetrics in the portal's lib/portalMetrics.js. Change both
// or the two apps disagree about the same campaign.
const LIVE_STAGES = new Set(["invoice_raised", "payment_done", "live", "creator_paid", "reporting", "completed"]);
// Either field means the post is up; postUrls is the array, postUrl the first
// link kept for back-compat.
const isCreatorLive = (cr) => !!(cr?.live?.postUrls?.length || cr?.live?.postUrl);
// clientCost is what the brand is charged; `cost` is what we pay the creator
// and never leaves the building.
const isPriced = (c) =>
  Number(c?.budget) > 0 && (c?.creators || []).some((cr) => Number(cr?.clientCost) > 0);
const countsInMetrics = (c) =>
  LIVE_STAGES.has(c?.stage) || ((c?.creators || []).some(isCreatorLive) && isPriced(c));

app.get("/api/portal/campaigns", async (req, res) => {
  try {
    const scope = await resolveBrandScope(req.query);
    if (!requireBrandScope(res, scope)) return;
    const campaigns = await Campaign.find({ brandId: scope.id, deleted: { $ne: true } }).lean();
    await hydrateCampaignCreators(campaigns);
    res.json(
      campaigns.map(({ _id, ...c }) => {
        for (const k of CAMPAIGN_PRIVATE) delete c[k];
        c.creators = (c.creators || []).map((cr) =>
          withRosterRef(
            withClientCost(
              CREATOR_PUBLIC.reduce((safe, k) => (k in cr ? { ...safe, [k]: cr[k] } : safe), {}),
              cr,
            ),
            cr,
          )
        );
        return { id: _id, ...c };
      })
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Asset review threads ────────────────────────────────────────────────────
// One conversation per reviewable asset on a roster row, stored at
// creators[].<asset>.comments and written from both ends: the brand comments
// from the portal on the file we uploaded (<asset>.fileLink), the team replies
// from the Deliverables tab.
//
// $push against the matched row, never a rewrite of creators[]. The campaign
// PATCH saves the whole array, so a read-modify-write here would race it and
// silently drop whichever note lost — the one failure a review thread cannot
// have.
const MAX_COMMENT = 2000;

// The assets a client may review, and the only values `:asset` may take — it
// is interpolated into an update path, so an allowlist is what stops a request
// writing to an arbitrary field on the roster row.
const REVIEWABLE = ["concept", "demo"];

// The brand's call on a creator we suggested, and the internal status each
// answer sets. A generated roster starts at `suggested` (5th-internal-front
// CR_JOURNEY), so the decision needs no field of its own to be acted on — it
// moves the row into the vocabulary the team already works from.
const BRAND_DECISION = { approve: "shortlisted", reject: "brand_reject" };
// Still the brand's call to make only while the row is at one of those three.
// Once we've reached out, negotiated or locked, the roster has moved past the
// question and a late flip would rewrite a deal already in progress.
const DECIDABLE = new Set(["suggested", ...Object.values(BRAND_DECISION)]);

/**
 * Append one note and hand back the whole thread.
 * `match` is the caller's own scoping — the portal adds the brandId to it,
 * the internal route doesn't need to.
 */
async function appendAssetComment(match, ref, asset, { body, role, author, accountId = null }) {
  const campaign = await Campaign.findOne(match, { creators: 1 }).lean();
  if (!campaign) return null;

  const row = (campaign.creators || []).find((cr) => String(cr?._id) === ref);
  if (!row) return null;

  const comment = {
    id: `cmt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    body, role, author, accountId,
  };
  await Campaign.updateOne(match, { $push: { [`creators.$[c].${asset}.comments`]: comment } },
    { arrayFilters: [{ "c._id": ref }] });

  // The whole thread, not just the new note — either client would otherwise
  // miss a reply that landed while its page was open.
  return { asset, comment, comments: [...(row[asset]?.comments || []), comment] };
}

/** Shared validation, so both routes reject the same things the same way. */
function readComment(req, res) {
  if (!REVIEWABLE.includes(req.params.asset)) {
    res.status(400).json({ error: `Reviewable assets are ${REVIEWABLE.join(", ")}.` });
    return null;
  }
  const body = String(req.body?.text ?? "").trim();
  if (!body) { res.status(400).json({ error: "A comment can't be empty." }); return null; }
  if (body.length > MAX_COMMENT) {
    res.status(400).json({ error: `Keep it under ${MAX_COMMENT} characters.` });
    return null;
  }
  return body;
}

// POST /api/portal/campaigns/:id/creators/:ref/:asset/comments — the brand's note.
//
// The portal's only write against campaign data. Scoped like every other
// /api/portal route: matched on the campaign id AND the brandId, so a
// guessed id from another brand matches nothing. `role` is set here and never
// read from the request — anything arriving on this route is a client note by
// definition.
app.post("/api/portal/campaigns/:id/creators/:ref/:asset/comments", async (req, res) => {
  try {
    const scope = await resolveBrandScope(req.body);
    if (!requireBrandScope(res, scope)) return;
    const body = readComment(req, res);
    if (!body) return;

    const result = await appendAssetComment(
      { _id: req.params.id, brandId: scope.id, deleted: { $ne: true } },
      String(req.params.ref),
      req.params.asset,
      {
        body, role: "client",
        author: String(req.body?.author || "").trim() || "Client",
        // Which portal login wrote it — their own id, never anyone else's.
        accountId: String(req.body?.accountId || "").trim() || null,
      },
    );
    if (!result) return res.status(404).json({ error: "not found" });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/campaigns/:id/creators/:ref/:asset/comments — the team's reply,
// from the internal Deliverables tab. Same append, so a reply and a client
// note landing together can't overwrite each other.
app.post("/api/campaigns/:id/creators/:ref/:asset/comments", async (req, res) => {
  try {
    const body = readComment(req, res);
    if (!body) return;

    const result = await appendAssetComment(
      { _id: req.params.id, deleted: { $ne: true } },
      String(req.params.ref),
      req.params.asset,
      { body, role: "team", author: String(req.body?.author || "").trim() || "5th Avenue" },
    );
    if (!result) return res.status(404).json({ error: "not found" });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/portal/campaigns/:id/creators/:ref/decision — the brand's yes or no
// on a creator we suggested.
//
// Writes the roster row's own `status`, so the answer lands where the internal
// Creators tab already reads from and nothing has to be reconciled later. The
// audit of who said it and when goes on `brandDecision` beside it. Scoped on
// campaign id AND brandId like every /api/portal route.
app.post("/api/portal/campaigns/:id/creators/:ref/decision", async (req, res) => {
  try {
    const scope = await resolveBrandScope(req.body);
    if (!requireBrandScope(res, scope)) return;
    const decision = String(req.body?.decision || "").trim();
    const status = BRAND_DECISION[decision];
    if (!status) return res.status(400).json({ error: "decision must be approve or reject" });

    const match = { _id: req.params.id, brandId: scope.id, deleted: { $ne: true } };
    const ref = String(req.params.ref);
    const campaign = await Campaign.findOne(match, { creators: 1 }).lean();
    const row = (campaign?.creators || []).find((cr) => String(cr?._id) === ref);
    if (!row) return res.status(404).json({ error: "not found" });
    if (!DECIDABLE.has(row.status)) {
      return res.status(409).json({
        error: "This creator has already moved on from here — talk to your team.",
      });
    }

    const brandDecision = {
      decision,
      at: new Date().toISOString(),
      by: String(req.body?.author || "").trim() || "Client",
      accountId: String(req.body?.accountId || "").trim() || null,
    };
    // $set through arrayFilters rather than a read-modify-write of creators[]:
    // the internal app PATCHes that array wholesale, and rewriting it from here
    // would drop whatever it saved in between.
    await Campaign.updateOne(
      match,
      { $set: { "creators.$[c].status": status, "creators.$[c].brandDecision": brandDecision } },
      { arrayFilters: [{ "c._id": ref }] },
    );

    res.json({ status, brandDecision });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/portal/client?brand=BRANDID — the brand's own company record, for the
// portal's Settings → Company panel.
//
// An ALLOWLIST for the same reason CREATOR_PUBLIC above is one: Client is
// `strict: false`, so a denylist would publish every field anyone ever adds.
// The Client document is mostly *our* working notes ON the brand — the FAAVI
// score, the audit issues list with its priority scoring, channel benchmarks,
// competitor mapping, package and open-recommendation counts. None of that is
// the brand's to read from a self-serve portal; it's what the account team
// presents, with context, in a review. What's left is the factual company
// profile the brand told us in the first place, plus who looks after them.
const CLIENT_PUBLIC = ["name", "website", "consultant"];
// profile{} is nested and carries the same distinction, so it gets its own list.
const CLIENT_PROFILE_PUBLIC = [
  "type", "industry", "subIndustry", "stage", "founded", "employees", "geography",
];

app.get("/api/portal/client", async (req, res) => {
  try {
    const scope = await resolveBrandScope(req.query);
    if (!requireBrandScope(res, scope)) return;
    const doc = await Client.findById(scope.id, OMIT_AVATAR).lean();
    if (!doc) return res.status(404).json({ error: "not found" });

    const pick = (src, keys) =>
      keys.reduce((out, k) => (src?.[k] == null || src[k] === "" ? out : { ...out, [k]: src[k] }), {});

    res.json({
      id: doc._id,
      ...pick(doc, CLIENT_PUBLIC),
      // The brand's own logo — its identity, and the fallback picture for
      // members who haven't set one. Bytes come from /api/clients/:id/avatar;
      // this is just the witness, same contract as clientPub().
      hasAvatar: !!doc.avatarUpdatedAt,
      avatarUpdatedAt: doc.avatarUpdatedAt || null,
      profile: pick(doc.profile, CLIENT_PROFILE_PUBLIC),
      products: Array.isArray(doc.products) ? doc.products : [],
      createdAt: doc.createdAt || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/portal/trending — the Insights → Trending shelf: Instagram links
// and short notes the internal team curates by hand (see POST/PATCH/DELETE
// /api/trending above). Deliberately UNIVERSAL, unlike every other /api/portal
// route on this page: every brand sees the same feed, so — unlike
// /api/portal/reels and /api/portal/client — this one takes no brand scope
// and needs none to resolve before it can answer.
app.get("/api/portal/trending", async (req, res) => {
  try {
    const rows = await TrendingItem.find({}).sort({ createdAt: -1 }).lean();
    res.json({
      items: rows.map(({ _id, brandId, ...rest }) => ({ id: _id, ...rest })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Clients (Company Overview) ─────────────────────────────────────────────

// Shared shaping for every client response. `avatarImage` is dropped for weight,
// not secrecy — the bytes are served from /api/clients/:id/avatar instead, and
// `hasAvatar` is derived from `avatarUpdatedAt` so it stays correct even when
// the query projected the bytes away. Mirrors pub() in routes/auth.js.
const clientPub = ({ _id, avatarImage, avatarUpdatedAt, ...rest }) => ({
  id: _id,
  hasAvatar: !!avatarUpdatedAt,
  avatarUpdatedAt: avatarUpdatedAt || null,
  ...rest,
});

// GET /api/clients — list all clients
app.get("/api/clients", async (req, res) => {
  try {
    // Logo bytes projected away at the query: this list is fetched by the app
    // shell's brand filter on EVERY page load, so it is the single hottest
    // endpoint in the product and has no business carrying images.
    const clients = await Client.find({}, OMIT_AVATAR).lean();
    res.json(clients.map(clientPub));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients — create a new client
app.post("/api/clients", async (req, res) => {
  try {
    const c = req.body;
    if (!c.id) return res.status(400).json({ error: "id is required" });
    const body = { ...c, _id: c.id };
    try { withAvatar(body, c); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const doc = await Client.create(body);
    res.status(201).json(clientPub(doc.toObject()));
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: "A client with this id already exists." });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/clients/:id — partial update
app.patch("/api/clients/:id", async (req, res) => {
  try {
    const patch = { ...req.body };
    // Absent = logo untouched; null = removed; data URI = replaced. An edit to
    // any other field must not disturb the logo.
    try { withAvatar(patch, req.body); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const updated = await Client.findByIdAndUpdate(
      req.params.id,
      { $set: patch },
      { new: true, projection: OMIT_AVATAR }
    ).lean();
    if (!updated) return res.status(404).json({ error: "not found" });
    res.json(clientPub(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id/avatar — the brand's logo bytes, cached immutably and
// read through ?v=<avatarUpdatedAt>. Registered before nothing else matches
// /api/clients/:id, so no ordering hazard.
app.get("/api/clients/:id/avatar", serveAvatar(Client));

// GET /api/logo-suggestion?website=nike.com — the brand's own site icon, as a
// data URI for the "use this as the logo?" confirmation.
//
// Read-only and not client-scoped: the founder can preview a logo for a brand
// that has no website saved yet (none of them do), and accepting it is a normal
// PATCH /api/clients/:id like any other logo change. See faviconFetch.js.
app.get("/api/logo-suggestion", async (req, res) => {
  try {
    const result = await suggestLogo(req.query.website);
    // 422, not 500: a site with no usable icon is an expected answer, and the
    // message is written for the founder to act on ("upload one instead").
    if (result.error) return res.status(422).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Findings (Audit Centre) ──────────────────────────────────────────────────

// GET /api/findings?clientId=fb — list findings, optionally filtered by client
app.get("/api/findings", async (req, res) => {
  try {
    const q = {};
    if (req.query.clientId) q.clientId = req.query.clientId;
    const findings = await Finding.find(q).lean();
    res.json(findings.map(({ _id, ...rest }) => ({ id: _id, ...rest })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/findings/:id — update status (open/develop/task/monitor/ignored)
app.patch("/api/findings/:id", async (req, res) => {
  try {
    const updated = await Finding.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    ).lean();
    if (!updated) return res.status(404).json({ error: "not found" });
    const { _id, ...rest } = updated;
    res.json({ id: _id, ...rest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Instagram lookup (Add Creator auto-fetch) ───────────────────────────────
// GET /api/instagram?handle=https://www.instagram.com/someuser/
app.get("/api/instagram", async (req, res) => {
  try {
    const handle = req.query.handle;
    if (!handle) return res.status(400).json({ error: "handle query param is required" });
    const result = await fetchInstagramProfile(handle);
    if (result.error) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── YouTube channel lookup (Add Creator auto-fetch, YouTube creators) ───────
// GET /api/youtube?handle=https://www.youtube.com/@somechannel (or @handle)
// Same response shape as /api/instagram so the frontend card renders both.
app.get("/api/youtube", async (req, res) => {
  try {
    const handle = req.query.handle;
    if (!handle) return res.status(400).json({ error: "handle query param is required" });
    const result = await fetchYouTubeChannel(handle);
    if (result.error) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Post metrics (Deliverables tab tracking) ────────────────────────────────
// GET /api/post-metrics?url=&platform= — dispatches on the link/platform:
// Instagram via HikerAPI, YouTube via the Data API.
app.get("/api/post-metrics", async (req, res) => {
  try {
    const { url, platform } = req.query;
    if (!url) return res.status(400).json({ error: "url query param is required" });
    const result = await fetchPostMetrics(url, platform);
    if (result.error) return res.status(502).json(result);
    res.json(result);

    // The response we just paid for carries the video, poster and caption the
    // portal's Reels shelf needs, and they were being dropped on the floor here
    // — exactly the waste refreshPostMetrics.js already avoids by handing its
    // own responses over. A hand-refreshed post now updates the brand's shelf
    // too, for nothing.
    //
    // After res.json and deliberately not awaited: the Deliverables button must
    // never wait on a cache write, and a failed one is not the caller's problem.
    // Only the v2 branch carries RAW_MEDIA (see postMetrics.js).
    const media = result[RAW_MEDIA];
    if (media) cacheReelFromMedia(String(url), media, { platform }).catch(() => {});
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Follower counts are stored compact and inconsistently — the creators
// directory keeps whatever was typed or scraped ("820K", "1.2M", "213001",
// 11606, ""), so this normalizes all of it to a number. Anything it can't
// parse is 0 rather than NaN, which would poison every sum downstream.
function parseFollowers(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (typeof raw !== "string") return 0;
  const up = raw.trim().toUpperCase().replace(/,/g, "");
  const mp = up.match(/^([\d.]+)\s*([KM])?$/);
  if (!mp) return 0;
  const n = parseFloat(mp[1]);
  if (!Number.isFinite(n)) return 0;
  return n * (mp[2] === "M" ? 1e6 : mp[2] === "K" ? 1e3 : 1);
}

// ── Client Portal Analytics ─────────────────────────────────────────────────
// GET /api/portal/reels?brand=BRANDID — the brand's live campaign posts, with
// the video, poster and caption Instagram holds, for the portal's Reels shelf.
//
// No allowlist pass here, unlike the two routes above: portalReels.js builds
// each reel field by field from the media object, so nothing internal is in the
// payload to strip. Everything returned is already public on the post itself.
//
// This route makes NO HikerAPI call in steady state — it reads the reel_cache
// collection, which the nightly jobs populate (and which the post-metrics job
// fills for free from calls it was already making). It used to fetch behind a
// process-local Map, which meant every deploy or idle recycle re-bought the
// whole shelf; see the header of portalReels.js.
app.get("/api/portal/reels", async (req, res) => {
  try {
    const scope = await resolveBrandScope(req.query);
    if (!requireBrandScope(res, scope)) return;
    res.json({ reels: await getClientReels(scope) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/portal/reels/:code/poster — one reel's cover frame, from bytes we
// own, keyed by the Instagram shortcode.
//
// This route is why the shelf no longer decays. `reel.thumbnail` is a signed
// CDN link that dies ~106h after it is issued, so every card was on a clock
// that only a paid refresh could reset — and when a refresh was missed the
// brand simply saw a broken tile (one post in this collection sat 50h past its
// signature). The bytes behind this route were copied once and expire never.
//
// Public for the same reason the reels payload is: a campaign cover frame is
// already public on Instagram. Immutable caching plus the `?v=` the client
// appends means a replaced poster is picked up at once despite the long
// max-age — the same contract as every avatar route here.
app.get("/api/portal/reels/:code/poster", async (req, res) => {
  try {
    const poster = await getReelPoster(req.params.code);
    const bytes = toBuffer(poster?.data);
    if (!bytes) return res.status(404).json({ error: "no poster stored for this post" });
    res.set("Content-Type", poster.contentType || "image/jpeg");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(bytes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/portal/analytics?brand=BRANDID&from=ISO&to=ISO
// Returns one dated event per campaign in the period (spend/reach/engagement
// metrics, dated by campaign start) plus a spend-by-service split. The portal
// buckets events into daily/weekly/monthly series client-side (see
// 5th-avenue-client-front src/lib/dates.js bucketSeries), so switching
// granularity never needs a refetch.
// Reach  = sum of creator followers (audience reach potential per campaign)
// Impressions = measured post views where we have them, else reach × 0.12
// Engagements = measured likes+comments+forwards where we have them, else reach × avgER
// Clicks = engagements × 0.08 (always an estimate — nothing tracks clicks)
// Measured vs estimated is reported per event so the portal can say which it is.
//
// Two bugs lived here, and both rendered the portal's headline numbers as 0
// while spend showed correctly — the shape a reader is most likely to read as
// "the campaign did nothing" rather than "the page is broken".
//
//  1. This read cr.followers / cr.avgER straight off the campaign document.
//     Those fields have not lived there since creator profiles moved into the
//     `creators` collection — they belong to the directory now and come back
//     only via hydrateCampaignCreators(), which every other read path already
//     calls (see /api/campaigns and /api/portal/campaigns). This endpoint was
//     written before the split and never migrated, so followers was undefined
//     for every creator, reach summed to 0, and impressions/engagements/clicks
//     -- all derived from reach -- collapsed with it.
//
//  2. Even with reach restored, every number here was still an estimate off
//     the follower count while cr.tracking held real measured view/like counts
//     fetched from the post itself. The portal's own footnote promised "real
//     tracking data updates when 5th Avenue refreshes post metrics"; nothing
//     ever read it. Measured data now wins per creator, falling back to the
//     estimate only for creators whose posts have not been fetched yet.
//
// NOTE: impressions can legitimately exceed reach once measured data is in
// play. Views count repeat views and non-followers (reels travel to explore),
// whereas reach is only the creator's own follower base. That is virality, not
// a bad number — the funnel in the portal is built to show it as a rise.
//
// GATED ON LIVE. Spend is committed when a campaign is booked; performance
// only exists once something is posted. A campaign with nothing up reports
// `live: false` and the portal drops it from every total, the trend line and
// the spend split. `spendByService` and `excluded` are pre-aggregated on the
// same rule — the portal can't re-derive a split it is handed as a map.
app.get("/api/portal/analytics", async (req, res) => {
  try {
    const scope = await resolveBrandScope(req.query);
    if (!requireBrandScope(res, scope)) return;

    const from = req.query.from ? new Date(req.query.from) : new Date(new Date().getFullYear(), 0, 1);
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();

    // Filtered here, not in the query: one predicate shared with the portal
    // beats the same rule written twice in two languages. It reads only fields
    // on the campaign itself, so it runs before the creator join, not after.
    const campaigns = (await Campaign.find({ brandId: scope.id, deleted: { $ne: true } }).lean())
      .filter(countsInMetrics);
    // Rejoins each roster entry with its profile in the creators directory.
    // Without this, followers/avgER are undefined and every metric below is 0.
    await hydrateCampaignCreators(campaigns);

    // Campaign.start/end are stored as ISO ("YYYY-MM-DD"). Legacy rows that
    // predated this (month-first "Mar 1", day-first "3 Jul") were normalized
    // to ISO via a one-time migration.
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    function parseISO(s) {
      if (!s || !ISO_DATE.test(s)) return null;
      const d = new Date(`${s}T00:00:00`);
      return isNaN(d) ? null : d;
    }

    const events = [];
    const spendByService = {};
    // What the numbers above leave out, so the portal can say so outright
    // instead of presenting a partial account as the whole one.
    const excluded = { campaigns: 0, spend: 0 };

    campaigns.forEach(c => {
      const startDate = parseISO(c.start);
      if (!startDate || startDate < from || startDate > to) return;

      // Per creator: use what was actually measured on their post, and fall
      // back to the follower-based estimate only for creators whose posts
      // haven't been fetched yet. Done per creator rather than per campaign so
      // a roster that is half-tracked reports the real numbers for the half we
      // have instead of discarding them.
      const creators = c.creators || [];
      let reach = 0, impressions = 0, engagements = 0;
      let measuredCreators = 0, liveCreators = 0;

      creators.forEach(cr => {
        const f = parseFollowers(cr.followers) || parseFollowers(cr.igFetched?.followers);
        reach += f;
        if (isCreatorLive(cr)) liveCreators++;

        // Directory ER first; otherwise derive it from the IG profile snapshot
        // stored on the campaign (avgLikes+avgComments over followers), which
        // is the only ER available for creators added by handle lookup.
        let er = Number(cr.avgER) > 0 ? Number(cr.avgER) : 0;
        if (!er && cr.igFetched && f > 0) {
          const likes = Number(cr.igFetched.avgLikes) || 0;
          const comments = Number(cr.igFetched.avgComments) || 0;
          if (likes || comments) er = ((likes + comments) / f) * 100;
        }

        const t = cr.tracking || {};
        const hasMeasured = t.views != null || t.likes != null;
        if (hasMeasured) {
          measuredCreators++;
          impressions += Number(t.views) || 0;
          engagements += (Number(t.likes) || 0) + (Number(t.comments) || 0) + (Number(t.forwards) || 0);
        } else {
          impressions += Math.round(f * 0.12);
          engagements += Math.round(f * (er / 100));
        }
      });

      // No click tracking exists anywhere in the pipeline, so this stays an
      // estimate even when everything above it was measured.
      const clicks = Math.round(engagements * 0.08);
      // 0 for a campaign raised before the client agreed a budget. Reported as
      // a flag rather than left to be inferred from the zero, so the portal can
      // label the campaign instead of charting it as having cost nothing.
      const budgetAgreed = Number(c.budget) > 0;
      const spend  = budgetAgreed ? Number(c.budget) : 0;
      const live = liveCreators > 0;

      events.push({
        date: c.start, campaign: c.name,
        spend, budgetPending: !budgetAgreed, reach, engagements, impressions, clicks,
        // Whether anything is actually posted. The portal reads this before it
        // reads any of the figures above — see the header note.
        live, liveCreators,
        // Lets the portal label the campaign honestly rather than presenting
        // an estimate and a measurement in the same typeface.
        measured: measuredCreators > 0,
        measuredCreators, totalCreators: creators.length,
      });

      if (!live) {
        excluded.campaigns++;
        excluded.spend += spend;
        return;
      }

      // Spend split by service — same period filter as the events above, so
      // "Spend Split · selected period" actually reflects the period.
      // Skipped entirely when nothing has been agreed. `+ 0` still CREATES the
      // bucket, so a service whose only campaign has no budget yet appeared in
      // the client's spend split at ₹0 — a service we are billing them nothing
      // for, listed alongside ones we are.
      const svc = (c.service || "Other").trim();
      if (budgetAgreed) spendByService[svc] = (spendByService[svc] || 0) + spend;
    });

    res.json({
      events,
      spendByService,
      excluded,
      note: "events with live=false have no post up yet and are excluded from spendByService/excluded-adjusted totals; reach=followers sum; impressions/engagements measured from post metrics where available, else impressions≈reach×0.12 and engagements≈reach×avgER; clicks≈engagements×0.08 (always estimated)",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/post-metrics/refresh-all — run the nightly job now.
// Exists so the scheduled job can be verified (and re-run after an outage)
// without waiting for midnight or redeploying. Returns the same summary the
// scheduler logs.
app.post("/api/post-metrics/refresh-all", async (req, res) => {
  try {
    res.json(await refreshAllPostMetrics());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/portal/reels/refresh-all — run the reel-cache job now.
// Same purpose as the route above: verify the job, or repopulate after an
// outage, without waiting for 01:00 IST. Honours the TTL, so calling it twice
// in a row costs nothing the second time.
app.post("/api/portal/reels/refresh-all", async (req, res) => {
  try {
    res.json(await refreshAllReels());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/portal/reels/backfill-posters — copy the poster frame for every
// cached reel that predates the poster store. Costs no HikerAPI calls: it reads
// the signed thumbnail each row already holds. One-shot in practice, but safe
// to run again — rows that already have a poster are skipped.
app.post("/api/portal/reels/backfill-posters", async (req, res) => {
  try {
    res.json(await backfillPosters());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/health — liveness, and the wake-up call the sign-in pages make.
//
// It pings Mongo rather than answering from memory alone. Both frontends hit
// this the moment their login page mounts, and the point is to pay the cold
// start while someone is typing their password instead of after they submit:
// on a host that sleeps an idle service, the first request also has to spin the
// process up and open a fresh connection pool. An `{ok:true}` that never
// touched the database would warm the process and leave the slow half undone.
//
// `db:false` is still a 200. This route says the service is reachable; a failed
// ping is information for the caller, not a reason to look down.
app.get("/api/health", async (req, res) => {
  let db = false;
  try {
    await mongoose.connection.db.admin().command({ ping: 1 });
    db = true;
  } catch {}
  res.json({ ok: true, db });
});

const PORT = process.env.PORT || 4000;

connectDB().then(() => {
  app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
  // After the DB is up — the jobs query Mongo directly.
  startScheduler();
});
