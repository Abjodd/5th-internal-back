import mongoose from "mongoose";

// One row per scheduled job (see scheduler.js), keyed by the job's name.
//
// Exists so a run that was MISSED can be noticed. The scheduler is in-process
// and arms a single timer for the next occurrence, so a restart — a deploy, a
// crash, a host recycling an idle instance — silently drops that day's run:
// the new process just arms a timer for the following midnight and nothing
// anywhere records that a day went unmeasured. With a stored `lastRunAt` the
// scheduler can compare against the last occurrence that was DUE and catch up
// on boot instead.
//
// Deliberately not a RegistryEntry: that collection is user-facing data behind
// /api/registry, and scheduler bookkeeping has no business showing up there.
const JobRunSchema = new mongoose.Schema(
  {
    _id: { type: String },  // job name, e.g. "post-metrics-refresh"
    lastRunAt: Date,        // when the job last completed (successfully or not)
    // The job's own summary object. Kept for diagnosing "why is the chart
    // empty" without shell access to the server's logs, which rotate.
    lastResult: mongoose.Schema.Types.Mixed,
  },
  { strict: false, versionKey: false }
);

export default mongoose.model("JobRun", JobRunSchema, "job_runs");
