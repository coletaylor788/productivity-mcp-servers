# Weather Data Sources — Analysis

**Date:** 2026-02-06  
**Status:** Brainstorming — needs decision

## The Core Problem

Mountain weather is fundamentally different from valley weather. Standard weather APIs give forecasts for a single point, usually at the elevation of the nearest town. A ski resort like Breckenridge has:

- **Town/Base:** 9,600 ft
- **Mid-mountain:** 11,000 ft  
- **Summit:** 12,998 ft

Temperature, wind, precipitation type, and snowfall can all be completely different across that 3,400 ft range. We need to solve for **elevation-aware forecasting**.

---

## Option 1: Open-Meteo (⭐ RECOMMENDED PRIMARY)

**URL:** https://open-meteo.com/en/docs  
**Cost:** Free for non-commercial use (<10k daily calls). Commercial plans available.  
**Auth:** None required (API key optional for commercial)

### Why It's Great for Ski Weather

1. **Elevation parameter** — You can pass `&elevation=XXXX` to get forecasts statistically downscaled to a specific elevation. This is the killer feature for mountain weather.
2. **Multiple weather models** — Combines NOAA GFS/HRRR, ECMWF, DWD ICON, Météo-France, MeteoSwiss (1-2km resolution for Switzerland!), MET Norway, and others. Auto-selects best model per location.
3. **High-resolution models available:**
   - NOAA HRRR: 3km resolution, hourly updates (US only)
   - MeteoSwiss: 1-2km (Switzerland)
   - MET Norway: 1km (Norway/Scandinavia)
   - DWD ICON-D2: 2km (Central Europe)
4. **Snowfall data** — Direct snowfall in cm, snow depth, freezing level, precipitation probability
5. **Pressure level variables** — Temperature, wind, humidity at specific pressure levels (800hPa ≈ 1,900m, 700hPa ≈ 3km, etc.)
6. **Up to 16-day forecast**
7. **Hourly and 15-minutely data**

### Relevant Variables for Skiing

```
Hourly:
- temperature_2m          → Current temp
- apparent_temperature    → Wind chill / feels-like
- precipitation           → Rain + snow total
- snowfall                → Snow in cm
- snow_depth              → Current snowpack
- rain                    → Just rain
- weather_code            → WMO condition codes
- cloud_cover             → Overcast?
- visibility              → Important for skiing!
- wind_speed_10m          → Surface wind
- wind_gusts_10m          → Gust speed
- wind_direction_10m      → Wind direction
- freezing_level_height   → Where rain turns to snow

Pressure Level (for summit conditions):
- temperature at 700hPa/800hPa
- wind_speed at 700hPa/800hPa
```

### Example API Call

```
# Vail summit (lat 39.6403, lon -106.3742, elev 3527m / 11,570ft)
https://api.open-meteo.com/v1/forecast?
  latitude=39.6403&longitude=-106.3742
  &elevation=3527
  &hourly=temperature_2m,apparent_temperature,precipitation,snowfall,
          snow_depth,weather_code,wind_speed_10m,wind_gusts_10m,
          visibility,freezing_level_height,cloud_cover
  &temperature_unit=fahrenheit
  &wind_speed_unit=mph
  &precipitation_unit=inch
  &forecast_days=7
```

### Approach for Multi-Elevation Forecasts

Make 2-3 API calls per resort (base, mid, summit elevations), same lat/lon but different `&elevation=` values. This gives us the full mountain picture.

### Limitations

- No resort-specific operational data (lift status, grooming, etc.)
- No avalanche data
- Snowfall is modeled, not measured — real-world snow can differ
- Statistical downscaling with elevation is good but not perfect for every microclimate

---

## Option 2: NWS Weather API (US Only — Good Complement)

**URL:** https://api.weather.gov  
**Cost:** Free (taxpayer-funded, no auth key required — just User-Agent header)

### Strengths

- **Gridpoint forecasts** — 2.5km grid resolution
- **Rich data** — Temperature, wind, snow amount, ice accumulation, hazards, sky cover
- **Hourly and 12-hour forecasts** with detailed text descriptions
- **Weather alerts** — Winter storm warnings, avalanche warnings, wind advisories
- **Zone-based forecasts** — Mountain zone forecasts from local NWS offices that specifically address mountain weather
- **Observation stations** — Actual measured data from SNOTEL, ASOS, etc.

### How to Use for Ski Weather

1. `GET /points/{lat},{lon}` → Get grid coordinates and forecast office
2. `GET /gridpoints/{wfo}/{x},{y}/forecast/hourly` → Hourly forecast
3. `GET /gridpoints/{wfo}/{x},{y}` → Raw gridpoint data (snowfall amounts, ice, etc.)
4. `GET /alerts?point={lat},{lon}` → Active weather alerts

### Key Data Available in Gridpoints

- `snowfallAmount` — Forecast snow accumulation
- `snowLevel` — Elevation where snow begins
- `iceAccumulation` — Ice accumulation
- `temperature`, `windSpeed`, `windGust`, `windDirection`
- `skyCover`, `visibility`
- `weather` — Decoded weather conditions
- `hazards` — Active watches/warnings

### Limitations

- **US only** — No international resort coverage
- Grid cells are 2.5km — may not perfectly represent summit vs. base
- Can be slow / unreliable at times
- No elevation parameter — forecast is for the grid cell's native elevation
- No resort-specific operational data

### Best Use

Complement Open-Meteo for US resorts:
- Weather alerts / winter storm warnings (Open-Meteo doesn't have this)
- Text-based forecasts from local meteorologists who know mountain weather
- Cross-reference snowfall amounts for confidence

---

## Option 3: Weather Unlocked API

**URL:** https://developer.weatherunlocked.com  
**Cost:** Free tier available (HTTP only), paid plans for HTTPS  
**Auth:** API key required (free signup)

### How It Works

- Standard current weather + forecast by lat/lon
- JSON or XML output
- Simple REST API: `/api/current/{lat},{lon}` and `/api/forecast/{lat},{lon}`

### Limitations

- No elevation parameter
- No ski-specific data
- Limited model resolution info
- The ski resort endpoint appears to be discontinued

### Verdict

**Skip** — Open-Meteo does everything this does, better, with elevation support.

---

## Option 4: Scraping Resort Websites / Snow-Forecast.com

**URL:** https://www.snow-forecast.com  

### What They Have

- Forecasts at 3 elevations (top lift, mid-mountain, bottom lift) for 3,300 resorts worldwide
- Snow reports
- Webcam links
- Updated 4x daily

### Why We Should Avoid It

- **No public API** — Would require web scraping
- Scraping is fragile, unethical without permission, and against most TOS
- Better to use proper APIs and compute our own multi-elevation forecasts

---

## Option 5: OpenSnow

**URL:** https://opensnow.com  

### What They Have

- The gold standard for ski weather forecasting
- Proprietary PEAKS model — "up to 50% more accurate in mountain terrain"
- Multi-model comparison
- Expert human forecasters for specific regions
- 15-day forecasts

### Why We Can't Use It

- **No public API** — It's a paid consumer product ($50-100/year)
- Proprietary data
- Would require scraping (which we shouldn't do)

### What We Can Learn From Them

- They combine multiple weather models for better mountain accuracy
- They use machine learning to improve mountain forecasts
- Multi-elevation forecasts are essential
- Day/night snowfall breakdown is useful for skiers

---

## Option 6: Avalanche.org API (Avalanche Forecasts)

**URL:** https://api.avalanche.org  
**Cost:** Requires permission / contact  

### What They Have

- Avalanche danger ratings by forecast zone
- Avalanche problem types (wind slab, persistent slab, etc.)
- Travel advice
- Covers the US (via regional avalanche centers)

### Status

The API exists but requires contacting avalanche.org for permission. We should investigate this for a later phase.

### Alternative: NWS Avalanche Warnings

NWS issues avalanche warnings and watches through the alerts system. We can get these via the NWS API for free.

---

## Recommendation: Tiered Approach

### Phase 1 (MVP)

| Source | Purpose |
|--------|---------|
| **Open-Meteo** | Primary weather/forecast data with elevation support |
| **Built-in resort database** | Curated JSON of popular resorts with coordinates + elevations |

This gets us:
- Current conditions at any resort (base/mid/summit)
- 7-16 day forecasts with snowfall
- Worldwide coverage
- Zero API keys required

### Phase 2 (Enhanced — US Focus)

| Source | Purpose |
|--------|---------|
| **NWS API** | Weather alerts, winter storm warnings, zone forecasts |
| **SNOTEL data** | Actual measured snow water equivalent at mountain stations |

### Phase 3 (Premium)

| Source | Purpose |
|--------|---------|
| **Avalanche.org** | Avalanche danger ratings |
| **Resort APIs** (if available) | Lift status, grooming reports |

---

## Open Questions

1. **How accurate is Open-Meteo's elevation downscaling?** — We should test with known mountain stations and compare.
2. **How many API calls per resort?** — If we do base + mid + summit, that's 3 calls per resort per request. Acceptable?
3. **Caching strategy** — Weather data doesn't change every second. Cache for 30-60 minutes?
4. **Should we support international resorts from day 1?** — Open-Meteo is global, so yes, it's nearly free to support.
5. **Ensemble models?** — Open-Meteo has an ensemble API (30 model runs). Could provide confidence intervals on snowfall forecasts. Worth the complexity?
