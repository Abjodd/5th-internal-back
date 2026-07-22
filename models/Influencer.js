import mongoose from "mongoose";

// Influencers directory — the persistent, deduped record of every creator
// who has ever been added to a campaign (see routes/influencers.js for the
// sync logic that keeps this collection in step with Campaign.creators).
//
// _id is the same dedupe key the old aggregation-only endpoint used to
// generate on the fly (lower-cased handle, else name) — kept identical so
// existing invoice matching (by creatorHandle/creatorName) and the frontend
// row-key contract don't need to change.
//
// `campaigns` is a denormalized snapshot (one entry per campaign the creator
// appears in) refreshed every time that campaign is created/updated —
// campaigns stay the operational record for per-campaign fields (fee,
// status, concept/demo); this collection is the standalone, queryable
// directory of the creator's profile + where they've worked.
const InfluencerSchema = new mongoose.Schema(
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
    campaigns: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { strict: false, versionKey: false, timestamps: true }
);

export default mongoose.model("Influencer", InfluencerSchema, "influencers");
