# News Map

A world map of the news. Every hour a GitHub Action pulls ~50 RSS feeds (global → country → city), asks Gemini (free tier) where each story happens, and saves one JSON file per day. The page is plain HTML + React from a CDN, with no build step.

```
feeds.json ──► scripts/update.mjs ──► Gemini ──► data/2026-09-25.json
   (hourly GitHub Action)                        data/index.json  ──► index.html (map)
```

## Setup (about 5 minutes)

1. **Create a GitHub repo** and push this folder to it.
2. **Get a free Gemini key** at https://aistudio.google.com/apikey.
3. In the repo, go to **Settings → Secrets and variables → Actions → New repository secret**. Name it `GEMINI_API_KEY` and paste the key.
4. Go to **Settings → Pages**. Set Source to "Deploy from a branch" and pick `main` / root. Your map will be at `https://<you>.github.io/<repo>/`.
5. Go to **Actions → Update news → Run workflow** to fill today's data now. After that it runs every hour on its own.

## How locations work

- Gemini returns 1–4 locations per story. Each location has a `level` of `place`, `city`, `state` or `country`, plus lat/lon.
- "Mamdani and Trump meet at Gracie": the pin goes on Gracie Mansion (`place`).
- A story about two places gets two pins, e.g. New York City **and** Spain.
- A story that only names a country is pinned on that country's **capital**.
- Pins at the same coordinate are merged into one pin with a count. Pins near each other cluster as you zoom out.
- Zoom into a city and the panel switches to "Map area" so you see its local news.

## Using it

- **Opens on today.** The side panel shows the day's **top headlines**, ranked by importance (Gemini scores each story 1–10) plus how many feeds carried it.
- **Date picker / ‹ › / Today**: switch days. Changing the day resets the panel to that day's top headlines.
- **Whole world / Map area**: zoom in yourself and the panel switches to the stories on screen; switch back anytime.
- **Top / Latest**: sort order.
- **Filters**: search box (title, summary, people, topics, places), region, time (today only: last hour / 3h / 12h), ★ Major only (importance 7+), trending people and countries, categories, and the precision legend (click to hide exact places / cities / states / countries). **✕ Clear** resets them.
- The URL keeps your state (`#date=2026-09-25&q=trump&region=Europe`), so you can share a filtered view.

## News sources

Defined in `feeds.json` (49 feeds):

- **Global:** BBC World, Al Jazeera, The Guardian World, NPR World, DW, France 24, NYT World, UN News
- **Regional:** BBC Asia, Africa, Latin America, Middle East, Europe
- **Country top stories (Google News):** US, UK, India, Australia, Canada, Singapore, Malaysia, Pakistan, Nigeria, South Africa, Kenya, Philippines, France, Germany, Spain, Brazil, Mexico, Japan, Indonesia, UAE
- **City/local (Google News local):** New York, Los Angeles, Chicago, London, Mumbai, Delhi, Kuala Lumpur, Singapore, Sydney, Toronto, Lagos, Karachi, Madrid, Paris, Tokyo, plus NYT New York Region

Google News pulls from thousands of publishers, so the `source` on each story is the actual outlet (Reuters, The Star, local papers…).

## Config

| Where | What |
|---|---|
| `feeds.json` | Add or remove feeds. `hint` (e.g. `"Local: Chicago"`) helps Gemini resolve ambiguous places. Google News local sections work for most cities: `https://news.google.com/rss/headlines/section/geo/<City>?hl=en-US&gl=US&ceid=US:en` |
| workflow `env` | `NEWS_TIMEZONE` (which timezone defines a "day", currently `Asia/Kuala_Lumpur`) and `START_DATE` |
| repo variable `GEMINI_MODEL` | Optional. A comma-separated list of models to try in order. Default: `gemini-flash-lite-latest,gemini-flash-latest` |
| script env | `ITEMS_PER_FEED` (12), `BATCH_SIZE` (40 stories per request), `MAX_BATCHES` (8 requests per run), `MAX_AGE_HOURS` (36) |

**Free-tier budget:** at most 8 requests per hour, about 190 per day, well under the free limits. Stories that don't fit in one run are picked up in the next. Stories are de-duplicated by headline across feeds and across the last 3 days.

## Custom domain

1. Repo **Settings → Pages → Custom domain**: enter e.g. `news.yourdomain.com` and Save (GitHub adds a `CNAME` file to the repo).
2. At your domain registrar's DNS settings:
   - Subdomain (`news.yourdomain.com`): add a **CNAME** record `news` → `<your-github-username>.github.io`
   - Root domain (`yourdomain.com`): add four **A** records → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (and optionally `www` CNAME → `<username>.github.io`)
3. Wait for the DNS check to go green (minutes to a few hours), then tick **Enforce HTTPS**.

## Run locally

```bash
GEMINI_API_KEY=xxx node scripts/update.mjs   # Node 20+, no npm install
npx serve .                                  # or: python3 -m http.server
```

## Files

- `index.html`, `app.js`, `style.css`: the React app (React + [htm](https://github.com/developit/htm) via jsDelivr, no JSX build)
- `map-style.js`: a no-roads map style on free [OpenFreeMap](https://openfreemap.org) vector tiles (land, water, parks, borders, place names)
- `scripts/update.mjs`: the fetch → Gemini → JSON pipeline (no dependencies)
- `.github/workflows/update-news.yml`: the hourly job
