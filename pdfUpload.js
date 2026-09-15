// Shared PDF handling for the collections that store bytes inline on the
// document (see avatarStore.js for why): Newsletter, and creator agreements.
import { toBuffer } from "./avatarStore.js";

export const MAX_PDF_BYTES = 2 * 1024 * 1024; // 2MB
const DATA_URI = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/i;

// Capped on DECODED bytes: base64 inflates by ~33%, so the string length is the
// wrong number in both directions. `label` names the thing in the error.
export function parsePdfUpload(dataUri, label = "File") {
  const m = DATA_URI.exec(String(dataUri || ""));
  if (!m) throw new Error("file must be a base64 data URI");
  if (m[1].toLowerCase() !== "application/pdf") throw new Error(`${label} must be a PDF.`);
  const data = Buffer.from(m[2], "base64");
  if (!data.length) throw new Error("That PDF is empty.");
  if (data.length > MAX_PDF_BYTES) throw new Error(`${label} PDFs must be 2MB or smaller.`);
  return { data, contentType: "application/pdf", size: data.length };
}

// Pass to .find() so PDF bytes never load for a list.
export const OMIT_FILE = { file: 0 };

const filenameOf = (title) => {
  const safe = String(title || "").replace(/[^\w.\- ]+/g, "").trim() || "document";
  return /\.pdf$/i.test(safe) ? safe : `${safe}.pdf`;
};

// Writes a stored { file } doc out as the response, or 404s. Callers keep their
// own lookup — that is where the scoping lives and it should stay visible.
export function sendPdf(res, doc) {
  const bytes = toBuffer(doc?.file?.data);
  if (!bytes) return res.status(404).json({ error: "not found" });
  res.set("Content-Type", doc.file.contentType || "application/pdf");
  res.set("Content-Disposition", `inline; filename="${filenameOf(doc.title)}"`);
  res.send(bytes);
}
