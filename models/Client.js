import mongoose from "mongoose";

// Loose schema mirroring the CLIENTS objects in CompanyOverview.jsx
// (profile, channels, recommendations, etc. are deeply nested — kept as
// Mixed so the frontend object shape can be stored/returned as-is).
const ClientSchema = new mongoose.Schema(
  {
    _id: { type: String }, // e.g. "fb"
    name: String,
    init: String,
    website: String,
    faavi: Number,
    phase: String,
    pkg: String,
    consultant: String,
    auditAge: Number,
    lastScanned: String,
    confidence: String,
    profile: mongoose.Schema.Types.Mixed,
    openRecs: Number,
    openTasks: Number,
    activeProjects: Number,
  },
  { strict: false, versionKey: false }
);

export default mongoose.model("Client", ClientSchema, "clients");
