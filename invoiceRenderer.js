// Server-side invoice PDF renderer (pdfkit).
// The backend is the single source of truth for the invoice document: the
// frontend sends the creator + campaign snapshot, we render the same tabular
// layout the old client-side HTML invoice used ("Times New Roman" bordered
// table). The resulting Buffer is stored in MongoDB GridFS (see the
// /api/invoices/:invoiceNo/pdf routes in server.js) so PDFs live in the same
// Atlas database as every other record — no server-disk coupling.
//
// Note on currency: pdfkit's built-in fonts (WinAnsi encoding) can't encode
// the ₹ glyph, so amounts are printed as "Rs. 74,000". See winAnsi() below for
// what happens to every OTHER character the encoding cannot represent.
import PDFDocument from "pdfkit";

const AGENCY = { name: "5th Avenue" };

const fmt = (n) => "Rs. " + (n || 0).toLocaleString("en-IN");

// ── TEXT ENCODING ────────────────────────────────────────────────────────────
// Punctuation phones and word processors produce — curly quotes, long dashes —
// that WinAnsi can't encode. Folded to ASCII rather than dropped, so "O'Brien"
// pasted from a phone stays "O'Brien" instead of becoming "OBrien".
const SUBSTITUTIONS = {
  "\u2018": "'", "\u2019": "'", "\u201A": ",", "\u201B": "'",
  "\u201C": '"', "\u201D": '"', "\u201E": '"',
  "\u2013": "-", "\u2014": "-", "\u2212": "-",
  "\u2026": "...", "\u00A0": " ", "\u20B9": "Rs.",
};

/**
 * Makes text safe for pdfkit's built-in fonts, which are WinAnsi (cp1252).
 *
 * A character WinAnsi can't encode is not rejected — pdfkit silently writes
 * wrong bytes. The creator name "Shoaib🦇" printed on a tax invoice as
 * "ShoaibØ>Ý".
 *
 * The rule: anything WinAnsi can encode passes through (é, ñ, ü included),
 * SUBSTITUTIONS punctuation is folded to ASCII, everything else is dropped.
 * A name missing its emoji is correct; a name in mojibake is not.
 *
 * Embedding a Unicode font would not fix this — pdfkit does no font fallback,
 * so a missing glyph draws .notdef boxes instead. Same problem, new garbage.
 */
export const winAnsi = (value) => String(value ?? "")
  // NFKC, not NFC. Composing keeps accents ("e" + combining acute -> "é")
  // that the filter below would otherwise strip, changing a name's spelling.
  // It also flattens styled text, which creators do use in display names:
  // "𝐾ℎ𝑤𝑎ℎ𝑖𝑠ℎ 𝑆ℎ𝑎𝑟𝑚𝑎" -> "Khwahish Sharma" instead of being dropped.
  .normalize("NFKC")
  .replace(/[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u2013\u2014\u2212\u2026\u00A0\u20B9]/g,
    (c) => SUBSTITUTIONS[c])
  .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");

// Collapses the gap a dropped character leaves behind. Only for standalone
// values like a name — never for the page's own literals, whose spacing is
// deliberate.
const cleanValue = (value) => winAnsi(value).replace(/\s{2,}/g, " ").trim();

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
 * The party this invoice is FROM.
 *
 * A creator assigned to a vendor is invoiced BY that vendor — the vendor is the
 * seller, their GSTIN/PAN is the billing identity and their account is what gets
 * paid. That decision belongs to the frontend's src/lib/payee.js, which sends
 * the resolved payee in the payload: this route has always been a pure renderer
 * of what it is handed (see routes/invoicePdf.js), so re-deriving the rule here
 * would be a second copy of it, free to drift from the one the UI shows.
 *
 * The fallback covers every payload without a payee — invoices raised before
 * vendors existed, and any other caller — by rebuilding the creator's own
 * details in the same shape, so there is one drawing path below either way.
 */
const payeeFrom = (creator, payee) => {
  if (payee) return payee;
  const pd = creator.personalDetails || {};
  return {
    kind: "creator", name: creator.name || "", onBehalfOf: null,
    address: pd.address || null, pan: pd.pan || null, gstin: pd.gstin || null,
    email: pd.email || null, phone: creator.phone || null,
    payType: creator.payType || null,
    bankName: pd.bankName || null, bankAccount: pd.bankAccount || null,
    bankBranch: pd.bankBranch || null, ifsc: pd.ifsc || null, upiId: pd.upiId || null,
  };
};

/**
 * renderInvoicePdf({ creator, payee, campaignName, invoiceNo, dated }) → Promise<Buffer>
 * `creator` is the campaign creator object (name, handle, fee) — whose work the
 * invoice is for. `payee` is who raises and is paid for it; see payeeFrom above.
 */
export function renderInvoicePdf({ creator, payee, campaignName, invoiceNo, dated }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    // Every string that reaches the page goes through the encoder, once, here —
    // rather than at each of the dozen call sites below, where the next line
    // anyone adds would be the one that forgets and quietly ships mojibake on a
    // financial document. An own property shadows the prototype method, and the
    // return value is passed straight back so `.font().fontSize().text()`
    // chaining still works.
    const drawText = doc.text.bind(doc);
    doc.text = (str, ...rest) => drawText(winAnsi(str), ...rest);

    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const p   = payeeFrom(creator, payee);
    const fee = creator.cost ?? creator.fee ?? 0;
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
    // A display name written wholly in a script WinAnsi cannot encode sanitises
    // to nothing, and an invoice with a blank NAME is a worse document than one
    // naming the payee by their handle. Falls back rather than printing empty.
    const sellerName = cleanValue(p.name) || cleanValue(creator.handle) || cleanValue(creator.name);
    // Declared with sellerName, not beside its other use further down: the
    // seller block below reads it, and a `const` used above its declaration is
    // a ReferenceError, not a hoisted undefined.
    const onBehalfOf = cleanValue(p.onBehalfOf) || cleanValue(creator.handle);

    const sellerLines = [
      ["Times-Bold",  `NAME: ${sellerName}`],
      p.onBehalfOf ? ["Times-Roman", `ON BEHALF OF: ${onBehalfOf}`]     : null,
      p.address    ? ["Times-Roman", `ADDRESS: ${p.address}`]           : null,
      p.gstin      ? ["Times-Bold",  `GSTIN: ${p.gstin}`]               : null,
      p.pan        ? ["Times-Bold",  `PAN: ${p.pan}`]                   : null,
      p.phone      ? ["Times-Roman", `CONTACT NO.: ${p.phone}`]         : null,
      p.email      ? ["Times-Roman", `EMAIL ID: ${p.email}`]            : null,
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
    // Whose work it was. On a vendor-raised invoice the seller block is the
    // vendor, so without this the creator the money is actually for appears
    // nowhere on the document.
    const forWhom = p.onBehalfOf
      ? ` (${onBehalfOf}${creator.handle ? ` · ${cleanValue(creator.handle)}` : ""})`
      : "";
    const item = [
      "1",
      `Influencer Marketing Services — ${campaignName || ""}${forWhom}`,
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
    const payLines = p.payType === "upi" && p.upiId
      ? [["UPI ID", p.upiId]]
      : [
          p.bankName    ? ["Bank Name", p.bankName]    : null,
          p.bankAccount ? ["A/c No.",   p.bankAccount] : null,
          p.bankBranch  ? ["Branch",    p.bankBranch]  : null,
          p.ifsc        ? ["IFS Code",  p.ifsc]        : null,
        ].filter(Boolean);
    if (payLines.length) {
      doc.font("Times-Bold").fontSize(10)
         .text(p.payType === "upi" ? "Payment Details" : "Bank Details", X + 10, y + 7);
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
       .text(sellerName.toUpperCase(), X, y + 46, { width: W - 14, align: "right" });
    doc.font("Times-Roman").fontSize(10)
       .text("Authorised Signatory", X, y + 60, { width: W - 14, align: "right" });
    y += 80; hRule(y);

    // Outer verticals
    line(X, 40, X, y);
    line(X + W, 40, X + W, y);

    doc.end();
  });
}
