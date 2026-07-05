import { connectDB } from "./db.js";
import Invoice from "./models/Invoice.js";
import Expense from "./models/Expense.js";
import PurchaseOrder from "./models/PurchaseOrder.js";
import ClientPO from "./models/ClientPO.js";
import Quote from "./models/Quote.js";
import RegistryEntry from "./models/RegistryEntry.js";

// Matches the date format used in the original frontend seed data.
function todayStr() {
  return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const SEED_INVOICES = [
  { id:"INV-2026-022", client:"FreshBite Foods", clientId:"cl1", campaign:"c1", type:"campaign",
    label:"Diwali Festive Push — Creator Batch 2", amount:280000, gstRate:18,
    raisedDate:"Apr 28, 2026", dueDate:"May 10, 2026", status:"pending",
    isRetainerClient:true, clientPO:{ id:"CPO-001", poNumber:"PO/FBF/2026/042", amount:1250000, status:"received" },
    schedule:{ type:"advance_final",
      advance:{ pct:50, amount:140000, status:"paid", paidDate:"Apr 28", utr:"HDFC2811204", razorpaySettled:true, settledDate:"Apr 30" },
      final:{ pct:50, amount:140000, status:"pending", dueDate:"May 10" } },
    gstin:"29AADCB2230M1ZP", sac:"998361", placeOfSupply:"Karnataka",
    confirmedByAccounts:true, confirmedByFounder:false },
  { id:"INV-2026-023", client:"FreshBite Foods", clientId:"cl1", campaign:null, type:"retainer",
    label:"Monthly Retainer — May 2026", amount:350000, gstRate:18,
    raisedDate:"May 1, 2026", dueDate:"May 15, 2026", status:"pending",
    isRetainerClient:true, clientPO:null,
    schedule:{ type:"single" },
    gstin:"29AADCB2230M1ZP", sac:"998311", placeOfSupply:"Karnataka",
    confirmedByAccounts:false, confirmedByFounder:false },
  { id:"INV-2026-020", client:"FreshBite Foods", clientId:"cl1", campaign:null, type:"retainer",
    label:"Monthly Retainer — April 2026", amount:350000, gstRate:18,
    raisedDate:"Apr 1, 2026", dueDate:"Apr 15, 2026", status:"overdue",
    isRetainerClient:true, clientPO:null,
    schedule:{ type:"single" },
    gstin:"29AADCB2230M1ZP", sac:"998311", placeOfSupply:"Karnataka",
    confirmedByAccounts:false, confirmedByFounder:false },
  { id:"INV-2026-019", client:"FreshBite Foods", clientId:"cl1", campaign:"c3", type:"campaign",
    label:"Festive Nano Wave — Final Settlement", amount:160000, gstRate:18,
    raisedDate:"Mar 10, 2026", dueDate:"Mar 25, 2026", status:"paid", paidDate:"Mar 22, 2026",
    isRetainerClient:true, clientPO:{ id:"CPO-002", poNumber:"PO/FBF/2026/019", amount:320000, status:"exhausted" },
    schedule:{ type:"advance_final",
      advance:{ pct:50, amount:80000, status:"paid", paidDate:"Mar 10", utr:"ICICI9920021", razorpaySettled:true, settledDate:"Mar 10" },
      final:{ pct:50, amount:80000, status:"paid", paidDate:"Mar 22", utr:"ICICI9920098", razorpaySettled:true, settledDate:"Mar 24" } },
    gstin:"29AADCB2230M1ZP", sac:"998361", placeOfSupply:"Karnataka",
    confirmedByAccounts:true, confirmedByFounder:true },
  { id:"CN-2026-003", client:"FreshBite Foods", clientId:"cl1", campaign:"c2", type:"credit_note",
    label:"Credit Note — Summer Launch (campaign delay)", amount:-45000, gstRate:18,
    raisedDate:"Apr 5, 2026", dueDate:null, status:"issued",
    isRetainerClient:true, clientPO:null, schedule:{ type:"single" },
    gstin:"29AADCB2230M1ZP", sac:"998311", placeOfSupply:"Karnataka",
    confirmedByAccounts:true, confirmedByFounder:true },
];

const SEED_CLIENT_POS = [
  { id:"CPO-001", client:"FreshBite Foods", campaign:"c1", campaignName:"Diwali Festive Push",
    poNumber:"PO/FBF/2026/042", amount:1250000, receivedDate:"Feb 18, 2026", validTill:"Jun 30, 2026",
    document:"uploaded", invoicedAmount:280000, status:"partial" },
  { id:"CPO-002", client:"FreshBite Foods", campaign:"c3", campaignName:"Festive Nano Wave",
    poNumber:"PO/FBF/2026/019", amount:320000, receivedDate:"Dec 28, 2025", validTill:"Mar 31, 2026",
    document:"uploaded", invoicedAmount:320000, status:"exhausted" },
];

const SEED_EXPENSES = [
  { id:"EXP-R-001", cat:"internal_regular", sub:"salary", payee:"May 2026 Payroll Batch", campaign:null,
    amount:385000, date:"May 1, 2026", status:"paid", schedule:{ type:"single" },
    tds:{ applicable:false }, gst:{ applicable:false }, approvedBy:"founder", utr:"AXS_PAYROLL_MAY26",
    note:"5 employees — batch transfer" },
  { id:"EXP-R-002", cat:"internal_regular", sub:"bonus", payee:"Q1 Performance Bonus", campaign:null,
    amount:75000, date:"Apr 28, 2026", status:"pending_approval", schedule:{ type:"single" },
    tds:{ applicable:false }, gst:{ applicable:false }, requestedBy:"founder" },
  { id:"EXP-DIR-001", cat:"director", sub:"salary", payee:"Founder — Director Salary", campaign:null,
    amount:200000, date:"May 1, 2026", status:"paid", schedule:{ type:"single" },
    tds:{ applicable:true, section:"192", rate:30, deducted:60000 }, gst:{ applicable:false },
    approvedBy:"founder", utr:"DIR_SAL_MAY26", directorOnly:true },
  { id:"EXP-DIR-002", cat:"director", sub:"consultancy", payee:"Founder LLP — Consultancy", campaign:null,
    amount:100000, date:"May 5, 2026", status:"paid", schedule:{ type:"single" },
    tds:{ applicable:true, section:"194J", rate:10, deducted:10000 }, gst:{ applicable:true, amount:18000 },
    approvedBy:"founder", utr:"DIR_CON_MAY26", directorOnly:true },
  { id:"EXP-DIR-003", cat:"director", sub:"drawings", payee:"Founder — Drawings", campaign:null,
    amount:50000, date:"May 10, 2026", status:"pending", schedule:{ type:"single" },
    tds:{ applicable:false }, gst:{ applicable:false }, directorOnly:true },
  { id:"EXP-DIR-004", cat:"director", sub:"profit_distribution", payee:"Founder — Profit Share Q1", campaign:null,
    amount:350000, date:"Apr 30, 2026", status:"paid", schedule:{ type:"single" },
    tds:{ applicable:false }, gst:{ applicable:false }, approvedBy:"founder", utr:"DIR_PRF_Q1_26", directorOnly:true },
  { id:"EXP-V-001", cat:"internal_variable", sub:"reimbursement", payee:"Arjun Reddy", campaign:"c1",
    amount:4200, date:"May 3, 2026", status:"pending_approval", schedule:{ type:"single" },
    tds:{ applicable:false }, gst:{ applicable:false }, requestedBy:"ea", note:"Travel to FreshBite HQ" },
  { id:"EXP-V-002", cat:"internal_variable", sub:"misc", payee:"Office Supplies", campaign:null,
    amount:8500, date:"Apr 28, 2026", status:"paid", schedule:{ type:"single" },
    tds:{ applicable:false }, gst:{ applicable:false }, approvedBy:"founder", utr:"MISC_APR26" },
  { id:"EXP-S-001", cat:"external_subscription", sub:"saas", payee:"Notion", campaign:null,
    amount:2800, date:"May 1, 2026", status:"paid", schedule:{ type:"single" },
    tds:{ applicable:false }, gst:{ applicable:true, amount:504 }, approvedBy:"founder" },
  { id:"EXP-S-002", cat:"external_subscription", sub:"saas", payee:"Adobe CC", campaign:null,
    amount:5400, date:"May 2, 2026", status:"paid", schedule:{ type:"single" },
    tds:{ applicable:false }, gst:{ applicable:true, amount:972 }, approvedBy:"founder" },
  { id:"EXP-S-003", cat:"external_subscription", sub:"saas", payee:"Metricool Pro", campaign:null,
    amount:1800, date:"May 1, 2026", status:"paid", schedule:{ type:"single" },
    tds:{ applicable:false }, gst:{ applicable:false }, approvedBy:"founder" },
  { id:"EXP-C-001", cat:"external_creator", sub:"creator_mcn", payee:"StarTalent MCN", campaign:"c1",
    amount:85000, date:"Apr 12, 2026", status:"paid",
    vendorType:"mcn", vendorForCreator:{ creatorName:"Anjali Kitchen", creatorHandle:"@anjalikitchen", creatorId:"r1", followers:820000, platform:"Instagram" },
    schedule:{ type:"single" }, tds:{ applicable:true, section:"194M", rate:10, deducted:8500 }, gst:{ applicable:false },
    pan:"STMCN1234A", poId:"PO-2026-001", approvedBy:"founder", utr:"HDFC2811909",
    eaConfirmed:true, cmConfirmed:true, accConfirmed:true },
  { id:"EXP-C-002", cat:"external_creator", sub:"creator_mcn", payee:"InfluenceHub Agency", campaign:"c1",
    amount:180000, date:null, status:"pending_approval",
    vendorType:"mcn", vendorForCreator:{ creatorName:"South Foodie", creatorHandle:"@southfoodie", creatorId:"r2", followers:1200000, platform:"YouTube" },
    schedule:{ type:"advance_final", advance:{ amount:90000, status:"pending_approval" }, final:{ amount:90000, status:"pending" } },
    tds:{ applicable:true, section:"194M", rate:10, deducted:18000 }, gst:{ applicable:false },
    pan:"IFHUB5678B", poId:"PO-2026-002", requestedBy:"cm", eaConfirmed:false, cmConfirmed:false, accConfirmed:false },
  { id:"EXP-C-003", cat:"external_creator", sub:"creator_mcn", payee:"NanoNet MCN", campaign:"c3",
    amount:18000, date:"Feb 10, 2026", status:"paid",
    vendorType:"mcn", vendorForCreator:{ creatorName:"Mumbai Munchies", creatorHandle:"@mumbaimunch", creatorId:"r3", followers:95000, platform:"Instagram" },
    schedule:{ type:"single" }, tds:{ applicable:false }, gst:{ applicable:false },
    pan:"NANO9012C", approvedBy:"founder", utr:"AXIS0029901", eaConfirmed:true, cmConfirmed:true, accConfirmed:true },
  { id:"EXP-C-004", cat:"external_creator", sub:"creator_mcn", payee:"GoaTalent MCN", campaign:"c3",
    amount:8000, date:"Feb 15, 2026", status:"paid",
    vendorType:"mcn", vendorForCreator:{ creatorName:"Goa Vibes", creatorHandle:"@goavibes", creatorId:"r4", followers:32000, platform:"Instagram" },
    schedule:{ type:"single" }, tds:{ applicable:false }, gst:{ applicable:false },
    pan:null, approvedBy:"founder", utr:"AXIS0029910", eaConfirmed:true, cmConfirmed:true, accConfirmed:true },
  { id:"EXP-V-010", cat:"external_vendor", sub:"vendor", payee:"Pixel Studio", campaign:"c2",
    amount:65000, date:"Apr 20, 2026", status:"paid",
    vendorType:"production", vendorForCreator:null,
    schedule:{ type:"advance_final",
      advance:{ amount:32500, status:"paid", paidDate:"Apr 20", utr:"SBI4481920" },
      final:{ amount:32500, status:"paid", paidDate:"May 8", utr:"SBI4491222" } },
    tds:{ applicable:true, section:"194C", rate:2, deducted:1300 }, gst:{ applicable:true, gstin:"27AAACS1234B1ZX", amount:11700 },
    pan:"PIXEL1234B", poId:"PO-2026-003", approvedBy:"founder", eaConfirmed:true, cmConfirmed:true, accConfirmed:true },
];

const SEED_POS = [
  { id:"PO-2026-001", raisedBy:"ea", raisedByName:"Arjun Reddy", vendor:"StarTalent MCN", vendorType:"creator_mcn",
    campaign:"c1", campaignName:"Diwali Festive Push", scope:"Creator fee via MCN for Anjali Kitchen — 3x Reels + 5x Stories",
    amount:85000, paymentScheduleType:"single", deliveryDate:"Apr 15, 2026",
    status:"closed", poDocument:"uploaded", approvedBy:"founder", approvedAt:"Mar 20, 2026",
    deliveryConfirmed:true, deliveryConfirmedBy:"ea", createdAt:"Mar 18, 2026", notes:"" },
  { id:"PO-2026-002", raisedBy:"cm", raisedByName:"Priya Nair", vendor:"InfluenceHub Agency", vendorType:"creator_mcn",
    campaign:"c1", campaignName:"Diwali Festive Push", scope:"Creator fee via MCN for South Foodie — 2x YouTube Shorts + 3x Community Posts",
    amount:180000, paymentScheduleType:"advance_final", deliveryDate:"May 20, 2026",
    status:"approved", poDocument:null, approvedBy:"founder", approvedAt:"Apr 25, 2026",
    deliveryConfirmed:false, deliveryConfirmedBy:null, createdAt:"Apr 23, 2026", notes:"" },
  { id:"PO-2026-003", raisedBy:"cm", raisedByName:"Priya Nair", vendor:"Pixel Studio", vendorType:"vendor",
    campaign:"c2", campaignName:"Summer Launch Teaser", scope:"Video production — 4x Reels (filming + editing)",
    amount:65000, paymentScheduleType:"advance_final", deliveryDate:"Apr 30, 2026",
    status:"closed", poDocument:"uploaded", approvedBy:"founder", approvedAt:"Apr 5, 2026",
    deliveryConfirmed:true, deliveryConfirmedBy:"ea", createdAt:"Apr 3, 2026", notes:"" },
  { id:"PO-2026-004", raisedBy:"cm", raisedByName:"Vikram Das", vendor:"VideoEdge Studio", vendorType:"vendor",
    campaign:"c2", campaignName:"Summer Launch Teaser", scope:"Post-production — colour grading + subtitle animation for 6 Reels",
    amount:38000, paymentScheduleType:"single", deliveryDate:"May 28, 2026",
    status:"pending_approval", poDocument:null, approvedBy:null, approvedAt:null,
    deliveryConfirmed:false, deliveryConfirmedBy:null, createdAt:todayStr(), notes:"" },
];

const SEED_REGISTRY = [
  { id:"r1", type:"creator", mcnVendor:"StarTalent MCN", name:"Anjali Kitchen", handle:"@anjalikitchen", platform:"Instagram", followers:820000, niche:"Cooking", pan:"ABCDE1234F", gstin:null, bank:"Via StarTalent MCN", tdsSection:"194M", tdsRate:10, totalPaid:255000, tdsDeducted:25500, panCollected:true, campaigns:["c1","c3"] },
  { id:"r2", type:"creator", mcnVendor:"InfluenceHub Agency", name:"South Foodie", handle:"@southfoodie", platform:"YouTube", followers:1200000, niche:"Food", pan:"FGHIJ5678K", gstin:null, bank:"Via InfluenceHub Agency", tdsSection:"194M", tdsRate:10, totalPaid:180000, tdsDeducted:18000, panCollected:true, campaigns:["c1"] },
  { id:"r3", type:"creator", mcnVendor:"NanoNet MCN", name:"Mumbai Munchies", handle:"@mumbaimunch", platform:"Instagram", followers:95000, niche:"Food", pan:"KLMNO9012P", gstin:null, bank:"Via NanoNet MCN", tdsSection:null, tdsRate:0, totalPaid:18000, tdsDeducted:0, panCollected:true, campaigns:["c3"] },
  { id:"r4", type:"creator", mcnVendor:"GoaTalent MCN", name:"Goa Vibes", handle:"@goavibes", platform:"Instagram", followers:32000, niche:"Lifestyle", pan:null, gstin:null, bank:"Via GoaTalent MCN", tdsSection:null, tdsRate:0, totalPaid:8000, tdsDeducted:0, panCollected:false, campaigns:["c3"] },
  { id:"r5", type:"vendor", mcnVendor:null, name:"Pixel Studio", handle:null, platform:null, followers:null, niche:null, pan:"PIXEL1234B", gstin:"27AAACS1234B1ZX", bank:"SBI — CA2229001", tdsSection:"194C", tdsRate:2, totalPaid:65000, tdsDeducted:1300, panCollected:true, campaigns:["c2"] },
  { id:"r6", type:"vendor", mcnVendor:null, name:"VideoEdge Studio", handle:null, platform:null, followers:null, niche:null, pan:"VIDEG5678C", gstin:"29VIDEG5678C1ZY", bank:"HDFC — CA4412009", tdsSection:"194C", tdsRate:2, totalPaid:0, tdsDeducted:0, panCollected:true, campaigns:["c2"] },
];

const SEED_QUOTES = [
  { id:"QT-2026-005", client:"FreshBite Foods", label:"FreshBite — Monsoon Campaign 2026", status:"sent",
    isAutoGenerated:false, campaignId:null, createdDate:"May 15, 2026", validTill:"May 31, 2026",
    isRetainerClient:true, marginPct:35, agencyFeePct:0, agencyFeeType:"over_above",
    lines:[
      { desc:"Influencer Marketing — 8 Creators (Reels + Stories)", sac:"998361", qty:1, rate:650000, gstRate:18 },
      { desc:"Campaign Strategy & Brief Development", sac:"998311", qty:1, rate:80000, gstRate:18 },
      { desc:"Performance Reports (2)", sac:"998312", qty:2, rate:25000, gstRate:18 },
    ],
    notes:"Retainer client — agency fee waived. 50% advance on acceptance." },
  { id:"QT-2026-004", client:"FreshBite Foods", label:"FreshBite — SEO Onboarding", status:"accepted",
    isAutoGenerated:false, campaignId:null, createdDate:"Apr 20, 2026", validTill:"May 5, 2026",
    isRetainerClient:true, marginPct:40, agencyFeePct:0, agencyFeeType:"baked_in",
    lines:[
      { desc:"SEO Strategy & Audit", sac:"998314", qty:1, rate:120000, gstRate:18 },
      { desc:"Monthly SEO Retainer (3 months)", sac:"998314", qty:3, rate:45000, gstRate:18 },
    ],
    notes:"Retainer client — agency fee waived. 3-month commitment." },
];

async function run() {
  await connectDB();

  await Invoice.deleteMany({});
  await Invoice.insertMany(SEED_INVOICES.map(d => ({ ...d, _id: d.id })));
  console.log(`[seed] inserted ${SEED_INVOICES.length} invoices`);

  await ClientPO.deleteMany({});
  await ClientPO.insertMany(SEED_CLIENT_POS.map(d => ({ ...d, _id: d.id })));
  console.log(`[seed] inserted ${SEED_CLIENT_POS.length} client POs`);

  await Expense.deleteMany({});
  await Expense.insertMany(SEED_EXPENSES.map(d => ({ ...d, _id: d.id })));
  console.log(`[seed] inserted ${SEED_EXPENSES.length} expenses`);

  await PurchaseOrder.deleteMany({});
  await PurchaseOrder.insertMany(SEED_POS.map(d => ({ ...d, _id: d.id })));
  console.log(`[seed] inserted ${SEED_POS.length} purchase orders`);

  await RegistryEntry.deleteMany({});
  await RegistryEntry.insertMany(SEED_REGISTRY.map(d => ({ ...d, _id: d.id })));
  console.log(`[seed] inserted ${SEED_REGISTRY.length} registry entries`);

  await Quote.deleteMany({});
  await Quote.insertMany(SEED_QUOTES.map(d => ({ ...d, _id: d.id })));
  console.log(`[seed] inserted ${SEED_QUOTES.length} quotes`);

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
