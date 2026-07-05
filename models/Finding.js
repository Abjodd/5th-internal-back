import mongoose from "mongoose";

// One document per audit finding. clientId + channel let us reproduce the
// ALL_FINDINGS[clientId][channel] grouping that AuditCentre.jsx expects.
const FindingSchema = new mongoose.Schema(
  {
    _id: { type: String },       // e.g. "fb-aeo-1"
    clientId: { type: String, index: true },
    channel: String,             // "aeo", "seo", "meo", etc.
    cat: String,                 // "auto" | "manual"
    sev: String,                 // critical | high | medium | low
    pri: Number,
    imp: Number,
    eff: Number,
    conf: Number,
    status: String,              // open | develop | task | monitor | ignored
    title: String,
    finding: String,
    insight: String,
    recommendation: String,
  },
  { strict: false, versionKey: false }
);

export default mongoose.model("Finding", FindingSchema, "findings");
