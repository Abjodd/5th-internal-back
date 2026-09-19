import mongoose from "mongoose";

/**
 * One item on a brand's Insights → Market Watch shelf: either an Instagram
 * link the internal team wants to surface for that brand, or a short note
 * typed straight in. Written by the internal app (see the hand-written
 * /api/market-watch routes in server.js), read by that brand's own portal
 * (GET /api/portal/market-watch).
 *
 * Same shape as TrendingItem — a reel carries `url` (what was pasted in) AND
 * `media`, a snapshot fetched from HikerAPI exactly once at save time (see
 * fetchReelSnapshot in portalReels.js, called from POST /api/market-watch) —
 * but PER BRAND, which is the one thing Trending explicitly is not: `brandId`
 * (the same id as Client._id) scopes every document to the one brand it was
 * added for, so each brand's internal team sees only their own items and each
 * brand's portal reads only its own feed.
 */
const MarketWatchItemSchema = new mongoose.Schema(
  {
    _id: { type: String },        // client-generated id, matches the other CRUD collections
    brandId: { type: String, index: true }, // same id as Client._id — scopes this item to one brand
    kind: { type: String },       // "reel" (an Instagram link) | "note" (typed insight)
    url: String,                  // kind: "reel"
    text: String,                 // kind: "note" — the answer
    topic: String,                // kind: "note" — the topic the answer is about; optional so notes added before this field existed still read fine with none
    author: String,               // who on the internal team added it
    createdAt: { type: Date, default: Date.now },
  },
  { strict: false, versionKey: false }
);

export default mongoose.model("MarketWatchItem", MarketWatchItemSchema, "marketwatchitems");
