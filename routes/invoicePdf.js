// Invoice PDF routes — render (pdfkit) + persist (GridFS).
// Generated invoice PDFs are stored in a GridFS bucket ("invoice_pdfs" →
// invoice_pdfs.files / invoice_pdfs.chunks collections) inside the same Atlas
// database as every other record, so the DB stays the single source of truth
// and PDFs survive server redeploys. The bucket is named distinctly from the
// `invoices` metadata collection to keep the two obviously separate in Compass.
import { Router } from "express";
import mongoose from "mongoose";
import Invoice from "../models/Invoice.js";
import { renderInvoicePdf } from "../invoiceRenderer.js";

const router = Router();

const invoiceBucket = () =>
  new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "invoice_pdfs" });

// Files are matched on invoiceNo metadata; the filename fallback covers
// legacy files uploaded before metadata was stored (plain <invoiceNo>.pdf).
const invoiceFileQuery = (invoiceNo) =>
  ({ $or: [{ "metadata.invoiceNo": invoiceNo }, { filename: `${invoiceNo}.pdf` }] });

// POST /api/invoices/:invoiceNo/pdf — render + persist a creator invoice PDF.
// Body: { campaignId, campaignName, brandId, creator, dated, actor }
// Regenerating the same invoiceNo replaces the previous file. Also upserts an
// Invoice doc (id = invoiceNo) so the PDF shows up in Billing / Influencers.
router.post("/api/invoices/:invoiceNo/pdf", async (req, res) => {
  try {
    const { invoiceNo } = req.params;
    const { campaignId, campaignName, brandId, creator, dated, actor } = req.body;
    if (!creator?.name) return res.status(400).json({ error: "creator is required" });

    const buffer = await renderInvoicePdf({
      creator,
      campaignName,
      invoiceNo,
      dated: dated || new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }),
    });

    // Filename carries the campaign so a downloaded PDF is identifiable at a
    // glance: <campaign-slug>_<campaignId>_<invoiceNo>.pdf
    const campSlug = String(campaignName || "campaign")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    const filename = `${campSlug}_${campaignId || "na"}_${invoiceNo}.pdf`;

    // Replace any previous version of this invoice's file.
    const bucket = invoiceBucket();
    const existing = await bucket.find(invoiceFileQuery(invoiceNo)).toArray();
    await Promise.all(existing.map((f) => bucket.delete(f._id)));

    const fileId = await new Promise((resolve, reject) => {
      const up = bucket.openUploadStream(filename, {
        contentType: "application/pdf",
        metadata: { invoiceNo, campaignId, campaignName: campaignName || null, brandId, creatorName: creator.name, actor },
      });
      up.on("finish", () => resolve(up.id));
      up.on("error", reject);
      up.end(buffer);
    });

    const pdfUrl = `/api/invoices/${encodeURIComponent(invoiceNo)}/pdf`;
    await Invoice.findByIdAndUpdate(
      invoiceNo,
      {
        $set: {
          kind: "creator",
          label: `${creator.name} — ${campaignName || "Creator Invoice"}`,
          creatorName: creator.name,
          creatorHandle: creator.handle || null,
          campaign: campaignId || null,
          brandId: brandId || null,
          amount: creator.fee || 0,
          payType: creator.payType || null,
          pdfFileId: fileId,
          pdfUrl,
          generatedAt: new Date(),
          generatedBy: actor || "Unknown",
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({ id: invoiceNo, pdfUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/invoices/:invoiceNo/pdf — stream the stored PDF from GridFS.
// Looks up by invoiceNo metadata; falls back to the legacy plain filename.
// The Content-Disposition filename is the stored (campaign-tagged) one.
router.get("/api/invoices/:invoiceNo/pdf", async (req, res) => {
  try {
    const { invoiceNo } = req.params;
    const bucket = invoiceBucket();
    const files = await bucket.find(invoiceFileQuery(invoiceNo))
      .sort({ uploadDate: -1 }).limit(1).toArray();
    if (!files.length) return res.status(404).json({ error: "PDF not found" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${files[0].filename}"`);
    bucket.openDownloadStream(files[0]._id).on("error", () => res.status(500).end()).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
