import mongoose from "mongoose";
import { AVATAR_FIELDS } from "../avatarStore.js";

/**
 * A consultant — an outside partner who brings and runs brands with us
 * (Services → Consultant in the internal app). Everything about them is kept
 * and edited internally; the consultant portal (built later) reads this same
 * record through their own login (models/ConsultantCredential.js).
 *
 * Contact people (the primary contact and every POC) share one shape so the
 * portal and any export can treat them alike. Brands are Client ids; a brand
 * can sit with several consultants and a consultant can hold several brands.
 * Documents live in their own collection (ConsultantDocument) so this record
 * stays small enough to list.
 */
const Person = new mongoose.Schema(
  {
    _id: { type: String },
    name: String,
    designation: String,
    email: String,
    phone: String,
  },
  { _id: false }
);

// A UGC creator dedicated to this consultant. `creatorId` links to the
// Creators directory when they're in it; name/handle are kept here too so a
// creator added by hand (not in the directory) is a full row on its own.
const UgcCreator = new mongoose.Schema(
  {
    _id: { type: String },
    creatorId: String,
    name: String,
    handle: String,
    platform: String,
    rate: Number,             // ₹ per piece, as agreed
    status: { type: String, enum: ["active", "paused"], default: "active" },
    notes: String,
    addedAt: Date,
  },
  { _id: false }
);

const ConsultantSchema = new mongoose.Schema(
  {
    _id: { type: String },            // "cs1", "cs2", … (assigned server-side)
    // 1. Basic
    name: { type: String, required: true },
    email: String,
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    // 2. Billing
    billing: {
      gstNumber: String,
      address: String,
      gst: String,
      email: String,
    },
    // 3. HQ
    hq: {
      address: String,
      gst: String,
    },
    // 4. Tax
    tax: {
      tin: String,
      pan: String,
    },
    // 5. Primary contact
    primaryContact: { type: Person, default: () => ({}) },
    // 6. POCs
    pocs: { type: [Person], default: [] },
    // 7. Brands (Client._id)
    brandIds: { type: [String], default: [] },
    // 8. Dedicated UGC creators
    ugcCreators: { type: [UgcCreator], default: [] },
    // Profile picture — set internally or by the consultant from their
    // portal; both sides show the same one. Bytes inline (avatarStore.js),
    // never in list responses; served from GET /api/consultants/:id/avatar.
    ...AVATAR_FIELDS,
    avatarSource: { type: String, enum: ["internal", "portal"] },
    avatarUpdatedBy: String,
    // Internal notes — never shown on the portal.
    notes: String,
    createdBy: String,
    updatedBy: String,
  },
  { versionKey: false, timestamps: true }
);

export default mongoose.models.Consultant || mongoose.model("Consultant", ConsultantSchema, "consultants");
