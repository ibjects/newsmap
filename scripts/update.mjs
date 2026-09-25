// Fetches RSS feeds, asks Gemini where each story happens, and writes
// data/YYYY-MM-DD.json + data/index.json. No dependencies (Node 20+).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";

const env = (k, d) => process.env[k] || d;
const API_KEY = env("GEMINI_API_KEY");
const MODELS = env("GEMINI_MODEL", "gemini-flash-lite-latest,gemini-flash-latest").split(",").map(s => s.trim()).filter(Boolean);
const TZ = env("NEWS_TIMEZONE", "UTC");
const PER_FEED = +env("ITEMS_PER_FEED", 12);      // newest N items taken from each feed
const BATCH = +env("BATCH_SIZE", 40);             // stories per Gemini request
const MAX_BATCHES = +env("MAX_BATCHES", 8);       // Gemini requests per run (free-tier friendly)
const MAX_AGE_H = +env("MAX_AGE_HOURS", 36);      // ignore stories older than this
const START_DATE = env("START_DATE", "");         // e.g. 2026-09-25: never write days before this
const GAP_MS = +env("REQUEST_GAP_MS", 7000);      // pause between Gemini calls (~8 RPM)
const DATA = new URL("../data/", import.meta.url);
const FEEDS = new URL("../feeds.json", import.meta.url);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dayOf = d => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const hash = s => createHash("sha1").update(s).digest("hex").slice(0, 12);
const normTitle = t => t.toLowerCase().replace(/\s[-–|]\s[^-–|]+$/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// ---------- RSS / Atom parsing (regex, good enough for news feeds) ----------
const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const stripTags = s => decode(decode(s)).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
};

function parseFeed(xml, feed) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    let link = stripTags(tag(b, "link"));
    if (!link) link = (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
    const title = stripTags(tag(b, "title"));
    const source = stripTags(tag(b, "source")) || feed.name;
    const when = new Date(stripTags(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date")) || Date.now());
    let summary = stripTags(tag(b, "description") || tag(b, "summary") || tag(b, "content"));
    if (summary.startsWith(title.slice(0, 40))) summary = ""; // Google News repeats the title
    return { title, url: decode(link), source, published: isNaN(when) ? new Date() : when, summary: summary.slice(0, 400), hint: feed.hint };
  }).filter(i => i.title && i.url);
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, { headers: { "user-agent": "Mozilla/5.0 (news-map bot)" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseFeed(await res.text(), feed)
      .sort((a, b) => b.published - a.published).slice(0, PER_FEED);
    console.log(`  ✓ ${feed.name}: ${items.length}`);
    return items;
  } catch (e) {
    console.log(`  ✗ ${feed.name}: ${e.message}`);
    return [];
  }
}

// ---------- Gemini ----------
const CATEGORIES = ["politics", "conflict", "business", "tech", "science", "health", "environment", "crime", "sports", "culture", "disaster", "other"];
const LOC_SCHEMA = {
  type: "OBJECT",
  properties: {
    name: { type: "STRING", description: "Most specific place: landmark/venue, neighbourhood, city, state or country" },
    city: { type: "STRING" }, state: { type: "STRING" }, country: { type: "STRING" },
    cc: { type: "STRING", description: "ISO 3166-1 alpha-2 country code" },
    level: { type: "STRING", enum: ["place", "city", "state", "country"] },
    lat: { type: "NUMBER" }, lon: { type: "NUMBER" },
  },
  required: ["name", "country", "cc", "level", "lat", "lon"],
};
const SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      i: { type: "INTEGER" },
      title: { type: "STRING", description: "Headline in English (translate if needed, drop the ' - Source' suffix)" },
      summary: { type: "STRING", description: "One neutral English sentence, max 30 words" },
      category: { type: "STRING", enum: CATEGORIES },
      importance: { type: "INTEGER", description: "1-10 global newsworthiness: 10 = world-changing, 7 = major national, 4 = regional, 1 = trivia" },
      people: { type: "ARRAY", items: { type: "STRING" } },
      topics: { type: "ARRAY", items: { type: "STRING" } },
      locations: { type: "ARRAY", items: LOC_SCHEMA },
    },
    required: ["i", "title", "summary", "category", "importance", "locations"],
  },
};

const PROMPT = `You geolocate news stories for a world news map.
For EACH story return where it happens / who it concerns geographically:
- Be as specific as the story allows. "Mamdani and Trump meet at Gracie" -> Gracie Mansion, New York (level "place", exact lat/lon of the mansion).
- A story can have several locations when it truly concerns several places (e.g. "NYC mayor meets Spain's PM" -> New York City AND Spain). Max 4.
- If a location is only a country (no city/place can be inferred), use level "country" and the coordinates of that country's CAPITAL city.
- For level "state" use the state/province capital coordinates. For "city" use the city centre.
- Use the feed hint only to disambiguate (e.g. "Springfield" in a Local: Illinois feed); do not invent a location from the hint alone unless the story is clearly local news from that feed.
- If a story has no real-world location (e.g. pure opinion, product review), return an empty locations array.
- people: named people central to the story (full common names, e.g. "Donald Trump", "Zohran Mamdani"). topics: 1-4 short tags.
- importance: rate 1-10 how significant the story is to a general audience (wars, elections, disasters, major economic moves score high; celebrity gossip, sports minutiae, listicles score low).
- Keep "i" equal to the input index. Return one entry per input story.`;

async function gemini(items) {
  const text = items.map((it, i) => `[${i}] (${it.hint}; ${it.source}) ${it.title}${it.summary ? " — " + it.summary : ""}`).join("\n");
  const body = {
    contents: [{ role: "user", parts: [{ text: PROMPT + "\n\nSTORIES:\n" + text }] }],
    generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseSchema: SCHEMA },
  };
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      }).catch(e => ({ ok: false, status: 0, text: async () => e.message }));
      if (res.ok) {
        const json = await res.json();
        const out = json.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "[]";
        try { return JSON.parse(out); } catch { console.log(`  ! ${model}: unparsable JSON`); break; }
      }
      const err = await res.text();
      console.log(`  ! ${model} HTTP ${res.status}: ${err.slice(0, 200)}`);
      if (res.status === 404 || res.status === 400) break;          // model missing → try next model
      if (res.status === 429 && /per ?day|PerDay/i.test(err)) break; // daily quota gone for this model
      await sleep(res.status === 429 ? 30000 : 5000);
    }
  }
  return null;
}

const validLoc = l => l && Number.isFinite(l.lat) && Number.isFinite(l.lon) && Math.abs(l.lat) <= 90 && Math.abs(l.lon) <= 180 && !(l.lat === 0 && l.lon === 0);

// ---------- storage ----------
async function readJson(name, fallback) {
  try { return JSON.parse(await readFile(new URL(name, DATA), "utf8")); } catch { return fallback; }
}
const days = new Map(); // date -> { date, updated, articles }
async function loadDay(date) {
  if (!days.has(date)) days.set(date, await readJson(`${date}.json`, { date, updated: null, articles: [] }));
  return days.get(date);
}

// ---------- main ----------
async function main() {
  if (!API_KEY) throw new Error("GEMINI_API_KEY is not set");
  await mkdir(DATA, { recursive: true });
  const now = new Date();

  // Known story ids from the last 3 days, so nothing gets sent to Gemini twice.
  // Also used to count coverage: how many different feeds carried a story (a strong "top story" signal).
  const known = new Map(), dirty = new Set();
  for (let d = 0; d < 3; d++) {
    const day = await loadDay(dayOf(new Date(now - d * 864e5)));
    day.articles.forEach(a => known.set(a.id, { a, day }));
  }

  const feeds = JSON.parse(await readFile(FEEDS, "utf8"));
  console.log(`Fetching ${feeds.length} feeds…`);
  const perFeed = await Promise.all(feeds.map(fetchFeed));

  // Round-robin across feeds so local feeds are not starved by big global ones.
  const queue = [], queued = new Map();
  for (let r = 0; r < PER_FEED; r++) perFeed.forEach((list, f) => {
    const it = list[r];
    if (!it || now - it.published > MAX_AGE_H * 36e5) return;
    if (START_DATE && dayOf(it.published) < START_DATE) return;
    it.id = hash(normTitle(it.title));
    const feedName = feeds[f].name;
    const old = known.get(it.id);
    if (old) {                                   // already stored: record extra coverage + that it's still live
      old.a.feeds = old.a.feeds || [];
      if (!old.a.feeds.includes(feedName)) old.a.feeds.push(feedName);
      old.a.lastSeen = now.toISOString();
      dirty.add(old.day.date);
      return;
    }
    if (queued.has(it.id)) { queued.get(it.id).feeds.add(feedName); return; }
    it.feeds = new Set([feedName]);
    queued.set(it.id, it); queue.push(it);
  });
  const todo = queue.slice(0, BATCH * MAX_BATCHES);
  console.log(`${queue.length} new stories, processing ${todo.length}`);

  let added = 0;
  for (let b = 0; b < todo.length; b += BATCH) {
    const batch = todo.slice(b, b + BATCH);
    if (b) await sleep(GAP_MS);
    const result = await gemini(batch);
    if (!result) { console.log("  Gemini unavailable, stopping (remaining stories retry next run)"); break; }
    for (const r of result) {
      const it = batch[r.i];
      if (!it) continue;
      const locations = (r.locations || []).filter(validLoc).slice(0, 4).map(l => ({
        name: l.name, city: l.city || "", state: l.state || "", country: l.country, cc: (l.cc || "").toUpperCase(),
        level: l.level, lat: +l.lat.toFixed(5), lon: +l.lon.toFixed(5),
      }));
      const day = await loadDay(dayOf(it.published));
      dirty.add(day.date);
      day.articles.push({
        id: it.id, title: r.title || it.title, summary: r.summary || it.summary, url: it.url, source: it.source,
        published: it.published.toISOString(), fetched: now.toISOString(), lastSeen: now.toISOString(), category: CATEGORIES.includes(r.category) ? r.category : "other",
        importance: Math.min(10, Math.max(1, Math.round(r.importance) || 3)), feeds: [...it.feeds],
        people: r.people || [], topics: r.topics || [], locations,
      });
      added++;
    }
    console.log(`  batch ${b / BATCH + 1}: +${result.length}`);
  }

  // Write touched days + index.
  const index = await readJson("index.json", []);
  for (const [date, day] of days) {
    if (!dirty.has(date) || !day.articles.length) continue;
    day.updated = now.toISOString();
    day.articles.sort((a, b) => b.published.localeCompare(a.published));
    await writeFile(new URL(`${date}.json`, DATA), JSON.stringify(day));
    const row = index.find(r => r.date === date);
    if (row) row.count = day.articles.length; else index.push({ date, count: day.articles.length });
  }
  index.sort((a, b) => b.date.localeCompare(a.date));
  await writeFile(new URL("index.json", DATA), JSON.stringify(index, null, 1));
  // meta.json tells the page which timezone defines "today" and when data last refreshed.
  await writeFile(new URL("meta.json", DATA), JSON.stringify({ timezone: TZ, updated: now.toISOString(), feeds: feeds.length }, null, 1));
  console.log(`Done: +${added} stories`);
}

main().catch(e => { console.error(e); process.exit(1); });
