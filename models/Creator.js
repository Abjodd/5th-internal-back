import mongoose from "mongoose";

// Creators directory — the single source of truth for a creator's profile.
// Campaign documents no longer embed a copy of these fields: each campaign's
// creators[] entry only holds campaign-specific data (fee, status,
// concept/demo/live, tracking) plus a `creatorId` pointing back here. See
// creatorSync.js for the split-on-write / hydrate-on-read logic that keeps
// the two in step, and routes/creators.js for this collection's own routes.
//
// _id is the dedupe key (lower-cased handle, else name) — kept stable so
// existing invoice matching (by creatorHandle/creatorName) and the frontend
// row-key contract don't need to change.
//
// "Where they've worked" is derived at read time from Campaign.creatorIds
// rather than stored here, so it can never go stale.
const CreatorSchema = new mongoose.Schema(
  {
    _id: { type: String }, // dedupe key — lower-cased handle, else name
    name: String,
    handle: String,
    platform: String,
    igUrl: String,
    followers: mongoose.Schema.Types.Mixed, // stored compact ("820K") like Campaign.creators
    avgLikes: mongoose.Schema.Types.Mixed,
    avgER: Number,
    niche: String,
    state: String,
    phone: String,
    payType: String,
    payId: String,
    personalDetails: {
      pan: String,
      email: String,
      address: String,
      bankName: String,
      bankAccount: String,
      bankBranch: String,
      ifsc: String,
      upiId: String,
    },
  },
  { strict: false, versionKey: false, timestamps: true }
);

export default mongoose.model("Creator", CreatorSchema, "creators");
