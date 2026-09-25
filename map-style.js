// Free vector tiles from OpenFreeMap (no API key). Only land, water, nature,
// borders and place names — no roads.
window.MAP_STYLE = (() => {
  const src = "omt";
  const name = ["coalesce", ["get", "name_en"], ["get", "name:en"], ["get", "name"]];
  const font = ["Noto Sans Regular"];
  const bold = ["Noto Sans Bold"];
  const halo = { "text-halo-color": "rgba(255,255,255,0.85)", "text-halo-width": 1.4 };
  const place = (id, classes, minzoom, size, color, f = font, maxzoom = 24) => ({
    id, type: "symbol", source: src, "source-layer": "place", minzoom, maxzoom,
    filter: ["in", ["get", "class"], ["literal", classes]],
    layout: { "text-field": name, "text-font": f, "text-size": size, "text-max-width": 8 },
    paint: { "text-color": color, ...halo },
  });

  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: { [src]: { type: "vector", url: "https://tiles.openfreemap.org/planet" } },
    layers: [
      { id: "land", type: "background", paint: { "background-color": "#f3efe6" } },
      { id: "landcover", type: "fill", source: src, "source-layer": "landcover",
        paint: {
          "fill-color": ["match", ["get", "class"],
            "wood", "#d4e4c3", "grass", "#e1ecd2", "farmland", "#ebeedb", "wetland", "#d9e8dc",
            "ice", "#fbfdff", "sand", "#efe5c9", "rock", "#e6e1d8", "#e4ebd5"],
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.8, 10, 0.6],
        } },
      { id: "residential", type: "fill", source: src, "source-layer": "landuse", minzoom: 8,
        filter: ["in", ["get", "class"], ["literal", ["residential", "suburb", "neighbourhood", "commercial", "industrial"]]],
        paint: { "fill-color": "#e9e2d6", "fill-opacity": 0.7 } },
      { id: "park", type: "fill", source: src, "source-layer": "park", paint: { "fill-color": "#cfe5bd", "fill-opacity": 0.8 } },
      { id: "water", type: "fill", source: src, "source-layer": "water", paint: { "fill-color": "#a8d0e6" } },
      { id: "waterway", type: "line", source: src, "source-layer": "waterway", minzoom: 6,
        paint: { "line-color": "#a8d0e6", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 14, 2.5] } },
      { id: "building", type: "fill", source: src, "source-layer": "building", minzoom: 14,
        paint: { "fill-color": "#e0d8cb", "fill-outline-color": "#d3c9b9" } },
      { id: "boundary-state", type: "line", source: src, "source-layer": "boundary", minzoom: 3,
        filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
        paint: { "line-color": "#b9aec4", "line-width": 0.8, "line-dasharray": [3, 2] } },
      { id: "boundary-country", type: "line", source: src, "source-layer": "boundary",
        filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
        paint: { "line-color": "#8e8299", "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 6, 1.6] } },
      { id: "water-name", type: "symbol", source: src, "source-layer": "water_name",
        layout: { "text-field": name, "text-font": ["Noto Sans Italic"], "text-size": 12, "text-max-width": 6 },
        paint: { "text-color": "#5f8fae" } },
      place("place-neighbourhood", ["suburb", "neighbourhood", "quarter"], 11, 11, "#7b7266"),
      place("place-village", ["village", "hamlet"], 10, 11, "#5d554b"),
      place("place-town", ["town"], 8, 12, "#4e463c"),
      place("place-city", ["city"], 4, ["interpolate", ["linear"], ["zoom"], 4, 11, 10, 17], "#3b342c", bold),
      place("place-state", ["state", "province"], 4, 11, "#8a7d97", font, 8),
      place("place-country", ["country"], 1, ["interpolate", ["linear"], ["zoom"], 1, 10, 6, 15], "#554a60", bold, 7),
    ],
  };
})();
