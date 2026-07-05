import { connectDB } from "./db.js";
import Finding from "./models/Finding.js";

const ALL_FINDINGS = {
  fb: {
    aeo: [
      { id:"fb-aeo-1", cat:"auto",   sev:"critical", pri:24.0, imp:9, eff:1, conf:9, status:"open",
        title:"No FAQ schema on any of 14 product pages",
        finding:"Automated schema scan: zero structured data across all 14 product pages. Competitor Yoga Bar has FAQ schema on 11/12 product pages.",
        insight:"Without schema, FreshBite cannot win featured snippets or AI answer boxes regardless of content quality.",
        recommendation:"Implement FAQ and Product schema on all 14 pages. Est. 4–6 snippet wins within 45 days." },
      { id:"fb-aeo-2", cat:"auto",   sev:"high",     pri:16.0, imp:8, eff:3, conf:8, status:"open",
        title:"'Best low sugar snacks India' AI answer owned by Yoga Bar",
        finding:"Query test: Yoga Bar's blog occupies AI answer box. FreshBite not in top 5 despite relevant products.",
        insight:"This commercial query captures ~8–12% of all clicks. FreshBite's absence costs an estimated 2,400 sessions/month.",
        recommendation:"Create comparison guide targeting this query with structured headers, comparison table, and FAQ schema." },
      { id:"fb-aeo-3", cat:"manual", sev:"medium",   pri:9.0,  imp:6, eff:4, conf:6, status:"open",
        title:"Recipe content lacks structured markup — 8 pages, CTR 1.2% vs 4.1% avg",
        finding:"8 recipe pages with no Recipe schema. Search Console shows high impressions, low CTR.",
        insight:"Recipe schema enables rich results with star ratings and calories — significantly higher CTR.",
        recommendation:"Add Recipe schema to all 8 pages and resubmit to Google Search Console." },
    ],
    seo: [
      { id:"fb-seo-1", cat:"auto",   sev:"high",     pri:16.0, imp:8, eff:5, conf:9, status:"develop",
        title:"Core Web Vitals failing on mobile — LCP 4.2s (threshold 2.5s)",
        finding:"PageSpeed: Mobile LCP 4.2s, FID 180ms, CLS 0.22. All three fail. Desktop acceptable (LCP 1.8s). Mobile = 71% of organic traffic.",
        insight:"Core Web Vitals are a confirmed ranking factor. Failing mobile scores suppress all mobile query rankings.",
        recommendation:"Optimise images (WebP, lazy load), reduce JS bundle. Target LCP < 2.5s, CLS < 0.1." },
      { id:"fb-seo-2", cat:"auto",   sev:"medium",   pri:12.0, imp:8, eff:5, conf:9, status:"open",
        title:"3 content cluster pages missing — 22K/mo combined search volume",
        finding:"Keyword gap: 'healthy office snacks', 'snacks for weight loss', 'high protein snacks India' — no FreshBite pages. Competitors rank P1–5 for all three.",
        insight:"Commercial-intent queries in FreshBite's exact category. Each missing page is a compounding traffic gap.",
        recommendation:"Create 3 pillar pages targeting these clusters (1,800–2,200 words each) with internal link architecture." },
      { id:"fb-seo-3", cat:"manual", sev:"low",      pri:4.0,  imp:4, eff:3, conf:7, status:"monitor",
        title:"Internal linking sparse — 1.2 links/post vs 4.8 category average",
        finding:"Manual review: 22 blog posts averaging 1.2 internal links. Blog posts not linking to product pages or pillar content.",
        insight:"Poor internal linking reduces PageRank flow to key pages and creates orphaned content.",
        recommendation:"Add 3–5 contextual internal links per post. Create a linking brief for the content team." },
    ],
    meo: [
      { id:"fb-meo-1", cat:"auto",   sev:"high",     pri:12.0, imp:6, eff:2, conf:8, status:"open",
        title:"2 partner branch listings unclaimed on Google Maps",
        finding:"GBP scan: Main office claimed. Koramangala and Bandra partner retail locations unclaimed — competitor can flag inaccuracies.",
        insight:"Unclaimed listings cannot be managed. They also affect local AI recommendations sourced from Maps.",
        recommendation:"Claim both via GBP bulk verification. Add photos, hours, products, Q&A within 48 hours." },
    ],
    ai: [
      { id:"fb-ai-1", cat:"auto",   sev:"critical",  pri:21.0, imp:9, eff:3, conf:8, status:"open",
        title:"Brand absent from ChatGPT, Perplexity and Gemini for category queries",
        finding:"Query tested across GPT-4o, Perplexity, Gemini: FreshBite not cited. Happilo cited in all 3. Too Yumm cited in 2 of 3.",
        insight:"AI search share growing 40% YoY. Absence now compounds as AI training solidifies brand associations.",
        recommendation:"Build citation strategy: 3 expert comparison articles, FAQ pages, seed on authoritative food publications." },
      { id:"fb-ai-2", cat:"auto",   sev:"high",      pri:12.0, imp:7, eff:4, conf:7, status:"open",
        title:"No presence in Perplexity for ingredient-based queries",
        finding:"Queries tested: 'millet snacks India', 'low GI snacks for diabetics', 'no maida snacks' — FreshBite absent from all.",
        insight:"Ingredient queries are high-intent purchase triggers. Perplexity heavily favours structured, cited content.",
        recommendation:"Create ingredient authority pages (millets, GI index, sugar content) with academic citations." },
    ],
    reviews: [
      { id:"fb-rev-1", cat:"auto",   sev:"medium",   pri:5.6,  imp:7, eff:4, conf:8, status:"open",
        title:"Review response rate 22% — 12 negative reviews unanswered",
        finding:"127 Google reviews, only 28 responded. 12 negative (1–2 stars) unanswered. Oldest: 6 months.",
        insight:"Response rate is a GBP quality signal. Unanswered negatives increase churn for prospective customers.",
        recommendation:"Respond to all reviews within 2 weeks. Create templates. Set weekly monitoring alert." },
    ],
    social:  [],
    website: [],
    pr:      [],
    community:[],
    marketplace:[],
    influencer:[],
  },
  nb: {
    aeo: [
      { id:"nb-aeo-1", cat:"auto", sev:"critical", pri:21.0, imp:9, eff:3, conf:8, status:"open",
        title:"Competitor owns AI answer for 'best protein powder India' across all platforms",
        finding:"MuscleBlaze cited in ChatGPT, Perplexity and Gemini for 8 of 10 tested category queries. NutriBlend cited in zero.",
        insight:"Brand is invisible at the highest-intent purchase moment. Gap will widen as competitor authority accumulates.",
        recommendation:"Produce 3 long-form comparison articles with clinical citations. Target Perplexity first (fastest to update)." },
    ],
    seo: [
      { id:"nb-seo-1", cat:"auto", sev:"critical", pri:18.0, imp:8, eff:5, conf:9, status:"open",
        title:"Domain authority DA 18 — MuscleBlaze DA 52, Myprotein DA 61",
        finding:"Ahrefs: NutriBlend DA 18, 43 referring domains. MuscleBlaze DA 52, 1,200+ referring domains.",
        insight:"DA gap means NutriBlend cannot compete for competitive keywords regardless of content quality.",
        recommendation:"Target 20 high-quality backlinks in 90 days: fitness blogs, nutrition publications, ingredient suppliers." },
    ],
    meo:[], ai:[], reviews:[], social:[], website:[], pr:[], community:[], marketplace:[], influencer:[],
  },
  ch: {
    meo: [
      { id:"ch-meo-1", cat:"auto", sev:"critical", pri:32.0, imp:8, eff:1, conf:9, status:"open",
        title:"Physical showroom unclaimed on Google Maps — invisible to local search",
        finding:"GBP scan: CraftHome offline store not found as a claimed business. Competitor Pepperfry has 3 claimed local listings within 5km.",
        insight:"Unclaimed GBP = zero local search visibility. Maps also feeds AI local recommendations. 15-minute fix.",
        recommendation:"Claim GBP immediately. Add photos, categories, hours. Request first 10 reviews from existing customers." },
    ],
    aeo: [
      { id:"ch-aeo-1", cat:"auto", sev:"high", pri:27.0, imp:9, eff:4, conf:8, status:"open",
        title:"110K/mo 'home decor ideas' cluster — zero content targeting these queries",
        finding:"Keyword scan: Home decor content cluster has 110K combined monthly searches. CraftHome has product pages only, no inspirational or informational content.",
        insight:"Pepperfry and Urban Ladder dominate these queries with content hubs. CraftHome has no top-of-funnel presence.",
        recommendation:"Build home decor content hub: 5 pillar pages, 20 supporting articles over 90 days." },
    ],
    seo:[], ai:[], reviews:[], social:[], website:[], pr:[], community:[], marketplace:[], influencer:[],
  },
  df: {
    seo: [
      { id:"df-seo-1", cat:"auto", sev:"high", pri:18.0, imp:9, eff:5, conf:9, status:"open",
        title:"Competitor Minimalist outranks on 28 of 35 shared tracked keywords",
        finding:"Rank tracker: DermFirst ranks below Minimalist on 28/35 shared keywords. Average position gap: 6.2 positions.",
        insight:"Systematic underperformance across shared keywords indicates a domain authority and content depth gap vs Minimalist.",
        recommendation:"Sustained 6-month content programme targeting the 28 underperforming keywords. Prioritise top 10 by volume." },
    ],
    aeo:[], meo:[], ai:[], reviews:[], social:[], website:[], pr:[], community:[], marketplace:[], influencer:[],
  },
  tg: {
    aeo:[], seo:[], meo:[], ai:[], reviews:[], social:[], website:[], pr:[], community:[], marketplace:[], influencer:[],
  },
};

async function run() {
  await connectDB();
  await Finding.deleteMany({});
  const docs = [];
  for (const clientId of Object.keys(ALL_FINDINGS)) {
    for (const channel of Object.keys(ALL_FINDINGS[clientId])) {
      for (const f of ALL_FINDINGS[clientId][channel]) {
        docs.push({ ...f, _id: f.id, clientId, channel });
      }
    }
  }
  await Finding.insertMany(docs);
  console.log(`[seed] inserted ${docs.length} findings`);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
