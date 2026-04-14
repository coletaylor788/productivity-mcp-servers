# Ski Weather MCP Plugin — Project Overview

**Date:** 2026-02-06  
**Status:** Brainstorming

## Concept

An MCP server that provides current conditions and forecasts for ski resorts. Users can ask their AI assistant (Claude, Claude Code) questions like:

- "What are the conditions at Vail today?"
- "Which Colorado resorts got the most snow in the last 24 hours?"
- "What's the 5-day forecast for Jackson Hole?"
- "Is it going to snow at Whistler this weekend?"
- "What's the avalanche danger level near Breckenridge?"

## Architecture

Same pattern as `gmail-mcp`:

```
┌─────────────────┐     MCP Protocol      ┌─────────────────────┐
│  Claude/Claude  │◄────────────────────► │   Ski Weather MCP   │
│      Code       │                       │       Server        │
└─────────────────┘                       └────────┬────────────┘
                                                   │
                                          HTTP APIs│(various)
                                                   │
                                          ┌────────▼────────────┐
                                          │  Weather & Snow     │
                                          │  Data Sources       │
                                          └─────────────────────┘
```

## Key Differentiator: Mountain Weather Is Hard

Standard weather APIs report for towns at valley floor elevation. Ski resorts span huge elevation ranges (e.g., base 8,000 ft → summit 12,000 ft). Weather conditions can be **radically different** between base and summit:

- Temperature drops ~3.5°F per 1,000 ft elevation gain
- Wind speeds increase dramatically at ridgeline
- Precipitation type changes (rain at base, snow at summit)
- Cloud cover / visibility differs by elevation band
- Snow accumulation varies massively with aspect and elevation

**We need data sources that understand this.**

## Proposed MCP Tools

| Tool | Description |
|------|-------------|
| `get_resort_conditions` | Current conditions at a resort (temp, wind, snow depth, lifts, etc.) |
| `get_resort_forecast` | Multi-day forecast for a resort (at base, mid, summit elevations) |
| `get_snow_report` | Recent snowfall (24h, 48h, 7-day), base depth, conditions |
| `find_resorts` | Search/list resorts by region, state, or country |
| `compare_resorts` | Compare conditions across multiple resorts |
| `get_avalanche_forecast` | Avalanche danger for a resort's region |

## Key Decision: Data Sources

See [02-weather-data-sources.md](./02-weather-data-sources.md) for detailed analysis.

## Resort Database

We need a database/list of ski resorts with:
- Name and aliases ("Vail", "Vail Mountain")
- Location (lat/lon)
- Elevation range (base, mid, summit)
- Region/state/country
- Possibly: resort website URL, webcam links

Options:
1. **Curate our own JSON file** — most control, maintenance burden
2. **Use an existing dataset** — less control, less maintenance
3. **Hybrid** — start with popular resorts, expand over time

See [03-resort-database.md](./03-resort-database.md) for analysis.
