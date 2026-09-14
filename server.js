// 二维码 / 条形码 防重复扫描工具 —— 本地服务端
// 使用 Node.js 内置模块（http + node:sqlite），无需安装任何依赖。
// 数据保存在 data/codes.db（SQLite）。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'codes.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

// 打开数据库
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS records (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    code             TEXT    NOT NULL UNIQUE,
    filename         TEXT    NOT NULL DEFAULT '',
    type             TEXT    NOT NULL DEFAULT '',
    format           TEXT    NOT NULL DEFAULT '',
    note             TEXT    NOT NULL DEFAULT '',
    submitter        TEXT    NOT NULL DEFAULT '',
    purpose          TEXT    NOT NULL DEFAULT '',
    buyer_name       TEXT    NOT NULL DEFAULT '',
    buyer_tax_id     TEXT    NOT NULL DEFAULT '',
    seller_name      TEXT    NOT NULL DEFAULT '',
    seller_tax_id    TEXT    NOT NULL DEFAULT '',
    scan_count       INTEGER NOT NULL DEFAULT 1,
    first_scanned_at TEXT    NOT NULL,
    last_scanned_at  TEXT    NOT NULL
  );
`);
// 兼容旧数据库：若缺少列则自动补充
const existingCols = db.prepare('PRAGMA table_info(records)').all().map(c => c.name);
const ensureColumn = (name, ddl) => {
  if (!existingCols.includes(name)) db.exec(ddl);
};
ensureColumn('filename', "ALTER TABLE records ADD COLUMN filename TEXT NOT NULL DEFAULT ''");
ensureColumn('submitter', "ALTER TABLE records ADD COLUMN submitter TEXT NOT NULL DEFAULT ''");
ensureColumn('purpose', "ALTER TABLE records ADD COLUMN purpose TEXT NOT NULL DEFAULT ''");
ensureColumn('buyer_name', "ALTER TABLE records ADD COLUMN buyer_name TEXT NOT NULL DEFAULT ''");
ensureColumn('buyer_tax_id', "ALTER TABLE records ADD COLUMN buyer_tax_id TEXT NOT NULL DEFAULT ''");
ensureColumn('seller_name', "ALTER TABLE records ADD COLUMN seller_name TEXT NOT NULL DEFAULT ''");
ensureColumn('seller_tax_id', "ALTER TABLE records ADD COLUMN seller_tax_id TEXT NOT NULL DEFAULT ''");

// 兼容旧版本：把旧的「公司 / 税号」字段内容迁移到新的「购买方」字段（只填充空值，幂等）
if (existingCols.includes('company') || existingCols.includes('tax_id')) {
  try {
    if (existingCols.includes('company')) {
      db.exec("UPDATE records SET buyer_name = company WHERE buyer_name = '' AND company <> ''");
    }
    if (existingCols.includes('tax_id')) {
      db.exec("UPDATE records SET buyer_tax_id = tax_id WHERE buyer_tax_id = '' AND tax_id <> ''");
    }
  } catch (_) { /* 迁移失败不阻断启动 */ }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

function localTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function listRecords() {
  return db.prepare('SELECT * FROM records ORDER BY last_scanned_at DESC, id DESC').all();
}

function getStats() {
  const total = db.prepare('SELECT COUNT(*) AS c FROM records').get().c;
  const scans = db.prepare('SELECT COALESCE(SUM(scan_count), 0) AS s FROM records').get().s;
  return { total, scans };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  try {
    // ---------- API ----------
    if (pathname === '/api/records' && req.method === 'GET') {
      return sendJson(res, 200, { records: listRecords() });
    }
    if (pathname === '/api/stats' && req.method === 'GET') {
      return sendJson(res, 200, getStats());
    }

    if (pathname === '/api/scan' && req.method === 'POST') {
      const body = await readBody(req);
      const code = String(body.code ?? '').trim();
      if (!code) return sendJson(res, 400, { error: '内容为空，无法保存' });
      const type = String(body.type ?? '').slice(0, 20);
      const format = String(body.format ?? '').slice(0, 30);
      const filename = String(body.filename ?? '').slice(0, 300);
      const buyer_name = String(body.buyer_name ?? '').slice(0, 200);
      const buyer_tax_id = String(body.buyer_tax_id ?? '').slice(0, 30);
      const seller_name = String(body.seller_name ?? '').slice(0, 200);
      const seller_tax_id = String(body.seller_tax_id ?? '').slice(0, 30);
      const nowStr = localTime();

      const existing = db.prepare('SELECT * FROM records WHERE code = ?').get(code);
      let duplicate = false;
      let record;
      if (existing) {
        duplicate = true;
        db.prepare(`UPDATE records SET scan_count = scan_count + 1, last_scanned_at = ?,
          filename = CASE WHEN filename = '' THEN ? ELSE filename END,
          buyer_name = CASE WHEN buyer_name = '' THEN ? ELSE buyer_name END,
          buyer_tax_id = CASE WHEN buyer_tax_id = '' THEN ? ELSE buyer_tax_id END,
          seller_name = CASE WHEN seller_name = '' THEN ? ELSE seller_name END,
          seller_tax_id = CASE WHEN seller_tax_id = '' THEN ? ELSE seller_tax_id END
          WHERE id = ?`)
          .run(nowStr, filename, buyer_name, buyer_tax_id, seller_name, seller_tax_id, existing.id);
        record = db.prepare('SELECT * FROM records WHERE id = ?').get(existing.id);
      } else {
        db.prepare('INSERT INTO records (code, filename, type, format, buyer_name, buyer_tax_id, seller_name, seller_tax_id, scan_count, first_scanned_at, last_scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
          .run(code, filename, type, format, buyer_name, buyer_tax_id, seller_name, seller_tax_id, nowStr, nowStr);
        record = db.prepare('SELECT * FROM records WHERE code = ?').get(code);
      }
      return sendJson(res, 200, { duplicate, record, stats: getStats() });
    }

    if (pathname === '/api/note' && req.method === 'POST') {
      const body = await readBody(req);
      const id = Number(body.id);
      const note = String(body.note ?? '').slice(0, 500);
      db.prepare('UPDATE records SET note = ? WHERE id = ?').run(note, id);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/record' && req.method === 'POST') {
      const body = await readBody(req);
      const id = Number(body.id);
      const note = String(body.note ?? '').slice(0, 500);
      const buyer_name = String(body.buyer_name ?? '').slice(0, 200);
      const buyer_tax_id = String(body.buyer_tax_id ?? '').slice(0, 30);
      const seller_name = String(body.seller_name ?? '').slice(0, 200);
      const seller_tax_id = String(body.seller_tax_id ?? '').slice(0, 30);
      db.prepare('UPDATE records SET note = ?, buyer_name = ?, buyer_tax_id = ?, seller_name = ?, seller_tax_id = ? WHERE id = ?')
        .run(note, buyer_name, buyer_tax_id, seller_name, seller_tax_id, id);
      return sendJson(res, 200, { ok: true });
    }

    if (pathname.startsWith('/api/records/') && req.method === 'DELETE') {
      const id = Number(pathname.split('/').pop());
      db.prepare('DELETE FROM records WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true, stats: getStats() });
    }

    if (pathname === '/api/records' && req.method === 'DELETE') {
      db.prepare('DELETE FROM records').run();
      return sendJson(res, 200, { ok: true, stats: getStats() });
    }

    // ---------- 静态文件 ----------
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(PUBLIC_DIR, filePath);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
      res.writeHead(403); return res.end('Forbidden');
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      return fs.createReadStream(filePath).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

const HOST = '127.0.0.1';

function listen(port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    server.once('error', onErr);
    server.listen(port, HOST, () => {
      server.removeListener('error', onErr);
      resolve();
    });
  });
}

(async () => {
  let port = 8020;
  for (let i = 0; i < 20; i++) {
    try {
      await listen(port);
      const url = `http://127.0.0.1:${port}`;
      console.log('==============================================');
      console.log('  二维码 / 条形码 防重复扫描工具 已启动');
      console.log('  请在浏览器打开：' + url);
      console.log('  数据库文件：' + DB_PATH);
      console.log('  关闭本窗口即停止服务（按 Ctrl+C 退出）');
      console.log('==============================================');
      try { exec(`start "" "${url}"`, { shell: true }); } catch (_) { /* 忽略打开浏览器失败 */ }
      return;
    } catch (e) {
      if (e.code === 'EADDRINUSE') { port += 1; continue; }
      throw e;
    }
  }
  console.error('错误：找不到可用端口，请关闭占用 8020 附近端口的程序后重试。');
  process.exit(1);
})();
