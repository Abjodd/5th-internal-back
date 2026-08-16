/**
 * faviconFetch.js — suggest a brand's logo from its website.
 *
 * Setting a brand's logo used to mean finding a file first, so brands sat
 * without one and the whole system that keys off a logo — the campaign board's
 * accent colour, the brand masthead, a portal member's fallback picture —
 * stayed switched off. Nearly every brand already publishes a square mark at a
 * predictable URL, so the founder is offered that and confirms it instead.
 *
 * The result is only ever a SUGGESTION: it comes back as a data URI for the UI
 * to preview, and nothing is stored until someone accepts it through the normal
 * PATCH /api/clients/:id path. Nothing here writes to the database.
 *
 * ── Why the format check is on the bytes ────────────────────────────────────
 * The stored logo goes through parseAvatar (avatarStore.js), which accepts PNG,
 * JPEG and WebP only — a genuine .ico cannot be stored, and there is no image
 * library here to convert one. Meanwhile plenty of sites serve a PNG at
 * /favicon.ico, or a PNG with `Content-Type: image/x-icon`. Sniffing the magic
 * bytes rather than trusting the header is what makes those work and rejects
 * only the files that really are unusable.
 */

// The API accepts uploads up to 2MB (MAX_AVATAR_BYTES); a favicon that big is a
// misconfiguration, and stopping early keeps a hostile URL from streaming at us.
const MAX_ICON_BYTES = 1024 * 1024;
// Enough HTML to reach </head> on any sane page without reading a whole SPA
// bundle inlined below it. Read as a TRUNCATION, not a rejection: <link rel=
// "icon"> lives at the top of the document, so a page that runs past this has
// still told us everything we need. Treating the overflow as a failure instead
// is what made this silently fall through to /favicon.ico on every large site
// — github.com alone ships 560KB of HTML.
const MAX_HTML_BYTES = 512 * 1024;
const TIMEOUT_MS = 6000;
// Well-known icon paths, tried after anything the page declares.
const CONVENTIONAL_ICONS = ["/apple-touch-icon.png", "/favicon.ico"];
// Upper bound on serial fetches per suggestion — see iconCandidates.
const MAX_CANDIDATES = 6;

// Hosts that must never be fetched. This endpoint takes a URL from the caller
// and makes the server request it, which is the shape of an SSRF: without this
// it would be a probe for anything reachable from inside the network but not
// from outside it — a metadata service, an admin port, a database console.
// Literal-IP and obvious-name checks only; defeating DNS that resolves to a
// private address needs resolution-time control this runtime doesn't expose.
const BLOCKED_HOST = /^(localhost$|127\.|0\.0\.0\.0$|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;

/** The website string a founder typed → a URL, or null if it isn't usable. */
function toUrl(website) {
  const raw = String(website || "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  // A brand's site is on the public web. Anything else is either a mistake or
  // an attempt to make this server reach somewhere it shouldn't.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (BLOCKED_HOST.test(url.hostname)) return null;
  return url;
}

/**
 * Reads at most `limit` bytes, so a huge or endless response can't be used to
 * exhaust memory here.
 *
 * `truncate` decides what hitting the limit MEANS, which differs by what is
 * being read: a partial HTML document is still worth parsing (the icon links
 * are in its head), while a partial image is not an image, so an oversized one
 * is refused outright.
 */
async function fetchCapped(url, limit, { truncate = false } = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // Some CDNs serve a bare 403 to an unrecognised agent.
    headers: { "user-agent": "Mozilla/5.0 (compatible; 5thAvenueBot/1.0)" },
  });
  if (!res.ok) return null;
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= limit) {
      if (!truncate) return null;
      break; // leaving the loop cancels the stream — the rest is never read
    }
  }
  return { buffer: Buffer.concat(chunks), contentType: res.headers.get("content-type") || "" };
}

// Real format from the leading bytes, not from Content-Type — see the header.
// Returns null for anything parseAvatar would refuse to store (notably a true
// ICO, whose header is 00 00 01 00).
function sniffImageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// An href in HTML is entity-encoded, and icon URLs are routinely image-CDN
// links with query strings — so `?w=180&fm=png` reaches us as `?w=180&amp;fm=png`.
// Handing that to the CDN un-decoded turns a valid request into a 400, which
// looked exactly like "this site has no usable icon".
const ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#38": "&", "#39": "'" };
const decodeEntities = (s) =>
  s.replace(/&(#?\w+);/g, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);

// The well-known paths resolved against a site — the whole candidate list when
// the page couldn't be read, and the tail of it when it could.
const conventionalOnly = (pageHref) =>
  CONVENTIONAL_ICONS.map((path) => new URL(path, pageHref).href);

// Candidate icon URLs from the page's <head>, best first.
//
// Ordered by how likely each is to be a large square mark rather than a 16px
// browser-tab glyph: apple-touch-icon is 180px by convention, then any declared
// icon by descending declared size, then the conventional /favicon.ico path
// which every site has whether or not it declares one.
function iconCandidates(html, pageHref) {
  const found = [];
  const LINK = /<link\b[^>]*>/gi;
  for (const [tag] of html.matchAll(LINK)) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() || "";
    if (!/\bicon\b/.test(rel)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)/i.exec(tag)?.[1];
    if (!href) continue;
    // "180x180" → 180. Unsized icons sort last among declared ones.
    const size = Number(/\b(\d+)x\d+/i.exec(/\bsizes\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] || "")?.[1]) || 0;
    found.push({ href, size, apple: rel.includes("apple-touch-icon") });
  }
  found.sort((a, b) => (b.apple - a.apple) || (b.size - a.size));

  const urls = [];
  for (const { href } of found) {
    try { urls.push(new URL(decodeEntities(href), pageHref).href); } catch { /* skip a malformed href */ }
  }
  // Conventional paths, tried whether or not the page declares them. Plenty of
  // sites ship a perfectly good 180px PNG here while declaring only an .ico we
  // can't store (apple.com is one), so skipping these would fail on brands
  // whose logo was one request away. SPAs that answer every unknown path with
  // their index page are caught by the magic-byte check, not by the status code
  // — those come back as a cheerful 200 text/html.
  urls.push(...conventionalOnly(pageHref));

  // Serial fetches with a timeout each, so the list is bounded: a page
  // declaring a dozen icons must not turn one click into a minute of waiting.
  return [...new Set(urls)].slice(0, MAX_CANDIDATES);
}

/**
 * Best logo we can find for a website.
 *
 * Resolves { dataUri, source, contentType, bytes } on success, or
 * { error } with a message meant for the founder to read. Never throws — a
 * brand whose site is down or has nothing usable is an ordinary outcome here,
 * and the answer is "upload one instead", not a 500.
 */
export async function suggestLogo(website) {
  const pageUrl = toUrl(website);
  if (!pageUrl) return { error: "Enter a valid public website address, e.g. nike.com" };

  let candidates;
  try {
    const page = await fetchCapped(pageUrl.href, MAX_HTML_BYTES, { truncate: true });
    // The page itself may be unreachable (a bot-blocking CDN answers the
    // document with a 403) while the icon paths still serve, so those are tried
    // either way rather than giving up here.
    candidates = page
      ? iconCandidates(page.buffer.toString("utf8"), pageUrl.href)
      : conventionalOnly(pageUrl.href);
  } catch {
    candidates = conventionalOnly(pageUrl.href);
  }

  for (const url of candidates) {
    try {
      const icon = await fetchCapped(url, MAX_ICON_BYTES);
      if (!icon?.buffer.length) continue;
      const contentType = sniffImageType(icon.buffer);
      if (!contentType) continue; // .ico or something that isn't an image at all
      return {
        dataUri: `data:${contentType};base64,${icon.buffer.toString("base64")}`,
        source: url,
        contentType,
        bytes: icon.buffer.length,
      };
    } catch {
      // One bad candidate must not end the search — the next one is usually fine.
    }
  }

  return {
    error: "Couldn't find a usable logo on that site. Its icon may be an .ico file, which we can't store — upload an image instead.",
  };
}
