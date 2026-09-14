// 二维码 / 条形码 防重复扫描工具 —— 本地服务端
// 使用 Node.js 内置模块（http + node:sqlite），无需安装任何依赖。
// 数据保存在 data/codes.db（SQLite）。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

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

// ==================== 科大讯飞云端 OCR（可选增强，密钥仅存服务端） ====================
// 配置文件 config.json（已加入 .gitignore，不会被提交到 Git）：
// { "xfyun": { "appid": "...", "apikey": "...", "apisecret": "...",
//              "host": "api.xf-yun.com", "path": "/v1/private/s824758f1", "serviceId": "s824758f1" } }
let XF = null;
try {
  const cfgPath = path.join(ROOT, 'config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    XF = (cfg && cfg.xfyun) ? cfg.xfyun : null;
  }
} catch (e) {
  console.warn('读取 config.json 失败，云端 OCR 不可用：', e.message);
}
if (XF && (!XF.appid || !XF.apikey || !XF.apisecret)) XF = null;

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

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('请求体过大')); return; }
      data += c;
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

// 生成科大讯飞 REST 鉴权 URL（HMAC-SHA256 签名，标准 Base64，POST 请求行）
function xfBuildUrl() {
  const date = new Date().toUTCString();                 // RFC1123 时间
  const requestLine = `POST ${XF.path} HTTP/1.1`;
  const origin = `host: ${XF.host}\ndate: ${date}\n${requestLine}`;
  const signature = crypto.createHmac('sha256', XF.apisecret).update(origin).digest('base64');
  const authOrigin = `api_key="${XF.apikey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authOrigin).toString('base64');
  const qs = `authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${encodeURIComponent(XF.host)}`;
  return `https://${XF.host}${XF.path}?${qs}`;
}

// 解析讯飞增值税发票识别返回的结构化 JSON，返回 { text, parties }
// text：全部识别文本行（用于展示与兜底）；parties：购买方/销售方名称与税号。
// 讯飞实际返回层级为 object_list → region_list → text_block_list → text_sent_list[].text，
// 字段用 key/class 标识；扫描件（数电票）里购买方在左、销售方在右，按位置区分买卖方。
function xfParseInvoice(obj) {
  const entries = [];   // { key, text, x, y }
  const seen = new Set();
  // 1) 收集所有文本（含坐标）：主格式 text_sent_list[].text
  (function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (Array.isArray(node.text_sent_list)) {
      const key = node.key || node.class || '';
      for (const s of node.text_sent_list) {
        const text = String((s && typeof s === 'object' ? (s.text || s.content || '') : (s || ''))).trim();
        if (!text) continue;
        const pos = (s && s.position && s.position.tl_point) || (node.position && node.position.tl_point) || null;
        const x = pos ? pos.x : null;
        const y = pos ? pos.y : null;
        if (!seen.has(text)) { seen.add(text); entries.push({ key: String(key), text, x, y }); }
      }
    }
    for (const k in node) collect(node[k]);
  })(obj);
  // 2) 老格式兜底：{type/name/label, content/value} 字段对
  if (!entries.length) {
    const labelKeys = ['type', 'name', 'label', 'key', 'field', 'field_name', 'fieldName', 'title'];
    const contentKeys = ['content', 'value', 'text', 'result', 'field_value', 'fieldValue'];
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      let label = '';
      for (const k of labelKeys) { const v = node[k]; if (typeof v === 'string' && v.trim()) { label = v.trim(); break; } }
      let content = null;
      for (const k of contentKeys) { if (node[k] != null && String(node[k]).trim()) { content = String(node[k]).trim(); break; } }
      if (label && content) {
        if (!seen.has(content)) { seen.add(content); entries.push({ key: label, text: content, x: null, y: null }); }
        return;
      }
      for (const k in node) walk(node[k]);
    })(obj);
  }

  // 3) 提取税号（统一社会信用代码 18 位 / 纳税人识别号 15-20 位）与公司/机构名称
  const nameRe = /[一-龥A-Za-z0-9（）()·]+(?:有限责任公司|股份有限公司|有限公司|医院|学校|大学|学院|中心|店|厂|集团|公司|事务所|合作社|银行|支行|分行|车站|宾馆|酒店|餐厅|餐饮)/;
  const taxes = [];   // { code, x, y }
  const names = [];   // { name, x, y }
  for (const e of entries) {
    for (const c of (e.text.match(/[0-9][0-9A-Za-z]{14,19}/g) || [])) {
      const code = c.toUpperCase();
      // 仅保留真正的统一社会信用代码（18 位含字母）或老版纳税人识别号（15 位纯数字），
      // 排除发票号码、银行账号等纯数字长串
      const isTax = (code.length === 18 && /[A-Z]/.test(code)) || (code.length === 15 && /^\d{15}$/.test(code));
      if (isTax && !taxes.some(t => t.code === code)) taxes.push({ code, x: e.x, y: e.y });
    }
    // 去掉常见标签前缀后，取以公司/机构后缀结尾的最长片段
    const cleaned = e.text.replace(/^(?:名称|名\s*称|称|收款单位|开票方|购方名称|销方名称|购买方|销售方)\s*[:：]?\s*/, '');
    const m = cleaned.match(nameRe);
    if (m) {
      const name = m[0].replace(/^[:：·、。*\-\s]+/, '').trim();
      if (name && name.length >= 4 && !names.some(n => n.name === name)) names.push({ name, x: e.x, y: e.y });
    }
  }

  // 4) 按位置分配：左/上 = 购买方，右/下 = 销售方
  const maxX = entries.reduce((m, e) => (e.x != null && e.x > m ? e.x : m), 0);
  const maxY = entries.reduce((m, e) => (e.y != null && e.y > m ? e.y : m), 0);
  const pick = (list) => {
    const arr = list;
    if (arr.length === 0) return { buyer: null, seller: null };
    if (arr.length === 1) {
      const it = arr[0];
      const right = it.x != null && maxX > 0 && it.x >= maxX * 0.5;
      const bottom = it.y != null && maxY > 0 && it.y >= maxY * 0.5;
      return right || bottom ? { buyer: null, seller: it } : { buyer: it, seller: null };
    }
    const xs = arr.filter(i => i.x != null).map(i => i.x);
    const ys = arr.filter(i => i.y != null).map(i => i.y);
    const xSpread = xs.length >= 2 ? Math.max(...xs) - Math.min(...xs) : 0;
    const ySpread = ys.length >= 2 ? Math.max(...ys) - Math.min(...ys) : 0;
    let sorted;
    if (ySpread > xSpread && ySpread > 150) sorted = [...arr].sort((a, b) => (a.y || 0) - (b.y || 0)); // 上下：上=购买方
    else sorted = [...arr].sort((a, b) => (a.x || 0) - (b.x || 0));                                  // 左右：左=购买方
    return { buyer: sorted[0], seller: sorted[sorted.length - 1] };
  };
  const taxPair = pick(taxes);
  const namePair = pick(names);

  const parties = {
    buyerName: namePair.buyer ? namePair.buyer.name : '',
    buyerTaxId: taxPair.buyer ? taxPair.buyer.code : '',
    sellerName: namePair.seller ? namePair.seller.name : '',
    sellerTaxId: taxPair.seller ? taxPair.seller.code : '',
  };

  return { text: entries.map(e => e.text).join('\n'), parties };
}

// 调用科大讯飞增值税发票识别，成功返回 { text, parties }，失败 reject
async function xfOcr(imageB64, encoding) {
  const url = xfBuildUrl();
  const sid = XF.serviceId || 's824758f1';
  const templateList = XF.templateList || 'vat_invoice';
  const body = {
    header: { app_id: XF.appid, status: 3 },
    parameter: { [sid]: { template_list: templateList, result: { encoding: 'utf8', compress: 'raw', format: 'json' } } },
    payload: { [sid + '_data_1']: { encoding: encoding || 'jpg', status: 3, image: imageB64 } },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('讯飞接口返回 HTTP ' + res.status);
  let msg;
  try { msg = await res.json(); } catch (_) { throw new Error('讯飞返回格式异常'); }
  const code = msg.header && msg.header.code;
  if (code !== 0) throw new Error('讯飞返回错误(code=' + code + ')：' + ((msg.header && msg.header.message) || ''));
  const textB64 = msg.payload && msg.payload.result && msg.payload.result.text;
  if (!textB64) return { text: '', parties: null };
  let raw;
  try { raw = Buffer.from(textB64, 'base64').toString('utf8').replace(/\0+/g, '').trim(); } catch (_) { return { text: '', parties: null }; }
  let obj;
  try { obj = JSON.parse(raw); } catch (_) { return { text: raw, parties: null }; }
  return xfParseInvoice(obj);
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

    if (pathname === '/api/ocr' && req.method === 'POST') {
      if (!XF) return sendJson(res, 503, { error: '未配置科大讯飞 OCR（缺少 config.json 或配置不完整）' });
      const body = await readBody(req, 8 * 1024 * 1024);
      const image = String(body.image ?? '').replace(/\s+/g, '');
      if (!image) return sendJson(res, 400, { error: '缺少图片数据' });
      const encoding = String(body.encoding ?? 'jpg');
      try {
        const r = await xfOcr(image, encoding);
        return sendJson(res, 200, { text: r.text || '', parties: r.parties || null });
      } catch (e) {
        return sendJson(res, 502, { error: String((e && e.message) || e) });
      }
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
