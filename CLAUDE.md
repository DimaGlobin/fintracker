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
