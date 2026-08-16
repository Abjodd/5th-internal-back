/**
 * In-process daily scheduler.
 *
 * Add jobs to the array; the mechanism doesn't change.
 *
 * Timezone is pinned to IST rather than the host's clock. The servers run in
 * UTC, so "midnight" would otherwise fire at 05:30 local — mid-morning
 *
 * Self-rescheduling setTimeout, not setInterval: an interval drifts by however
 * long each run takes, and a job that takes four minutes would walk itself out
 * of the night over a few weeks.
 *
 * ── Why a missed run has to be caught up ────────────────────────────────────
 * A timer only fires if the process that armed it is still alive when it comes
 * due, and this one lives inside the API. Every deploy, crash or idle-instance
 * recycle re-arms it for the NEXT midnight, so a restart at any time after
 * midnight silently skips that day entirely — nothing retries and nothing logs
 * that a day went unmeasured. During active development that is most days,
 * which is exactly how the post-metrics history stayed empty for days after it
 * shipped while looking, from the outside, like the feature was broken.
 *
 * So each run is recorded (models/JobRun.js) and startup compares that against
 * the last occurrence that was DUE. The guarantee this buys is "runs at least
 * once per period, as long as the service is alive at some point during it"
 * rather than "runs only if the service happens to be alive at exactly
 * midnight" — which for a job whose whole purpose is an append-only daily
 * series is the difference between a chart and an empty box.
 */
import JobRun from "./models/JobRun.js";
import { refreshAllPostMetrics } from "./refreshPostMetrics.js";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
// setTimeout clamps to a 32-bit ms delay (~24.9 days), so a daily gap is
// always safely inside it — but the guard documents why we can rely on that.
const MAX_DELAY_MS = 2 ** 31 - 1;

// ms from now until the next `hourIST:00` in IST. Works off epoch arithmetic
// rather than local Date fields, so it is unaffected by the host timezone and
// has no DST edge case (India observes none).
export function msUntilIST(hourIST, now = Date.now()) {
  const istNow = now + IST_OFFSET_MS;
  const sinceMidnight = istNow % 86400000;
  const target = hourIST * 3600000;
  const delay = target - sinceMidnight;
  return delay > 0 ? delay : delay + 86400000;
}

// The most recent `hourIST:00` at or before `now`, as epoch ms — i.e. the run
// that should already have happened. Derived from the NEXT occurrence rather
// than computed separately, so the two can never disagree about where a day
// boundary falls: msUntilIST always returns a strictly positive delay, so the
// previous occurrence is exactly one day earlier.
export function lastDueIST(hourIST, now = Date.now()) {
  return now + msUntilIST(hourIST, now) - 86400000;
}

// How long after boot a caught-up run starts. Not immediate: the process has
// just come up and the job makes a long serial run of rate-limited third-party
// calls, so it yields to whatever traffic prompted the start first.
const CATCHUP_DELAY_MS = 30_000;

const JOBS = [
  {
    name: "post-metrics-refresh",
    hourIST: 0, // midnight IST
    run: refreshAllPostMetrics,
  },
];

// Runs the job and records that it ran. The timestamp is written even when the
// job throws: a failing job that reran on every restart would hammer a
// third-party API that is already unhappy, and the next scheduled run is the
// right place to retry.
async function runAndRecord(job) {
  try {
    const result = await job.run();
    await JobRun.findByIdAndUpdate(
      job.name,
      { $set: { lastRunAt: new Date(), lastResult: result } },
      { upsert: true },
    );
  } catch (e) {
    // A throwing job must not take the scheduler — or the API process — down
    // with it. Log and let the next run try again.
    console.error(`[scheduler] ${job.name} failed:`, e.message);
    await JobRun.findByIdAndUpdate(
      job.name,
      { $set: { lastRunAt: new Date(), lastResult: { error: e.message } } },
      { upsert: true },
    ).catch(() => {}); // bookkeeping must never mask the original failure
  }
}

function schedule(job) {
  const delay = Math.min(msUntilIST(job.hourIST), MAX_DELAY_MS);
  setTimeout(async () => {
    await runAndRecord(job);
    schedule(job);
  }, delay).unref?.(); // never hold the process open on its own account
  console.log(`[scheduler] ${job.name} in ${Math.round(delay / 60000)} min (${job.hourIST}:00 IST)`);
}

// Runs the job now if its last due occurrence came and went without one —
// see the header. Never throws: a scheduler that cannot read its own
// bookkeeping should still schedule.
async function catchUp(job) {
  try {
    const record = await JobRun.findById(job.name).lean();
    const lastRunAt = record?.lastRunAt ? new Date(record.lastRunAt).getTime() : 0;
    const due = lastDueIST(job.hourIST);
    if (lastRunAt >= due) return;

    const missedFor = lastRunAt
      ? `${Math.round((due - lastRunAt) / 3600000)}h behind`
      : "never run";
    console.log(`[scheduler] ${job.name} missed its ${job.hourIST}:00 IST run (${missedFor}) — catching up in ${CATCHUP_DELAY_MS / 1000}s`);
    setTimeout(() => runAndRecord(job), CATCHUP_DELAY_MS).unref?.();
  } catch (e) {
    console.error(`[scheduler] ${job.name} catch-up check failed:`, e.message);
  }
}

export function startScheduler() {
  // Opt-out for local dev and for any second instance: two schedulers against
  // one database would double every third-party API call the jobs make.
  if (process.env.DISABLE_SCHEDULER === "1") {
    console.log("[scheduler] disabled (DISABLE_SCHEDULER=1)");
    return;
  }
  JOBS.forEach((job) => {
    schedule(job);
    catchUp(job);
  });
}
