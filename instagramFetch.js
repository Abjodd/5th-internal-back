// Wrapper around the "Instagram Scraper Stable API" on RapidAPI.
// Kept isolated in this one file: if you switch providers or the response
// shape doesn't match (these scraper APIs are not officially documented and
// fields vary), only this file needs editing — not the routes or frontend.

const RAPIDAPI_HOST = "instagram-scraper-stable-api.p.rapidapi.com";
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

// Pull a username out of a full profile URL or handle (@user, user, or full link)
function extractUsername(input) {
  if (!input) return null;
  let s = input.trim();
  s = s.replace(/^@/, "");
  const m = s.match(/instagram\.com\/([^/?#]+)/i);
  if (m) return m[1];
  return s;
}

// Try a list of possible key paths (different scraper responses use
// different field names) and return the first defined value.
function pick(obj, paths) {
  for (const path of paths) {
    const val = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (val !== undefined && val !== null) return val;
  }
  return null;
}

export async function fetchInstagramProfile(usernameOrUrl) {
  if (!RAPIDAPI_KEY) {
    return { error: "RAPIDAPI_KEY is not set in backend/.env — add it to enable Instagram auto-fetch." };
  }
  const username = extractUsername(usernameOrUrl);
  if (!username) {
    return { error: "Could not parse a username from that Instagram link/handle." };
  }

  const url = `https://${RAPIDAPI_HOST}/get_ig_user_about.php?username_or_url=${encodeURIComponent(username)}`;

  let res, raw;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-host": RAPIDAPI_HOST,
        "x-rapidapi-key": RAPIDAPI_KEY,
      },
    });
    raw = await res.text();
  } catch (err) {
    return { error: `Network error calling Instagram API: ${err.message}` };
  }

  if (!res.ok) {
    return { error: `Instagram API returned ${res.status}: ${raw.slice(0, 300)}` };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: "Instagram API did not return valid JSON.", raw: raw.slice(0, 500) };
  }

  // The actual payload may be nested under "data", "result", "user", or be the root object.
  const root = pick(data, ["data", "result", "user", "graphql.user"]) || data;

  const followers = pick(root, [
    "follower_count", "followers", "followers_count",
    "edge_followed_by.count", "follower",
  ]);
  const following = pick(root, ["following_count", "following", "edge_follow.count"]);
  const posts = pick(root, ["media_count", "posts_count", "edge_owner_to_timeline_media.count"]);
  const fullName = pick(root, ["full_name", "fullname", "name"]);
  const bio = pick(root, ["biography", "bio"]);
  const isVerified = pick(root, ["is_verified", "verified"]);
  const profilePic = pick(root, ["profile_pic_url", "profile_pic_url_hd", "avatar"]);
  const avgLikes = pick(root, ["avg_likes", "average_likes"]); // rarely present from "about" endpoints
  const engagementRate = pick(root, ["engagement_rate", "avg_engagement_rate"]);

  if (followers == null && fullName == null && bio == null) {
    // Nothing recognizable came back — surface the raw shape so the mapping
    // in this file can be corrected quickly.
    return {
      error: "Got a response but couldn't find recognizable profile fields. Raw response attached.",
      raw: data,
    };
  }

  return {
    username,
    fullName: fullName || null,
    bio: bio || null,
    followers: followers != null ? Number(followers) : null,
    following: following != null ? Number(following) : null,
    posts: posts != null ? Number(posts) : null,
    avgLikes: avgLikes != null ? Number(avgLikes) : null,
    engagementRate: engagementRate != null ? Number(engagementRate) : null,
    isVerified: !!isVerified,
    profilePic: profilePic || null,
    fetchedAt: new Date().toISOString(),
  };
}
