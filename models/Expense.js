import mongoose from "mongoose";

const ExpenseSchema = new mongoose.Schema(
  { _id: { type: String } },
  { strict: false, versionKey: false }
);

export default mongoose.model("Expense", ExpenseSchema, "expenses");
