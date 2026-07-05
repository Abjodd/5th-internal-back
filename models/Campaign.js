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
    service: String,
    region: String,
    stage: String,
    progress: Number,
    budget: Number,
    creatorBudget: Number,
    numReq: Number,
    start: String,
    end: String,
    bmId: String,
    cmId: String,
    eaId: String,
    brief: mongoose.Schema.Types.Mixed,
    briefStatus: String,
    bmNote: String,
    cmNote: String,
    creators: { type: [mongoose.Schema.Types.Mixed], default: [] },
    genRounds: Number,
    sentToClient: Boolean,
    internalNotes: String,
    timeline: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { strict: false, versionKey: false }
);

export default mongoose.model("Campaign", CampaignSchema, "campaigns");
