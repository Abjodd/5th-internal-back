import mongoose from "mongoose";

/**
 * One item on the Insights → Trending shelf: either an Instagram link the
 * internal team wants to surface, or a short note typed straight in. Written
 * by the internal app (see registerCrudRoutes("/api/trending", ...) in
 * server.js), read by the client portal (GET /api/portal/trending).
 *
 * Deliberately universal — one shelf, not one per brand. Every client sees
 * the same feed, so there is no brandId here the way there is on Campaign or
 * Finding; scoping this per-brand was tried and explicitly dropped.
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
