/**
 * 仓库看板多用户服务器
 * 零依赖，使用 Node 原生 http + fs + crypto 模块
 * 数据结构（多批次版本）：
 *   cells["A1"] = { location: "A1", batches: [
 *     { code, batch, product, quantity, createdAt: ms_timestamp },
 *     ... 最多 3 个批次
 *   ]}
 * 启动: node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ===== 配置 =====
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = path.join(__dirname, 'data.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const INDEX_FILE = path.join(__dirname, 'index.html');
const SESSION_TTL = 8 * 3600 * 1000; // 8 小时
const MAX_BATCHES_PER_CELL = 3;

// ===== 静态文件 MIME =====
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};

// ===== Session 管理 =====
const sessions = new Map();
function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { ...user, expires: Date.now() + SESSION_TTL });
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return s;
}
function destroySession(token) {
  if (token) sessions.delete(token);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now > v.expires) sessions.delete(k);
  }
}, 60000).unref();

// ===== 账号管理 =====
function loadAccounts() {
  try {
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    const defaultAccounts = {
      admin: { password: '123456', name: '管理员', role: 'admin' },
      operator: { password: '123456', name: '操作员', role: 'user' }
    };
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(defaultAccounts, null, 2));
    return defaultAccounts;
  }
}

// ===== 存储层 =====
let memData = null;
let writeQueue = Promise.resolve();

function batchDateFromBatchNo(batchNo) {
  if (!batchNo) return Date.now();
  const m = String(batchNo).match(/^B(\d{4})(\d{2})(\d{2})/);
  if (m) {
    const d = new Date(+m[1], (+m[2]) - 1, +m[3]);
    if (!isNaN(d)) return d.getTime();
  }
  return Date.now();
}

function migrateOldCell(old) {
  if (!old) return null;
  // 新格式：已有 batches 数组
  if (Array.isArray(old.batches)) {
    old.batches.forEach(b => { if (!b.createdAt) b.createdAt = batchDateFromBatchNo(b.batch); });
    return old;
  }
  // 旧格式：扁平结构，转换为 batches[0]
  if (old.batch) {
    return {
      location: old.location,
      batches: [{
        code: old.code || '',
        batch: old.batch,
        product: old.product || '',
        quantity: old.quantity || 0,
        createdAt: batchDateFromBatchNo(old.batch)
      }]
    };
  }
  return { location: old.location, batches: [] };
}

function buildDemoData() {
  const demo = { version: 2, cells: {}, records: [], updatedAt: Date.now() };
  const now = Date.now();
  const demoData = [
    { key: 'A1', code: '303001', batch: 'B' + new Date(now - 2 * 86400000).toISOString().slice(0,10).replace(/-/g,''), product: 'C673开关装饰件', qty: 100, offset: 2 },
    { key: 'A1', code: '302001', batch: 'B' + new Date(now - 20 * 86400000).toISOString().slice(0,10).replace(/-/g,''), product: 'C673侧围装饰件-慕夜黑', qty: 50, offset: 20 },
    { key: 'B1', code: '303002', batch: 'B' + new Date(now - 40 * 86400000).toISOString().slice(0,10).replace(/-/g,''), product: 'C673 EU 开关装饰件-3价', qty: 30, offset: 40 },
    { key: 'A5', code: '304008', batch: 'B' + new Date(now - 5 * 86400000).toISOString().slice(0,10).replace(/-/g,''), product: 'SC3E 喷漆装饰件C', qty: 80, offset: 5 },
    { key: 'D5', code: '304010', batch: 'B' + new Date(now - 18 * 86400000).toISOString().slice(0,10).replace(/-/g,''), product: 'SA5H 喷漆装饰件 A', qty: 40, offset: 18 },
    { key: 'E3', code: '305005', batch: 'B' + new Date(now - 35 * 86400000).toISOString().slice(0,10).replace(/-/g,''), product: 'EKEAA 夜影黑PVD装饰件-左', qty: 20, offset: 35 }
  ];
  demoData.forEach(d => {
    if (!demo.cells[d.key]) demo.cells[d.key] = { location: d.key, batches: [] };
    demo.cells[d.key].batches.push({
      code: d.code, batch: d.batch, product: d.product, quantity: d.qty,
      createdAt: now - d.offset * 86400000
    });
    demo.records.unshift({
      type: '入库', location: d.key, code: d.code, batch: d.batch, product: d.product,
      quantity: d.qty, status: '已入库', time: now - d.offset * 86400000, operator: 'system'
    });
  });
  return demo;
}

function initData() {
  if (!fs.existsSync(DATA_FILE)) {
    console.log('[data.json] 首次启动，已初始化 demo 数据');
    const demo = buildDemoData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(demo, null, 2));
    memData = demo;
  } else {
    try {
      memData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      if (!memData.cells) memData.cells = {};
      if (!memData.records) memData.records = [];
      // 数据迁移：旧扁平格式 -> 新多批次格式
      Object.keys(memData.cells).forEach(k => {
        const migrated = migrateOldCell(memData.cells[k]);
        if (migrated) memData.cells[k] = migrated;
      });
      memData.version = 2;
    } catch (e) {
      console.error('[data.json] 解析失败，重建 demo 数据', e.message);
      memData = buildDemoData();
      fs.writeFileSync(DATA_FILE, JSON.stringify(memData, null, 2));
    }
  }
}

function persist() {
  memData.updatedAt = Date.now();
  const snapshot = JSON.stringify(memData, null, 2);
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, snapshot);
  fs.renameSync(tmp, DATA_FILE);
}

function withLock(fn) {
  // .catch(() => {}) 吞掉前一次的错误，确保写队列在出错后仍能继续处理后续请求
  // 否则一旦某次写操作失败，writeQueue 会保持 rejected 状态，
  // 后续所有 withLock 调用都会返回旧的错误消息（而非真正执行 fn）
  writeQueue = writeQueue.catch(() => {}).then(() => {
    try {
      const r = fn(memData);
      persist();
      return r;
    } catch (e) {
      console.error('[withLock] 写操作失败:', e.message);
      throw e;
    }
  });
  return writeQueue;
}

function cellTotalQty(cell) {
  return cell.batches.reduce((s, b) => s + (b.quantity || 0), 0);
}
function cellHasBatch(cell) {
  return cell && Array.isArray(cell.batches) && cell.batches.length > 0;
}
function sortBatchesByTime(cell) {
  // 按批次时间(批次号解析)升序（最老批次排前，FIFO出库），无法解析时回退入库时间
  cell.batches.sort((a, b) => batchDateFromBatchNo(a.batch, a.createdAt) - batchDateFromBatchNo(b.batch, b.createdAt));
}

// ===== 工具函数 =====
function send(res, status, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache'
  });
  res.end(body);
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

// ===== 鉴权 =====
function requireAuth(req, res, cb, role) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const session = m && getSession(m[1]);
  if (!session) return send(res, 401, { error: '未登录或会话已过期' });
  if (role && session.role !== role) return send(res, 403, { error: '权限不足' });
  req.session = session;
  cb();
}

// ===== API 处理器 =====
function handleLogin(req, res, body) {
  const { username, password } = body;
  if (!username || !password) return send(res, 400, { error: '请输入账号和密码' });
  const accounts = loadAccounts();
  const user = accounts[username];
  if (!user || user.password !== password) {
    return send(res, 401, { error: '账号或密码错误' });
  }
  const token = createSession({ username, name: user.name, role: user.role });
  send(res, 200, { token, username, name: user.name, role: user.role });
}
function handleLogout(req, res) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) destroySession(m[1]);
  send(res, 200, { ok: true });
}
function handleMe(req, res) {
  send(res, 200, { username: req.session.username, name: req.session.name, role: req.session.role });
}
function handleGetData(req, res) {
  send(res, 200, { cells: memData.cells, records: memData.records });
}

function handleInbound(req, res, body) {
  const { location, code, batch, product, quantity, batchIndex } = body;
  if (!location || !code) return send(res, 400, { error: '参数缺失：location 和 code 必填' });
  if (!batch) return send(res, 400, { error: '批次号不能为空' });
  const q = Math.max(1, parseInt(quantity) || 1);

  withLock(data => {
    if (!data.cells[location]) data.cells[location] = { location, batches: [] };
    const cell = data.cells[location];
    let isNewCell = !cellHasBatch(cell);
    let mode = 'new_batch';

    // 1) 若指定了 batchIndex：更新已有批次数量
    if (typeof batchIndex === 'number' && batchIndex >= 0 && batchIndex < cell.batches.length) {
      cell.batches[batchIndex].quantity = (cell.batches[batchIndex].quantity || 0) + q;
      mode = 'add_qty';
    } else {
      // 2) 若批次号相同：累加数量
      const sameIdx = cell.batches.findIndex(b => b.batch === batch);
      if (sameIdx >= 0) {
        cell.batches[sameIdx].quantity += q;
        mode = 'merge';
      } else {
        // 3) 新批次：如果超过 MAX_BATCHES_PER_CELL，报错
        if (cell.batches.length >= MAX_BATCHES_PER_CELL) {
          throw new Error(`同一库位最多存放 ${MAX_BATCHES_PER_CELL} 个批次，已达上限`);
        }
        cell.batches.push({
          code, batch, product: product || '', quantity: q,
          createdAt: Date.now()
        });
        mode = 'new_batch';
      }
    }
    sortBatchesByTime(cell);

    const type = isNewCell ? '入库' : (mode === 'new_batch' ? '二次入库' : '更新');
    const status = isNewCell ? '已入库' : (mode === 'new_batch' ? '已入库' : '已更新');
    data.records.unshift({
      type, location, code, batch, product: product || '', quantity: q,
      status, time: Date.now(), operator: req.session.username
    });
    return { cell: JSON.parse(JSON.stringify(cell)), isNewCell, mode };
  }).then(r => send(res, 200, r))
    .catch(e => send(res, 400, { error: e.message }));
}

function handleOutbound(req, res, body) {
  const { location, quantity, batchIndex } = body;
  if (!location) return send(res, 400, { error: '参数缺失：location 必填' });

  withLock(data => {
    const cell = data.cells[location];
    if (!cell || !cellHasBatch(cell)) throw new Error('库位为空，无法出库');
    sortBatchesByTime(cell);

    let targetIdx;
    if (typeof batchIndex === 'number' && batchIndex >= 0 && batchIndex < cell.batches.length) {
      targetIdx = batchIndex;
    } else {
      targetIdx = 0; // FIFO 从最早批次出库
    }
    const b = cell.batches[targetIdx];
    const cur = b.quantity || 0;
    let out = parseInt(quantity);
    if (isNaN(out) || out < 1) out = cur;
    if (out > cur) out = cur;

    data.records.unshift({
      type: '出库', location, code: b.code, batch: b.batch, product: b.product,
      quantity: out, status: '已出库',
      time: Date.now(), operator: req.session.username
    });

    b.quantity = cur - out;
    if (b.quantity <= 0) {
      cell.batches.splice(targetIdx, 1); // 批次清空移除
    }
    const cleared = cell.batches.length === 0;
    if (cleared) delete data.cells[location];
    return {
      cleared,
      remain: cleared ? 0 : cellTotalQty(cell),
      remainByBatch: cleared ? [] : cell.batches.map(x => ({
        code: x.code, batch: x.batch, product: x.product, quantity: x.quantity, createdAt: x.createdAt
      })),
      outQuantity: out,
      outBatch: b.batch
    };
  }).then(r => send(res, 200, r))
    .catch(e => send(res, 400, { error: e.message }));
}

function handleImport(req, res, body) {
  const { rows, mode } = body;
  if (!Array.isArray(rows)) return send(res, 400, { error: 'rows 必须是数组' });

  withLock(data => {
    if (mode === 'replace') {
      data.cells = {};
      data.records = [];
    }
    const allKeys = [];
    const whSections = [
      { p1: 'A', p2: 'B', count: 8 }, { p1: 'C', p2: 'D', count: 8 },
      { p1: 'E', p2: 'F', count: 8 }, { p1: 'G', p2: 'H', count: 8 },
      { p1: 'I', p2: 'J', count: 8 }, { p1: 'K', p2: 'L', count: 8 },
      { p1: 'M', p2: 'N', count: 8 }
    ];
    whSections.forEach(sec => {
      for (let i = 1; i <= sec.count; i++) {
        allKeys.push(`${sec.p1}${i}`, `${sec.p2}${i}`);
      }
    });
    // 已使用的库位 = 有任何批次即可
    const usedKeys = new Set(Object.keys(data.cells).filter(k => cellHasBatch(data.cells[k])));
    let emptyIdx = 0;
    const nextEmptyKey = () => {
      while (emptyIdx < allKeys.length) {
        const k = allKeys[emptyIdx++];
        if (!usedKeys.has(k)) { usedKeys.add(k); return k; }
      }
      return null;
    };

    let imported = 0, skipped = 0;
    rows.forEach(r => {
      const code = String(r.code || '').trim();
      const batch = String(r.batch || '').trim();
      const product = String(r.product || '').trim();
      const quantity = Math.max(1, parseInt(r.quantity) || 1);
      if (!batch && !product && !code) { skipped++; return; }

      let cellKey = String(r.location || '').trim().toUpperCase().replace(/\s/g, '');
      if (!cellKey) {
        cellKey = nextEmptyKey();
        if (!cellKey) { skipped++; return; }
      }

      if (!data.cells[cellKey]) data.cells[cellKey] = { location: cellKey, batches: [] };
      const cell = data.cells[cellKey];
      let isNewCell = !cellHasBatch(cell);
      usedKeys.add(cellKey);

      const sameIdx = cell.batches.findIndex(b => b.batch === batch);
      if (sameIdx >= 0) {
        cell.batches[sameIdx].quantity += quantity;
      } else {
        if (cell.batches.length >= MAX_BATCHES_PER_CELL) {
          skipped++; return;
        }
        cell.batches.push({
          code, batch: batch || '-', product: product || '-', quantity,
          createdAt: Date.now()
        });
      }
      sortBatchesByTime(cell);
      if (isNewCell) {
        data.records.unshift({
          type: '入库', location: cellKey, code, batch: batch || '-', product: product || '-',
          quantity, status: '已导入', time: Date.now(), operator: req.session.username
        });
      }
      imported++;
    });
    return { imported, skipped };
  }).then(r => send(res, 200, r))
    .catch(e => send(res, 500, { error: e.message }));
}

function handleReset(req, res) {
  withLock(data => {
    const demo = buildDemoData();
    data.cells = demo.cells;
    data.records = demo.records;
    return { ok: true };
  }).then(r => send(res, 200, r))
    .catch(e => send(res, 500, { error: e.message }));
}

// ===== 静态文件服务 =====
function serveStatic(req, res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { send(res, 404, 'Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ===== 路由分发 =====
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const urlObj = new URL(req.url, 'http://localhost');
  const pathname = urlObj.pathname;
  let body = {};
  if (req.method === 'POST') {
    try { body = await readJsonBody(req); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveStatic(req, res, INDEX_FILE);
  }
  if (req.method === 'GET' && pathname === '/favicon.ico') {
    return send(res, 204, '');
  }
  // 交付计划平衡表
  if (req.method === 'GET' && (pathname === '/balance.html' || decodeURIComponent(pathname) === '/交付计划平衡表.html')) {
    return serveStatic(req, res, path.join(__dirname, '交付计划平衡表.html'));
  }
  // BOM数据文件
  if (req.method === 'GET' && (pathname === '/bom-data.tsv' || decodeURIComponent(pathname) === '/BOM数据.tsv')) {
    return serveStatic(req, res, path.join(__dirname, 'bom-data.tsv'));
  }

  if (req.method === 'POST' && pathname === '/api/login') return handleLogin(req, res, body);
  if (req.method === 'POST' && pathname === '/api/logout') return requireAuth(req, res, () => handleLogout(req, res));
  if (req.method === 'GET' && pathname === '/api/me') return requireAuth(req, res, () => handleMe(req, res));
  if (req.method === 'GET' && pathname === '/api/data') return requireAuth(req, res, () => handleGetData(req, res));
  if (req.method === 'POST' && pathname === '/api/inbound') return requireAuth(req, res, () => handleInbound(req, res, body));
  if (req.method === 'POST' && pathname === '/api/outbound') return requireAuth(req, res, () => handleOutbound(req, res, body));
  if (req.method === 'POST' && pathname === '/api/import') return requireAuth(req, res, () => handleImport(req, res, body));
  if (req.method === 'POST' && pathname === '/api/reset') return requireAuth(req, res, () => handleReset(req, res), 'admin');

  send(res, 404, { error: 'Not Found' });
});

initData();
server.listen(PORT, HOST, () => {
  const ip = getLocalIP();
  console.log('========================================');
  console.log('  仓库看板多用户服务已启动 (多批次版)');
  console.log('========================================');
  console.log(`  本机访问:   http://localhost:${PORT}`);
  console.log(`  局域网访问: http://${ip}:${PORT}`);
  console.log(`  默认账号: admin / 123456`);
  console.log(`  每库位最多 ${MAX_BATCHES_PER_CELL} 个批次`);
  console.log('----------------------------------------');
  console.log('  按 Ctrl+C 停止服务');
  console.log('========================================');
});
