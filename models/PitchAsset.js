// models/PitchAsset.js
//
// Image bytes for pitch-draft links — the suggested-content poster frames and
// candidate profile photos — copied off Instagram's CDN the moment they're
// added and served from our own route (GET /api/pitch-drafts/asset/:key).
//
// Why bytes and not the URL: an Instagram CDN URL is signed and dies in days
// (poster ~106h, video ~32h — measured in portalReels.js). A pitch link is
// meant to live for as long as the pitch exists, so anything it shows has to
// outlive the signature. Same reasoning, and the same { data, contentType }
// shape, as Creator.avatarImage (avatarStore.js) and ReelCache.poster
// (portalReels.js).
//
// Its own small collection rather than a field on PitchDraft: a draft is read
// whole on every editor load and every client-link open, and dragging a
// dozen images' bytes along with each read would make both slow. Keys are
// `sc_<contentId>` (poster) and `pf_<draftId>_<profileId>` (photo).
import mongoose from "mongoose";

const PitchAssetSchema = new mongoose.Schema(
  {
    _id: { type: String },
    data: Buffer,
    contentType: String,
    updatedAt: Date,
  },
  { versionKey: false },
);

export default mongoose.model("PitchAsset", PitchAssetSchema, "pitchassets");
