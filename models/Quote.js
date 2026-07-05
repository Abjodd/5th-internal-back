import mongoose from "mongoose";

const QuoteSchema = new mongoose.Schema(
  { _id: { type: String } },
  { strict: false, versionKey: false }
);

export default mongoose.model("Quote", QuoteSchema, "quotes");
