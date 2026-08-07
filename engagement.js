/**
 * Engagement maths shared by every profile fetcher.
 *
 * Both instagramfetchhiker.js and youtubeFetch.js sample a creator's recent
 * posts and average the reactions. They were each carrying their own copy of
 * `avg`, and only YouTube went on to turn that into an ER% — so a creator added
 * from Instagram arrived with `avgER` empty even though the frontend has always
 * read `data.engagementRate` from the lookup response (see AddCreatorModal's
 * handleFetch).
 *
 * ER is followers-based and the follower base is the number the
 * rate card is negotiated against anyway.
 */

// Mean of the numbers present, or null when the sample is empty — null and 0
// are different answers ("we couldn't measure" vs "nobody engaged") and the
// callers render them differently.
export const avg = (arr) => {
  const nums = (arr || []).filter((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
};

/**
 * ER% = ((avgLikes + avgComments) / followers) × 100, to one decimal.
 *
 * Returns null rather than 0 when it can't be computed, so an unmeasurable
 * creator never reads as a zero-engagement one.
 *
 * avgComments is optional
 */
export function engagementRate({ avgLikes, avgComments, followers }) {
  const f = Number(followers);
  if (!Number.isFinite(f) || f <= 0) return null;
  if (avgLikes == null && avgComments == null) return null;
  const reactions = (Number(avgLikes) || 0) + (Number(avgComments) || 0);
  return Math.round((reactions / f) * 1000) / 10;
}
