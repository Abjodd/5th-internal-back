import mongoose from "mongoose";

// A file held against one consultant (agreement, GST certificate, PAN card…),
// with the name the team gave it. Bytes inline like CreatorDocument — kept in
// its own collection so listing consultants never loads files.
const ConsultantDocumentSchema = new mongoose.Schema(
  {
    _id: { type: String },
    consultantId: { type: String, index: true },
    name: String,                 // "Signed agreement", "GST certificate" …
    filename: String,             // the uploaded file's own name
    file: { data: Buffer, contentType: String, size: Number },
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: String,
    // "internal" (the team) or "portal" (the consultant, from their own login).
    source: { type: String, enum: ["internal", "portal"], default: "internal" },
  },
  { versionKey: false }
);

export default mongoose.models.ConsultantDocument || mongoose.model("ConsultantDocument", ConsultantDocumentSchema, "consultant_documents");
