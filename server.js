#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// ФИНАНСОВЫЙ ТРЕКЕР — локальный сервер
// Раздаёт статику + REST API для чтения/записи JSONL-файлов
// Запуск: node server.js  (или: node server.js 3000)
// ═══════════════════════════════════════════════════════════════

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT     = parseInt(process.argv[2] || '3000', 10);
const ROOT_DIR = path.join(__dirname, 'public');  // статика
const DATA_DIR = path.join(__dirname, 'data');    // данные пользователя

// Создаём папку data/ если её нет
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ── MIME types ────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl':'application/x-ndjson; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.webmanifest': 'application/manifest+json',
};

// ── Helpers ───────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((res, rej) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end',  ()    => res(data));
    req.on('error', rej);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':  'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function monthFile(ym) {
  // ym = "2026-03"
  if (!/^\d{4}-\d{2}$/.test(ym)) return null;
  return path.join(DATA_DIR, `${ym}.jsonl`);
}

function readJSONL(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function rebuildIndex() {
  const months = fs.readdirSync(DATA_DIR)
    .filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f))
    .map(f => {
      const ym       = f.replace('.jsonl', '');
      const expenses = readJSONL(path.join(DATA_DIR, f));
      return {
        period: ym,
        count:  expenses.length,
        total:  Math.round(expenses.reduce((s, e) => s + (e.amount || 0), 0)),
      };
    })
    .sort((a, b) => b.period.localeCompare(a.period));

  const index = { months, updated: new Date().toISOString() };
  fs.writeFileSync(path.join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  return index;
}

// ── API Router ────────────────────────────────────────────────────

function handleAPI(req, res, pathname) {
  const method = req.method;

  // GET /api/index → список месяцев с метаданными
  if (pathname === '/api/index' && method === 'GET') {
    const indexPath = path.join(DATA_DIR, 'index.json');
    const index = fs.existsSync(indexPath)
      ? JSON.parse(fs.readFileSync(indexPath, 'utf8'))
      : rebuildIndex();
    return json(res, 200, index);
  }

  // GET /api/expenses?month=2026-03 → все расходы за месяц
  if (pathname === '/api/expenses' && method === 'GET') {
    const qs    = new url.URL(req.url, 'http://localhost').searchParams;
    const month = qs.get('month');
    if (!month) {
      // Вернуть все месяцы
      const all = fs.readdirSync(DATA_DIR)
        .filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f))
        .flatMap(f => readJSONL(path.join(DATA_DIR, f)));
      return json(res, 200, all);
    }
    const fp = monthFile(month);
    if (!fp) return json(res, 400, { error: 'Invalid month format' });
    return json(res, 200, readJSONL(fp));
  }

  // POST /api/expenses → добавить расход (append-only)
  if (pathname === '/api/expenses' && method === 'POST') {
    return readBody(req).then(body => {
      let expense;
      try { expense = JSON.parse(body); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
      if (!expense.date || !expense.amount || !expense.category_id) {
        return json(res, 400, { error: 'Missing required fields: date, amount, category_id' });
      }
      const ym = expense.date.substring(0, 7);
      const fp = monthFile(ym);
      if (!fp) return json(res, 400, { error: 'Invalid date' });
      fs.appendFileSync(fp, JSON.stringify(expense) + '\n');
      rebuildIndex();
      return json(res, 201, expense);
    });
  }

  // DELETE /api/expenses/:id → удалить расход по id
  if (pathname.startsWith('/api/expenses/') && method === 'DELETE') {
    const id = pathname.split('/').pop();
    if (!id) return json(res, 400, { error: 'Missing id' });

    const files = fs.readdirSync(DATA_DIR).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f));
    let deleted = false;
    for (const f of files) {
      const fp       = path.join(DATA_DIR, f);
      const expenses = readJSONL(fp);
      // id может быть числом или строкой
      const filtered = expenses.filter(e => String(e.id) !== String(id));
      if (filtered.length < expenses.length) {
        fs.writeFileSync(fp, filtered.map(e => JSON.stringify(e)).join('\n') + (filtered.length ? '\n' : ''));
        deleted = true;
        break;
      }
    }
    rebuildIndex();
    return json(res, deleted ? 200 : 404, { deleted });
  }

  // PUT /api/expenses → заменить весь массив (используется при bulk-операциях)
  if (pathname === '/api/expenses' && method === 'PUT') {
    return readBody(req).then(body => {
      let expenses;
      try { expenses = JSON.parse(body); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
      // Группируем по месяцам, перезаписываем файлы
      const byMonth = {};
      expenses.forEach(e => {
        const ym = (e.date || '').substring(0, 7);
        if (ym) { if (!byMonth[ym]) byMonth[ym] = []; byMonth[ym].push(e); }
      });
      // Очищаем старые файлы
      fs.readdirSync(DATA_DIR).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).forEach(f => {
        fs.writeFileSync(path.join(DATA_DIR, f), '');
      });
      for (const [ym, exps] of Object.entries(byMonth)) {
        const fp = monthFile(ym);
        if (fp) fs.writeFileSync(fp, exps.map(e => JSON.stringify(e)).join('\n') + '\n');
      }
      rebuildIndex();
      return json(res, 200, { ok: true });
    });
  }

  // GET /api/config → читаем конфиг пользователя
  if (pathname === '/api/config' && method === 'GET') {
    const fp = path.join(DATA_DIR, 'config.json');
    if (!fs.existsSync(fp)) return json(res, 404, { error: 'No config' });
    try {
      return json(res, 200, JSON.parse(fs.readFileSync(fp, 'utf8')));
    } catch { return json(res, 500, { error: 'Config parse error' }); }
  }

  // POST /api/config → сохраняем конфиг пользователя
  if (pathname === '/api/config' && method === 'POST') {
    return readBody(req).then(body => {
      let config;
      try { config = JSON.parse(body); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
      fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify(config, null, 2) + '\n');
      return json(res, 200, { ok: true });
    });
  }

  return json(res, 404, { error: 'Unknown API endpoint' });
}

// ── Static file server ────────────────────────────────────────────

function handleStatic(req, res, pathname) {
  // Безопасность: не выходим за пределы ROOT_DIR
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const fp   = path.join(ROOT_DIR, safe === '/' ? 'index.html' : safe);

  if (!fp.startsWith(ROOT_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  let filePath = fp;
  // Если путь — директория, отдаём index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  // Без расширения → пробуем .html
  if (!fs.existsSync(filePath) && !path.extname(filePath)) {
    filePath += '.html';
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(filePath);

  res.writeHead(200, {
    'Content-Type':  mime,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

// ── Main server ───────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const { pathname } = new url.URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (pathname.startsWith('/api/')) {
    handleAPI(req, res, pathname);
  } else {
    handleStatic(req, res, pathname);
  }
});

server.listen(PORT, () => {
  console.log(`\n  💸 Финансовый трекер`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Данные: ${DATA_DIR}`);
  console.log(`  Для остановки: Ctrl+C\n`);
});
