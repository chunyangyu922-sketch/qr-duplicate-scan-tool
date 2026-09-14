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
// 配置文件 config.json（已加入 .gitignore，不会被提交到 Git）。两套讯飞接口都支持，
// 由 mode 选择（缺省按凭据齐不齐自动判定）。两套凭据分属不同的讯飞服务，不通用：
//   新版 REST  ：{ "mode": "newapi", "appid": "…", "apikey": "…", "apisecret": "…",
//                  "host": "api.xf-yun.com", "path": "/v1/private/s824758f1",
//                  "serviceId": "s824758f1", "templateList": "vat_invoice" }
//   老版 WebAPI：{ "mode": "webapi", "appid": "…", "apikey": "…",
//                  "url": "https://webapi.xfyun.cn/v1/service/v1/ocr/invoice",
//                  "engineType": "vat_invoice" }
let XF = null;
let XF_MODE = '';        // 'newapi' | 'webapi'
try {
  const cfgPath = path.join(ROOT, 'config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const x = (cfg && cfg.xfyun) || null;
    if (x) {
      const restOk = !!(x.appid && x.apikey && x.apisecret && x.host && x.path);
      const webOk = !!(x.appid && x.apikey && x.url);
      const mode = x.mode === 'webapi' || x.mode === 'newapi' ? x.mode : (restOk ? 'newapi' : 'webapi');
      if ((mode === 'newapi' && restOk) || (mode === 'webapi' && webOk)) { XF = x; XF_MODE = mode; }
    }
  }
} catch (e) {
  console.warn('读取 config.json 失败，云端 OCR 不可用：', e.message);
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

// 取更长/更完整者（合并重复扫描的新旧字段值；OCR 常把名称首字截断，如「广州」只剩「州」）
function preferLonger(existing, incoming) {
  existing = String(existing || '').trim();
  incoming = String(incoming || '').trim();
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (incoming.indexOf(existing) >= 0) return incoming;   // 新值包含旧值（旧值被截断）→ 取新值
  if (existing.indexOf(incoming) >= 0) return existing;   // 旧值包含新值 → 保留旧值
  return incoming.length > existing.length ? incoming : existing;
}
// 判断税号是否“像”合法编码：18 位含字母（统一社会信用代码）或 15 位纯数字（纳税人识别号）
// 判断税号是否合法：18 位统一社会信用代码（校验码对得上）或 15 位纯数字纳税人识别号。
// 注意不能要求「含字母」：统一社会信用代码可以全是数字（如 911201163409833307）。
function isGoodTax(s) {
  return taxQuality(s, true) >= 2;
}
// 取更合法/更长的税号：一合法一非法取合法，否则取更长
function preferBetterTax(existing, incoming) {
  existing = String(existing || '').trim().toUpperCase();
  incoming = String(incoming || '').trim().toUpperCase();
  if (!incoming) return existing;
  if (!existing) return incoming;
  const ge = isGoodTax(existing), gi = isGoodTax(incoming);
  if (ge !== gi) return gi ? incoming : existing;
  return incoming.length > existing.length ? incoming : existing;
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

// 生成老版 WebAPI 的鉴权头：X-CheckSum = md5(apikey + 时间戳 + X-Param)
function xfWebapiRequest(imageB64) {
  const curtime = String(Math.floor(Date.now() / 1000));
  const param = Buffer.from(JSON.stringify({ engine_type: XF.engineType || 'vat_invoice' })).toString('base64');
  const checkSum = crypto.createHash('md5').update(XF.apikey + curtime + param).digest('hex');
  return {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      'X-Appid': XF.appid,
      'X-CurTime': curtime,
      'X-Param': param,
      'X-CheckSum': checkSum,
    },
    body: 'image=' + encodeURIComponent(imageB64),
  };
}

// ==================== 税号规范化 ====================
// 统一社会信用代码校验码字符集与权重（GB 32100-2015）
const USC_CHARS = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const USC_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
// 补全被切掉最后一位的统一社会信用代码：扫描件常把第 18 位校验码截掉，
// 而校验码由前 17 位唯一确定，因此可以精确还原（不是猜测）。
function repairUsc(s) {
  if (s.length !== 17 || !/^[159Y][1-9]\d{6}/.test(s)) return '';
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const idx = USC_CHARS.indexOf(s[i]);
    if (idx < 0) return '';
    sum += idx * USC_WEIGHTS[i];
  }
  const c = 31 - (sum % 31);
  return s + USC_CHARS[(c === 31 ? 0 : c) % 31];
}
// 规范税号：17 位（被切掉校验位）补齐为 18 位；18 位以校验码为准（第 18 位没有信息量，
// 扫描件常把 B 读成 E、8 读成 3 之类，用 GB 32100 校验码订正反而更准）
function normalizeTax(s) {
  const code = String(s || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (code.length === 17) return repairUsc(code) || code;
  if (code.length >= 18) {
    const fixed = repairUsc(code.slice(0, 17));
    // 前 18 位本身就是合法统一社会信用代码时，多出来的位数是粘上去的地址/编号噪声
    if (fixed && code.length > 18 && fixed === code.slice(0, 18)) return fixed;
    if (code.length === 18 && fixed && fixed !== code) return fixed;
  }
  return code;
}
// 税号可信度：2=完整合法 1=校验位对不上但形态合理 0=长度可疑（被截断/多字） -1=丢弃
function taxQuality(s, labeled) {
  const code = normalizeTax(s);
  if (/^\d{15}$/.test(code)) return 2;                       // 老版纳税人识别号
  if (code.length === 18) {
    if (repairUsc(code.slice(0, 17)) === code) return 2;     // 校验位对得上，完全可信
    return /[A-Z]/.test(code) ? (labeled ? 1 : 0) : 0;
  }
  if (labeled && code.length >= 16 && code.length <= 20 && /^[159Y][1-9]/.test(code)) return 0;
  return -1;
}

// 新版 REST（api.xf-yun.com）返回嵌套结构：object_list → region_list → text_block_list →
// text_sent_list[].text，字段用 key/class 标识并带坐标；扫描件（数电票）里购买方在左、销售方在右，
// 因此按坐标判断买卖方。返回结构与 xfParseInvoiceFlat 一致。
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

  // 3) 提取税号（统一社会信用代码 18 位 / 纳税人识别号 15 位）与公司/机构名称
  const nameRe = /[一-龥A-Za-z0-9（）()·]+(?:有限责任公司|股份有限公司|有限公司|医院|学校|大学|学院|中心|店|厂|集团|公司|事务所|合作社|银行|支行|分行|车站|宾馆|酒店|餐厅|餐饮)/;
  const taxes = [];   // { code, x, y }
  const names = [];   // { name, x, y }
  for (const e of entries) {
    // 统一社会信用代码可以全是数字（如 911201163409833307），不能要求含字母；
    // 是否像税号交给 taxQuality 判断，发票号码、银行账号等长数字串会被判掉
    for (const c of (e.text.match(/[0-9][0-9A-Za-z]{13,20}/g) || [])) {
      const code = normalizeTax(c);
      if (taxQuality(code, false) < 0 || taxes.some(t => t.code === code)) continue;
      taxes.push({ code, x: e.x, y: e.y });
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

  // 只有一条税号/名称时，pick 按「在右/在下就是销售方」硬判，容易把购买方当销售方。
  // 用它离哪个名称更近来定归属，和名称一侧互相印证（税号通常就在同名下方）
  // 避免像「只有一条税号但它是购买方的」被一律算到销售方名下
  const nearerTo = (item, ref) => Math.abs((item.x || 0) - (ref.x || 0));
  if (taxes.length === 1 && namePair.buyer && namePair.seller) {
    const t = taxes[0];
    const toBuyer = nearerTo(t, namePair.buyer) <= nearerTo(t, namePair.seller);
    taxPair.buyer = toBuyer ? t : null;
    taxPair.seller = toBuyer ? null : t;
  } else if (names.length === 1 && taxPair.buyer && taxPair.seller) {
    const n = names[0];
    const toBuyer = nearerTo(n, taxPair.buyer) <= nearerTo(n, taxPair.seller);
    namePair.buyer = toBuyer ? n : null;
    namePair.seller = toBuyer ? null : n;
  }

  const parties = {
    buyerName: namePair.buyer ? namePair.buyer.name : '',
    buyerTaxId: taxPair.buyer ? taxPair.buyer.code : '',
    sellerName: namePair.seller ? namePair.seller.name : '',
    sellerTaxId: taxPair.seller ? taxPair.seller.code : '',
  };

  const text = entries.map(e => e.text).join('\n');

  // 5) 发票要素：号码 / 价税合计 / 开票日期。二维码解不出的扫描件用它当去重键。
  // 号码优先取「代码右半」文本块（即发票号码），其次在全文里找 19~20 位数字串；
  // 价税合计取「价税合计」块里的数字，取不到就用 金额 + 税额 相加。
  const numOf = (s) => {
    const m = String(s || '').match(/\d[\d,.]*/);
    const v = m ? Number(m[0].replace(/,/g, '')) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  const keyed = (re) => entries.filter(e => re.test(e.key)).map(e => e.text);
  // 发票号码（二维码解不出时用它当去重键）。15~25 位：数电票号码 19~20 位；
  // 铁路电子客票的「电子客票号」25 位，讯飞会把它归到 daima 键上，它同样一票一号，可以拿来去重。
  let invoiceNo = '';
  for (const t of keyed(/daima/i)) {
    const m = String(t).match(/\d{15,25}/);
    if (m && m[0].length > invoiceNo.length) invoiceNo = m[0];
  }
  if (!invoiceNo) {
    const m = text.match(/发票号码[:：]?\s*(\d{15,25})/);
    if (m) invoiceNo = m[1];
  }
  let amount = null;
  for (const t of keyed(/total-cover-tax/i)) { const v = numOf(t); if (v != null && amount == null) amount = v; }
  if (amount == null) {
    const a = keyed(/vat-invoice-total$/i).map(numOf).find(v => v != null);
    const b = keyed(/tax-total/i).map(numOf).find(v => v != null);
    if (a != null) amount = Math.round((a + (b || 0)) * 100) / 100;
  }
  const dm = text.match(/开票日期[:：]?\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const invoiceDate = dm ? `${dm[1]}${String(dm[2]).padStart(2, '0')}${String(dm[3]).padStart(2, '0')}` : '';

  return {
    text,
    parties,
    // 所有候选（不做左右归属）：前端据此在整份 PDF 内交叉印证购买方
    candidates: { names: names.map(n => n.name), taxes: taxes.map(t => t.code) },
    invoice: { number: invoiceNo, amount, date: invoiceDate },
  };
}

// 老版 WebAPI（webapi.xfyun.cn）返回扁平字段（vat_invoice_xxx）：买卖方是语义字段
// （payer=购买方、seller/payee=销售方），不必按坐标判断左右；映射成与新版一致的结果结构。
function xfParseInvoiceFlat(obj) {
  const d = (obj && obj.data) || {};
  const keys = Object.keys(d).filter(k => !/_pos$/.test(k));
  const val = (k) => String(d[k] == null ? '' : d[k]).trim();
  const text = keys.filter(k => val(k)).map(k => `${k}: ${val(k)}`).join('\n');

  // 老版引擎偶尔把「名称 + 地址 + 电话 + 开户行」拼成一整段。只在地名/银行类关键词之后
  // 还留着完整机构名时才切掉尾巴，否则原样保留（避免把「广州市白云区人民医院」这类名字切坏）。
  const cutAddr = (s) => {
    const m = String(s).match(/省|市|区|县|路|街|道|巷|号|楼|层|室|银行|支行|分行|信用社|电话|开户|账号|传真|邮编|镇|村|广场|大厦/);
    if (!m) return s;
    const head = String(s).slice(0, m.index);
    const nm = head.match(/^.*(?:有限责任公司|股份有限公司|有限公司|医院|学校|大学|学院|中心|店|厂|集团|公司|事务所|合作社|银行|支行|分行|宾馆|酒店|餐厅|餐饮|车站|门诊部|诊所)/);
    return nm ? nm[0] : s;
  };
  // 名称：同义键可能不止一个（payer/seller/payee…），取最长的一条，扫描件上更长的通常更完整
  const nameOf = (re) => {
    let best = '';
    for (const k of keys) {
      if (!/name/i.test(k) || !re.test(k)) continue;
      const s = cutAddr(val(k));
      if (s.length > best.length) best = s;
    }
    return best;
  };
  // 税号：同名键里挑校验位对得上的那条
  const taxOf = (re) => {
    let best = '';
    for (const k of keys) {
      if (!re.test(k)) continue;
      const code = normalizeTax(val(k));
      if (taxQuality(code, true) > taxQuality(best, true)) best = code;
    }
    return best;
  };
  const buyerName = nameOf(/payer|buyer/i);
  const sellerName = nameOf(/seller|payee|saler/i);
  // 老版把购买方税号放在 vat_invoice_rate_payer_id 里（rate 是引擎的历史命名）
  const buyerTaxId = taxOf(/payer.*(id|num|code)|buyer.*(id|num|code)/i);
  const sellerTaxId = taxOf(/(seller|payee|saler).*(id|num|code)/i);

  const numOf = (s) => {
    const m = String(s || '').match(/\d[\d,.]*/);
    const v = m ? Number(m[0].replace(/,/g, '')) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  // 发票号码：haoma（含 haoma_large_size），15~25 位同新版口径
  let invoiceNo = '';
  for (const k of keys) {
    if (!/haoma/i.test(k)) continue;
    const m = val(k).match(/\d{15,25}/);
    if (m && m[0].length > invoiceNo.length) invoiceNo = m[0];
  }
  // 价税合计：优先「价税合计小写」，其次大写键里的数字（拿不到），最后 金额 + 税额
  let amount = null;
  for (const k of keys) {
    if (!/total_cover_tax_digits/i.test(k)) continue;
    const v = numOf(val(k));
    if (v != null) { amount = v; break; }
  }
  if (amount == null) {
    const a = keys.filter(k => /total$/i.test(k)).map(k => numOf(val(k))).find(v => v != null);
    const b = keys.filter(k => /tax_total/i.test(k)).map(k => numOf(val(k))).find(v => v != null);
    if (a != null) amount = Math.round((a + (b || 0)) * 100) / 100;
  }
  let invoiceDate = '';
  for (const k of keys) {
    if (!/issue_date/i.test(k)) continue;
    const m = val(k).match(/(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/);
    if (m) { invoiceDate = `${m[1]}${String(m[2]).padStart(2, '0')}${String(m[3]).padStart(2, '0')}`; break; }
  }

  // 候选：把整个扁平结果里像税号、像机构名的值都收进来，供前端跨票交叉印证
  const names = [], taxes = [];
  for (const k of keys) {
    const s = val(k);
    if (!s) continue;
    if (/name/i.test(k)) {
      const n = cutAddr(s);
      if (n.length >= 4 && !names.includes(n)) names.push(n);
    }
    for (const c of (s.match(/[0-9][0-9A-Za-z]{13,20}/g) || [])) {
      const code = normalizeTax(c);
      if (taxQuality(code, false) < 0 || taxes.includes(code)) continue;
      taxes.push(code);
    }
  }
  for (const n of [buyerName, sellerName]) if (n && !names.includes(n)) names.push(n);

  return {
    text,
    parties: { buyerName, buyerTaxId, sellerName, sellerTaxId },
    candidates: { names, taxes },
    invoice: { number: invoiceNo, amount, date: invoiceDate },
  };
}

// fetch 失败时 e.message 只有 "fetch failed"，真正的原因（如 TLS 握手被拒）在 e.cause 里
function fetchFailReason(e) {
  return (e.cause && (e.cause.code || e.cause.message)) ? `${e.message}（${e.cause.code || e.cause.message}）` : (e.message || String(e));
}

// 老版 WebAPI 调用
async function xfOcrWebapi(imageB64) {
  const { headers, body } = xfWebapiRequest(imageB64);
  let res;
  try {
    res = await fetch(XF.url, { method: 'POST', headers, body });
  } catch (e) {
    throw new Error('讯飞接口连接失败：' + fetchFailReason(e));
  }
  if (!res.ok) throw new Error('讯飞接口返回 HTTP ' + res.status);
  let msg;
  try { msg = await res.json(); } catch (_) { throw new Error('讯飞返回格式异常'); }
  if (String(msg.code) !== '0') throw new Error('讯飞返回错误(code=' + msg.code + ')：' + (msg.desc || ''));
  return xfParseInvoiceFlat(msg);
}

// 新版 REST 调用
async function xfOcrRest(imageB64, encoding) {
  const sid = XF.serviceId || 's824758f1';
  const templateList = XF.templateList || 'vat_invoice';
  const body = {
    header: { app_id: XF.appid, status: 3 },
    parameter: { [sid]: { template_list: templateList, result: { encoding: 'utf8', compress: 'raw', format: 'json' } } },
    payload: { [sid + '_data_1']: { encoding: encoding || 'jpg', status: 3, image: imageB64 } },
  };
  let res;
  try {
    res = await fetch(xfBuildUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('讯飞接口连接失败：' + fetchFailReason(e));
  }
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

// 调用科大讯飞增值税发票识别，成功返回 { text, parties, candidates, invoice }，失败 reject。
// 走哪套接口由 config.json 的 mode 决定（见文件顶部注释），失败不自动切换。
async function xfOcr(imageB64, encoding) {
  return XF_MODE === 'webapi' ? xfOcrWebapi(imageB64) : xfOcrRest(imageB64, encoding);
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
        return sendJson(res, 200, { text: r.text || '', parties: r.parties || null, candidates: r.candidates || null, invoice: r.invoice || null });
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
        // 重复扫描时用“更好”的新值修正旧值：名称取更完整者，税号取更合法者，
        // 这样重新扫描就能纠正旧记录里被截断/漏字的购买方、销售方名称与税号。
        const mbuyerName = preferLonger(existing.buyer_name, buyer_name);
        const mbuyerTax = preferBetterTax(existing.buyer_tax_id, buyer_tax_id);
        const msellerName = preferLonger(existing.seller_name, seller_name);
        const msellerTax = preferBetterTax(existing.seller_tax_id, seller_tax_id);
        db.prepare(`UPDATE records SET scan_count = scan_count + 1, last_scanned_at = ?,
          filename = CASE WHEN filename = '' THEN ? ELSE filename END,
          buyer_name = ?, buyer_tax_id = ?, seller_name = ?, seller_tax_id = ?
          WHERE id = ?`)
          .run(nowStr, filename, mbuyerName, mbuyerTax, msellerName, msellerTax, existing.id);
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
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      if (ext === '.html') headers['Cache-Control'] = 'no-store'; // 前端代码改动后，确保浏览器总是加载最新版
      res.writeHead(200, headers);
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
