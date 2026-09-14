// Standalone diagnostic for the Google News image-fetch chain.
// Run this with plain `node` (Node 18+, needs global fetch) from inside the
// backend folder — it does NOT touch Mongo or the running server, it just
// exercises the same fetch/decode/scrape logic newsFeed.js uses, with a
// verbose log at every step, so we can see exactly which step fails on your
// machine's real network.
//
// Usage:
//   cd "5th-avenue-internal 2/backend"
//   node /path/to/diagnose_news_images.mjs

const QUERY = '"influencer marketing"';
const RSS_URL = `https://news.google.com/rss/search?q=${encodeURIComponent(QUERY)}&hl=en-US&gl=US&ceid=US:en`;
const NEWS_USER_AGENT = "Mozilla/5.0 (compatible; FifthAvenueBot/1.0)";
const UA_HEADERS = { "User-Agent": NEWS_USER_AGENT };

function log(label, ...rest) {
  console.log(`\n=== ${label} ===`);
  for (const r of rest) console.log(r);
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return null;
  let val = m[1].trim();
  const cdata = val.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) val = cdata[1].trim();
  return val;
}

function extractOgImage(html) {
  const match =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
    html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  return match ? match[1] : null;
}

async function main() {
  log("STEP 1: fetch Google News RSS", RSS_URL);
  let xml;
  try {
    const res = await fetch(RSS_URL, { headers: UA_HEADERS });
    console.log("HTTP status:", res.status);
    xml = await res.text();
    console.log("Body length:", xml.length);
  } catch (e) {
    console.log("FAILED to fetch RSS feed at all:", e.message);
    return;
  }

  const blocks = xml.split("<item>").slice(1).map((b) => b.split("</item>")[0]);
  console.log("Items found in feed:", blocks.length);
  if (!blocks.length) {
    console.log("No <item> blocks — printing first 1000 chars of body for inspection:");
    console.log(xml.slice(0, 1000));
    return;
  }

  const firstLink = extractTag(blocks[0], "link");
  const firstTitle = extractTag(blocks[0], "title");
  log("STEP 2: first article's Google interstitial link", firstTitle, firstLink);

  if (!firstLink) {
    console.log("Could not extract a <link> from the first item — dumping raw block:");
    console.log(blocks[0].slice(0, 1000));
    return;
  }

  log("STEP 3: fetch the interstitial page");
  let interstitialHtml;
  try {
    const res = await fetch(firstLink, { redirect: "follow", headers: UA_HEADERS });
    console.log("HTTP status:", res.status, "final URL after redirects:", res.url);
    interstitialHtml = await res.text();
    console.log("Body length:", interstitialHtml.length);
  } catch (e) {
    console.log("FAILED to fetch interstitial page:", e.message);
    return;
  }

  const id = interstitialHtml.match(/data-n-a-id="([^"]+)"/)?.[1];
  const sig = interstitialHtml.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = interstitialHtml.match(/data-n-a-ts="([^"]+)"/)?.[1];
  log("STEP 4: decode attributes found on interstitial page", { id, sig: sig ? sig.slice(0, 20) + "..." : sig, ts });

  if (!id || !sig || !ts) {
    console.log("MISSING one or more data-n-a-* attributes — this is likely the break point.");
    console.log("Searching for any data-n-a- attributes at all in the page:");
    const anyAttrs = interstitialHtml.match(/data-n-a-[a-z]+="[^"]*"/g);
    console.log(anyAttrs ? anyAttrs.slice(0, 10) : "NONE FOUND");
    console.log("\nFirst 2000 chars of interstitial HTML for manual inspection:");
    console.log(interstitialHtml.slice(0, 2000));
    console.log("\nFalling back to extractOgImage on the interstitial page itself:");
    console.log("og:image found:", extractOgImage(interstitialHtml));
    return;
  }

  log("STEP 5: call Google's batchexecute endpoint");
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

  let text;
  try {
    const res = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": NEWS_USER_AGENT,
      },
      body: `f.req=${encodeURIComponent(fReq)}`,
    });
    console.log("HTTP status:", res.status);
    text = await res.text();
    console.log("Body length:", text.length);
    console.log("First 500 chars of response:");
    console.log(text.slice(0, 500));
  } catch (e) {
    console.log("FAILED to call batchexecute:", e.message);
    return;
  }

  log("STEP 6: scan response for the resolved URL");
  let realUrl = null;
  for (const line of text.split("\n")) {
    if (!line.includes("wrb.fr")) continue;
    console.log("Found a wrb.fr line, length:", line.length);
    try {
      const outer = JSON.parse(line);
      const inner = JSON.parse(outer[0][2]);
      realUrl = inner.find((v) => typeof v === "string" && /^https?:\/\//.test(v));
      console.log("Parsed inner payload OK. Extracted URL:", realUrl);
    } catch (e) {
      console.log("Line matched 'wrb.fr' but failed to parse:", e.message);
      console.log("Line content (first 500 chars):", line.slice(0, 500));
    }
  }
  if (!realUrl) {
    console.log("No usable URL extracted from the batchexecute response — this is likely the break point.");
    return;
  }

  log("STEP 7: fetch the real article page and look for og:image", realUrl);
  try {
    const res = await fetch(realUrl, { redirect: "follow", headers: UA_HEADERS });
    console.log("HTTP status:", res.status, "final URL:", res.url);
    const html = await res.text();
    console.log("Body length:", html.length);
    const image = extractOgImage(html);
    console.log("og:image found:", image);
  } catch (e) {
    console.log("FAILED to fetch real article page:", e.message);
  }
}

main();
