# Resort Database — Options & Design

**Date:** 2026-02-06  
**Status:** Brainstorming — needs decision

## What We Need Per Resort

At minimum, each resort entry needs:

```json
{
  "id": "vail-co",
  "name": "Vail",
  "display_name": "Vail Mountain Resort",
  "aliases": ["Vail", "Vail Mountain", "Vail Ski Resort"],
  "location": {
    "latitude": 39.6403,
    "longitude": -106.3742,
    "state": "CO",
    "country": "US",
    "region": "Rocky Mountains",
    "timezone": "America/Denver"
  },
  "elevations": {
    "base_ft": 8120,
    "mid_ft": 10350,
    "summit_ft": 11570,
    "base_m": 2475,
    "mid_m": 3155,
    "summit_m": 3527
  }
}
```

### Why Elevations Matter

This is the key differentiator. Without elevations, we're just another weather app. With them, we can call Open-Meteo 3x with different `&elevation=` values and give a real mountain forecast:

> "At Vail's summit (11,570 ft): 15°F, 35 mph winds, 8-12" of snow expected. At base (8,120 ft): 28°F, 10 mph winds, possible rain/snow mix."

### Optional Fields (Phase 2+)

```json
{
  "website": "https://www.vail.com",
  "snow_report_url": "https://www.vail.com/the-mountain/mountain-conditions/snow-and-weather-report.aspx",
  "vertical_drop_ft": 3450,
  "skiable_acres": 5317,
  "number_of_lifts": 31,
  "nws_zone": "COZ033",
  "avalanche_center": "colorado-avalanche-information-center"
}
```

---

## Option A: Curate Our Own JSON (⭐ RECOMMENDED)

### Approach

Create a `resorts.json` file in the project with the top 100-200 North American resorts and top 50-100 European resorts.

### Pros

- **Full control** — We define exactly what data is available
- **Correct elevations** — We can verify from official resort stats
- **Works offline** — No API dependency for resort lookup
- **Simple** — Just a JSON file
- **Fast** — No API call needed to find a resort

### Cons

- **Manual curation** — Someone has to build and maintain it
- **Coverage gaps** — Small/obscure resorts won't be included
- **Staleness** — Resorts change (new lifts, updated stats)

### Mitigation

- Start with top resorts, add more based on user requests
- Use a simple structure so community contributions are easy
- Elevation data is stable (mountains don't move)

---

## Option B: Existing Open Datasets

### Potential Sources

1. **Skimap.org** — Has a database of ski areas worldwide with maps. Previously had a developer API, but it appears to be gone or moved.

2. **OpenStreetMap** — Has ski resort data via Overpass API
   - Tags: `landuse=winter_sports`, `sport=skiing`, `piste:type=*`
   - Has coordinates but elevation data is inconsistent
   - Complex to query

3. **Wikipedia/Wikidata** — Has structured data for major resorts
   - Elevation, coordinates, vertical drop
   - SPARQL queries possible
   - Data quality varies

### Verdict

These could supplement our curated list but shouldn't be the primary source. The elevation data quality is too inconsistent to rely on.

---

## Option C: Hybrid Approach (Recommended)

1. **Curated JSON** for popular resorts (Phase 1)
2. **Fallback to geocoding + elevation API** for unknown resorts:
   - User says "What's the weather at Mount Baker?"
   - We don't have it in our database
   - Use Open-Meteo Geocoding API to get coordinates
   - Use Open-Meteo Elevation API to get elevation
   - Return weather with a note: "Using estimated coordinates. Results may not be precise."

This way we're never stuck saying "I don't know that resort" — we degrade gracefully.

---

## Phase 1 Resort List (Candidates)

### Priority: Top US/Canada Resorts

**Colorado:** Vail, Breckenridge, Keystone, Copper Mountain, Arapahoe Basin, Winter Park, Steamboat, Aspen/Snowmass, Telluride, Crested Butte, Purgatory, Wolf Creek, Loveland, Monarch, Eldora, Beaver Creek

**Utah:** Park City, Snowbird, Alta, Brighton, Solitude, Deer Valley, Powder Mountain, Snowbasin, Sundance, Brian Head

**California:** Mammoth Mountain, Palisades Tahoe (Squaw Valley), Heavenly, Northstar, Kirkwood, Sugar Bowl, Mt. Bachelor (OR technically), Bear Mountain, Snow Summit, Dodge Ridge

**Wyoming:** Jackson Hole, Grand Targhee

**Montana:** Big Sky, Whitefish Mountain, Bridger Bowl

**Idaho:** Sun Valley, Schweitzer, Tamarack, Brundage

**Washington:** Crystal Mountain, Stevens Pass, Mt. Baker, Snoqualmie, White Pass

**Oregon:** Mt. Hood Meadows, Mt. Bachelor, Timberline, Mt. Hood Skibowl

**Vermont:** Stowe, Killington, Sugarbush, Mad River Glen, Jay Peak, Smugglers' Notch, Stratton, Okemo, Bolton Valley

**New Hampshire:** Cannon Mountain, Wildcat, Loon, Bretton Woods, Waterville Valley

**Maine:** Sugarloaf, Sunday River

**New York:** Whiteface, Gore, Hunter, Windham

**Canada:** Whistler Blackcomb, Revelstoke, Kicking Horse, Big White, Sun Peaks, Lake Louise, Sunshine Village, Banff Norquay, Fernie, Mont-Tremblant, Le Massif

### Priority: Top European Resorts (Phase 1.5)

**France:** Chamonix, Val d'Isère, Tignes, Les 3 Vallées (Courchevel, Méribel, Val Thorens), Alpe d'Huez, La Plagne

**Switzerland:** Zermatt, Verbier, St. Moritz, Davos, Laax, Engelberg

**Austria:** St. Anton, Kitzbühel, Innsbruck, Lech/Zürs, Ischgl, Sölden

**Italy:** Cortina d'Ampezzo, Courmayeur, Madonna di Campiglio, Livigno

**Japan:** Niseko, Hakuba, Furano, Myoko Kogen

---

## Resort Matching Strategy

Users won't always type exact names. We need fuzzy matching:

1. **Exact match** on `id` or `name`
2. **Alias match** on `aliases` list
3. **Fuzzy match** using string similarity (Levenshtein distance or similar)
4. **Fallback** to geocoding API

Examples:
- "Breck" → matches alias for Breckenridge
- "Squaw Valley" → matches alias for Palisades Tahoe  
- "A-Basin" → matches alias for Arapahoe Basin
- "JHole" → matches alias for Jackson Hole
- "Some random mountain" → fallback to geocoding

---

## Open Questions

1. **How many resorts in Phase 1?** — 100? 150? 200?
2. **Who verifies elevation data?** — Resort websites are the gold standard
3. **Should we include closed/seasonal info?** — Some resorts are summer-only during off-season
4. **How do we handle resort complexes?** — e.g., "Aspen" includes 4 mountains (Aspen Mountain, Aspen Highlands, Buttermilk, Snowmass)
5. **Data format** — Single JSON file, or one file per region/country?
