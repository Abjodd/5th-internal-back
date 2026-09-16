import mongoose from "mongoose";

// The signed agreement between us and a creator we manage directly. Uploaded
// and creator-scoped, unlike the invoices GENERATED per campaign into GridFS
// (routes/invoicePdf.js). Its own collection rather than a field on Creator so
// a re-signed copy can't overwrite the one in force for past invoices.
const CreatorDocumentSchema = new mongoose.Schema(
  {
    _id: { type: String },
    creatorId: { type: String, index: true }, // Creator._id — the lower-cased handle
    title: { type: String },                  // defaults to the uploaded filename
    file: { data: Buffer, contentType: String, size: Number },
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: String,
  },
  { versionKey: false }
);

export default mongoose.model("CreatorDocument", CreatorDocumentSchema, "creator_documents");
