// Server-side invoice PDF renderer (pdfkit).
// The backend is the single source of truth for the invoice document: the
// frontend sends the creator + campaign snapshot, we render the same tabular
// layout the old client-side HTML invoice used ("Times New Roman" bordered
// table). The resulting Buffer is stored in MongoDB GridFS (see the
// /api/invoices/:invoiceNo/pdf routes in server.js) so PDFs live in the same
// Atlas database as every other record — no server-disk coupling.
//
// Note on currency: pdfkit's built-in fonts (WinAnsi encoding) can't encode
// the ₹ glyph, so amounts are printed as "Rs. 74,000".
import PDFDocument from "pdfkit";

const AGENCY = { name: "5th Avenue" };

const fmt = (n) => "Rs. " + (n || 0).toLocaleString("en-IN");

// Same amount-in-words helper as the frontend invoice (Indian lakh/thousand
// grouping) — duplicated here because the rendering now lives server-side.
function amtInWords(n) {
  const ones = ["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine",
    "Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"];
  const tens = ["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
  const convert = (num) => {
    if (num === 0) return "";
    if (num < 20)  return ones[num] + " ";
    if (num < 100) return tens[Math.floor(num/10)] + " " + ones[num%10] + " ";
    return ones[Math.floor(num/100)] + " Hundred " + convert(num%100);
  };
  const lakh = Math.floor(n / 100000), rest = n % 100000;
  const thou = Math.floor(rest / 1000), rem  = rest % 1000;
  let result = "";
  if (lakh) result += convert(lakh) + "Lakh ";
  if (thou) result += convert(thou) + "Thousand ";
  result += convert(rem);
  return ("INR " + result.trim() + " Only").replace(/\s+/g, " ");
}

/**
 * renderInvoicePdf({ creator, campaignName, invoiceNo, dated }) → Promise<Buffer>
 * `creator` is the campaign creator object (name, phone, fee, payType,
 * personalDetails { address, pan, email, bankName, bankAccount, bankBranch,
 * ifsc, upiId }).
 */
export function renderInvoicePdf({ creator, campaignName, invoiceNo, dated }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pd  = creator.personalDetails || {};
    const fee = creator.fee || 0;
    const X = 40, W = 515;          // table left edge + width
    let y = 40;

    const line = (x1, y1, x2, y2) => doc.moveTo(x1, y1).lineTo(x2, y2).stroke("#000");
    const hRule = (yy) => line(X, yy, X + W, yy);

    // ── Title row ─────────────────────────────────────────────────────────
    hRule(y);
    doc.font("Times-Bold").fontSize(14).fillColor("#000")
       .text("INVOICE", X, y + 8, { width: W, align: "center" });
    y += 30; hRule(y);

    // ── Seller (creator) block + invoice meta ─────────────────────────────
    const metaX = X + W * 0.62;
    const sellerLines = [
      ["Times-Bold",  `NAME: ${creator.name || ""}`],
      pd.address     ? ["Times-Roman", `ADDRESS: ${pd.address}`]        : null,
      pd.pan         ? ["Times-Bold",  `PAN: ${pd.pan}`]                : null,
      creator.phone  ? ["Times-Roman", `CONTACT NO.: ${creator.phone}`] : null,
      pd.email       ? ["Times-Roman", `EMAIL ID: ${pd.email}`]         : null,
    ].filter(Boolean);
    let sy = y + 7;
    sellerLines.forEach(([font, txt]) => {
      doc.font(font).fontSize(10).text(txt, X + 10, sy, { width: metaX - X - 20 });
      sy = doc.y + 2;
    });
    // Meta mini-table: Invoice No / Dated
    const metaRowH = 22;
    doc.font("Times-Roman").fontSize(10);
    doc.text("Invoice No.", metaX + 8, y + 7);
    doc.text(invoiceNo,     metaX + (W + X - metaX) * 0.45, y + 7);
    line(metaX, y + metaRowH, X + W, y + metaRowH);
    doc.text("Dated", metaX + 8, y + metaRowH + 7);
    doc.text(dated,   metaX + (W + X - metaX) * 0.45, y + metaRowH + 7);
    line(metaX, y + metaRowH * 2, X + W, y + metaRowH * 2);
    line(metaX + (W + X - metaX) * 0.40, y, metaX + (W + X - metaX) * 0.40, y + metaRowH * 2);

    const sellerH = Math.max(sy - y + 6, metaRowH * 2 + 14);
    line(metaX, y, metaX, y + sellerH);
    y += sellerH; hRule(y);

    // ── Buyer block ───────────────────────────────────────────────────────
    doc.font("Times-Roman").fontSize(10).text("Buyer:-", X + 10, y + 7);
    doc.font("Times-Bold").fontSize(11).text(AGENCY.name, X + 10, y + 24);
    y += 44; hRule(y);

    // ── Particulars table ─────────────────────────────────────────────────
    const cols = [
      { w: 40,  label: "Sl No.",  align: "center" },
      { w: 245, label: "Particulars of Service", align: "left" },
      { w: 50,  label: "Qty",     align: "center" },
      { w: 90,  label: "Rate",    align: "center" },
      { w: 90,  label: "Amount",  align: "center" },
    ];
    const colX = cols.reduce((acc, c, i) => [...acc, acc[i] + c.w], [X]);
    const headH = 22;
    doc.font("Times-Bold").fontSize(10);
    cols.forEach((c, i) => doc.text(c.label, colX[i] + 4, y + 6, { width: c.w - 8, align: c.align }));
    y += headH; hRule(y);

    // Item row
    const itemH = 26;
    doc.font("Times-Roman").fontSize(10);
    const item = [
      "1",
      `Influencer Marketing Services — ${campaignName || ""}`,
      "1",
      fmt(fee),
      fmt(fee),
    ];
    item.forEach((txt, i) => doc.text(txt, colX[i] + 4, y + 7, {
      width: cols[i].w - 8, align: i === 0 || i === 2 ? "center" : i >= 3 ? "right" : "left",
    }));
    y += itemH;

    // Blank filler rows (mirrors the 8 empty rows on the HTML invoice)
    const blankH = 16 * 6;
    y += blankH; hRule(y);

    // Column verticals across header + item + filler
    const gridTop = y - headH - itemH - blankH;
    colX.slice(1, -1).forEach((cx) => line(cx, gridTop, cx, y));

    // ── Total row ─────────────────────────────────────────────────────────
    const totalH = 22;
    doc.font("Times-Bold").fontSize(10);
    doc.text("Total", X, y + 6, { width: W - 94, align: "right" });
    doc.text(fmt(fee), colX[4] + 4, y + 6, { width: cols[4].w - 8, align: "right" });
    line(colX[4], y, colX[4], y + totalH);
    y += totalH; hRule(y);

    // ── Amount in words ───────────────────────────────────────────────────
    doc.font("Times-Roman").fontSize(10)
       .text(`Tax Amount (in words): ${amtInWords(fee)}`, X + 10, y + 7, { width: W - 20 });
    y += 26; hRule(y);

    // ── Payment / bank details (pay-type specific, like the HTML invoice) ─
    const payLines = creator.payType === "upi" && pd.upiId
      ? [["UPI ID", pd.upiId]]
      : [
          pd.bankName    ? ["Bank Name", pd.bankName]    : null,
          pd.bankAccount ? ["A/c No.",   pd.bankAccount] : null,
          pd.bankBranch  ? ["Branch",    pd.bankBranch]  : null,
          pd.ifsc        ? ["IFS Code",  pd.ifsc]        : null,
        ].filter(Boolean);
    if (payLines.length) {
      doc.font("Times-Bold").fontSize(10)
         .text(creator.payType === "upi" ? "Payment Details" : "Bank Details", X + 10, y + 7);
      let py = y + 22;
      doc.font("Times-Roman").fontSize(10);
      payLines.forEach(([label, val]) => {
        doc.text(label, X + 10, py);
        doc.text(`: ${val}`, X + 110, py);
        py += 14;
      });
      y = py + 4; hRule(y);
    }

    // ── Signatory ─────────────────────────────────────────────────────────
    doc.font("Times-Roman").fontSize(10)
       .text("for NAME", X, y + 10, { width: W - 14, align: "right" });
    doc.font("Times-Bold").fontSize(10)
       .text((creator.name || "").toUpperCase(), X, y + 46, { width: W - 14, align: "right" });
    doc.font("Times-Roman").fontSize(10)
       .text("Authorised Signatory", X, y + 60, { width: W - 14, align: "right" });
    y += 80; hRule(y);

    // Outer verticals
    line(X, 40, X, y);
    line(X + W, 40, X + W, y);

    doc.end();
  });
}
