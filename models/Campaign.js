import mongoose from "mongoose";

// Flexible schema — campaign objects mirror the shape already used in the
// frontend (brief, creators[], timeline[], etc). We keep this loose
// (strict:false) so the frontend object can be stored/returned as-is
// without needing to keep two schemas in lockstep.
//
// IMPORTANT: do NOT add `_id: false` to the schema options below. Doing so
// together with an explicit `_id: { type: String }` path (as we have here,
// so campaigns keep readable ids like "c1") breaks Mongoose's internal
// casting for findById / findByIdAndUpdate — every PATCH (e.g. moving a
// campaign to the next pipeline stage) then silently fails to match the
// document. This was the root cause of pipeline stage changes not
// persisting to the database.
const CampaignSchema = new mongoose.Schema(
  {
    _id: { type: String }, // e.g. "c1" — keeps frontend ids stable
    name: String,
    client: String,
    brandId: String, // FK to Client._id — "client" stays as a denormalized display name
    service: String,
    region: String,
    // The FINANCE track only:
    //   draft → brief_locked → team_assigned → po_raised → advance_received
    //         → invoice_raised → payment_done
    // Deliberately an unconstrained String. Retired ids from two earlier
    // vocabularies are still on documents here and are remapped on read by the
    // frontend's normStage() (src/lib/campaign.js), which self-heals each
    // document on its next save — an enum would reject them on write instead.
    //
    // There is no execution stage stored anywhere. Delivery is derived from
    // creators[] on every read (executionStageOf), so a campaign can never
    // hold a delivery stage that disagrees with its own roster.
    stage: String,
    progress: Number,
    budget: Number,
    creatorBudget: Number,
    numReq: Number,
    // How many posts each creator is briefed for. The PLAN, not a cap — a
    // creator's own `numDeliverables` (on their creators[] entry) overrides it
    // for that row, so a roster where one creator does two reels and the rest
    // do one is expressible without a second campaign.
    deliverablesPerCreator: Number,
    start: String,
    end: String,
    amId: String,
    cmId: String,
    eaId: String,
    brief: mongoose.Schema.Types.Mixed,
    briefStatus: String,
    bmNote: String,
    cmNote: String,
    // Slim, campaign-specific records only (fee, status, concept/demo/live,
    // tracking, invoiceNo, ...) — each entry's `creatorId` is a FK into the
    // `creators` collection (models/Creator.js), which owns the profile
    // (name, handle, platform, followers, niche, personalDetails, ...).
    // Split-on-write / hydrated-on-read by creatorSync.js so the API still
    // returns one flat merged object per creator, same shape as always.
    creators: { type: [mongoose.Schema.Types.Mixed], default: [] },
    // Denormalized index into the creators directory — creatorIds[i] is the
    // creatorId of creators[i]. Kept in step by the campaign POST/PATCH
    // handlers so campaigns can be queried/joined by creator without scanning
    // the embedded objects.
    creatorIds: { type: [String], default: [] },
    genRounds: Number,
    sentToClient: Boolean,
    internalNotes: String,
    timeline: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { strict: false, versionKey: false }
);

export default mongoose.model("Campaign", CampaignSchema, "campaigns");
