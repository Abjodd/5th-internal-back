/**
 * Founder email notifications — Resend (https://resend.com).
 *
 * TESTING NOTE: with the default "onboarding@resend.dev" sender you can only
 *  deliver to the email address that you signed up with.
 */

import "dotenv/config";
import { Resend } from "resend";

const API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.RESEND_FROM || "onboarding@resend.dev";
const TO = process.env.FOUNDER_EMAIL;
// The internal platform's own URL — links the CTA button straight to the new
// Client Requests tab. Falls back to localhost for local dev.
const APP_URL = process.env.APP_URL || "http://localhost:5173";

const resend = API_KEY ? new Resend(API_KEY) : null;

const esc = (s) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// One label/value row in the details table.
const row = (label, value) =>
  value
    ? `<tr>
        <td style="padding:9px 16px 9px 0;color:#8A8A8E;font-size:12.5px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;white-space:nowrap;vertical-align:top">${esc(label)}</td>
        <td style="padding:9px 0;color:#1D1D1F;font-size:13.5px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;line-height:1.5">${esc(value)}</td>
      </tr>`
    : "";

// Shared email shell — header, body, details table, optional highlight block,
// CTA and footer. Both the client-signup and creator-application notifications
// render through this so they stay visually identical as the template evolves.
function shell({ heading, intro, rows, highlight, ctaUrl, ctaLabel }) {
  return `
  <div style="background:#F5F5F7;padding:32px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
    <div style="max-width:540px;margin:0 auto;background:#FFFFFF;border-radius:14px;overflow:hidden;border:1px solid #E5E5EA">

      <!-- Header — 5th Avenue mark -->
      <div style="padding:28px 32px;background:#1D1D1F;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:21px;color:#FFFFFF;letter-spacing:-0.01em">
          5th Avenue<span style="font-size:11px;vertical-align:super;font-style:normal;opacity:0.6">™</span>
        </div>
        <div style="font-size:11px;color:rgba(255,255,255,0.55);margin-top:2px;letter-spacing:0.02em">Internal Platform</div>
      </div>

      <!-- Body -->
      <div style="padding:28px 32px 8px">
        <p style="margin:0 0 4px;font-size:15px;color:#1D1D1F;font-weight:600">${heading}</p>
        <p style="margin:0 0 20px;font-size:13.5px;color:#6E6E73;line-height:1.6">${intro}</p>

        <table style="width:100%;border-collapse:collapse;border-top:1px solid #F0F0F2">
          ${rows}
        </table>

        ${highlight ? `
        <div style="margin-top:18px;padding:14px 16px;background:#F9F9FB;border-radius:8px;border:1px solid #F0F0F2">
          <div style="font-size:10.5px;font-weight:600;color:#8A8A8E;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">${esc(highlight.label)}</div>
          <div style="font-size:13px;color:#1D1D1F;line-height:1.6">${esc(highlight.value)}</div>
        </div>` : ""}
      </div>

      <!-- CTA -->
      <div style="padding:20px 32px 32px">
        <a href="${ctaUrl}" style="display:inline-block;padding:11px 22px;background:#1D1D1F;color:#FFFFFF;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600">
          ${esc(ctaLabel)} →
        </a>
      </div>

      <!-- Footer -->
      <div style="padding:16px 32px;background:#FAFAFA;border-top:1px solid #F0F0F2">
        <p style="margin:0;font-size:10.5px;color:#ACACB0">5th Avenue™ — Internal Platform. Automated notification, no reply needed.</p>
      </div>
    </div>
  </div>`;
}

const tab = (path) => `${APP_URL.replace(/\/$/, "")}/${path}`;

/**
 * Send one notification to the founder. Best-effort — resolves to { ok:true }
 * on success, { ok:false, reason } otherwise; never rejects, so callers can
 * fire-and-forget without risking an unhandled rejection.
 */
async function send({ subject, html, label }) {
  if (!resend || !TO) {
    console.warn("[mailer] RESEND_API_KEY / FOUNDER_EMAIL not set — skipping email");
    return { ok: false, reason: "not-configured" };
  }
  try {
    const { data, error } = await resend.emails.send({ from: FROM, to: TO, subject, html });
    if (error) {
      console.warn("[mailer] Resend error:", error.message || error);
      return { ok: false, reason: error.message || String(error) };
    }
    console.log(`[mailer] founder notified of ${label} (${data?.id})`);
    return { ok: true };
  } catch (err) {
    console.warn("[mailer] send failed:", err.message);
    return { ok: false, reason: err.message };
  }
}

/** Notify the founder of a new client request ("Start a project" form). */
export async function sendFounderEmail(reqDoc) {
  const brand = reqDoc.organisation || reqDoc.name || "A new brand";
  return send({
    subject: `New signup — ${brand} wants to work with 5th Avenue`,
    label: reqDoc.id || "signup",
    html: shell({
      heading: "New project brief received",
      intro: `<strong>${esc(brand)}</strong> just submitted the "Start a project" form on the landing page. Details below — set them up as a client whenever you're ready.`,
      rows: [
        row("Name", reqDoc.name),
        row("Role", reqDoc.role),
        row("Contact", reqDoc.contact),
        row("Organisation", reqDoc.organisation),
        row("Headquarters", reqDoc.headquarters),
      ].join(""),
      highlight: reqDoc.goal ? { label: "What they want", value: reqDoc.goal } : null,
      ctaUrl: tab("client-requests"),
      ctaLabel: "Review in Client Requests",
    }),
  });
}

/** Notify the founder of a new creator application ("Apply as a creator" form). */
export async function sendCreatorApplicationEmail(reqDoc) {
  const who = reqDoc.name || reqDoc.handle || "A new creator";
  const list = (a) => (Array.isArray(a) && a.length ? a.join(", ") : "");
  return send({
    subject: `New creator application — ${who}`,
    label: reqDoc.id || "creator application",
    html: shell({
      heading: "New creator application received",
      intro: `<strong>${esc(who)}</strong> just applied through the "Apply as a creator" form on the landing page. Review and add them to the creator directory if they're a fit.`,
      rows: [
        row("Name", reqDoc.name),
        row("Handle", reqDoc.handle),
        row("Platform", reqDoc.platform),
        row("Followers", reqDoc.followers),
        row("Email", reqDoc.email),
        row("Phone", reqDoc.phone),
        row("State", reqDoc.state),
        row("Languages", list(reqDoc.languages)),
      ].join(""),
      highlight: list(reqDoc.niche) ? { label: "Niche", value: list(reqDoc.niche) } : null,
      ctaUrl: tab("creators"),
      ctaLabel: "Review in Creator Requests",
    }),
  });
}
