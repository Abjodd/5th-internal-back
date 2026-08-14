import mongoose from "mongoose";
import { AVATAR_FIELDS } from "../avatarStore.js";

// Loose schema mirroring the CLIENTS objects in CompanyOverview.jsx
// (profile, channels, recommendations, etc. are deeply nested — kept as
// Mixed so the frontend object shape can be stored/returned as-is).
const ClientSchema = new mongoose.Schema(
  {
    _id: { type: String }, // e.g. "fb"
    name: String,
    // The brand's initials (`init`) are deliberately NOT declared here. `init`
    // is a reserved Mongoose pathname: declaring it compiles a getter onto the
    // document prototype that shadows Document.prototype.init, which Mongoose
    // calls internally to hydrate. Any non-lean Client read or .save() then
    // dies with "Cannot read properties of undefined (reading
    // 'Symbol(mongoose#Document#scope)')". That went unnoticed for a long time
    // because every Client query here uses .lean(), which skips hydration.
    //
    // strict:false means the field still stores, reads and round-trips through
    // save() untouched — it just has no schema entry. Read it with doc.get("init")
    // rather than doc.init on a hydrated document.
    // The brand's logo, same contract as a user's profile photo: downscaled
    // client-side, stored inline, omitted from list responses and served from
    // GET /api/clients/:id/avatar. See avatarStore.js.
    ...AVATAR_FIELDS,
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
