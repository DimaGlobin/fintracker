# Техническая архитектура

## Стек

- Vanilla JS (без фреймворков, без бандлера)
- Node.js HTTP-сервер (zero dependencies)
- Chart.js 4.4.0 (CDN, только на странице детализации)
- Google Fonts: JetBrains Mono + Manrope

## Структура проекта

```
fintracker/
├── server.js          # Node.js сервер (статика + REST API)
├── package.json
├── CLAUDE.md          # Контекст для Claude Code
├── data/              # Данные пользователя (в .gitignore)
│   ├── config.json    # Бюджет, категории, доход
│   └── YYYY-MM.jsonl  # Расходы по месяцам (JSON Lines)
├── docs/              # Документация и референсы
└── public/            # Статические файлы
    ├── index.html     # Дашборд
    ├── add.html       # Добавление расхода
    ├── history.html   # История, фильтры, экспорт CSV
    ├── charts.html    # Детализация (графики)
    ├── settings.html  # Настройки бюджета
    ├── css/styles.css # Тёмная тема, CSS custom properties
    ├── js/app.js      # Общий data layer
    ├── manifest.json  # PWA манифест
    └── sw.js          # Service Worker
```

## Архитектура данных

### Хранение

Три уровня, с автоматическим fallback:

1. **Сервер** (`node server.js`) — JSONL-файлы в `data/`, один файл на месяц
2. **File System Access API** — браузерный доступ к папке на диске
3. **localStorage** — fallback, если сервер недоступен

### In-memory кеш

`app.js` загружает все расходы в массив `_expenses` при старте (`initStorage()`). Все чтения синхронные из кеша. Записи обновляют кеш мгновенно, затем асинхронно пишут на диск.

### Конфиг

`DEFAULT_CONFIG` зашит в `app.js` с дефолтными категориями. При вводе дохода бюджеты автоматически распределяются по процентам (`BUDGET_PCT`). Конфиг хранится в `localStorage` (быстрый доступ) + `data/config.json` (персистентность).

## REST API

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/index` | Список месяцев с количеством записей |
| GET | `/api/expenses` | Все расходы |
| GET | `/api/expenses?month=YYYY-MM` | Расходы за месяц |
| POST | `/api/expenses` | Добавить расход (JSON body) |
| PUT | `/api/expenses` | Перезаписать все расходы |
| DELETE | `/api/expenses/:id` | Удалить расход по ID |
| GET | `/api/config` | Получить конфиг |
| POST | `/api/config` | Сохранить конфиг |

## Страницы

Каждая HTML-страница — самостоятельная, подключает `js/app.js` и `css/styles.css`. Своя логика — в inline `<script>` внизу страницы.

Навигация фиксирована: Главная → История → ＋ → Детализация → Настройки. На десктопе (`≥768px`) — левый сайдбар, на мобильном — нижний таб-бар.

## Формат данных

### Расход (одна строка в JSONL)

```json
{"id":1709827200000,"date":"2026-03-07","amount":360,"category_id":"food_out","description":"Кофе","regret_score":2,"created_at":"2026-03-07T12:00:00.000Z"}
```

### Конфиг (config.json)

```json
{
  "monthly_income": 100000,
  "categories": [
    {"id": "groceries", "name": "Продукты", "emoji": "🛒", "budget": 20000, "color": "#4CAF50"}
  ],
  "fixed_expenses": [
    {"name": "Аренда", "emoji": "🏠", "amount": 55000}
  ],
  "budget_summary": {
    "total_variable_budget": 58000,
    "total_fixed": 55000,
    "free_money": -13000
  }
}
```
