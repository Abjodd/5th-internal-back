import mongoose from "mongoose";
import { AVATAR_FIELDS } from "../avatarStore.js";

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
    // Languages the creator publishes in. Collected on the public application
    // form (models/CreatorRequest.js) and carried across on promotion. The
    // client portal's Regional Map falls back to the primary language of the
    // creator's state when this is empty, which is a guess — this is the
    // creator's own answer.
    languages: { type: [String], default: [] },
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
    // The creator's profile photo, stored inline exactly like a user's or a
    // brand's — see avatarStore.js for why bytes live on the document, and
    // remoteAvatar.js for why the platform's own URL is copied rather than
    // kept. NEVER returned by the list route; see OMIT_AVATAR in
    // routes/creators.js.
    ...AVATAR_FIELDS,
  },
  { strict: false, versionKey: false, timestamps: true }
);

export default mongoose.model("Creator", CreatorSchema, "creators");
