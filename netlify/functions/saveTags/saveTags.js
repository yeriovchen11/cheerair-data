/* Netlify Function: 红人资源库云端存储（人工标注 + 机器外联状态 双域）
 * 路由: /.netlify/functions/saveTags
 *
 * 两个物理隔离的 Blob key，永不互相覆盖：
 *   overlay_v1 —— 人工标注（HUMAN_FIELDS：cat/coop/email/...），页面编辑实时推送
 *   mstate_v1  —— 机器外联状态（outreach: {mcat, followups, updated}），
 *                 由 writeback_library.py 每日推送，取代「每日重新部署」。
 *
 * GET  -> { version, entries, updated, mstate, mupdated }
 * POST -> { entries } 走 overlay_v1；{ mstate } 走 mstate_v1；可同时带。
 *         均按 uid 逐条字段合并（last-write-wins per field），不整体覆盖。
 *
 * 可选加固：环境变量 MSTATE_TOKEN 若设置，则写 mstate 必须带
 *           x-mstate-token 头且值匹配；未设置则不校验（零配置可用）。
 */
const STORE = 'cheerair-overlay';
const KEY = 'overlay_v1';
const MKEY = 'mstate_v1';
// 站点标识（公开，无敏感信息）；token 为服务端回退凭证（仅函数内使用，不暴露给浏览器）
const SITE_ID = '3e84c9d9-fec3-4d64-8fb8-a246a5330f6d';
const FALLBACK_TOKEN = 'nfp_tRvn3hqg2VFbZgj5LHYHaMwAaHAUzoCS8888';

function cors(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-mstate-token',
    'Cache-Control': 'no-store'
  }, extra || {});
}

function blobCtx() {
  try { return JSON.parse(process.env.NETLIFY_BLOBS_CONTEXT || '{}'); }
  catch (e) { return {}; }
}

// 手动 store（当 context 以 env 提供但未注入全局时，用 Netlify Blobs HTTP API）
function makeManualStore(base, siteID, token) {
  return {
    async get(k, opts) {
      const r = await fetch(`${base}/blobs/${siteID}/${STORE}/${k}`, {
        headers: { authorization: 'Bearer ' + token }
      });
      if (r.status === 404) return undefined;
      if (!r.ok) throw new Error('blob get ' + r.status);
      return (opts && opts.type === 'json') ? await r.json() : await r.text();
    },
    async set(k, v) {
      const r = await fetch(`${base}/blobs/${siteID}/${STORE}/${k}`, {
        method: 'PUT',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: v
      });
      if (!r.ok) throw new Error('blob set ' + r.status);
    }
  };
}

// 获取 blob store：优先运行时全局 NetlifyBlobs（自动带上下文），其次显式 context 兜底
function getStoreSafe() {
  // 1) Netlify Functions 运行时自带全局 NetlifyBlobs（最稳，无需显式 context）
  if (typeof NetlifyBlobs !== 'undefined' && NetlifyBlobs.getStore) {
    try { return NetlifyBlobs.getStore({ name: STORE, consistency: 'strong' }); }
    catch (e) { /* 退回下一方案 */ }
  }
  // 2) 运行时注入的 context（NETLIFY_BLOBS_CONTEXT）或硬编码回退（服务端，不暴露浏览器）
  const c = blobCtx();
  const siteID = c.siteID || SITE_ID;
  const token = c.token || FALLBACK_TOKEN;
  const apiURL = (c.apiURL || 'https://api.netlify.com/api/v1').replace(/\/$/, '');
  if (siteID && token && token.indexOf('__INJECT') === -1) {
    try {
      const { getStore } = require('@netlify/blobs');
      return getStore({ name: STORE, consistency: 'strong', siteID: siteID, token: token, apiURL: apiURL });
    } catch (e) { /* 退回手动 API */ }
    return makeManualStore(apiURL, siteID, token);
  }
  throw new Error('no blobs context available (NetlifyBlobs global missing and no fallback token)');
}

// 简单内存锁，避免同一实例并发读改写丢更新
let _busy = Promise.resolve();
function withLock(fn) {
  const next = _busy.then(fn, fn);
  _busy = next.catch(function () {});
  return next;
}

// 读-改-写：按 uid 逐字段合并进指定 blob key，返回合并条数。
// 两个域（overlay_v1 / mstate_v1）各存各的 key，物理隔离，互不覆盖。
async function mergeInto(store, key, incoming) {
  let cur = { version: 1, entries: {}, updated: 0 };
  try {
    const raw = await store.get(key, { type: 'json' });
    if (raw && raw.entries) cur = raw;
  } catch (e) { /* 首次写入，保持空 */ }
  const keys = Object.keys(incoming);
  for (const k of keys) {
    const patch = incoming[k];
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
    const base = (cur.entries[k] && typeof cur.entries[k] === 'object') ? cur.entries[k] : {};
    for (const f of Object.keys(patch)) base[f] = patch[f];
    cur.entries[k] = base;
  }
  cur.updated = Date.now();
  await store.set(key, JSON.stringify(cur));
  return keys.length;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors({}) };
  }

  let store;
  try { store = getStoreSafe(); }
  catch (e) {
    return { statusCode: 500, headers: cors({ 'content-type': 'application/json' }),
      body: JSON.stringify({ error: 'blob store init failed: ' + e.message }) };
  }

  if (event.httpMethod === 'GET') {
    let data = { version: 1, entries: {}, updated: 0 };
    try {
      const raw = await store.get(KEY, { type: 'json' });
      if (raw && raw.entries) data = raw;
    } catch (e) { /* empty */ }
    // 机器外联状态（缺失不影响人工标注，静默返回空）
    let mstate = {};
    let mupdated = 0;
    try {
      const raw = await store.get(MKEY, { type: 'json' });
      if (raw && raw.entries) { mstate = raw.entries; mupdated = raw.updated || 0; }
    } catch (e) { /* empty */ }
    return { statusCode: 200, headers: cors({ 'content-type': 'application/json' }),
      body: JSON.stringify({ version: data.version || 1, entries: data.entries || {},
        updated: data.updated || 0, mstate: mstate, mupdated: mupdated }) };
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (e) {
      return { statusCode: 400, headers: cors({ 'content-type': 'application/json' }),
        body: JSON.stringify({ error: 'bad json' }) };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { statusCode: 400, headers: cors({ 'content-type': 'application/json' }),
        body: JSON.stringify({ error: 'body must be a json object' }) };
    }

    const hasHuman = body.entries || body.overlay;
    const hasMachine = body.mstate;
    // legacy 兼容：没有已知顶层键的裸 {uid:{...}} 视为人工标注
    const legacyHuman = (!hasHuman && !hasMachine) ? body : null;
    const incomingHuman = hasHuman || legacyHuman;
    const incomingMachine = hasMachine;

    if (!incomingHuman && !incomingMachine) {
      return { statusCode: 400, headers: cors({ 'content-type': 'application/json' }),
        body: JSON.stringify({ error: 'missing entries/mstate' }) };
    }
    if (incomingHuman && typeof incomingHuman !== 'object') {
      return { statusCode: 400, headers: cors({ 'content-type': 'application/json' }),
        body: JSON.stringify({ error: 'entries must be an object' }) };
    }
    if (incomingMachine && typeof incomingMachine !== 'object') {
      return { statusCode: 400, headers: cors({ 'content-type': 'application/json' }),
        body: JSON.stringify({ error: 'mstate must be an object' }) };
    }

    // 可选加固：设了 MSTATE_TOKEN 才校验写机器状态的头
    if (incomingMachine) {
      const need = process.env.MSTATE_TOKEN;
      if (need) {
        const h = event.headers || {};
        const got = h['x-mstate-token'] || h['X-Mstate-Token'] || '';
        if (got !== need) {
          return { statusCode: 401, headers: cors({ 'content-type': 'application/json' }),
            body: JSON.stringify({ error: 'bad mstate token' }) };
        }
      }
    }

    // 读-改-写，逐 uid 合并（仅合并存在的字段，不整体覆盖）
    let nHuman = 0, nMachine = 0;
    try {
      await withLock(async function () {
        if (incomingHuman) nHuman = await mergeInto(store, KEY, incomingHuman);
        if (incomingMachine) nMachine = await mergeInto(store, MKEY, incomingMachine);
      });
    } catch (e) {
      return { statusCode: 500, headers: cors({ 'content-type': 'application/json' }),
        body: JSON.stringify({ error: 'store set failed: ' + e.message }) };
    }
    return { statusCode: 200, headers: cors({ 'content-type': 'application/json' }),
      body: JSON.stringify({ ok: true, keys: nHuman, mkeys: nMachine }) };
  }

  return { statusCode: 405, headers: cors({ 'content-type': 'application/json' }),
    body: JSON.stringify({ error: 'method not allowed' }) };
};
