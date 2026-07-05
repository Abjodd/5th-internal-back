import { connectDB } from "./db.js";
import Campaign from "./models/Campaign.js";

const CREATOR_DB = [
  {id:"c001",name:"Anjali Kitchen",   handle:"@anjalikitchen",  platform:"Instagram",niche:"Cooking",  followers:"820K",  avgLikes:"32K",avgER:4.2, fee:85000 },
  {id:"c002",name:"South Foodie",     handle:"@southfoodie",    platform:"YouTube",  niche:"Food",     followers:"1.2M",  avgLikes:"58K",avgER:5.1, fee:180000},
  {id:"c003",name:"Taste of Madras",  handle:"@tasteofmadras",  platform:"Instagram",niche:"Food",     followers:"540K",  avgLikes:"18K",avgER:3.8, fee:65000 },
  {id:"c004",name:"Foodie Hyderabad", handle:"@foodiehyd",      platform:"Instagram",niche:"Lifestyle",followers:"380K",  avgLikes:"16K",avgER:4.5, fee:50000 },
  {id:"c005",name:"Kerala Food Tales",handle:"@keralafood",     platform:"YouTube",  niche:"Cooking",  followers:"290K",  avgLikes:"16K",avgER:6.1, fee:40000 },
  {id:"c006",name:"Mumbai Munchies",  handle:"@mumbaimunch",    platform:"Instagram",niche:"Food",     followers:"95K",   avgLikes:"6.5K",avgER:7.2,fee:18000 },
  {id:"c007",name:"Delhi Diaries",    handle:"@delhidiaries",   platform:"Instagram",niche:"Lifestyle",followers:"78K",   avgLikes:"5K", avgER:6.8, fee:15000 },
  {id:"c008",name:"Chef Kabira",      handle:"@chefkabira",     platform:"YouTube",  niche:"Cooking",  followers:"650K",  avgLikes:"30K",avgER:4.9, fee:90000 },
  {id:"c009",name:"Fit Freaks IN",    handle:"@fitfreaksin",    platform:"Instagram",niche:"Fitness",  followers:"120K",  avgLikes:"6K", avgER:5.5, fee:22000 },
  {id:"c010",name:"Goa Vibes",        handle:"@goavibes",       platform:"Instagram",niche:"Lifestyle",followers:"32K",   avgLikes:"2.8K",avgER:9.2,fee:8000  },
  {id:"c011",name:"Bong Kitchen",     handle:"@bongkitchen",    platform:"YouTube",  niche:"Cooking",  followers:"420K",  avgLikes:"17K",avgER:4.4, fee:55000 },
  {id:"c012",name:"Pune Palate",      handle:"@punepalate",     platform:"Instagram",niche:"Food",     followers:"67K",   avgLikes:"5K", avgER:8.1, fee:12000 },
  {id:"c013",name:"Coastal Kitchen",  handle:"@coastalkitchen", platform:"YouTube",  niche:"Cooking",  followers:"510K",  avgLikes:"25K",avgER:5.3, fee:72000 },
  {id:"c014",name:"Hyderabad Hunger", handle:"@hydhunger",      platform:"Instagram",niche:"Food",     followers:"41K",   avgLikes:"4K", avgER:10.4,fee:9000  },
];

// ── CREATOR FACTORY ──────────────────────────────────────────────────────────
const mkCreator = (src={}, fee) => ({
  _id:      src._id || `cr_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
  dbId:     src.id || src.dbId || null,
  name:     src.name    || "",
  platform: src.platform|| "Instagram",
  handle:   src.handle  || "",
  phone:    src.phone   || null,
  niche:    src.niche   || "",
  followers:src.followers|| "",
  avgLikes: src.avgLikes || null,
  avgER:    src.avgER !== undefined ? src.avgER : (src.engRate || null),
  fee:      fee ?? src.fee ?? 0,
  status:   "shortlisted",
  payType:  null,
  payId:    null,
  concept:  {status:"yet_to_receive",fileLink:null},
  demo:     {status:"yet_to_receive",fileLink:null},
  live:     {postUrl:null,postedDate:null},
  tracking: {views:null,likes:null,comments:null,forwards:null,commentAnalysis:null,positivityScore:null,lastFetched:null},
});

// ── SEED DATA ────────────────────────────────────────────────────────────────
const INIT_CAMPS = [
  {
    id:"c1",name:"Diwali Festive Push",client:"FreshBite Foods",
    service:"Influencer Marketing",region:"South India",
    stage:"outreach",progress:62,budget:1250000,creatorBudget:750000,numReq:5,
    start:"Mar 1",end:"Apr 30",bmId:"t7",cmId:"t1",eaId:"t3",
    brief:{objective:"Build festive awareness across South India for FreshBite's new snack range.",
      audience:"18–35 in TN, KA, KL, TS.",messages:"FreshBite — the festive snack companion.",
      deliverables:["Reel — Collab","Reel — Non-Collab","Story"],budget:"₹12.5L",timeline:"6 weeks"},
    briefStatus:"locked",amNote:"",cmNote:"Focus on authentic home-cook aesthetic.",
    creators:[
      {...mkCreator(CREATOR_DB[0],85000), status:"locked",   payType:"vendor",     payId:"VND-1042",
        concept:{status:"approved",fileLink:"https://drive.google.com/file1"},
        demo:{status:"locked",fileLink:"https://drive.google.com/demo1"},
        live:{postUrl:"https://instagram.com/p/abc1",postedDate:"Apr 12"},
        tracking:{views:480000,likes:21000,comments:980,forwards:3200,commentAnalysis:"Very positive. Users tagging friends.",positivityScore:88,lastFetched:"May 2 09:14"}},
      {...mkCreator(CREATOR_DB[1],180000),status:"negotiating",payType:null,payId:null,
        concept:{status:"received",fileLink:"https://drive.google.com/file2"},
        demo:{status:"yet_to_receive",fileLink:null},live:{postUrl:null,postedDate:null},
        tracking:{views:null,likes:null,comments:null,forwards:null,commentAnalysis:null,positivityScore:null,lastFetched:null}},
      {...mkCreator(CREATOR_DB[3],50000), status:"reached_out",payType:null,payId:null,
        concept:{status:"yet_to_receive",fileLink:null},demo:{status:"yet_to_receive",fileLink:null},
        live:{postUrl:null,postedDate:null},
        tracking:{views:null,likes:null,comments:null,forwards:null,commentAnalysis:null,positivityScore:null,lastFetched:null}},
    ],
    genRounds:1,sentToClient:true,
    internalNotes:"Creator budget ₹7.5L. Keep pricing tight.",
    timeline:[
      {date:"Feb 20",event:"Campaign submitted by client",actor:"Client"},
      {date:"Feb 25",event:"Brief locked by client",actor:"Client"},
      {date:"Feb 27",event:"CM approved, advance pending",actor:"Priya Nair"},
      {date:"Mar 2", event:"Advance confirmed",actor:"Accounts"},
      {date:"Mar 2", event:"Assigned to Arjun Reddy",actor:"Priya Nair"},
    ],
  },
  {
    id:"c2",name:"Summer Launch Teaser",client:"FreshBite Foods",
    service:"Influencer Marketing",region:"North India",
    stage:"bm_review",progress:8,budget:800000,creatorBudget:500000,numReq:8,
    start:"Apr 20",end:"Jun 15",bmId:"t7",cmId:null,eaId:null,
    brief:{objective:"Teaser campaign for FreshBite's summer range.",audience:"18–28, college students.",
      messages:"",deliverables:[],budget:"₹8L",timeline:"Apr 20 – Jun 15"},
    briefStatus:"pending",amNote:"",cmNote:"",
    creators:[],genRounds:0,sentToClient:false,
    internalNotes:"Solid budget — good margin potential.",
    timeline:[{date:"Apr 18",event:"Campaign submitted",actor:"Client"}],
  },
  {
    id:"c3",name:"Festive Nano Wave",client:"FreshBite Foods",
    service:"Influencer Marketing",region:"Pan-India",
    stage:"live",progress:88,budget:320000,creatorBudget:200000,numReq:3,
    start:"Jan 1",end:"Feb 28",bmId:"t7",cmId:"t1",eaId:"t4",
    brief:{objective:"Nano creator sampling across 10 cities.",audience:"18–30 urban millennials.",
      messages:"Healthy snacking, redefined.",deliverables:["Reel — Non-Collab","Story"],budget:"₹3.2L",timeline:"8 weeks"},
    briefStatus:"locked",amNote:"",cmNote:"",
    creators:[
      {...mkCreator(CREATOR_DB[5],18000),status:"locked",payType:"net_banking",payId:"9876543210@upi",
        concept:{status:"locked",fileLink:"#"},demo:{status:"locked",fileLink:"#"},
        live:{postUrl:"https://instagram.com/p/xyz1",postedDate:"Feb 10"},
        tracking:{views:420000,likes:18200,comments:840,forwards:1200,commentAnalysis:"Very positive. Strong brand recall.",positivityScore:91,lastFetched:"Apr 28 10:32"}},
      {...mkCreator(CREATOR_DB[9],8000),status:"locked",payType:"vendor",payId:"VND-2081",
        concept:{status:"locked",fileLink:"#"},demo:{status:"approved",fileLink:"#"},
        live:{postUrl:null,postedDate:null},
        tracking:{views:null,likes:null,comments:null,forwards:null,commentAnalysis:null,positivityScore:null,lastFetched:null}},
    ],
    genRounds:1,sentToClient:true,internalNotes:"Strong results on first creator.",timeline:[],
  },
];

async function run() {
  await connectDB();
  await Campaign.deleteMany({});
  const docs = INIT_CAMPS.map(c => ({ ...c, _id: c.id }));
  await Campaign.insertMany(docs);
  console.log(`[seed] inserted ${docs.length} campaigns`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
