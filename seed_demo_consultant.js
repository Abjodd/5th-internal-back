/**
 * Demo consultant "Komal" — every section filled in, so Services → Consultant
 * and the consultant portal have something real to show.
 *
 *   npm run seed:consultant-demo
 *
 * Creates (or brings up to date — safe to run again, never duplicates):
 *   · the consultant: basic, billing, HQ, tax, primary contact, two POCs
 *   · up to three existing brands assigned (whatever brands this database has)
 *   · three dedicated UGC creators (linked to the Creators directory when the
 *     database has creators; otherwise added by hand)
 *   · a profile picture and a one-page "Consultancy agreement" PDF
 *   · a consultant-portal login: komal@example.com — its password is printed
 *     once, and can be revealed again in Settings → Consultant Login
 *
 * Remove it like any consultant: Services → Consultant → Komal → Delete
 * consultant (that also removes her documents and login).
 *
 * Connects with MONGO_URI from .env and deliberately never prints it.
 */
import "dotenv/config";
import crypto from "node:crypto";
import zlib from "node:zlib";
import mongoose from "mongoose";
import PDFDocument from "pdfkit";
import Consultant from "./models/Consultant.js";
import ConsultantDocument from "./models/ConsultantDocument.js";
import ConsultantCredential from "./models/ConsultantCredential.js";
import Client from "./models/Client.js";
import Creator from "./models/Creator.js";
import { hashPassword, encryptPassword } from "./routes/auth.js";

const EMAIL = "komal@example.com";

// ── a 256×256 PNG picture (warm gradient with a soft ring), no image library needed
function picturePng(size = 256) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      const dx = x - size / 2, dy = y - size / 2, d = Math.sqrt(dx * dx + dy * dy) / (size / 2);
      const ring = Math.max(0, 1 - Math.abs(d - 0.55) * 9) * 0.55;
      const r = Math.round(233 * (1 - t) + 120 * t + 22 * ring), g = Math.round(162 * (1 - t) + 70 * t + 60 * ring), b = Math.round(59 * (1 - t) + 110 * t + 80 * ring);
      row[1 + x * 3] = Math.min(255, r); row[2 + x * 3] = Math.min(255, g); row[3 + x * 3] = Math.min(255, b);
    }
    rows.push(row);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── a one-page agreement PDF
function agreementPdf(brandNames) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A4", margin: 56 });
    const parts = [];
    doc.on("data", (b) => parts.push(b));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    doc.fontSize(9).fillColor("#888").text("DEMO DOCUMENT — sample data for the consultant portal", { align: "right" });
    doc.moveDown(2).fontSize(22).fillColor("#111").text("Consultancy Agreement");
    doc.moveDown(0.5).fontSize(11).fillColor("#444").text("Between Fifth Avenue Marketing and Komal");
    doc.moveDown(1.5).fontSize(11).fillColor("#222");
    const lines = [
      `Effective date: ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}`,
      `Brands covered: ${brandNames.length ? brandNames.join(", ") : "to be assigned"}`,
      "Scope: brand strategy, influencer campaigns and dedicated UGC production.",
      "Billing: monthly, against the GSTIN on record.",
      "This is a sample document created by the demo seed script.",
    ];
    for (const l of lines) doc.text(`•  ${l}`).moveDown(0.4);
    doc.end();
  });
}

async function nextId(Model, prefix) {
  const docs = await Model.find({}, { _id: 1 }).lean();
  const re = new RegExp(`^${prefix}(\\d+)$`);
  return `${prefix}${docs.reduce((m, d) => Math.max(m, Number(re.exec(d._id)?.[1] || 0)), 0) + 1}`;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set in backend/.env");
  mongoose.set("strictQuery", false);
  await mongoose.connect(process.env.MONGO_URI);
  console.log("[seed] connected (database:", mongoose.connection.name + ")");

  const brands = await Client.find({}, { name: 1 }).sort({ name: 1 }).limit(3).lean();
  const directory = await Creator.find({}, { name: 1, handle: 1, platform: 1 }).limit(2).lean();
  const ugc = [
    ...directory.map((c, i) => ({ _id: crypto.randomUUID(), creatorId: c._id, name: c.name || c.handle, handle: c.handle, platform: c.platform || "Instagram", rate: [4500, 6000][i], status: "active", notes: i ? "Long-form reviews, weekend shoots" : "Skincare routines, 48-hour turnaround", addedAt: new Date() })),
    { _id: crypto.randomUUID(), name: "Aanya Kapoor", handle: "@aanya.creates", platform: "Instagram", rate: 3500, status: "active", notes: "Unboxing and lifestyle reels in Hindi and English", addedAt: new Date() },
    { _id: crypto.randomUUID(), name: "Rehan Joshi", handle: "@rehan.ugc", platform: "YouTube", rate: 5000, status: "paused", notes: "Tech explainers — paused until January", addedAt: new Date() },
  ].slice(0, 3);

  const details = {
    name: "Komal",
    email: EMAIL,
    status: "active",
    billing: { gstNumber: "27AAKCK1234M1Z5", address: "Office 704, Lotus Corporate Park, Goregaon East, Mumbai 400063", gst: "27AAKCK1234M1Z5", email: "accounts.komal@example.com" },
    hq: { address: "Lotus Corporate Park, Goregaon East, Mumbai, Maharashtra 400063", gst: "27AAKCK1234M1Z5" },
    tax: { tin: "27551234567", pan: "AAKCK1234M" },
    primaryContact: { _id: "komal-primary", name: "Komal", designation: "Founder & Lead Consultant", email: EMAIL, phone: "+91 98200 12345" },
    pocs: [
      { _id: "komal-poc-1", name: "Neha Iyer", designation: "Account Director", email: "neha.komal@example.com", phone: "+91 98201 22334" },
      { _id: "komal-poc-2", name: "Arjun Desai", designation: "Finance & Billing", email: "arjun.komal@example.com", phone: "+91 98202 33445" },
    ],
    brandIds: brands.map((b) => b._id),
    ugcCreators: ugc,
    notes: "Demo consultant created by seed_demo_consultant.js — safe to delete.",
    avatarImage: { data: picturePng(), contentType: "image/png" },
    avatarUpdatedAt: new Date(),
    avatarSource: "internal",
    avatarUpdatedBy: "Demo seed",
    updatedBy: "Demo seed",
  };

  let c = await Consultant.findOne({ email: EMAIL }).lean();
  if (c) {
    await Consultant.updateOne({ _id: c._id }, { $set: details });
    console.log(`[seed] updated consultant ${c._id} (Komal)`);
  } else {
    c = await Consultant.create({ _id: await nextId(Consultant, "cs"), ...details, createdBy: "Demo seed" });
    console.log(`[seed] created consultant ${c._id} (Komal)`);
  }
  const id = c._id;

  if (!(await ConsultantDocument.exists({ consultantId: id, name: "Consultancy agreement (demo)" }))) {
    const pdf = await agreementPdf(brands.map((b) => b.name));
    await ConsultantDocument.create({ _id: crypto.randomUUID(), consultantId: id, name: "Consultancy agreement (demo)", filename: "komal-consultancy-agreement.pdf",
      file: { data: pdf, contentType: "application/pdf", size: pdf.length }, uploadedBy: "Demo seed", source: "internal", uploadedAt: new Date() });
    console.log("[seed] added document: Consultancy agreement (demo)");
  }

  const existingLogin = await ConsultantCredential.findOne({ username: EMAIL, deleted: { $ne: true } }).lean();
  if (existingLogin) {
    await ConsultantCredential.updateOne({ _id: existingLogin._id }, { $set: { consultantId: id } });
    console.log(`[seed] portal login ${EMAIL} already exists — password unchanged (reveal it in Settings → Consultant Login)`);
  } else {
    const password = `Komal-${crypto.randomBytes(4).toString("hex")}`;
    await ConsultantCredential.create({ _id: await nextId(ConsultantCredential, "cc"), consultantId: id, username: EMAIL, name: "Komal", title: "Founder & Lead Consultant",
      avatar: "K", hashKey: hashPassword(password), passKey: encryptPassword(password) });
    console.log(`[seed] portal login created — email: ${EMAIL}  password: ${password}`);
  }

  console.log(`[seed] brands assigned: ${brands.map((b) => b.name).join(", ") || "none (this database has no brands yet)"}`);
  console.log(`[seed] UGC creators: ${ugc.map((u) => `${u.name}${u.creatorId ? " (from directory)" : ""}`).join(", ")}`);
  await mongoose.disconnect();
}

main().catch(async (e) => { console.error("[seed] failed:", e.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
