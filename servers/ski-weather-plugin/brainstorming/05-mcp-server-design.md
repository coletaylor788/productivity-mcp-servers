# MCP Server Design Notes

**Date:** 2026-02-06  
**Status:** Brainstorming

## Patterns from gmail-mcp

Our existing `gmail-mcp` server establishes patterns we should follow:

### Structure

```
servers/ski-weather-plugin/
├── pyproject.toml           # Dependencies
├── README.md                # Setup & usage
├── src/ski_weather/
│   ├── __init__.py
│   ├── __main__.py          # Entry point
│   ├── config.py            # Config management
│   ├── server.py            # MCP server + tool handlers
│   ├── weather.py           # Open-Meteo API client
│   ├── nws.py               # NWS API client (Phase 2)
│   ├── resorts.py           # Resort database + search
│   └── data/
│       └── resorts.json     # Curated resort database
├── tests/
│   ├── test_server.py
│   ├── test_weather.py
│   ├── test_resorts.py
│   └── integration/
│       └── test_weather_api.py
└── docs/
    ├── architecture.md
    ├── tools.md
    └── plans/
```

### Key Patterns to Follow

1. **Async tool handlers** — All `call_tool` handlers are async
2. **Error handling** — Wrap API calls in try/except with helpful messages
3. **TextContent responses** — Return formatted text for the AI to interpret
4. **Input validation** — Check required args before making API calls
5. **Type hints** — Python type hints throughout

### Differences from gmail-mcp

| Aspect | gmail-mcp | ski-weather |
|--------|-----------|-------------|
| Auth | OAuth 2.0 + Keychain | None (Open-Meteo is free) |
| API calls | Google API client lib | Direct HTTP (httpx/aiohttp) |
| State | User's Gmail token | Stateless |
| Secrets | OAuth credentials | None |
| Data | User's emails | Public weather data |

This is simpler — no auth flow needed! Just install and go.

---

## Dependencies (Phase 1)

```toml
[project]
dependencies = [
    "mcp>=1.0.0",
    "httpx>=0.25.0",    # Async HTTP client for API calls
]

[project.optional-dependencies]
dev = [
    "pytest>=7.0",
    "pytest-asyncio>=0.21",
    "ruff>=0.1.0",
    "respx>=0.20.0",   # Mock httpx for tests
]
```

### Why httpx?

- Native async support (needed for MCP tool handlers)
- Modern, well-maintained
- Connection pooling
- Timeout handling
- No Google client library needed

---

## Tool Definitions (Draft)

### `get_conditions`

Get current weather conditions at a ski resort.

```json
{
  "name": "get_conditions",
  "description": "Get current weather conditions at a ski resort, including temperature, wind, snow depth, and visibility at base, mid-mountain, and summit elevations.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "resort": {
        "type": "string",
        "description": "Resort name (e.g., 'Vail', 'Jackson Hole', 'Whistler')"
      }
    },
    "required": ["resort"]
  }
}
```

**Output format:**

```
Vail Mountain Resort — Current Conditions
==========================================

Summit (11,570 ft / 3,527m):
  Temperature: 12°F (-11°C) | Feels Like: -8°F (-22°C)
  Wind: W 28 mph, gusts to 45 mph
  Conditions: Snow showers
  Visibility: 0.3 mi (poor)

Mid-Mountain (10,350 ft / 3,155m):
  Temperature: 18°F (-8°C) | Feels Like: 3°F (-16°C)
  Wind: W 18 mph, gusts to 30 mph
  Conditions: Light snow
  Visibility: 1.2 mi (moderate)

Base (8,120 ft / 2,475m):
  Temperature: 26°F (-3°C) | Feels Like: 15°F (-9°C)
  Wind: W 8 mph, gusts to 15 mph
  Conditions: Overcast
  Visibility: 5+ mi (good)

Snow Depth: 58" (base depth)
Freezing Level: 7,200 ft — All snow at all elevations

Last Updated: 2026-02-06 10:00 AM MST
```

### `get_forecast`

```json
{
  "name": "get_forecast",
  "description": "Get multi-day weather forecast for a ski resort with snowfall predictions at multiple elevations.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "resort": {
        "type": "string",
        "description": "Resort name"
      },
      "days": {
        "type": "integer",
        "description": "Number of forecast days (1-16, default: 5)",
        "default": 5
      }
    },
    "required": ["resort"]
  }
}
```

### `get_snow_report`

```json
{
  "name": "get_snow_report",
  "description": "Get recent snowfall summary and snow depth for a ski resort.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "resort": {
        "type": "string",
        "description": "Resort name"
      }
    },
    "required": ["resort"]
  }
}
```

### `find_resorts`

```json
{
  "name": "find_resorts",
  "description": "Search for ski resorts by name, state, or region.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Search query (resort name, state, or region)"
      },
      "state": {
        "type": "string",
        "description": "Filter by US state code (e.g., 'CO', 'UT', 'VT')"
      },
      "country": {
        "type": "string",
        "description": "Filter by country code (e.g., 'US', 'CA', 'FR')"
      }
    }
  }
}
```

### `compare_conditions`

```json
{
  "name": "compare_conditions",
  "description": "Compare current conditions and snowfall across multiple ski resorts.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "resorts": {
        "type": "array",
        "items": { "type": "string" },
        "description": "List of resort names to compare (max 5)"
      }
    },
    "required": ["resorts"]
  }
}
```

---

## Caching Strategy

Weather data doesn't change every second. We should cache to:
- Be respectful of API rate limits
- Speed up responses
- Reduce latency

### Proposed Cache TTLs

| Data Type | TTL | Rationale |
|-----------|-----|-----------|
| Current conditions | 30 minutes | Weather changes slowly |
| Hourly forecast | 1 hour | Models update every 1-6 hours |
| Daily forecast | 3 hours | Longer-range less volatile |
| Resort database | Permanent | Static data |
| Elevation lookup | Permanent | Mountains don't move |

### Implementation

Simple in-memory dict with TTL, keyed by (resort_id, data_type, elevation). No external cache needed for a local MCP server.

---

## Open Questions for Decision

1. **Temperature units** — Default to Fahrenheit (US-centric) or auto-detect? Or always show both?
2. **Resort not found** — Geocode and try anyway, or return "Resort not found" with suggestions?
3. **Concurrent API calls** — Make 3 elevation calls in parallel with `asyncio.gather()`?
4. **Output verbosity** — Full report vs. summary? Let user control with a `detail` parameter?
5. **Server name** — `ski-weather-mcp`? `ski-weather-plugin`? `snow-forecast-mcp`?
