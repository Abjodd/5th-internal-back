// Session tokens for the consultant portal.
//
// POST /api/auth/consultant-login hands one back; every /api/consultant-portal
// call carries it (Authorization: Bearer …, or ?t= on links the browser opens
// itself, like a document download). It names the login and the consultant and
// is signed with the server's secret, so the portal can only ever read the one
// consultant it was issued for — unlike the internal routes, which trust the
// caller.
//
//   <base64url(JSON {c: credentialId, k: consultantId, e: expiry ms})>.<base64url(HMAC-SHA256)>
import crypto from "node:crypto";

const KEY = crypto.createHash("sha256")
  .update(`consultant-portal:${process.env.AUTH_SECRET || process.env.MONGO_URI || "5th-avenue-dev"}`)
  .digest();
export const TOKEN_DAYS = 7;

const b64 = (buf) => Buffer.from(buf).toString("base64url");
const sign = (body) => b64(crypto.createHmac("sha256", KEY).update(body).digest());

export function issueToken(credentialId, consultantId, days = TOKEN_DAYS) {
  const body = b64(JSON.stringify({ c: credentialId, k: consultantId, e: Date.now() + days * 864e5 }));
  return `${body}.${sign(body)}`;
}

/** { credentialId, consultantId } for a valid, unexpired token — otherwise null. */
export function readToken(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(sign(body)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!p?.c || !p?.k || !(p.e > Date.now())) return null;
  return { credentialId: p.c, consultantId: p.k };
}
