/**
 * seed_all.js — seeds campaigns + all billing collections together
 * with consistent IDs so billing numbers show up immediately.
 *
 * Run: npm run seed:all
 *
 * Campaign IDs (stable): c1, c2, c3
 * Billing records reference those same IDs.
 * Some invoices start as "paid" so the dashboard shows real numbers.
 */
import "dotenv/config";
import { connectDB } from "./db.js";
import Campaign   from "./models/Campaign.js";
import Invoice    from "./models/Invoice.js";
import Expense    from "./models/Expense.js";
import PurchaseOrder from "./models/PurchaseOrder.js";
import ClientPO   from "./models/ClientPO.js";
import Quote      from "./models/Quote.js";
import RegistryEntry from "./models/RegistryEntry.js";

// ── Helper ───────────────────────────────────────────────────────────────────
function d(str) { return str; } // date passthrough — keeps strings readable

// ── CAMPAIGNS ────────────────────────────────────────────────────────────────
const CAMPAIGNS = [
  {
    id:"c1", name:"Diwali Festive Push", client:"FreshBite Foods",
    service:"Influencer Marketing", region:"South India",
    stage:"execution", progress:62, budget:1250000, creatorBudget:750000, numReq:5,
    start:"Mar 1", end:"Apr 30",
    createdBy:"t7", amId:"t7", cmId:"t1", eaId:"t3",
    brief:{ objective:"Build festive awareness across South India.", audience:"18–35 in TN, KA, KL, TS.", messages:"FreshBite — the festive snack companion.", deliverables:["Reel — Collab","Story"], budget:"₹12.5L", timeline:"6 weeks" },
    briefStatus:"shortlisting", amNote:"", cmNote:"", creators:[], genRounds:0,
    sentToClient:false, internalNotes:"Creator budget ₹7.5L.", timeline:[{date:"Feb 20",event:"Campaign created",actor:"Divya Pillai"}],
  },
  {
    id:"c2", name:"Summer Launch Teaser", client:"FreshBite Foods",
    service:"Influencer Marketing", region:"North India",
    stage:"draft", progress:8, budget:800000, creatorBudget:500000, numReq:8,
    start:"Apr 20", end:"Jun 15",
    createdBy:"t7", amId:"t7", cmId:null, eaId:null,
    brief:{ objective:"Teaser for FreshBite summer range.", audience:"18–28 college students.", messages:"", deliverables:[], budget:"₹8L", timeline:"Apr 20 – Jun 15" },
    briefStatus:"draft", amNote:"", cmNote:"", creators:[], genRounds:0,
    sentToClient:false, internalNotes:"Good margin potential.", timeline:[{date:"Apr 18",event:"Campaign created",actor:"Divya Pillai"}],
  },
  {
    id:"c3", name:"Festive Nano Wave", client:"FreshBite Foods",
    service:"Influencer Marketing", region:"Pan-India",
    stage:"live", progress:88, budget:320000, creatorBudget:200000, numReq:3,
    start:"Jan 1", end:"Feb 28",
    createdBy:"t7", amId:"t7", cmId:"t1", eaId:"t4",
    brief:{ objective:"Nano creator sampling across 10 cities.", audience:"18–30 urban millennials.", messages:"Healthy snacking, redefined.", deliverables:["Reel — Non-Collab","Story"], budget:"₹3.2L", timeline:"8 weeks" },
    briefStatus:"shortlisting", amNote:"", cmNote:"", creators:[], genRounds:0,
    sentToClient:true, internalNotes:"Strong results on first creator.", timeline:[],
  },
];

// ── CLIENT POs ───────────────────────────────────────────────────────────────
const CLIENT_POS = [
  { id:"CPO-001", client:"FreshBite Foods", campaign:"c1", poNumber:"PO/FBF/2026/042", amount:1250000, status:"received", receivedDate:"Feb 25, 2026" },
  { id:"CPO-002", client:"FreshBite Foods", campaign:"c2", poNumber:"PO/FBF/2026/055", amount:800000, status:"pending", receivedDate:null },
  { id:"CPO-003", client:"FreshBite Foods", campaign:"c3", poNumber:"PO/FBF/2026/011", amount:320000, status:"received", receivedDate:"Jan 3, 2026" },
];

// ── INVOICES ─────────────────────────────────────────────────────────────────
const INVOICES = [
  {
    id:"INV-2026-001", client:"FreshBite Foods", clientId:"cl1", campaign:"c1",
    type:"campaign", label:"Diwali Festive Push — Advance 50%",
    amount:625000, gstRate:18,
    raisedDate:"Feb 25, 2026", dueDate:"Mar 5, 2026", status:"paid", paidDate:"Mar 3, 2026",
    isRetainerClient:true, clientPO:{ id:"CPO-001", poNumber:"PO/FBF/2026/042", amount:1250000, status:"received" },
    schedule:{ type:"single" },
    gstin:"29AADCB2230M1ZP", sac:"998361", placeOfSupply:"Karnataka",
    confirmedByAccounts:true, confirmedByFounder:true,
  },
  {
    id:"INV-2026-002", client:"FreshBite Foods", clientId:"cl1", campaign:"c1",
    type:"campaign", label:"Diwali Festive Push — Final 50%",
    amount:625000, gstRate:18,
    raisedDate:"May 1, 2026", dueDate:"May 15, 2026", status:"pending",
    isRetainerClient:true, clientPO:{ id:"CPO-001", poNumber:"PO/FBF/2026/042", amount:1250000, status:"received" },
    schedule:{ type:"single" },
    gstin:"29AADCB2230M1ZP", sac:"998361", placeOfSupply:"Karnataka",
    confirmedByAccounts:false, confirmedByFounder:false,
  },
  {
    id:"INV-2026-003", client:"FreshBite Foods", clientId:"cl1", campaign:"c3",
    type:"campaign", label:"Festive Nano Wave — Full Payment",
    amount:320000, gstRate:18,
    raisedDate:"Jan 10, 2026", dueDate:"Jan 20, 2026", status:"paid", paidDate:"Jan 18, 2026",
    isRetainerClient:true, clientPO:{ id:"CPO-003", poNumber:"PO/FBF/2026/011", amount:320000, status:"received" },
    schedule:{ type:"single" },
    gstin:"29AADCB2230M1ZP", sac:"998361", placeOfSupply:"Karnataka",
    confirmedByAccounts:true, confirmedByFounder:true,
  },
  {
    id:"INV-2026-004", client:"FreshBite Foods", clientId:"cl1", campaign:"c2",
    type:"campaign", label:"Summer Launch Teaser — Advance",
    amount:400000, gstRate:18,
    raisedDate:"Apr 20, 2026", dueDate:"Apr 30, 2026", status:"pending",
    isRetainerClient:true, clientPO:null,
    schedule:{ type:"advance_final",
      advance:{ pct:50, amount:400000, status:"pending" },
      final:{ pct:50, amount:400000, status:"pending" },
    },
    gstin:"29AADCB2230M1ZP", sac:"998361", placeOfSupply:"Karnataka",
    confirmedByAccounts:false, confirmedByFounder:false,
  },
  {
    id:"INV-2026-005", client:"FreshBite Foods", clientId:"cl1", campaign:null,
    type:"retainer", label:"Monthly Retainer — May 2026",
    amount:350000, gstRate:18,
    raisedDate:"May 1, 2026", dueDate:"May 15, 2026", status:"paid", paidDate:"May 10, 2026",
    isRetainerClient:true, clientPO:null,
    schedule:{ type:"single" },
    gstin:"29AADCB2230M1ZP", sac:"998311", placeOfSupply:"Karnataka",
    confirmedByAccounts:true, confirmedByFounder:true,
  },
];

// ── EXPENSES ─────────────────────────────────────────────────────────────────
const EXPENSES = [
  {
    id:"EXP-001", vendor:"Anjali Kitchen", vendorType:"creator_mcn", campaign:"c1",
    scope:"Instagram Reel — Collab", amount:85000, status:"paid",
    paymentDate:"Mar 15, 2026", paymentMode:"UPI", utr:"UPI20260315001",
    gst:{ applicable:false }, tds:{ applicable:true, rate:2, deducted:1700 },
    directorOnly:false, notes:"",
  },
  {
    id:"EXP-002", vendor:"South Foodie", vendorType:"creator_mcn", campaign:"c1",
    scope:"YouTube Integration", amount:180000, status:"paid",
    paymentDate:"Mar 20, 2026", paymentMode:"NEFT", utr:"NEFT20260320045",
    gst:{ applicable:false }, tds:{ applicable:true, rate:2, deducted:3600 },
    directorOnly:false, notes:"",
  },
  {
    id:"EXP-003", vendor:"Mumbai Munchies", vendorType:"creator_mcn", campaign:"c3",
    scope:"Instagram Reel", amount:18000, status:"paid",
    paymentDate:"Jan 20, 2026", paymentMode:"UPI", utr:"UPI20260120088",
    gst:{ applicable:false }, tds:{ applicable:true, rate:2, deducted:360 },
    directorOnly:false, notes:"",
  },
  {
    id:"EXP-004", vendor:"Content Studio Bengaluru", vendorType:"agency", campaign:"c1",
    scope:"Video production & editing", amount:45000, status:"pending",
    paymentDate:null, paymentMode:null, utr:null,
    gst:{ applicable:true, rate:18, amount:8100 },
    tds:{ applicable:false },
    directorOnly:false, notes:"Invoice received, pending approval",
  },
  {
    id:"EXP-005", vendor:"Taste of Madras", vendorType:"creator_mcn", campaign:"c1",
    scope:"Instagram Story Series", amount:65000, status:"pending",
    paymentDate:null, paymentMode:null, utr:null,
    gst:{ applicable:false }, tds:{ applicable:true, rate:2, deducted:1300 },
    directorOnly:false, notes:"Awaiting content delivery",
  },
];

// ── PURCHASE ORDERS ───────────────────────────────────────────────────────────
const PURCHASE_ORDERS = [
  {
    id:"PO-2026-001", vendor:"Anjali Kitchen", vendorType:"creator_mcn", campaign:"c1",
    scope:"Diwali Festive Push — Reel × 2", amount:85000,
    status:"work_delivered", approvalStatus:"approved",
    raisedDate:"Mar 1, 2026", deliveryDate:"Mar 20, 2026",
    deliveryConfirmed:true, deliveryConfirmedBy:"Arjun Reddy",
    createdAt:"Mar 1, 2026", notes:"",
  },
  {
    id:"PO-2026-002", vendor:"South Foodie", vendorType:"creator_mcn", campaign:"c1",
    scope:"YouTube Long-form Integration", amount:180000,
    status:"work_delivered", approvalStatus:"approved",
    raisedDate:"Mar 5, 2026", deliveryDate:"Apr 5, 2026",
    deliveryConfirmed:true, deliveryConfirmedBy:"Arjun Reddy",
    createdAt:"Mar 5, 2026", notes:"",
  },
  {
    id:"PO-2026-003", vendor:"Mumbai Munchies", vendorType:"creator_mcn", campaign:"c3",
    scope:"Nano Wave — Reel", amount:18000,
    status:"work_delivered", approvalStatus:"approved",
    raisedDate:"Jan 5, 2026", deliveryDate:"Jan 22, 2026",
    deliveryConfirmed:true, deliveryConfirmedBy:"Sneha Iyer",
    createdAt:"Jan 5, 2026", notes:"",
  },
  {
    id:"PO-2026-004", vendor:"Content Studio Bengaluru", vendorType:"agency", campaign:"c1",
    scope:"Production & editing for Diwali campaign", amount:45000,
    status:"pending_approval", approvalStatus:"pending",
    raisedDate:"Mar 10, 2026", deliveryDate:"Mar 25, 2026",
    deliveryConfirmed:false, deliveryConfirmedBy:null,
    createdAt:"Mar 10, 2026", notes:"",
  },
];

// ── QUOTES ───────────────────────────────────────────────────────────────────
const QUOTES = [
  {
    id:"QT-2026-001", client:"FreshBite Foods", label:"Diwali Festive Push — Commercial Proposal",
    status:"accepted", isRetainerClient:true, campaignId:"c1",
    createdDate:"Feb 10, 2026", validTill:"Feb 20, 2026",
    marginPct:35, agencyFeePct:0, agencyFeeType:"baked_in",
    lines:[
      { desc:"Influencer Marketing — Diwali Festive Push", sac:"998361", qty:1, rate:1250000, gstRate:18 }
    ],
    notes:"",
  },
  {
    id:"QT-2026-002", client:"FreshBite Foods", label:"Summer Launch Teaser — Commercial Proposal",
    status:"pending_review", isRetainerClient:true, campaignId:"c2",
    createdDate:"Apr 15, 2026", validTill:"Apr 25, 2026",
    marginPct:38, agencyFeePct:0, agencyFeeType:"baked_in",
    lines:[
      { desc:"Influencer Marketing — Summer Launch Teaser", sac:"998361", qty:1, rate:800000, gstRate:18 }
    ],
    notes:"Pending client review.",
  },
];

// ── REGISTRY ─────────────────────────────────────────────────────────────────
const REGISTRY = [
  { id:"r1", type:"creator", name:"Anjali Kitchen", handle:"@anjalikitchen", platform:"Instagram", pan:"AAAPA1234A", tdsSection:"194M", tdsRate:2, tdsDeducted:1700, totalPaid:85000, campaigns:["c1"] },
  { id:"r2", type:"creator", name:"South Foodie",   handle:"@southfoodie",   platform:"YouTube",   pan:"BBBSF5678B", tdsSection:"194M", tdsRate:2, tdsDeducted:3600, totalPaid:180000, campaigns:["c1"] },
  { id:"r3", type:"creator", name:"Mumbai Munchies",handle:"@mumbaimunch",   platform:"Instagram", pan:"CCCMM9012C", tdsSection:"194M", tdsRate:2, tdsDeducted:360,  totalPaid:18000,  campaigns:["c3"] },
  { id:"r4", type:"vendor",  name:"Content Studio Bengaluru", pan:"DDDCS3456D", tdsSection:"194C", tdsRate:2, tdsDeducted:900, totalPaid:45000, campaigns:["c1"] },
];

// ── SEED ─────────────────────────────────────────────────────────────────────
async function run() {
  await connectDB();

  // Campaigns
  await Campaign.deleteMany({});
  await Campaign.insertMany(CAMPAIGNS.map(c => ({ ...c, _id: c.id })));
  console.log(`✓ campaigns: ${CAMPAIGNS.length}`);

  // Billing
  await Invoice.deleteMany({});
  await Invoice.insertMany(INVOICES.map(d => ({ ...d, _id: d.id })));
  console.log(`✓ invoices: ${INVOICES.length}`);

  await Expense.deleteMany({});
  await Expense.insertMany(EXPENSES.map(d => ({ ...d, _id: d.id })));
  console.log(`✓ expenses: ${EXPENSES.length}`);

  await PurchaseOrder.deleteMany({});
  await PurchaseOrder.insertMany(PURCHASE_ORDERS.map(d => ({ ...d, _id: d.id })));
  console.log(`✓ purchase orders: ${PURCHASE_ORDERS.length}`);

  await ClientPO.deleteMany({});
  await ClientPO.insertMany(CLIENT_POS.map(d => ({ ...d, _id: d.id })));
  console.log(`✓ client POs: ${CLIENT_POS.length}`);

  await Quote.deleteMany({});
  await Quote.insertMany(QUOTES.map(d => ({ ...d, _id: d.id })));
  console.log(`✓ quotes: ${QUOTES.length}`);

  await RegistryEntry.deleteMany({});
  await RegistryEntry.insertMany(REGISTRY.map(d => ({ ...d, _id: d.id })));
  console.log(`✓ registry: ${REGISTRY.length}`);

  console.log("\n✅ All done. Campaigns and billing share consistent IDs.\n");
  console.log("What you should see in the dashboard:");
  console.log("  Revenue Collected: ₹13L (INV-001 ₹6.25L + INV-003 ₹3.2L + INV-005 ₹3.5L = all paid)");
  console.log("  Total Spent: ₹2.83L (EXP-001 ₹85K + EXP-002 ₹1.8L + EXP-003 ₹18K = paid only)");
  console.log("  Outstanding: ₹10.25L (INV-002 ₹6.25L + INV-004 ₹4L = pending)");
  console.log("  Campaign Budget Tracker: c1 ₹12.5L budget, ₹2.65L spent so far");
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });