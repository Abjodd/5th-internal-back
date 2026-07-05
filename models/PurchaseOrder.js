import mongoose from "mongoose";

const PurchaseOrderSchema = new mongoose.Schema(
  { _id: { type: String } },
  { strict: false, versionKey: false }
);

export default mongoose.model("PurchaseOrder", PurchaseOrderSchema, "purchase_orders");
