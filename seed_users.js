/**
 * seed_users.js — seeds the auth collections: internal users + brand
 * portal credentials.
 *
 * Run: npm run seed:users
 *
 * Mirrors the USERS directory that used to live in
 * 5th-internal-front/src/context/AuthContext.jsx and the PORTAL_USERS in
 * 5th-avenue-client-front — the DB is now the single source of truth for
 * logins. Passwords are stored as hashKey (sha256, for login checks) plus
 * passKey (AES-256-GCM, so the founder Auth page can reveal them); the
 * plaintext itself is never stored. Ids are sequential in the u{n} / bc{n}
 * format — the backend continues the sequence for records added via the
 * Auth page.
 */
import "dotenv/config";
import { connectDB } from "./db.js";
import User from "./models/User.js";
import BrandCredential from "./models/BrandCredential.js";
import { hashPassword, encryptPassword } from "./routes/auth.js";

// ── INTERNAL USERS ───────────────────────────────────────────────────────────
const USERS = [
  { id:"u1", teamId:"t8", name:"Aisha Founder", username:"founder@5thavenue.in",  password:"founder123",  role:"founder",       avatar:"AF", title:"Founder"                    },
  { id:"u2", teamId:"t0", name:"Rohan Mehta",   username:"rohan@5thavenue.in",    password:"pcm123",      role:"pcm",           avatar:"RM", title:"Partner Category Manager"   },
  { id:"u3", teamId:"t1", name:"Priya Nair",    username:"priya@5thavenue.in",    password:"cm123",       role:"cm",            avatar:"PN", title:"Category Manager"           },
  { id:"u4", teamId:"t2", name:"Vikram Das",    username:"vikram@5thavenue.in",   password:"cm456",       role:"cm",            avatar:"VD", title:"Category Manager"           },
  { id:"u5", teamId:"t7", name:"Divya Pillai",  username:"divya@5thavenue.in",    password:"am123",       role:"am",            avatar:"DP", title:"Account Manager"            },
  { id:"u6", teamId:"t3", name:"Arjun Reddy",   username:"arjun@5thavenue.in",    password:"ea123",       role:"ea",            avatar:"AR", title:"Senior Executive Associate" },
  { id:"u7", teamId:"t4", name:"Sneha Iyer",    username:"sneha@5thavenue.in",    password:"ea456",       role:"ea",            avatar:"SI", title:"Executive Associate"        },
  { id:"u8", teamId:"t5", name:"Meera Joshi",   username:"meera@5thavenue.in",    password:"ea789",       role:"ea",            avatar:"MJ", title:"Executive Associate"        },
  { id:"u9", teamId:"t9", name:"Accounts",      username:"accounts@5thavenue.in", password:"accounts123", role:"accounts_head", avatar:"AC", title:"Accounting Head"            },
];

// ── BRAND PORTAL CREDENTIALS ─────────────────────────────────────────────────
// brandId MUST equal a real Client._id (see seed_clients.js) — portal-login
// (routes/auth.js) resolves brandId -> Client to get clientName, and fails
// closed if there's no match. "nb" has no Client doc yet (NutriBlend isn't
// seeded in seed_clients.js), so that login won't work until one is created.
//
// NOTE: re-running this script (npm run seed:users) wipes and rebuilds the
// whole BrandCredential collection — any credentials added later via the
// internal app's Auth page (e.g. ones for brands created after this file was
// last touched) will be lost. Treat this as the initial-seed baseline, not
// a live mirror of the DB.
const BRAND_CREDENTIALS = [
  { id:"bc1", brandId:"freshbite-foods", name:"Rahul Sharma", username:"rahul@freshbitefoods.com", password:"freshbite123",  avatar:"RS", title:"Owner"          },
  { id:"bc2", brandId:"nb",              name:"Kavya Menon",  username:"kavya@nutriblend.in",      password:"nutriblend123", avatar:"KM", title:"Marketing Head" },
];

async function run() {
  await connectDB();

  await User.deleteMany({});
  await User.insertMany(
    USERS.map(({ id, password, ...rest }) => ({ ...rest, _id: id, hashKey: hashPassword(password), passKey: encryptPassword(password) }))
  );
  console.log(`✓ users: ${USERS.length}`);

  await BrandCredential.deleteMany({});
  await BrandCredential.insertMany(
    BRAND_CREDENTIALS.map(({ id, password, ...rest }) => ({ ...rest, _id: id, hashKey: hashPassword(password), passKey: encryptPassword(password) }))
  );
  console.log(`✓ brand credentials: ${BRAND_CREDENTIALS.length}`);

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
