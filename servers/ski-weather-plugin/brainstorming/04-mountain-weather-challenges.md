# Mountain Weather Challenges & Solutions

**Date:** 2026-02-06  
**Status:** Brainstorming — technical deep dive

## Why Mountain Weather Is Hard

Standard weather models operate on grids. A grid cell might be 3-25km across. Mountains create micro-climates at scales much smaller than that. Here's what makes ski resort forecasting particularly tricky:

---

### 1. Elevation Gradient

**Problem:** Temperature drops ~3.5°F (2°C) per 1,000 ft (300m) of elevation gain in the free atmosphere. But this "lapse rate" varies:
- Dry adiabatic: ~5.5°F/1000 ft (when no condensation)
- Moist adiabatic: ~3°F/1000 ft (when clouds/precipitation forming)
- Temperature inversions: Temperature *increases* with elevation (common in valleys)

**Impact:** A forecast of 34°F at base could mean 20°F at summit — the difference between rain and powder.

**Our solution:** Open-Meteo's `elevation` parameter applies statistical downscaling. We query at 3 elevations (base, mid, summit) to show the full picture. For extra accuracy, we could also use pressure-level data from the API.

---

### 2. Orographic Enhancement

**Problem:** Mountains force air upward, cooling it and squeezing out moisture. The windward side of a mountain gets dramatically more precipitation than the leeward side. This is why:
- Windward slopes get "upslope" snow
- Leeward slopes are in a "rain shadow"
- A resort on one side of a ridge can get 2-3x more snow than one 10 miles away

**Impact:** Two resorts at similar elevations, 20 miles apart, can have vastly different snowfall.

**Our solution:** We use each resort's actual coordinates, so the weather model uses the correct grid cell. High-resolution models (HRRR 3km, ICON-D2 2km) capture some orographic effects. For critical decisions, we should note forecast uncertainty.

---

### 3. Wind at Elevation

**Problem:** Wind speed increases with altitude (roughly follows a power law). Surface wind at a valley town might be 5 mph while a ridgeline summit has 50 mph winds. Wind:
- Creates wind chill (feels -20°F at summit)
- Transports and redistributes snow (wind slabs, cornices)
- Closes upper lifts
- Creates ground blizzard conditions even on clear days

**Impact:** Calm and sunny at base, survival conditions at summit.

**Our solution:** 
- Report wind at each elevation band
- Calculate wind chill / apparent temperature
- Flag high-wind conditions prominently
- Open-Meteo provides wind gusts which are critical for ski operations

---

### 4. Snow Level / Freezing Level

**Problem:** The elevation where rain transitions to snow (snow level) is different from the freezing level (0°C). Snow level is typically 1,000-1,500 ft below the freezing level because snow takes time to melt as it falls into warmer air.

**Impact:** 
- If snow level is at 7,000 ft and base is at 8,000 ft → all snow at base
- If snow level is at 9,000 ft and base is at 8,000 ft → rain at base, snow above 9,000 ft
- This is the most common scenario that ruins ski days

**Our solution:** Open-Meteo provides `freezing_level_height`. We should:
1. Report it explicitly
2. Compare it to resort elevation bands
3. Flag when "rain at base, snow at summit" conditions exist
4. Express this in plain language: "Snow level around 8,500 ft — expect rain at base areas, snow from mid-mountain up"

---

### 5. Snowfall Measurement vs. Model Output

**Problem:** Weather models predict "liquid equivalent precipitation" and then apply a snow ratio to convert to snowfall depth. But snow ratios vary wildly:
- Wet, warm snow: 5:1 (5 inches of snow per 1 inch of water)
- Average: 10:1  
- Cold, dry powder: 15-20:1
- Extremely cold/light: 25:1+

**Impact:** A model predicting 1 inch of precipitation could mean 5 inches of wet cement or 20 inches of cold smoke powder.

**Our solution:**
- Open-Meteo provides both `precipitation` (liquid) and `snowfall` (cm), so it applies a snow ratio internally
- We should also report the temperature context so users can judge snow quality
- Consider adding a simple "snow quality" indicator based on temperature:
  - < 15°F: "Cold/Dry powder"
  - 15-25°F: "Light snow"
  - 25-32°F: "Dense snow"
  - > 32°F: "Wet snow/rain mix"

---

### 6. Diurnal Cycles in Mountains

**Problem:** Mountains have exaggerated day/night temperature swings compared to flatlands. Morning freeze → afternoon warming creates:
- Great morning conditions → afternoon slush
- Overnight refreeze → morning ice → mid-day corn snow (spring skiing)
- Afternoon convective snow showers (especially in Rockies)

**Impact:** The *timing* of weather matters more in mountains than flatlands.

**Our solution:** Provide hourly forecasts, not just daily summaries. Highlight:
- Morning conditions (opening bell)
- Afternoon trend
- Overnight snowfall (the morning powder check)

---

### 7. Valley Inversions

**Problem:** Cold air pools in valleys, especially overnight under clear skies. This creates a temperature inversion where the valley is actually *colder* than mid-mountain. 

**Impact:** 
- Valley town shows -10°F but mid-mountain is 20°F
- Valley fog/smog layer while upper mountain is sunny
- Standard elevation-based temperature models get this backwards

**Our solution:** This is the hardest one. Open-Meteo's downscaling may not capture inversions well. We should:
- Note when forecasts show inversions
- Let the model data speak for itself (if base forecast is colder than mid, that's an inversion)
- Don't "correct" the model — inversions are real

---

## Confidence & Forecast Quality

### What We Should Communicate

1. **Forecast range/uncertainty** for snowfall — e.g., "4-8 inches expected" rather than "6 inches"
2. **Model agreement** — Open-Meteo's ensemble API runs 30 simulations. If they agree, confidence is high. If they diverge, flag it.
3. **Forecast horizon** — Days 1-3 are reasonably accurate. Days 4-7 are trends. Days 8+ are general patterns.
4. **Local knowledge gaps** — Note that AI forecasts can't replace local knowledge (e.g., "this resort tends to over-perform in northwest flow")

### Phased Approach to Confidence

**Phase 1:** Just report the forecast. Let users interpret.
**Phase 2:** Add snowfall ranges (use ensemble spread).
**Phase 3:** Add model comparison and confidence language.

---

## Summary: Our Accuracy Strategy

| Challenge | Strategy | Phase |
|-----------|----------|-------|
| Elevation gradient | Multi-elevation queries | 1 |
| Orographic effects | Use actual resort coordinates + hi-res models | 1 |
| Wind at elevation | Report per elevation band | 1 |
| Snow level | Report freezing level vs resort elevations | 1 |
| Snow quality | Temperature-based quality indicator | 1 |
| Timing | Hourly forecast data | 1 |
| Snowfall uncertainty | Ensemble-based ranges | 2 |
| Valley inversions | Let model data show it, add notes | 2 |
| Model confidence | Multi-model comparison | 3 |

We won't match OpenSnow's proprietary PEAKS model or expert human forecasters, but we can build something genuinely useful that's better than checking a standard weather app.
