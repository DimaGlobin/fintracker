// ═══════════════════════════════════════════════════════════════
// ФИНАНСОВЫЙ ТРЕКЕР — DATA LAYER
// Storage: server API (JSONL в ./data/) → localStorage fallback
// ═══════════════════════════════════════════════════════════════

const STORAGE_KEY = 'ft_expenses';
const CONFIG_KEY  = 'ft_budget_config';

// ── IN-MEMORY CACHE ───────────────────────────────────────────────
// После initStorage() все синхронные функции работают с этим массивом.
// Запись на диск идёт асинхронно в фоне.
let _expenses = null; // null = ещё не инициализирован

// ═══════════════════════════════════════════════════════════════
// SERVER STORE — REST API к ./data/*.jsonl через node server.js
// ═══════════════════════════════════════════════════════════════

const FS_SUPPORTED = 'showDirectoryPicker' in window; // для обратной совместимости с UI

const serverStore = {
  available: false,

  async detect() {
    try {
      const r = await fetch('/api/index', { method: 'GET' });
      this.available = r.ok;
    } catch {
      this.available = false;
    }
    return this.available;
  },

  async loadAll() {
    const r = await fetch('/api/expenses');
    if (!r.ok) throw new Error('Server error');
    return r.json();
  },

  async appendExpense(expense) {
    const r = await fetch('/api/expenses', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(expense),
    });
    return r.ok;
  },

  async deleteExpense(id) {
    const r = await fetch(`/api/expenses/${id}`, { method: 'DELETE' });
    return r.ok;
  },

  async replaceAll(expenses) {
    const r = await fetch('/api/expenses', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(expenses),
    });
    return r.ok;
  },

  async migrateFromLocalStorage() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    let expenses;
    try { expenses = JSON.parse(raw); } catch { return 0; }
    if (!expenses?.length) return 0;
    const ok = await this.replaceAll(expenses);
    if (ok) {
      localStorage.removeItem(STORAGE_KEY);
      console.log(`Migrated ${expenses.length} expenses to server files`);
      return expenses.length;
    }
    return 0;
  },
};

// ── IndexedDB helpers (для хранения file handle между сессиями) ──
const IDB = (() => {
  let _db = null;
  async function open() {
    if (_db) return _db;
    return new Promise((res, rej) => {
      const req = indexedDB.open('fintracker_fs', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = () => rej(req.error);
    });
  }
  return {
    async get(key) {
      const db = await open();
      return new Promise((res, rej) => {
        const req = db.transaction('kv','readonly').objectStore('kv').get(key);
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
      });
    },
    async set(key, val) {
      const db = await open();
      return new Promise((res, rej) => {
        const req = db.transaction('kv','readwrite').objectStore('kv').put(val, key);
        req.onsuccess = () => res();
        req.onerror   = () => rej(req.error);
      });
    },
    async del(key) {
      const db = await open();
      return new Promise((res, rej) => {
        const req = db.transaction('kv','readwrite').objectStore('kv').delete(key);
        req.onsuccess = () => res();
        req.onerror   = () => rej(req.error);
      });
    },
  };
})();

// ── File Storage object ───────────────────────────────────────────
const fileStore = {
  dirHandle: null,
  _fileCache: {},    // { 'YYYY-MM': Expense[] } — уже прочитанные месяцы

  // --- Инициализация: пытаемся восстановить доступ к папке --------
  async tryRestore() {
    if (!FS_SUPPORTED) return false;
    try {
      const handle = await IDB.get('dirHandle');
      if (!handle) return false;
      // queryPermission не требует жеста пользователя
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        this.dirHandle = handle;
        return true;
      }
      // Разрешение нужно запросить явно — сохраним handle для кнопки
      this._pendingHandle = handle;
      return false;
    } catch { return false; }
  },

  // Запросить разрешение на pending handle (вызывать из клика кнопки)
  async requestPendingPermission() {
    if (!this._pendingHandle) return false;
    try {
      const perm = await this._pendingHandle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        this.dirHandle = this._pendingHandle;
        this._pendingHandle = null;
        await IDB.set('dirHandle', this.dirHandle);
        return true;
      }
    } catch {}
    return false;
  },

  // Пользователь выбирает папку
  async selectFolder() {
    if (!FS_SUPPORTED) return false;
    try {
      this.dirHandle = await window.showDirectoryPicker({
        id: 'fintracker',
        mode: 'readwrite',
        startIn: 'documents',
      });
      await IDB.set('dirHandle', this.dirHandle);
      return true;
    } catch { return false; }
  },

  async disconnect() {
    this.dirHandle = null;
    this._fileCache = {};
    await IDB.del('dirHandle');
  },

  get isConnected() { return !!this.dirHandle; },
  get folderName()  { return this.dirHandle?.name || null; },
  get hasPending()  { return !!this._pendingHandle; },

  // --- JSONL чтение/запись ----------------------------------------

  // Загрузить все расходы из всех JSONL-файлов в папке
  async loadAll() {
    if (!this.dirHandle) return [];
    const all = [];
    try {
      for await (const [name, handle] of this.dirHandle.entries()) {
        if (handle.kind === 'file' && name.match(/^\d{4}-\d{2}\.jsonl$/)) {
          const ym = name.replace('.jsonl', '');
          const expenses = await this._readMonthFile(handle);
          this._fileCache[ym] = expenses;
          all.push(...expenses);
        }
      }
    } catch (e) { console.error('FS loadAll error:', e); }
    return all;
  },

  async _readMonthFile(handle) {
    try {
      const file = await handle.getFile();
      const text = await file.text();
      return text.trim().split('\n')
        .filter(l => l.trim())
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
  },

  // Дописать одну запись в конец файла (O(1), не перезаписываем файл)
  async appendExpense(expense) {
    if (!this.dirHandle) return false;
    const ym = expense.date.substring(0, 7);
    try {
      const fh       = await this.dirHandle.getFileHandle(`${ym}.jsonl`, { create: true });
      const file     = await fh.getFile();
      const writable = await fh.createWritable({ keepExistingData: true });
      await writable.seek(file.size);
      await writable.write(JSON.stringify(expense) + '\n');
      await writable.close();
      if (!this._fileCache[ym]) this._fileCache[ym] = [];
      this._fileCache[ym].push(expense);
      await this._updateIndex();
      return true;
    } catch (e) { console.error('FS append error:', e); return false; }
  },

  // Удалить запись — перезаписать месячный файл без неё
  async deleteExpense(id) {
    if (!this.dirHandle) return false;
    // Ищем в каком месяце находится запись
    for (const [ym, expenses] of Object.entries(this._fileCache)) {
      const idx = expenses.findIndex(e => e.id === id);
      if (idx >= 0) {
        expenses.splice(idx, 1);
        await this._rewriteMonth(ym, expenses);
        return true;
      }
    }
    return false;
  },

  // Перезаписать месячный файл целиком (используется при удалении)
  async _rewriteMonth(ym, expenses) {
    if (!this.dirHandle) return;
    this._fileCache[ym] = expenses;
    try {
      const fh = await this.dirHandle.getFileHandle(`${ym}.jsonl`, { create: true });
      const w  = await fh.createWritable();
      await w.write(expenses.map(e => JSON.stringify(e)).join('\n') + (expenses.length ? '\n' : ''));
      await w.close();
    } catch (e) { console.error('FS rewrite error:', e); }
    await this._updateIndex();
  },

  // Обновить index.json — лёгкий индекс с метаданными
  async _updateIndex() {
    if (!this.dirHandle) return;
    const months = Object.entries(this._fileCache)
      .map(([period, exps]) => ({
        period,
        count: exps.length,
        total: Math.round(exps.reduce((s, e) => s + e.amount, 0)),
      }))
      .sort((a, b) => b.period.localeCompare(a.period));
    try {
      const fh = await this.dirHandle.getFileHandle('index.json', { create: true });
      const w  = await fh.createWritable();
      await w.write(JSON.stringify({ months, updated: new Date().toISOString() }, null, 2) + '\n');
      await w.close();
    } catch {}
  },

  // Перенести данные из localStorage в файлы
  async migrateFromLocalStorage() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    let expenses;
    try { expenses = JSON.parse(raw); } catch { return 0; }
    if (!expenses?.length) return 0;

    // Группируем по месяцам, пишем те что ещё не в файлах
    const byMonth = {};
    expenses.forEach(e => {
      const ym = e.date.substring(0, 7);
      if (!byMonth[ym]) byMonth[ym] = [];
      byMonth[ym].push(e);
    });
    let count = 0;
    for (const [ym, exps] of Object.entries(byMonth)) {
      const existing = this._fileCache[ym] || [];
      const existingIds = new Set(existing.map(e => e.id));
      const newOnes = exps.filter(e => !existingIds.has(e.id));
      if (newOnes.length) {
        const merged = [...existing, ...newOnes]
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        await this._rewriteMonth(ym, merged);
        count += newOnes.length;
      }
    }
    if (count > 0) {
      localStorage.removeItem(STORAGE_KEY);
      console.log(`Migrated ${count} expenses to file storage`);
    }
    return count;
  },
};

// ═══════════════════════════════════════════════════════════════
// STORAGE INIT — вызывается один раз при старте страницы
// ═══════════════════════════════════════════════════════════════

async function initStorage() {
  // Сначала пробуем сервер (node server.js)
  const serverOk = await serverStore.detect();
  if (serverOk) {
    // Автомиграция из localStorage если есть данные
    const lsRaw = localStorage.getItem(STORAGE_KEY);
    if (lsRaw) {
      try {
        const lsData = JSON.parse(lsRaw);
        if (lsData?.length) await serverStore.migrateFromLocalStorage();
      } catch {}
    }
    _expenses = await serverStore.loadAll();
    return 'server';
  }

  // Fallback: File System Access API
  const fsOk = await fileStore.tryRestore();
  if (fsOk) {
    _expenses = await fileStore.loadAll();
    const migrated = await fileStore.migrateFromLocalStorage();
    if (migrated > 0) _expenses = await fileStore.loadAll();
    return 'filesystem';
  }

  // Fallback: localStorage
  _expenses = null;
  return 'localstorage';
}

// ═══════════════════════════════════════════════════════════════
// CONFIG — бюджетный конфиг
// Всегда есть дефолт. Пользователь меняет в Настройках.
// ═══════════════════════════════════════════════════════════════

// Дефолтные проценты от дохода для автораспределения бюджета
const BUDGET_PCT = {
  groceries:    0.20,
  food_out:     0.07,
  taxi:         0.04,
  transport:    0.05,
  health:       0.03,
  leisure:      0.05,
  clothes:      0.04,
  marketplaces: 0.04,
  beauty:       0.02,
  misc:         0.04,
};

// Текущая версия формата конфига. Увеличивать при каждом изменении схемы.
const CONFIG_VERSION = 2;

const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  monthly_income: 0,
  currency: 'RUB',
  categories: [
    { id:'groceries',    name:'Продукты',      emoji:'🛒', budget:0, color:'#4CAF50', notes:'', fixed:false },
    { id:'food_out',     name:'Еда вне дома',  emoji:'🍔', budget:0, color:'#FF9800', notes:'', fixed:false },
    { id:'taxi',         name:'Такси',          emoji:'🚕', budget:0, color:'#FFEB3B', notes:'', fixed:false },
    { id:'transport',    name:'Транспорт',      emoji:'🚂', budget:0, color:'#2196F3', notes:'', fixed:false },
    { id:'health',       name:'Здоровье',       emoji:'💊', budget:0, color:'#E91E63', notes:'', fixed:false },
    { id:'leisure',      name:'Развлечения',    emoji:'🎭', budget:0, color:'#9C27B0', notes:'', fixed:false },
    { id:'clothes',      name:'Одежда',         emoji:'👕', budget:0, color:'#00BCD4', notes:'', fixed:false },
    { id:'marketplaces', name:'Маркетплейсы',   emoji:'📦', budget:0, color:'#FF5722', notes:'', fixed:false },
    { id:'beauty',       name:'Красота',        emoji:'💈', budget:0, color:'#F06292', notes:'', fixed:false },
    { id:'misc',         name:'Прочее',         emoji:'🎲', budget:0, color:'#78909C', notes:'', fixed:false },
  ],
  savings_plan:   [],
  budget_summary: { total_variable_budget:0, total_fixed:0, total_savings:0, free_money:0 },
};

// ── Миграция конфига ──────────────────────────────────────────────
// Дотягивает старый конфиг до актуальной версии, сохраняя данные пользователя.
// Каждая миграция — отдельный шаг: v0→1, v1→2 и т.д.
function migrateConfig(config) {
  if (!config || typeof config !== 'object') {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  const v = config.version || 0;
  if (v >= CONFIG_VERSION) return config;

  // v0 → v1: добавляем недостающие поля из DEFAULT_CONFIG
  if (v < 1) {
    // Гарантируем наличие всех верхних полей
    if (!config.currency)        config.currency = DEFAULT_CONFIG.currency;
    if (!config.fixed_expenses)  config.fixed_expenses = [];
    if (!config.savings_plan)    config.savings_plan = [];
    if (!config.budget_summary)  config.budget_summary = { ...DEFAULT_CONFIG.budget_summary };

    // Гарантируем что у каждой категории есть все поля
    if (Array.isArray(config.categories)) {
      config.categories = config.categories.map(cat => ({
        id:    cat.id    || 'unknown',
        name:  cat.name  || cat.id || 'Без названия',
        emoji: cat.emoji || '❓',
        budget: cat.budget || 0,
        color: cat.color || '#78909C',
        notes: cat.notes || '',
        fixed: cat.fixed || false,
      }));
    } else {
      config.categories = JSON.parse(JSON.stringify(DEFAULT_CONFIG.categories));
    }

    config.version = 1;
  }

  // v1 → v2: фиксированные расходы становятся категориями с fixed:true
  if (v < 2) {
    // Добавляем fixed:false ко всем существующим категориям (если ещё нет)
    if (Array.isArray(config.categories)) {
      config.categories.forEach(cat => {
        if (cat.fixed === undefined) cat.fixed = false;
      });
    }

    // Мигрируем old fixed_expenses → categories с fixed:true
    const existingIds = new Set((config.categories || []).map(c => c.id));
    if (Array.isArray(config.fixed_expenses)) {
      config.fixed_expenses.forEach(f => {
        const id = f.id || ('fixed_' + (f.name || '').toLowerCase().replace(/[^a-zа-яё0-9]/gi, '_') + '_' + Date.now());
        if (!existingIds.has(id)) {
          config.categories.push({
            id,
            name:  f.name  || 'Без названия',
            emoji: f.emoji || '📌',
            budget: f.amount || 0,
            color: '#607D8B',
            notes: '',
            fixed: true,
          });
          existingIds.add(id);
        }
      });
    }
    delete config.fixed_expenses;

    config.version = 2;
  }

  // Будущие миграции добавлять здесь:
  // if (v < 3) { ... config.version = 3; }

  return config;
}

// Автораспределение бюджета по процентам от дохода.
// Округляет до 500₽. Вызывается при вводе зарплаты если лимиты ещё нулевые.
function distributeBudget(config, income) {
  config.categories.filter(c => !c.fixed).forEach(cat => {
    const pct = BUDGET_PCT[cat.id] || 0.03;
    cat.budget = Math.round(income * pct / 500) * 500;
  });
}

async function loadBudgetConfig() {
  let config = null;

  // 1. localStorage
  const cached = localStorage.getItem(CONFIG_KEY);
  if (cached) {
    try { config = JSON.parse(cached); } catch {}
  }

  // 2. Сервер
  if (!config) {
    try {
      const r = await fetch('/api/config');
      if (r.ok) config = await r.json();
    } catch {}
  }

  // 3. Первый запуск — дефолт
  if (!config) {
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  // Миграция: дотягиваем старый конфиг до актуальной версии
  const before = config.version || 0;
  config = migrateConfig(config);
  if (config.version !== before) {
    saveBudgetConfig(config); // сохраняем обновлённый конфиг
  } else {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }

  return config;
}

function getBudgetConfig() {
  let config;
  try {
    config = JSON.parse(localStorage.getItem(CONFIG_KEY));
  } catch {}
  if (!config) config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  return migrateConfig(config);
}

function saveBudgetConfig(config) {
  // Вычисляем budget_summary автоматически
  const cats = config.categories || [];
  const totalVariable = cats.filter(c => !c.fixed).reduce((s, c) => s + (c.budget || 0), 0);
  const totalFixed    = cats.filter(c => c.fixed).reduce((s, c) => s + (c.budget || 0), 0);
  const totalSavings  = (config.savings_plan || []).reduce((s, p) => s + (p.monthly || 0), 0);
  config.budget_summary = {
    total_variable_budget: totalVariable,
    total_fixed:           totalFixed,
    total_savings:         totalSavings,
    free_money:            (config.monthly_income || 0) - totalVariable - totalFixed - totalSavings,
  };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  // Асинхронно сохраняем на сервер
  fetch('/api/config', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(config),
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
// EXPENSES — публичный API (синхронный, из памяти)
// ═══════════════════════════════════════════════════════════════

// Нормализация записи расхода: гарантируем наличие всех полей.
// Старые записи могут не содержать новых полей — заполняем дефолтами.
function normalizeExpense(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    id:           e.id          ?? Date.now(),
    date:         e.date        || new Date().toISOString().split('T')[0],
    amount:       Number(e.amount) || 0,
    category_id:  e.category_id || 'misc',
    description:  e.description || '',
    regret_score: Number(e.regret_score) ?? 3,
    created_at:   e.created_at  || e.date || new Date().toISOString(),
  };
}

function _useFileStorage() {
  return _expenses !== null; // true если сервер или FS API, false = localStorage
}

function loadExpenses() {
  let raw;
  if (_useFileStorage()) {
    raw = [..._expenses];
  } else {
    try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch { return []; }
  }
  return raw.map(normalizeExpense).filter(Boolean);
}

function saveExpenses(arr) {
  if (_useFileStorage()) {
    _expenses = [...arr];
    // Синхронизируем файлы: обновляем только изменившиеся месяцы
    // (полная перезапись, вызывается редко — из настроек)
    _rebuildFilesFromArray(arr);
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  }
}

async function _rebuildFilesFromArray(arr) {
  const byMonth = {};
  arr.forEach(e => {
    const ym = e.date.substring(0, 7);
    if (!byMonth[ym]) byMonth[ym] = [];
    byMonth[ym].push(e);
  });
  // Очищаем месяцы которые стали пустыми
  for (const ym of Object.keys(fileStore._fileCache)) {
    if (!byMonth[ym]) await fileStore._rewriteMonth(ym, []);
  }
  for (const [ym, exps] of Object.entries(byMonth)) {
    await fileStore._rewriteMonth(ym, exps);
  }
}

function saveExpense(expense) {
  if (_useFileStorage()) {
    _expenses.push(expense);
    // Пробуем сервер, затем FS API — фоновая запись
    if (serverStore.available) {
      serverStore.appendExpense(expense);
    } else if (fileStore.isConnected) {
      fileStore.appendExpense(expense);
    }
  } else {
    const all = loadExpenses();
    all.push(expense);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  }
  return expense;
}

function deleteExpense(id) {
  if (_useFileStorage()) {
    _expenses = _expenses.filter(e => e.id !== id);
    if (serverStore.available) {
      serverStore.deleteExpense(id);
    } else if (fileStore.isConnected) {
      fileStore.deleteExpense(id);
    }
  } else {
    const filtered = loadExpenses().filter(e => e.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  }
}

function updateExpense(id, updates) {
  if (_useFileStorage()) {
    const idx = _expenses.findIndex(e => e.id === id);
    if (idx < 0) return null;
    const old = _expenses[idx];
    const updated = normalizeExpense({ ...old, ...updates, id: old.id, created_at: old.created_at });
    _expenses[idx] = updated;
    // Перезаписываем через delete + append (работает с существующим API сервера)
    if (serverStore.available) {
      serverStore.deleteExpense(id).then(() => serverStore.appendExpense(updated));
    } else if (fileStore.isConnected) {
      fileStore.deleteExpense(id).then(() => fileStore.appendExpense(updated));
    }
    return updated;
  } else {
    const all = loadExpenses();
    const idx = all.findIndex(e => e.id === id);
    if (idx < 0) return null;
    const updated = normalizeExpense({ ...all[idx], ...updates, id: all[idx].id, created_at: all[idx].created_at });
    all[idx] = updated;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    return updated;
  }
}

function getExpenses(dateFrom, dateTo) {
  const all = loadExpenses();
  if (!dateFrom && !dateTo) return all;
  return all.filter(e => {
    if (dateFrom && e.date < dateFrom) return false;
    if (dateTo   && e.date > dateTo)   return false;
    return true;
  });
}

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function getMonthPrefix(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function getMonthExpenses(year, month) {
  const prefix = (year && month)
    ? `${year}-${String(month).padStart(2, '0')}`
    : getMonthPrefix();
  return loadExpenses().filter(e => e.date.startsWith(prefix));
}

function getMonthlyStats(year, month) {
  const config = getBudgetConfig();
  if (!config) return null;
  const expenses   = getMonthExpenses(year, month);
  const byCategory = {};
  config.categories.forEach(cat => {
    const spent = expenses
      .filter(e => e.category_id === cat.id)
      .reduce((s, e) => s + e.amount, 0);
    byCategory[cat.id] = { spent, budget: cat.budget, remaining: cat.budget - spent };
  });
  const totalSpent  = expenses.reduce((s, e) => s + e.amount, 0);
  const totalBudget = config.budget_summary.total_variable_budget;
  return { byCategory, totalSpent, totalBudget, expenses };
}

// ═══════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════

function exportToCSV(dateFrom, dateTo) {
  const config   = getBudgetConfig();
  const expenses = getExpenses(dateFrom, dateTo)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const catName  = id => (config?.categories.find(c => c.id === id) || { name: id }).name;
  const rows = [['Дата', 'Сумма', 'Категория', 'Описание', 'Оценка_ненужности', 'Создано']];
  expenses.forEach(e => rows.push([
    e.date, e.amount, catName(e.category_id),
    e.description || '', e.regret_score, e.created_at,
  ]));
  const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  const now    = new Date();
  const suffix = dateFrom || `${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}`;
  a.download   = `expenses_${suffix}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════════
// THEME
// ═══════════════════════════════════════════════════════════════

const THEME_KEY = 'ft_theme';
const THEME_COLORS = { dark: '#080810', light: '#f2f2f7' };

function getTheme() {
  return localStorage.getItem(THEME_KEY) || 'dark';
}

function setTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLORS[theme] || THEME_COLORS.dark;
}

// Применяем тему сразу при загрузке скрипта (до init), чтобы не было вспышки
applyTheme(getTheme());

// ═══════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════

function fmtRub(n) {
  return Math.round(n).toLocaleString('ru') + '\u00a0₽';
}

function fmtK(n) {
  if (n >= 1000) return (n / 1000).toFixed(0) + 'к\u00a0₽';
  return fmtRub(n);
}

function animateCount(el, to, duration = 700) {
  const start = performance.now();
  function step(now) {
    const p    = Math.min((now - start) / duration, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(to * ease).toLocaleString('ru') + '\u00a0₽';
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

