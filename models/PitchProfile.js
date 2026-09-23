import mongoose from "mongoose";

// A pitch is the pre-sale step before a creator is committed to a campaign's
// roster: the internal team drops in a handful of candidate profiles for one
// campaign, sends the client a code-gated link (see routes/pitch.js), and the
// client marks each one approved or rejected. Deliberately its OWN collection
// rather than a Campaign.creators[] row at status "suggested" — that existing
// vocabulary (see server.js BRAND_DECISION/DECIDABLE) is for a brand reviewing
// a roster the team has already committed to negotiating; a pitch is earlier
// and lighter than that, and not every profile shown to a client is meant to
// become a real roster entry. An approved pitch only becomes a creators[] row
// once the internal team clicks "Ship to Creators" (see PATCH .../ship below),
// which is a deliberate, separate act — see routes/pitch.js for why.
//
// The client's link/access code is brand-wide (Client.pitchCode), not per
// campaign — one link shows a client everything ever pitched to them, across
// every campaign — but each pitch still remembers which campaign it was
// pitched under (campaignId), both so "Ship to Creators" knows which
// roster to land in, and so the client-facing list can label each card.
const PitchProfileSchema = new mongoose.Schema(
  {
    _id: { type: String }, // e.g. "pp_<timestamp>_<rand>"
    campaignId: String,    // FK to Campaign._id — which roster this ships into
    brandId: String,       // FK to Client._id — what the client-wide link/code scopes by
    // Profile snapshot at the moment it was pitched — a client's decision
    // should read the same numbers the internal team saw when they pitched
    // it, not whatever the creator's follower count has drifted to since.
    creatorId: String,     // FK into the Creator directory. Set whether the
                            // profile was already known (source: "directory")
                            // or freshly fetched and upserted into the
                            // directory on the spot (source: "hiker") — see
                            // upsertCreatorFromFetch in creatorSync.js.
    profileUrl: String,    // what the internal team pasted in
    handle: String,
    platform: String,
    name: String,
    bio: String,
    avatar: String,        // profile_pic_url, as returned by Hiker/the directory
    externalUrl: String,
    followers: mongoose.Schema.Types.Mixed,
    following: mongoose.Schema.Types.Mixed,
    posts: mongoose.Schema.Types.Mixed,
    avgLikes: mongoose.Schema.Types.Mixed,
    avgComments: mongoose.Schema.Types.Mixed,
    avgViews: mongoose.Schema.Types.Mixed,
    avgER: Number,
    isVerified: Boolean,
    isPrivate: Boolean,
    isBusiness: Boolean,
    source: { type: String, enum: ["directory", "hiker"], default: "hiker" },
    // The client's call. "pending" until they decide; changeable back and
    // forth until `shipped` locks it in, mirroring DECIDABLE's own "still
    // reversible until acted on" rule for the roster-decision flow.
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    decision: {
      at: Date,
      by: String, // whoever the client identified themselves as, free text
    },
    addedBy: String, // internal team member who pitched this profile
    shipped: { type: Boolean, default: false },
    shippedAt: Date,
    // The campaigns[].creators[] row id this became, once shipped — lets the
    // internal UI link straight to it instead of just showing a checkmark.
    shippedCreatorRef: String,
  },
  { strict: false, versionKey: false, timestamps: true }
);

export default mongoose.model("PitchProfile", PitchProfileSchema, "pitch_profiles");
