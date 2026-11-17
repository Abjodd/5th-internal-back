import mongoose from "mongoose";
import { AVATAR_FIELDS } from "../avatarStore.js";

// A login for the consultant portal (built later), scoped to one consultant.
// Same contract as BrandCredential: hashKey = sha256(password) for sign-in,
// passKey = encrypted copy so the founder can reveal it in Settings → Consultant
// Login. Managed by the shared credential routes in routes/auth.js.
const ConsultantCredentialSchema = new mongoose.Schema(
  {
    _id: { type: String },        // "cc1", "cc2", …
    consultantId: String,         // Consultant._id this login belongs to
    username: String,             // login email
    name: String,                 // the person using it
    title: String,
    avatar: String,
    ...AVATAR_FIELDS,
    hashKey: String,
    firstLoginAt: Date,
    deleted: Boolean,
    deletedAt: Date,
  },
  { strict: false, versionKey: false, timestamps: true }
);

export default mongoose.models.ConsultantCredential || mongoose.model("ConsultantCredential", ConsultantCredentialSchema, "consultant_credentials");
