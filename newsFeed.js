/**
 * Influencer-marketing industry news — Market Watch's "Latest News" list.
 *
 * Source is Google News' public RSS search (no API key, no signup, no cost):
 *   https://news.google.com/rss/search?q=...
 * Parsed by hand below rather than pulling in an XML library — Google's RSS
 * shape here is small, stable, and entirely under our control (we choose the
 * query), so a couple of regexes cover it without a new dependency.
 *
 * Fetched lazily on request, not on a schedule: unlike HikerAPI
 * (portalReels.js), a Google News RSS request costs nothing per call, so
 * there's no reason to move it off the request path — only a reason to avoid
 * re-fetching on every page view, which the Mongo-backed TTL cache below
 * handles (durable across restarts, same lesson portalReels.js already
 * learned the hard way — see that file's header). A failed refetch falls
 * back to whatever is already cached, even if stale, rather than breaking
 * the tile outright.
 */
import NewsCache from "./models/NewsCache.js";

const FEED_KEY = "influencer-marketing";
const QUERY = '"influencer marketing"';
const RSS_URL = `https://news.google.com/rss/search?q=${encodeURIComponent(QUERY)}&hl=en-US&gl=US&ceid=US:en`;
const TTL_MS = 30 * 60 * 1000; // 30 minutes — see file header
const MAX_ITEMS = 8;
const FETCH_TIMEOUT_MS = 8000;
const IMAGE_FETCH_TIMEOUT_MS = 10_000; // shared across the whole resolve-then-fetch chain in fetchArticleImage — see its header
const IMAGE_FETCH_MAX_BYTES = 200_000; // an article page — its og:image is always in <head>
const INTERSTITIAL_MAX_BYTES = 2_000_000; // Google's own redirect page — measured at ~580KB in practice (the decode attributes sit near the end, past <head>), so this needs real headroom, not a <head>-sized budget like the real article page below
const NEWS_USER_AGENT = "Mozilla/5.0 (compatible; FifthAvenueBot/1.0)";

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return null;
  let val = m[1].trim();
  const cdata = val.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) val = cdata[1].trim();
  return decodeXmlEntities(val);
}

function extractSource(block) {
  const m = block.match(/<source\s+url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/);
  if (!m) return null;
  return decodeXmlEntities(m[2].trim());
}

/** Read a response body as text, stopping once `maxBytes` have been seen or
 *  (if given) once `stopMarker` shows up in the text so far — same bounded
 *  read shape reused by every fetch in this function group, so nothing here
 *  can be made to download an unbounded amount of a slow or huge page. */
async function readBody(res, maxBytes, stopMarker) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  while (bytes < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    text += decoder.decode(value, { stream: true });
    if (stopMarker && text.includes(stopMarker)) break;
  }
  try { await reader.cancel(); } catch { /* best-effort */ }
  return text;
}

/**
 * Google News RSS `<link>` values (since Google reworked the redirect
 * scheme in 2024) are not the real article — they're an interstitial
 * `news.google.com/rss/articles/<id>` page that resolves to the publisher
 * client-side, via JS a real browser runs. That's why the card's own link
 * still works fine for a person clicking it; it's only a problem for US
 * trying to fetch the real page server-side to read ITS og:image tag. This
 * replicates the same signed lookup Google's own front-end performs: pull
 * the request Google embeds as data-n-a-* attributes on the interstitial
 * page, then ask Google's batchexecute endpoint what it resolves to.
 *
 * This rides on an undocumented internal endpoint rather than a published
 * API, so it can break if Google changes the scheme again — every step
 * fails closed (null) rather than throwing, exactly like the og:image
 * lookup itself, since a photo here is a nice-to-have, not something worth
 * risking the feed over.
 */
async function decodeGoogleNewsUrl(interstitialHtml, signal) {
  const id = interstitialHtml.match(/data-n-a-id="([^"]+)"/)?.[1];
  const sig = interstitialHtml.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = interstitialHtml.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!id || !sig || !ts) {
    console.log("[news-image] decode: missing data-n-a-* attributes on interstitial page");
    return null;
  }

  const innerPayload = JSON.stringify([
    "garturlreq",
    [
      ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
      "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0,
    ],
    id,
    Number(ts),
    sig,
  ]);
  const fReq = JSON.stringify([[["Fbv4je", innerPayload, null, "generic"]]]);

  let res;
  try {
    res = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": NEWS_USER_AGENT,
      },
      body: `f.req=${encodeURIComponent(fReq)}`,
    });
  } catch (e) {
    console.log("[news-image] decode: batchexecute request threw —", e.message);
    return null;
  }
  if (!res.ok) {
    console.log("[news-image] decode: batchexecute returned HTTP", res.status);
    return null;
  }

  const text = await readBody(res, 100_000);
  // The response is Google's usual anti-hijacking batchexecute shape: a
  // ")]}'" line, then alternating byte-count / JSON-array lines. Scanning
  // every line for the one carrying the "wrb.fr" marker (rather than
  // assuming a fixed line offset) is more resilient to minor formatting
  // drift than indexing into a hardcoded position would be.
  for (const line of text.split("\n")) {
    if (!line.includes("wrb.fr")) continue;
    try {
      const outer = JSON.parse(line);
      const inner = JSON.parse(outer[0][2]);
      const url = inner.find((v) => typeof v === "string" && /^https?:\/\//.test(v));
      if (url) return url;
    } catch (e) {
      console.log("[news-image] decode: found wrb.fr line but failed to parse it —", e.message);
      continue;
    }
  }
  console.log("[news-image] decode: batchexecute response had no usable wrb.fr line. First 200 chars:", text.slice(0, 200));
  return null;
}

/** Pull og:image (falling back to twitter:image) out of a page's HTML —
 *  shared by both the "resolved real article" path and the last-resort
 *  fallback below. */
function extractOgImage(html) {
  const match =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
    html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (!match) return null;
  const image = decodeXmlEntities(match[1]);
  return image.startsWith("http") ? image : null;
}

/**
 * Best-effort thumbnail for one article. Google's RSS link only ever leads
 * us to its interstitial page (see decodeGoogleNewsUrl above for why), so
 * the real path here is: fetch that page → decode it to the actual
 * publisher URL → fetch THAT page's og:image. If the decode call itself
 * fails for any reason (Google changes the scheme, the endpoint is
 * unreachable, the response doesn't parse), we fall back to checking
 * whatever the interstitial page itself contained — rarely useful, but
 * costs nothing since it's already in hand.
 *
 * Returns null on anything short of a clean hit rather than throwing: a
 * photo is a nice-to-have on this card, never something worth failing the
 * whole feed over, and the card design has to look right without one.
 */
async function fetchArticleImage(googleUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  const tag = googleUrl.slice(-24); // just enough to tell log lines for different articles apart
  try {
    let interstitialHtml;
    try {
      const res = await fetch(googleUrl, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": NEWS_USER_AGENT },
      });
      if (!res.ok) {
        console.log(`[news-image ${tag}] interstitial fetch returned HTTP`, res.status);
        return null;
      }
      interstitialHtml = await readBody(res, INTERSTITIAL_MAX_BYTES);
    } catch (e) {
      console.log(`[news-image ${tag}] interstitial fetch threw —`, e.name === "AbortError" ? "timed out" : e.message);
      return null;
    }

    const realUrl = await decodeGoogleNewsUrl(interstitialHtml, controller.signal).catch((e) => {
      console.log(`[news-image ${tag}] decodeGoogleNewsUrl threw —`, e.message);
      return null;
    });
    if (realUrl) {
      console.log(`[news-image ${tag}] decoded to real URL:`, realUrl);
      try {
        const res2 = await fetch(realUrl, {
          signal: controller.signal,
          redirect: "follow",
          headers: { "User-Agent": NEWS_USER_AGENT },
        });
        if (res2.ok) {
          const html2 = await readBody(res2, IMAGE_FETCH_MAX_BYTES, "</head>");
          const image = extractOgImage(html2);
          if (image) {
            console.log(`[news-image ${tag}] SUCCESS —`, image);
            return image;
          }
          console.log(`[news-image ${tag}] real article page had no og:image/twitter:image meta tag`);
        } else {
          console.log(`[news-image ${tag}] real article fetch returned HTTP`, res2.status);
        }
      } catch (e) {
        console.log(`[news-image ${tag}] real article fetch threw —`, e.name === "AbortError" ? "timed out" : e.message);
        // fall through to the interstitial page itself, below
      }
    } else {
      console.log(`[news-image ${tag}] decode failed, falling back to interstitial page's own og:image`);
    }

    const fallback = extractOgImage(interstitialHtml);
    console.log(`[news-image ${tag}] fallback result:`, fallback || "null");
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One request to Google News RSS, parsed into plain {title, link, source,
 * publishedAt} rows. Throws on a network failure or an empty/unexpected
 * response — the caller (getInfluencerMarketingNews) decides what to do
 * with that, typically falling back to the last good cache.
 */
async function fetchFromGoogleNews() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let xml;
  try {
    const res = await fetch(RSS_URL, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FifthAvenueBot/1.0)" },
    });
    if (!res.ok) throw new Error(`Google News RSS returned ${res.status}`);
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const blocks = xml.split("<item>").slice(1).map((b) => b.split("</item>")[0]);
  const items = blocks
    .map((block) => {
      let title = extractTag(block, "title");
      const link = extractTag(block, "link");
      const pubDate = extractTag(block, "pubDate");
      const source = extractSource(block);
      if (!title || !link) return null;
      // Google News titles are usually "Headline - Source Name" — strip the
      // trailing source suffix when it matches the <source> tag, since the
      // source is rendered separately.
      if (source && title.endsWith(` - ${source}`)) {
        title = title.slice(0, -(source.length + 3)).trim();
      }
      const publishedAt = pubDate ? new Date(pubDate) : null;
      return {
        title,
        link,
        source: source || null,
        publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_ITEMS);

  if (!items.length) throw new Error("Google News RSS returned no parseable items");

  // Best-effort thumbnails — run concurrently (not one after another) so a
  // slow or blocking publisher costs at most IMAGE_FETCH_TIMEOUT_MS total,
  // not IMAGE_FETCH_TIMEOUT_MS × MAX_ITEMS. Never rejects: fetchArticleImage
  // already swallows its own errors and returns null.
  const images = await Promise.all(items.map((item) => fetchArticleImage(item.link)));
  return items.map((item, i) => ({ ...item, image: images[i] || null }));
}

/**
 * The current influencer-marketing news list — served from cache if it's
 * still fresh, freshly fetched (and cached) otherwise. Never throws while a
 * usable cache exists: a failed refetch just serves what's already there.
 * Universal — one shared list, not scoped to any one brand (see the Market
 * Watch feature this backs: reels/notes are per-brand, this feed is not).
 */
export async function getInfluencerMarketingNews() {
  const cached = await NewsCache.findById(FEED_KEY).lean();
  const isFresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() < TTL_MS;
  if (isFresh) return cached.items;

  try {
    const items = await fetchFromGoogleNews();
    await NewsCache.findByIdAndUpdate(FEED_KEY, { items, fetchedAt: new Date() }, { upsert: true });
    return items;
  } catch (err) {
    if (cached) return cached.items; // stale beats broken
    throw err;
  }
}
