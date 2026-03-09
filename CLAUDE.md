# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start

```bash
node server.js        # Start server on port 3000
npm start             # Same via npm
node server.js 8080   # Custom port
```

Open http://localhost:3000. No build step, no dependencies, no bundler.

## Architecture

Vanilla JS multi-page PWA. No frameworks. All code is in `public/`, served as static files by `server.js`.

### Data Flow

1. **`server.js`** — zero-dependency Node.js HTTP server. Serves static files from `public/` and exposes REST API (`/api/*`) for reading/writing JSONL files in `data/`.
2. **`public/js/app.js`** — shared data layer loaded by every HTML page. Contains:
   - `serverStore` — REST API client for `server.js`
   - `fileStore` — File System Access API fallback (browser-based file access)
   - `initStorage()` — tries server → FS API → localStorage, populates `_expenses` in-memory cache
   - `DEFAULT_CONFIG` — hardcoded category list; used when no config exists
   - All sync read functions (`getExpenses()`, `loadExpenses()`) read from `_expenses` cache
   - All write functions (`saveExpense()`, `deleteExpense()`) update cache first, then async write to disk
3. **Each HTML page** has its own `<script>` with page-specific logic (rendering, filters, charts). Every page calls `await loadBudgetConfig()` and `await initStorage()` in its `init()`.

### Storage

- **Primary**: JSONL files in `data/` via server REST API. One file per month (`2026-03.jsonl`), one JSON object per line.
- **Config**: `data/config.json` (budget, categories, income). Also cached in `localStorage` under `ft_budget_config`.
- **Fallback**: `localStorage` key `ft_expenses` when server is unavailable.
- **Index**: `data/index.json` — lightweight metadata rebuilt by server on writes.

### Key Conventions

- Language: Russian (UI text, variable naming in comments)
- Fonts: JetBrains Mono (mono), Manrope (sans) — loaded from Google Fonts CDN
- Charts: Chart.js 4.4.0 from CDN (used only in `charts.html`)
- CSS: Dark theme with custom properties defined in `public/css/styles.css`. Desktop sidebar nav at `@media (min-width: 768px)`.
- Nav order is fixed across all pages: Главная → История → ＋ → Детализация → Настройки

### REST API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/index` | Month list with counts |
| GET/POST/PUT/DELETE | `/api/expenses` | CRUD for expenses |
| GET/POST | `/api/config` | User budget config |

### Backward Compatibility

User data must survive across updates. Three mechanisms ensure this:

1. **Config versioning** (`CONFIG_VERSION` in `app.js`). Every config has a `version` field. On load, `migrateConfig()` runs step-by-step upgrades (v0→1, v1→2, …) filling missing fields with defaults while preserving user values. Increment `CONFIG_VERSION` and add a new `if (v < N)` block for each schema change.
2. **Expense normalization** (`normalizeExpense()` in `app.js`). Every expense record is normalized on read — missing fields get safe defaults. Old JSONL records without new fields won't crash the UI.
3. **Graceful category fallback**. All `.find()` lookups on `config.categories` must have a fallback: `|| { emoji:'❓', name: id, budget: 0 }`. If a user's expenses reference a deleted/renamed category, they still render.

**Rules for making changes:**
- Never rename or remove fields from expense JSONL format — only add new ones
- Never change category `id` values in `DEFAULT_CONFIG` — old expenses reference them
- Never change `localStorage` keys (`ft_expenses`, `ft_budget_config`)
- Never change REST API paths — old Service Workers may cache them
- When adding config fields, add a migration step in `migrateConfig()` and bump `CONFIG_VERSION`
- Service Worker uses network-first strategy so code updates are picked up immediately
