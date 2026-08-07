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
 */
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

const JOBS = [
  {
    name: "post-metrics-refresh",
    hourIST: 0, // midnight IST
    run: refreshAllPostMetrics,
  },
];

function schedule(job) {
  const delay = Math.min(msUntilIST(job.hourIST), MAX_DELAY_MS);
  setTimeout(async () => {
    try {
      await job.run();
    } catch (e) {
      // A throwing job must not take the scheduler — or the API process —
      // down with it. Log and let tomorrow's run try again.
      console.error(`[scheduler] ${job.name} failed:`, e.message);
    }
    schedule(job);
  }, delay).unref?.(); // never hold the process open on its own account
  console.log(`[scheduler] ${job.name} in ${Math.round(delay / 60000)} min (${job.hourIST}:00 IST)`);
}

export function startScheduler() {
  // Opt-out for local dev and for any second instance: two schedulers against
  // one database would double every third-party API call the jobs make.
  if (process.env.DISABLE_SCHEDULER === "1") {
    console.log("[scheduler] disabled (DISABLE_SCHEDULER=1)");
    return;
  }
  JOBS.forEach(schedule);
}
