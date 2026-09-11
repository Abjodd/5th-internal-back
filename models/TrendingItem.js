import mongoose from "mongoose";

/**
 * One item on the Insights → Trending shelf: either an Instagram link the
 * internal team wants to surface, or a short note typed straight in. Written
 * by the internal app (see the hand-written /api/trending routes in
 * server.js), read by the client portal (GET /api/portal/trending).
 *
 * Deliberately universal — one shelf, not one per brand. Every client sees
 * the same feed, so there is no brandId here the way there is on Campaign or
 * Finding; scoping this per-brand was tried and explicitly dropped.
 *
 * A reel carries `url` (what was pasted in) AND `media` — a snapshot fetched
 * from HikerAPI exactly once, at the moment the row was created (see
 * fetchReelSnapshot in portalReels.js, called from POST /api/trending). That
 * one fetch is the only HikerAPI credit this reel ever costs: `media` is
 * never re-fetched — not on a nightly job, not on PATCH, not when the client
 * views it — the client just reads `media` straight back out of this
 * document. `media.ok === false` (or a missing `media`) means the fetch
 * failed or the row predates this behavior; the client falls back to a plain
 * "Open on Instagram" card for those. `strict: false` stays on because
 * `media` is an arbitrary snapshot shape (see toReel in portalReels.js), not
 * one worth mirroring field-by-field into this schema.
 */
const TrendingItemSchema = new mongoose.Schema(
  {
    _id: { type: String },        // client-generated id, matches the other CRUD collections
    kind: { type: String },       // "reel" (an Instagram link) | "note" (typed insight)
    url: String,                  // kind: "reel"
    text: String,                 // kind: "note"
    author: String,               // who on the internal team added it
    createdAt: { type: Date, default: Date.now },
  },
  { strict: false, versionKey: false }
);

export default mongoose.model("TrendingItem", TrendingItemSchema, "trendingitems");
