import mongoose from "mongoose";

const ClientPOSchema = new mongoose.Schema(
  { _id: { type: String } },
  { strict: false, versionKey: false }
);

export default mongoose.model("ClientPO", ClientPOSchema, "client_pos");
