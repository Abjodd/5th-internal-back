import mongoose from "mongoose";

const InvoiceSchema = new mongoose.Schema(
  { _id: { type: String } },
  { strict: false, versionKey: false }
);

export default mongoose.model("Invoice", InvoiceSchema, "invoices");
