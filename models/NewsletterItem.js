import mongoose from "mongoose";

/**
 * One PDF uploaded to a brand's Insights → Newsletter section — the
 * internal team's periodic newsletter, sent out per brand. Written by the
 * internal app (POST /api/newsletter in server.js), read by that brand's
 * own portal (GET /api/portal/newsletter). Brand-scoped like
 * MarketWatchItem, not universal like Trending: each brand keeps its own
 * newsletter history, not one shared feed.
 *
 * `file` holds the PDF bytes inline (see pdfUpload.js for why, and
 * for the 2MB cap) — every list query must project it away with
 * OMIT_FILE so a history list stays light; the PDF itself is
 * served from its own byte-serving route, the same shape as
 * avatarStore.js's serveAvatar.
 */
const NewsletterItemSchema = new mongoose.Schema(
  {
    _id: { type: String },        // client-generated id, matches the other CRUD collections
    brandId: { type: String, index: true }, // same id as Client._id — scopes this item to one brand
    title: { type: String },      // shown in the history list — defaults to the uploaded filename
    file: { data: Buffer, contentType: String, size: Number },
    uploadedAt: { type: Date, default: Date.now },
    author: String,               // who on the internal team uploaded it
  },
  { versionKey: false }
);

export default mongoose.model("NewsletterItem", NewsletterItemSchema, "newsletteritems");
