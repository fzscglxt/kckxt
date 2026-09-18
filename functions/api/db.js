/**
 * 库存电子看板系统 - 云端数据同步 API (Cloudflare Pages Functions)
 *
 * 接口规范：
 *   GET  /api/db          → 拉取云端最新数据 { version, updatedAt, db }
 *   PUT  /api/db          → 推送本地数据到云端（带 If-Version 头做乐观锁）
 *   OPTIONS /api/db       → CORS 预检
 *
 * KV 存储：
 *   key: "inventory_data"
 *   value: { version: number, updatedAt: number, db: object, savedBy: string }
 *
 * 在 Cloudflare Pages 项目设置 → Functions → KV namespace bindings 中，
 * 绑定一个 KV 命名空间，变量名设为 FZ_INVENTORY_DB。
 */

const KV_KEY = 'inventory_data';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-Version',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}

async function readData(kv) {
  try {
    const raw = await kv.get(KV_KEY, 'json');
    if (raw && typeof raw === 'object') {
      return {
        version: typeof raw.version === 'number' ? raw.version : 0,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
        db: raw.db || null,
        savedBy: raw.savedBy || '',
      };
    }
  } catch (e) {
    console.error('KV read error:', e);
  }
  return { version: 0, updatedAt: 0, db: null, savedBy: '' };
}

async function writeData(kv, data) {
  await kv.put(KV_KEY, JSON.stringify(data));
}

export async function onRequestGet(context) {
  const kv = context.env.FZ_INVENTORY_DB;
  if (!kv) {
    return jsonResponse({ error: 'kv_not_bound', message: 'KV 命名空间 FZ_INVENTORY_DB 未绑定，请在 Pages 项目设置中配置' }, 500);
  }
  const data = await readData(kv);
  return jsonResponse({
    version: data.version,
    updatedAt: data.updatedAt,
    db: data.db,
  });
}

export async function onRequestPut(context) {
  const kv = context.env.FZ_INVENTORY_DB;
  if (!kv) {
    return jsonResponse({ error: 'kv_not_bound', message: 'KV 命名空间 FZ_INVENTORY_DB 未绑定，请在 Pages 项目设置中配置' }, 500);
  }

  const ifVersion = parseInt(context.request.headers.get('If-Version') || '0', 10) || 0;

  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return jsonResponse({ error: 'invalid_json', message: '请求体不是有效的 JSON' }, 400);
  }

  if (!body || !body.db) {
    return jsonResponse({ error: 'missing_db', message: '请求体缺少 db 字段' }, 400);
  }

  const current = await readData(kv);

  if (current.version > 0 && ifVersion !== current.version) {
    return jsonResponse({
      error: 'conflict',
      version: current.version,
      updatedAt: current.updatedAt,
      db: current.db,
    }, 409);
  }

  const newVersion = current.version + 1;
  const newUpdatedAt = Date.now();
  const newData = {
    version: newVersion,
    updatedAt: newUpdatedAt,
    db: body.db,
    savedBy: body.savedBy || '',
  };

  await writeData(kv, newData);

  return jsonResponse({
    version: newVersion,
    updatedAt: newUpdatedAt,
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
