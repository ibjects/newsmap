const { useState, useEffect, useMemo, useRef, useCallback } = React;
const html = htm.bind(React.createElement);

const LEVELS = {
  place:   { color: "#e11d48", label: "Exact place", zoom: 14 },
  city:    { color: "#f97316", label: "City",        zoom: 10 },
  state:   { color: "#8b5cf6", label: "State",       zoom: 6 },
  country: { color: "#2563eb", label: "Country",     zoom: 4.5 },
};
const RANK = { place: 0, city: 1, state: 2, country: 3 };
const CATEGORIES = ["politics", "conflict", "business", "tech", "science", "health", "environment", "crime", "sports", "culture", "disaster", "other"];
const TIMES = [[0, "Any time"], [1, "Last hour"], [3, "Last 3 hours"], [12, "Last 12 hours"]];

// ISO country code -> region, for the region filter.
const REGIONS = {
  "North America": "US CA GL BM PM",
  "Latin America": "MX GT BZ SV HN NI CR PA CU JM HT DO PR BS BB TT AG DM GD KN LC VC CO VE EC PE BO CL AR UY PY BR GY SR GF AW CW KY TC VG VI MQ GP",
  "Europe": "GB IE FR DE ES PT IT NL BE LU CH AT DK NO SE FI IS PL CZ SK HU RO BG GR HR SI RS BA ME MK AL XK MD UA BY RU EE LV LT MT CY AD MC SM VA LI GI FO IM JE GG",
  "Middle East": "TR IL PS LB SY JO IQ IR SA AE QA BH KW OM YE EG",
  "Africa": "DZ MA TN LY SD SS ET ER DJ SO KE UG TZ RW BI CD CG CF CM TD NE NG BJ TG GH CI BF ML SN GM GW GN SL LR MR CV ST GQ GA AO ZM ZW MW MZ MG MU SC KM NA BW ZA LS SZ EH RE YT",
  "South Asia": "IN PK BD LK NP BT MV AF",
  "East Asia": "CN JP KR KP TW HK MO MN",
  "Southeast Asia": "MY SG ID TH VN PH MM KH LA BN TL",
  "Central Asia": "KZ UZ TM KG TJ AM AZ GE",
  "Oceania": "AU NZ PG FJ SB VU WS TO KI TV NR PW FM MH NC PF GU",
};
const REGION_OF = {};
for (const [r, codes] of Object.entries(REGIONS)) codes.split(" ").forEach(c => (REGION_OF[c] = r));

// ---------- helpers ----------
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const locKey = l => `${l.lat.toFixed(3)},${l.lon.toFixed(3)}`;
const locLabel = l => [l.name, l.level !== "city" && l.city !== l.name ? l.city : "", l.level !== "country" ? l.country : ""]
  .filter((v, i, a) => v && a.indexOf(v) === i).join(", ");
const timeAgo = iso => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 60) return `${Math.max(m, 1)}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const dayIn = tz => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); } catch { return new Date().toISOString().slice(0, 10); } };
const prettyDate = d => new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const readHash = () => Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
const coverage = a => a.feeds?.length || 1;
// "Top" score: how important Gemini judged it + how many feeds carried it.
const score = a => (a.importance || 4) + Math.log2(coverage(a)) * 1.5;
const byTop = (x, y) => score(y) - score(x) || y.published.localeCompare(x.published);
const byLatest = (x, y) => y.published.localeCompare(x.published);
const matches = (a, q) => {
  if (!q) return true;
  const hay = [a.title, a.summary, a.source, ...(a.people || []), ...(a.topics || []),
    ...a.locations.flatMap(l => [l.name, l.city, l.state, l.country])].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
};
const topN = (list, key, n) => {
  const c = {};
  list.forEach(a => new Set(key(a)).forEach(v => v && (c[v] = (c[v] || 0) + 1)));
  return Object.entries(c).filter(([, k]) => k > 1).sort((a, b) => b[1] - a[1]).slice(0, n).map(([v]) => v);
};

// One map feature per unique coordinate, carrying all stories pinned there.
function buildPins(articles) {
  const pins = new Map();
  for (const a of articles) for (const l of a.locations) {
    const k = locKey(l);
    if (!pins.has(k)) pins.set(k, { key: k, loc: l, articles: [] });
    const p = pins.get(k);
    if (RANK[l.level] < RANK[p.loc.level]) p.loc = l;
    if (!p.articles.includes(a)) p.articles.push(a);
  }
  pins.forEach(p => p.articles.sort(byTop));
  return pins;
}
const toGeoJSON = pins => ({
  type: "FeatureCollection",
  features: [...pins.values()].map(p => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [p.loc.lon, p.loc.lat] },
    properties: { key: p.key, count: p.articles.length, level: p.loc.level },
  })),
});

function popupHTML(pin) {
  const items = pin.articles.map(a => `
    <li><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>
      <div class="meta">${esc(a.source)} · ${timeAgo(a.published)}</div></li>`).join("");
  return `<div class="popup"><div class="popup-head"><span class="dot" style="background:${LEVELS[pin.loc.level].color}"></span>
    ${esc(locLabel(pin.loc))}</div><ul>${items}</ul></div>`;
}

// ---------- Map component ----------
function NewsMap({ pins, selected, onView, mapRef }) {
  const el = useRef(null);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;

  useEffect(() => {
    const map = new maplibregl.Map({ container: el.current, style: window.MAP_STYLE, center: window.innerWidth < 760 ? [-20, 25] : [35, 25], zoom: window.innerWidth < 760 ? 0.3 : 1.2, attributionControl: false });
    mapRef.current = window.__map = map; // __map handy for debugging in devtools
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-left");
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }), "bottom-left");

    const setup = () => {
      if (map.getSource("pins")) return;
      map.addSource("pins", {
        type: "geojson", data: toGeoJSON(pinsRef.current),
        cluster: true, clusterRadius: 46, clusterMaxZoom: 13,
        clusterProperties: { total: ["+", ["get", "count"]] },
      });
      map.addSource("selected", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

      map.addLayer({ id: "clusters", type: "circle", source: "pins", filter: ["has", "point_count"],
        paint: {
          "circle-color": "#1f2937", "circle-opacity": 0.85, "circle-stroke-color": "#fff", "circle-stroke-width": 2,
          "circle-radius": ["interpolate", ["linear"], ["get", "total"], 2, 14, 20, 20, 100, 28, 500, 36],
        } });
      map.addLayer({ id: "cluster-count", type: "symbol", source: "pins", filter: ["has", "point_count"],
        layout: { "text-field": ["to-string", ["get", "total"]], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-allow-overlap": true },
        paint: { "text-color": "#fff" } });
      map.addLayer({ id: "selected-line", type: "line", source: "selected", filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#111827", "line-width": 2, "line-dasharray": [2, 2] } });
      map.addLayer({ id: "pin", type: "circle", source: "pins", filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": ["match", ["get", "level"], ...Object.entries(LEVELS).flatMap(([k, v]) => [k, v.color]), "#666"],
          "circle-radius": ["interpolate", ["linear"], ["get", "count"], 1, 7, 10, 12, 50, 18],
          "circle-stroke-color": "#fff", "circle-stroke-width": 2,
        } });
      map.addLayer({ id: "pin-count", type: "symbol", source: "pins", filter: ["all", ["!", ["has", "point_count"]], [">", ["get", "count"], 1]],
        layout: { "text-field": ["to-string", ["get", "count"]], "text-font": ["Noto Sans Bold"], "text-size": 10, "text-allow-overlap": true },
        paint: { "text-color": "#fff" } });
      map.addLayer({ id: "selected-pin", type: "circle", source: "selected", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 14, "circle-color": "transparent", "circle-stroke-color": "#111827", "circle-stroke-width": 3 } });

      map.on("click", "clusters", async e => {
        const f = e.features[0];
        const zoom = await map.getSource("pins").getClusterExpansionZoom(f.properties.cluster_id);
        map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(zoom, 15) }, { user: true });
      });
      map.on("click", "pin", e => {
        const pin = pinsRef.current.get(e.features[0].properties.key);
        if (pin) new maplibregl.Popup({ maxWidth: "340px", offset: 12 }).setLngLat(e.features[0].geometry.coordinates).setHTML(popupHTML(pin)).addTo(map);
      });
      for (const l of ["clusters", "pin"]) {
        map.on("mouseenter", l, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", l, () => (map.getCanvas().style.cursor = ""));
      }
      onView(map, false);
    };
    // "load" waits for every tile; if some tiles fail it can stall, so also poll for the style.
    map.on("load", setup);
    const poll = setInterval(() => { if (map.getSource("pins")) clearInterval(poll); else if (map.isStyleLoaded()) setup(); }, 400);
    map.on("moveend", e => onView(map, !!(e.originalEvent || e.user)));
    return () => { clearInterval(poll); map.remove(); };
  }, []);

  useEffect(() => { mapRef.current?.getSource("pins")?.setData(toGeoJSON(pins)); }, [pins]);

  useEffect(() => {
    const src = mapRef.current?.getSource("selected");
    if (!src) return;
    const locs = selected?.locations || [];
    const features = locs.map(l => ({ type: "Feature", geometry: { type: "Point", coordinates: [l.lon, l.lat] } }));
    if (locs.length > 1) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: locs.map(l => [l.lon, l.lat]) } });
    src.setData({ type: "FeatureCollection", features });
  }, [selected]);

  return html`<div ref=${el} class="map"></div>`;
}

// ---------- App ----------
function App() {
  const init = readHash();
  const [meta, setMeta] = useState(null);
  const [dates, setDates] = useState(null);
  const [date, setDate] = useState(init.date || "");
  const [day, setDay] = useState(null);
  const [query, setQuery] = useState(init.q || "");
  const [cats, setCats] = useState(init.cat ? init.cat.split(",") : []);
  const [region, setRegion] = useState(init.region || "");
  const [hours, setHours] = useState(+init.hours || 0);
  const [major, setMajor] = useState(init.major === "1");
  const [levels, setLevels] = useState(Object.keys(LEVELS));
  const [sort, setSort] = useState(init.sort || "top");
  const [scope, setScope] = useState("world"); // "world" = whole day, "area" = only what's on the map
  const [view, setView] = useState({ bounds: null, zoom: 1.2 });
  const [selected, setSelected] = useState(null);
  const [panelOpen, setPanelOpen] = useState(window.innerWidth > 760);
  const mapRef = useRef(null);
  const listRef = useRef(null);

  const today = dayIn(meta?.timezone || "Asia/Kuala_Lumpur");

  useEffect(() => {
    Promise.all([
      fetch("data/meta.json", { cache: "no-cache" }).then(r => r.json()).catch(() => ({})),
      fetch("data/index.json", { cache: "no-cache" }).then(r => r.json()).catch(() => []),
    ]).then(([m, list]) => {
      setMeta(m);
      const t = dayIn(m.timezone || "Asia/Kuala_Lumpur");
      if (!list.some(d => d.date === t)) list = [{ date: t, count: 0 }, ...list]; // today is always selectable
      setDates(list);
      if (!date || !list.some(d => d.date === date)) setDate(t);
    });
  }, []);

  // New day selected: load it and show that day's top headlines.
  useEffect(() => {
    if (!date) return;
    setDay(null); setSelected(null); setScope("world"); setSort("top");
    if (date !== today) setHours(0);
    listRef.current?.scrollTo(0, 0);
    fetch(`data/${date}.json`, { cache: "no-cache" }).then(r => r.ok ? r.json() : Promise.reject())
      .then(setDay).catch(() => setDay({ date, articles: [] }));
  }, [date]);

  useEffect(() => {
    const p = new URLSearchParams();
    if (date) p.set("date", date);
    if (query) p.set("q", query);
    if (cats.length) p.set("cat", cats.join(","));
    if (region) p.set("region", region);
    if (hours) p.set("hours", hours);
    if (major) p.set("major", "1");
    if (sort !== "top") p.set("sort", sort);
    history.replaceState(null, "", "#" + p.toString());
  }, [date, query, cats, region, hours, major, sort]);

  const all = day?.articles || [];
  const filtered = useMemo(() => {
    const since = hours ? Date.now() - hours * 36e5 : 0;
    return all.map(a => {
      // Keep only the locations that pass the level/region filters.
      const locs = a.locations.filter(l => levels.includes(l.level) && (!region || REGION_OF[l.cc] === region));
      return locs.length === a.locations.length ? a : { ...a, locations: locs };
    }).filter(a => a.locations.length && matches(a, query) && (!cats.length || cats.includes(a.category))
      && (!major || (a.importance || 0) >= 7) && (!since || new Date(a.published) >= since));
  }, [all, query, cats, region, hours, major, levels]);
  const pins = useMemo(() => buildPins(filtered), [filtered]);

  const onView = useCallback((map, user) => {
    const zoom = map.getZoom();
    setView({ bounds: map.getBounds(), zoom });
    if (user) setScope(zoom >= 3 ? "area" : "world"); // you zoomed in yourself → list what's on screen
  }, []);

  const inArea = useMemo(() => {
    const b = view.bounds;
    return b ? filtered.filter(a => a.locations.some(l => b.contains([l.lon, l.lat]))) : filtered;
  }, [filtered, view]);

  const shown = useMemo(() => {
    const list = [...(scope === "area" ? inArea : filtered)];
    return list.sort(sort === "latest" ? byLatest : byTop);
  }, [scope, inArea, filtered, sort]);

  const focus = a => {
    setSelected(a);
    const map = mapRef.current;
    if (!map || !a.locations.length) return;
    const wide = window.innerWidth > 760;
    const padding = { top: 110, bottom: 40, left: 40, right: wide && panelOpen ? 400 : 40 };
    if (a.locations.length === 1) {
      const l = a.locations[0];
      map.flyTo({ center: [l.lon, l.lat], zoom: LEVELS[l.level].zoom, speed: 1.6, padding });
    } else {
      const b = new maplibregl.LngLatBounds();
      a.locations.forEach(l => b.extend([l.lon, l.lat]));
      map.fitBounds(b, { padding, maxZoom: 8 });
    }
    if (!wide) setPanelOpen(false);
  };

  const idx = dates?.findIndex(d => d.date === date) ?? -1;
  const step = dir => { const d = dates?.[idx + dir]; if (d) setDate(d.date); };
  const toggle = (list, set, v) => set(list.includes(v) ? list.filter(x => x !== v) : [...list, v]);
  const quick = q => setQuery(query === q ? "" : q);
  const active = query || cats.length || region || hours || major || levels.length < 4;
  const clearAll = () => { setQuery(""); setCats([]); setRegion(""); setHours(0); setMajor(false); setLevels(Object.keys(LEVELS)); };

  const trendingPeople = useMemo(() => topN(all, a => a.people || [], 6), [all]);
  const trendingPlaces = useMemo(() => topN(all, a => a.locations.map(l => l.country), 5), [all]);

  const isToday = date === today;
  return html`
    <${NewsMap} pins=${pins} selected=${selected} onView=${onView} mapRef=${mapRef} />

    <header class="bar">
      <div class="brand">News<span>Map</span></div>
      <div class="date">
        <button onClick=${() => step(1)} disabled=${!dates || idx >= dates.length - 1} title="Previous day">‹</button>
        <select value=${date} onChange=${e => setDate(e.target.value)} disabled=${!dates?.length}>
          ${(dates || []).map(d => html`<option key=${d.date} value=${d.date}>
            ${d.date === today ? "Today" : prettyDate(d.date)} · ${d.count} stories</option>`)}
        </select>
        <button onClick=${() => step(-1)} disabled=${idx <= 0} title="Next day">›</button>
        ${!isToday && html`<button class="today" onClick=${() => setDate(today)}>Today</button>`}
      </div>
      <div class="search">
        <input type="search" placeholder="Search: Trump, Gaza, floods, Kuala Lumpur…" value=${query} onInput=${e => setQuery(e.target.value)} />
      </div>
    </header>

    <div class="chips">
      <select class=${"chip" + (region ? " on" : "")} value=${region} onChange=${e => setRegion(e.target.value)}>
        <option value="">🌍 All regions</option>
        ${Object.keys(REGIONS).map(r => html`<option key=${r} value=${r}>${r}</option>`)}
      </select>
      ${isToday && html`<select class=${"chip" + (hours ? " on" : "")} value=${hours} onChange=${e => setHours(+e.target.value)}>
        ${TIMES.map(([h, l]) => html`<option key=${h} value=${h}>${l}</option>`)}
      </select>`}
      <button class=${"chip plain" + (major ? " on" : "")} onClick=${() => setMajor(m => !m)}>★ Major only</button>
      ${active && html`<button class="chip clear" onClick=${clearAll}>✕ Clear</button>`}
      <span class="sep"></span>
      ${trendingPeople.map(p => html`<button key=${p} class=${"chip person" + (query === p ? " on" : "")} onClick=${() => quick(p)}>${p}</button>`)}
      ${trendingPlaces.map(p => html`<button key=${p} class=${"chip place" + (query === p ? " on" : "")} onClick=${() => quick(p)}>📍 ${p}</button>`)}
      <span class="sep"></span>
      ${CATEGORIES.map(c => html`<button key=${c} class=${"chip" + (cats.includes(c) ? " on" : "")} onClick=${() => toggle(cats, setCats, c)}>${c}</button>`)}
    </div>

    <aside class=${"panel" + (panelOpen ? " open" : "")}>
      <button class="panel-toggle" onClick=${() => setPanelOpen(o => !o)}>
        ${panelOpen ? "Hide" : "Headlines"} · ${shown.length}
      </button>
      <div class="panel-body" ref=${listRef}>
        <div class="panel-head">
          <div class="panel-title">
            <strong>${isToday ? "Today's headlines" : `Headlines · ${date ? prettyDate(date) : ""}`}</strong>
            ${meta?.updated && isToday && html`<span class="updated">updated ${timeAgo(meta.updated)}</span>`}
          </div>
          <div class="seg">
            <button class=${scope === "world" ? "on" : ""} onClick=${() => setScope("world")}>Whole world · ${filtered.length}</button>
            <button class=${scope === "area" ? "on" : ""} onClick=${() => setScope("area")}>Map area · ${inArea.length}</button>
          </div>
          <div class="seg small">
            <button class=${sort === "top" ? "on" : ""} onClick=${() => setSort("top")}>Top</button>
            <button class=${sort === "latest" ? "on" : ""} onClick=${() => setSort("latest")}>Latest</button>
          </div>
          <div class="legend">${Object.entries(LEVELS).map(([k, v]) => html`
            <button key=${k} class=${levels.includes(k) ? "" : "off"} onClick=${() => toggle(levels, setLevels, k)} title="Show/hide">
              <i style=${{ background: v.color }}></i>${v.label}</button>`)}</div>
        </div>
        ${!dates || !day ? html`<p class="empty">Loading…</p>`
          : !all.length ? html`<p class="empty">${isToday
              ? `No stories for today yet. The updater runs every hour${meta?.updated ? ` (last run ${timeAgo(meta.updated)})` : ""}. Or pick an earlier day above.`
              : "No stories saved for this day."}</p>`
          : !shown.length ? html`<p class="empty">No stories match. ${scope === "area" ? "Zoom out, switch to Whole world, " : ""}or clear the filters.</p>`
          : html`<ol class="list">${shown.slice(0, 300).map((a, i) => html`
              <li key=${a.id} class=${selected?.id === a.id ? "sel" : ""} onClick=${() => focus(a)}>
                ${sort === "top" && html`<span class="rank">${i + 1}</span>`}
                <div class="body">
                  <div class="title">${a.importance >= 8 && html`<span class="major">★</span>`}${a.title}</div>
                  ${a.summary && html`<div class="summary">${a.summary}</div>`}
                  <div class="places">${a.locations.map((l, j) => html`<span key=${j} class="place"><i style=${{ background: LEVELS[l.level].color }}></i>${locLabel(l)}</span>`)}</div>
                  <div class="meta"><span class="cat">${a.category}</span> ${a.source}${coverage(a) > 1 ? ` +${coverage(a) - 1} feeds` : ""} · ${timeAgo(a.published)} ·
                    <a href=${a.url} target="_blank" rel="noopener" onClick=${e => e.stopPropagation()}>read</a></div>
                </div>
              </li>`)}</ol>`}
      </div>
    </aside>
  `;
}

ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
