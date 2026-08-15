/**
 * Append-only history of a creator's live-post metrics.
 *
 * `cr.tracking` holds only the LATEST numbers — each refresh overwrites the
 * previous ones. That is all the deliverables table needs, but it means the
 * growth of a post over time is thrown away the moment it is measured, so
 * "how did this campaign build?" was unanswerable from stored data. This adds
 * `cr.tracking.history[]`, an append-only series alongside the current values.
 *
 * ── Why both write paths go through here ────────────────────────────────────
 * Post metrics reach a campaign two ways: the nightly job
 * (refreshPostMetrics.js) and the manual "refresh" in the deliverables tab,
 * which PATCHes the whole campaign. If each appended its own points they would
 * drift in shape and in dedupe rules, and the chart would be reading two
 * different series. Both call into this module instead.
 *
 * ── Why every save does not become a point ──────────────────────────────────
 * PATCH /api/campaigns/:id fires on ANY edit — renaming a campaign, moving a
 * stage, editing a brief — and those requests carry the full creators[] array
 * with unchanged tracking. Appending unconditionally would bury the real
 * measurements under hundreds of identical points and grow the document for no
 * information. A point is recorded when the numbers actually moved, or when
 * enough time has passed that a flat stretch is itself worth plotting (a post
 * that stopped growing is a real finding, and without the second rule the
 * chart would draw a straight line across the plateau and hide it).
 */

// Roughly eight months of nightly points. Creators are embedded in the
// campaign document, so this is bounded deliberately: 16MB is a hard limit for
// the whole campaign, and an unbounded series on a 20-creator roster is the
// kind of thing that works fine for a year and then cannot be saved at all.
export const MAX_HISTORY = 240;

// A plateau is worth one point per this interval, so a post that stops growing
// still shows as a flat line rather than being interpolated across.
const MIN_GAP_MS = 6 * 60 * 60 * 1000;

const METRICS = ["views", "likes", "comments", "forwards"];

const numOrNull = (v) => (v == null ? null : Number(v) || 0);

/** The stored shape of one point. Deliberately flat and small. */
export function snapshotOf(tracking, at = new Date()) {
  return {
    at: at.toISOString(),
    views: numOrNull(tracking?.views),
    likes: numOrNull(tracking?.likes),
    comments: numOrNull(tracking?.comments),
    forwards: numOrNull(tracking?.forwards),
    posts: Number(tracking?.postsCounted) || 0,
  };
}

const sameMetrics = (a, b) => METRICS.every((k) => numOrNull(a?.[k]) === numOrNull(b?.[k]));

/** A Date from an ISO string, or null. Guards against `lastFetched`, which is
 *  a display string ("12:06 am") carrying no date and must never seed a point. */
function isoDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

/**
 * The history array a creator should carry after `tracking` is written.
 * Returns the existing array unchanged when the new reading earns no point,
 * so callers can cheaply detect "nothing to store".
 *
 * `prevTracking` is the reading being REPLACED. When a creator has no history
 * yet but does have a previous reading with a real timestamp, that reading
 * becomes the first point. Without this the already-measured numbers are
 * thrown away and the series restarts from the next refresh — so a chart that
 * needs two points to draw would stay empty for two full refresh cycles even
 * though a perfectly good earlier reading was sitting on the document. Seeding
 * is only ever done from `lastAutoRefresh` (an ISO timestamp); a reading we
 * cannot date is skipped rather than given an invented one.
 */
export function withHistory(prevHistory, tracking, at = new Date(), prevTracking = null) {
  let history = Array.isArray(prevHistory) ? prevHistory : [];

  if (!history.length && prevTracking && !METRICS.every((k) => prevTracking[k] == null)) {
    const seedAt = isoDate(prevTracking.lastAutoRefresh);
    // Strictly earlier than the reading being stored — a seed at or after `at`
    // would put the series out of order.
    if (seedAt && seedAt < at) history = [snapshotOf(prevTracking, seedAt)];
  }
  // Nothing measured yet — recording a row of nulls would put a false zero at
  // the start of every chart.
  if (!tracking || METRICS.every((k) => tracking[k] == null)) return history;

  const last = history[history.length - 1];
  if (last) {
    const gap = at.getTime() - new Date(last.at).getTime();
    if (sameMetrics(last, tracking) && gap < MIN_GAP_MS) return history;
  }

  const next = [...history, snapshotOf(tracking, at)];
  return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
}

/**
 * Carry history across a campaign PATCH.
 *
 * The incoming creators[] comes from the browser, which has no reason to know
 * about history and does not send it back. Writing that array straight to
 * Mongo would therefore DELETE the series on every save — so the previous
 * history is always sourced from the stored document, never from the request,
 * and extended with whatever the request reports.
 *
 * Matching is by creatorId (the directory key), falling back to handle/name,
 * because array position is not stable across roster edits.
 */
export function carryTrackingHistory(prevCreators = [], nextCreators = [], at = new Date()) {
  const keyOf = (cr) =>
    String(cr?.creatorId || cr?.handle || cr?.name || "").toLowerCase().trim();
  const prevByKey = new Map();
  for (const cr of prevCreators) {
    const k = keyOf(cr);
    if (k) prevByKey.set(k, cr);
  }
  return nextCreators.map((cr) => {
    if (!cr?.tracking) return cr;
    const prior = prevByKey.get(keyOf(cr));
    const history = withHistory(prior?.tracking?.history, cr.tracking, at, prior?.tracking);
    return { ...cr, tracking: { ...cr.tracking, history } };
  });
}
