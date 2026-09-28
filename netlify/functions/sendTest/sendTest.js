/* Netlify Function: 测试邮件可达性（收件人测试邮箱）
 * 路由: /.netlify/functions/sendTest
 * POST -> { jobs: [{ name, niche, handle, testEmail, touch, account }] }
 *        把生产同款邀约邮件【只发往 testEmail】（绝不发真实红人邮箱），
 *        用于验证 Gmail 发信是否进垃圾箱。返回每封送达状态 + message-id。
 *
 * 扩展模式（虚拟红人·社媒分析触达）：
 *   POST -> { jobs: [{ link, testEmail, account, touches, name?, niche?, handle? }] }
 *         link 为红人社媒主页/帖子链接；函数服务端抓取页面（og:title/description/正文），
 *         推断垂类与 handle，生成引用该内容的 one-liner，复用同款 render() 渲染首触+跟进，
 *         并通过同一 Gmail 通道真实发出 touches 封（默认 3 = 首触+2跟进）。绝不发真实红人。
 *
 * 安全护栏：
 *   - GMAIL_SECRETS：JSON 映射 { "账号邮箱": "16位AppPassword" }，由 Netlify 环境变量注入（不入库）。
 *   - TEST_ALLOWED_DOMAINS（可选）：逗号分隔的域名白名单；设置后 testEmail 必须属于其中之一，
 *     即使被滥用也只会发到你自己的测试域名，不会发给第三方真实红人。
 *   - 单请求 jobs 上限 25，且只接受 testEmail，杜绝误发真实收件人。
 *   - CORS 放行（同源），OPTIONS 预检返回 204。
 */

const tls = require('tls');
const crypto = require('crypto');

// ===== 渲染配置（与 outreach.py 保持一致）=====
const BRAND = 'CheerAir';
const ASIN = 'B0GHKNZH44';
const BRAND_URL = 'https://www.amazon.com/CHEERAIR';

const ACCOUNTS = {
  '1': { email: 'yeriov.chen11@gmail.com', sender: 'Ulaa' },     // 首次冷触达人设
  '2': { email: 'jialicheer@gmail.com', sender: 'Govanda' },     // 联盟合作负责人
};
const DEFAULT_ACCOUNT = '1';

// 主题行池
const SUBJECT_DIR1 = [
  'The summer gadget your {Niche} audience will actually use',
  'a small thing your followers would genuinely reach for',
  'the one summer essential your audience is sleeping on',
  'a handheld fan your {Niche} audience will actually appreciate',
  'the little summer upgrade your followers keep overlooking',
];
const SUBJECT_DIR2 = [
  'Loved your recent {Niche} post — quick hello from a fan',
  'been a follower — quick hello, {First}',
  'your {Niche} content is why I’m reaching out, {First}',
];
const SUBJECT_DIR3 = [
  'Amazon creator collab — CheerAir × your {Niche} audience (no UGC needed)',
  'creator partnership — CheerAir × your {Niche} audience',
  'collaborate with CheerAir? your {Niche} audience is a fit',
];
const SUBJECT_FOLLOW = [
  'following up, {First}?',
  'quick nudge on the fan, {First}',
  'still happy to send that CheerAir fan, {First}?',
];

const TEMPLATE_V2_FIRST = `Hi {First},

Hope you're having a great week! I've been following your {Niche} content on @{Handle} for a while — watched through a good number of your posts, and the one that stuck with me: {OneLine}

I'm {Sender} from {Brand}, an Amazon brand. We make a handheld fan (ASIN: {ASIN}) — {Conn}. It only launched at the end of April this year, but it's already a fan favorite on Amazon — over 3,000 units sold monthly and shaping up to be one of 2026's breakout new products.

We'd love to create something great together. Interested in working with us? Simply reply "yes", and I'll send you the available products and collaboration details. Looking forward to working with you!

Best regards
{Sender}
{BrandURL}`;

const TEMPLATE_V2_FOLLOW = `Hi {First},

Hope you're having a good week — just circling back on my note about our handheld fan (ASIN: {ASIN}). No worries at all if the timing was off, but if you'd ever like to try it — we'd be glad to send one your way — just reply "yes" and I'll share the details.

Best regards
{Sender}
{BrandURL}`;

const ONE_LINERS = {
  'Mabell Media': 'your Spanish-language beauty tutorials are so engaging',
  '7 Days of Play': 'your family travel and parenting reels always feel relatable',
  'annnsvan': 'your cozy home decor transforms feel so inviting',
  'velush.aestetic': 'your aesthetic home setups are absolutely gorgeous',
  'Ozgetatli_': 'your lifestyle and beauty mix is so polished',
  'Rose Peixoto': 'your beauty-and-home content feels so warm and real',
  'HayleyLarue': 'your home and fashion finds are always on trend',
  'estcetera_': 'your beauty and fashion picks are so well curated',
  'markable.ai': "your no-fluff take on how creators actually get paid is exactly the kind of content we love",
  'Lolly Jane 𐙚 home decor': 'the way you layer a room with warmth and real-life detail is genuinely inspiring',
  'Mandy Starin✨': 'your bargain finds are the kind people screenshot and send to a friend',
  'jessica': 'your home content has that easy, unfiltered feel that’s hard to fake',
  'Lisa Chun': 'the way you make the most of every dollar and every square inch is genuinely clever',
  'Elnaz': 'how calm and satisfying you make the whole process look',
};

const CUSTOM_CONN = {
  'Mabell Media': 'the kind of small, genuinely useful thing your beauty audience would actually reach for on a hot day',
  '7 Days of Play': 'the kind of small, genuinely useful thing that earns a permanent spot in a busy family’s routine',
  'annnsvan': 'the kind of small, genuinely useful thing that makes a cozy home feel even more comfortable',
  'velush.aestetic': 'the kind of small, genuinely useful thing that fits right into a beautifully styled space',
  'Ozgetatli_': 'the kind of small, genuinely useful thing your lifestyle audience would actually carry with them',
  'Rose Peixoto': 'the kind of small, genuinely useful thing your beauty-and-home audience would genuinely love',
  'HayleyLarue': 'the kind of small, genuinely useful thing your home-and-fashion audience would actually reach for',
  'estcetera_': 'the kind of small, genuinely useful thing your beauty-and-fashion audience would actually use',
  'markable.ai': 'the kind of small, genuinely useful thing your creator audience would actually reach for on a hot day',
  'Lolly Jane 𐙚 home decor': 'the kind of small, genuinely useful thing that blends right into a beautifully styled room — until the day someone really needs it',
  'Mandy Starin✨': 'the kind of small, genuinely useful thing that makes a smart find feel even better',
  'jessica': 'the kind of small, genuinely useful thing your home audience would reach for the second it gets warm',
  'Lisa Chun': 'the kind of small, genuinely useful thing that earns its square inch in a well-planned home',
  'Elnaz': 'the kind of small, genuinely useful thing that fits right into a home you’ve just finished tidying',
};
const NICHE_CONN = {
  'beauty': 'the kind of small, genuinely useful thing your beauty audience would actually reach for on a hot day',
  'home': 'the kind of small, genuinely useful thing that makes a comfortable home even better',
  'home decor': 'the kind of small, genuinely useful thing that fits right into a home your audience is already styling',
  'home organizing': 'the kind of small, genuinely useful thing that slips neatly into a space you’ve just sorted out',
  'lifestyle': 'the kind of small, genuinely useful thing that quietly makes everyday life a bit more comfortable',
  'fashion': 'the kind of small, genuinely useful thing your fashion audience would actually carry with them',
  'travel': 'the kind of small, genuinely useful thing that earns a spot in your travel bag',
  'parenting': 'the kind of small, genuinely useful thing a busy parent would actually reach for',
};
const GENERIC_CONN = 'the kind of small, genuinely useful thing your audience would actually use';

// ===== 社媒链接分析（轻量 best-effort，用于虚拟红人测试）=====
const NICHE_KEYWORDS = {
  'beauty': ['beauty','makeup','skincare','cosmetic','glow','lipstick','foundation'],
  'home decor': ['home decor','interior','styling','aesthetic room','room decor'],
  'home': ['home','renovation','diy','furniture','house','apartment'],
  'home organizing': ['organize','declutter','storage','tidying'],
  'fashion': ['fashion','outfit','style','ootd','clothing','wardrobe'],
  'lifestyle': ['lifestyle','daily vlog','routine'],
  'travel': ['travel','trip','vacation','wanderlust','destination'],
  'parenting': ['parenting','mom','kids','baby','family','toddler'],
  'tech': ['tech','gadget','review','device','setup'],
  'fitness': ['fitness','workout','gym','health'],
  'food': ['food','recipe','cooking','meal','kitchen'],
};
function inferNiche(text) {
  text = (text || '').toLowerCase();
  // 命中即记录该垂类「最佳匹配关键词」的词数；返回最佳匹配词数最多的垂类（最具体者胜）
  let best = null, bestLen = 0;
  for (const k of Object.keys(NICHE_KEYWORDS)) {
    for (const kw of NICHE_KEYWORDS[k]) {
      if (text.includes(kw)) {
        const len = kw.split(' ').length;
        if (len > bestLen) { bestLen = len; best = k; }
        break; // 每个垂类取首个命中即可
      }
    }
  }
  return best;
}
function deriveHandleFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/@([A-Za-z0-9_.]+)/);
    if (m) return m[1];
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  } catch (e) {}
  return '';
}
function extractMeta(html, attr) {
  const re = new RegExp(`<meta[^>]+${attr}=["']([^"']+)["']`, 'i');
  const m = html.match(re);
  return m ? m[1] : '';
}
async function analyzeLink(link) {
  const out = { link, title: '', description: '', snippet: '', niche: null, handle: '', ok: false, note: '' };
  try {
    const ctrl = new AbortController();
    // ⚠️ Netlify 免费版函数总时限 10s：分析最多 4.5s，留足时间给 SMTP 发信
    const timer = setTimeout(() => ctrl.abort(), 4500);
    const resp = await fetch(link, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; CheerAirBot/1.0)' }, signal: ctrl.signal });
    clearTimeout(timer);
    const html = await resp.text();
    out.title = extractMeta(html, 'property="og:title"') || extractMeta(html, 'name="twitter:title"') || (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    out.description = extractMeta(html, 'property="og:description"') || extractMeta(html, 'name="description"') || '';
    const txt = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    out.snippet = txt.slice(0, 500);
    out.ok = true;
  } catch (e) {
    out.note = '链接抓取失败（' + e.message + '），已按 URL handle + 默认垂类生成';
  }
  out.niche = inferNiche(out.title + ' ' + out.description + ' ' + out.snippet);
  out.handle = deriveHandleFromUrl(link);
  return out;
}
function buildOneLine(analysis, name) {
  const niche = analysis.niche || 'creator';
  const seed = (analysis.title || analysis.description || '').trim();
  if (seed) return 'your recent ' + niche + ' post — "' + seed.slice(0, 80) + '" — really caught my eye';
  return 'your ' + niche + ' content is exactly our vibe';
}

// ===== 渲染辅助 =====
function md5hex(s) { return crypto.createHash('md5').update(String(s || ''), 'utf8').digest('hex'); }

function first_name(name) {
  const parts = String(name || '').split(/\s+/);
  const w = parts[0] || name || '';
  if (!w || !w[0] || !w[0].match(/[A-Za-z]/)) return name || '';
  if (parts.length === 1 && /^[A-Za-z]+$/.test(w) && w === w.toLowerCase()) return w[0].toUpperCase() + w.slice(1);
  return w;
}
function clean_niche(niche) { return String(niche || '').replace(/\//g, ', '); }

function dir_for(rec) {
  const h = md5hex(rec.name || rec.handle || '');
  return (parseInt(h.slice(0, 8), 16) % 3) + 1;
}
function subject_idx_for(rec) {
  const h = md5hex(rec.name || rec.handle || '');
  return parseInt(h.slice(8, 12), 16);
}
function conn_for(rec) {
  return CUSTOM_CONN[rec.name] || NICHE_CONN[(rec.niche || 'creator').toLowerCase()] || GENERIC_CONN;
}
function template_for_v2(touch) { return touch === 1 ? TEMPLATE_V2_FIRST : TEMPLATE_V2_FOLLOW; }
function subject_pool_for_v2(touch, direction) {
  if (touch > 1) return SUBJECT_FOLLOW;
  return { 1: SUBJECT_DIR1, 2: SUBJECT_DIR2, 3: SUBJECT_DIR3 }[direction] || SUBJECT_DIR1;
}
function fmt(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

function render(rec, touch, account_id, overrides) {
  overrides = overrides || {};
  const acct = ACCOUNTS[account_id] || ACCOUNTS[DEFAULT_ACCOUNT];
  const sender = acct.sender;
  const fn = first_name(rec.name);
  const niche = clean_niche(rec.niche || 'creator');
  const direction = dir_for(rec);
  const pool = subject_pool_for_v2(touch, direction);
  const subj = fmt(pool[subject_idx_for(rec) % pool.length], { First: fn, Handle: rec.handle, Niche: niche });
  const one = overrides.oneLine || ONE_LINERS[rec.name] || `your ${(rec.niche || 'creator')} content is exactly our vibe`;
  const conn = overrides.conn || conn_for(rec);
  const body = fmt(template_for_v2(touch), {
    First: fn, Handle: rec.handle, Niche: niche, OneLine: one,
    Sender: sender, Brand: BRAND, ASIN: ASIN, Conn: conn, BrandURL: BRAND_URL,
  });
  return { subj, body, sender };
}

// ===== RFC2047 编码（非 ASCII 的主题/发件名）=====
function encodeIfNeeded(s) {
  s = String(s == null ? '' : s);
  if (/^[\x20-\x7e]*$/.test(s)) return s; // 纯 ASCII 不编码
  const b64 = Buffer.from(s, 'utf8').toString('base64');
  return '=?UTF-8?B?' + b64 + '?=';
}

// ===== 纯 Node TLS SMTP 客户端（零依赖）=====
function smtpSend({ user, pass, to, subject, text, senderName }) {
  return new Promise((resolve, reject) => {
    // ⚠️ 10s 函数时限：单封 SMTP 上限 8.5s（Gmail 正常 1-3s 内完成，超时即失败不再拖）
    const socket = tls.connect(465, 'smtp.gmail.com', { timeout: 8500 }, () => {});
    let buf = '';
    let step = 0;
    let responded = false;
    let messageId = '<' + crypto.randomBytes(10).toString('hex') + '@msg.gmail.com>';
    const close = () => { try { socket.destroy(); } catch (e) {} };
    const fail = (err) => { if (!responded) { responded = true; close(); reject(err); } };
    const ok = (res) => { if (!responded) { responded = true; close(); resolve(res); } };

    socket.setEncoding('utf8');
    socket.on('error', (e) => fail(e));
    socket.on('timeout', () => fail(new Error('SMTP 连接超时（Gmail 8.5s 无响应）')));
    socket.on('close', () => { if (!responded) fail(new Error('SMTP 连接被关闭')); });

    const send = (cmd) => socket.write(cmd + '\r\n');
    const code = (line) => parseInt(line.slice(0, 3), 10);

    socket.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        // 只处理最终响应（第4字符为空格）；'-' 表示多行续接，忽略
        if (line.length >= 4 && line[3] === '-') continue;
        handle(line);
        if (responded) return;
      }
    });

    function handle(line) {
      const c = code(line);
      switch (step) {
        case 0:
          if (c !== 220) return fail(new Error('SMTP 握手失败: ' + line));
          send('EHLO cheerair-test.local'); step = 1; break;
        case 1:
          if (c !== 250) return fail(new Error('EHLO 失败: ' + line));
          send('AUTH LOGIN'); step = 2; break;
        case 2:
          if (c !== 334) return fail(new Error('AUTH 失败: ' + line));
          send(Buffer.from(user).toString('base64')); step = 3; break;
        case 3:
          if (c !== 334) return fail(new Error('AUTH 失败: ' + line));
          send(Buffer.from(pass).toString('base64')); step = 4; break;
        case 4:
          if (c !== 235) return fail(new Error('登录失败（App Password 错误或账号未开两步验证）: ' + line));
          send('MAIL FROM:<' + user + '>'); step = 5; break;
        case 5:
          if (c !== 250) return fail(new Error('MAIL FROM 失败: ' + line));
          send('RCPT TO:<' + to + '>'); step = 6; break;
        case 6:
          if (c !== 250) return fail(new Error('RCPT TO 失败（收件地址被拒）: ' + line));
          send('DATA'); step = 7; break;
        case 7:
          if (c !== 354) return fail(new Error('DATA 失败: ' + line));
          {
            // 正文按行处理：CRLF + 行首 '.' 转义
            const safeText = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
              .split('\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
            const msg = [
              'Message-ID: ' + messageId,
              'From: ' + encodeIfNeeded(senderName ? senderName + ' <' + user + '>' : user),
              'To: ' + to,
              'Subject: ' + encodeIfNeeded(subject),
              'Date: ' + new Date().toUTCString(),
              'MIME-Version: 1.0',
              'Content-Type: text/plain; charset=UTF-8',
              'Content-Transfer-Encoding: 8bit',
              '',
              safeText,
              '.',
            ].join('\r\n');
            send(msg); step = 8;
          }
          break;
        case 8:
          if (c !== 250) return fail(new Error('投递失败: ' + line));
          send('QUIT'); step = 9; break;
        case 9:
          ok({ messageId, final: line }); break;
        default:
          fail(new Error('未知 SMTP 步骤 ' + step + ': ' + line));
      }
    }
  });
}

// ===== 工具 =====
function cors(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Cache-Control': 'no-store',
  }, extra || {});
}
function getSecrets() {
  const raw = process.env.GMAIL_SECRETS;
  if (!raw) throw new Error('未配置环境变量 GMAIL_SECRETS（Netlify 后台 → Site settings → Environment variables）');
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error('GMAIL_SECRETS 不是合法 JSON'); }
  const out = {};
  for (const k of Object.keys(data)) out[k.trim().toLowerCase()] = String(data[k]).trim();
  if (!Object.keys(out).length) throw new Error('GMAIL_SECRETS 为空');
  return out;
}
function allowedDomains() {
  const raw = process.env.TEST_ALLOWED_DOMAINS || '';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// ===== 主入口 =====
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors({}) };

  let secrets;
  try { secrets = getSecrets(); }
  catch (e) {
    return { statusCode: 500, headers: cors({ 'content-type': 'application/json' }),
      body: JSON.stringify({ error: e.message }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors({ 'content-type': 'application/json' }),
      body: JSON.stringify({ error: 'method not allowed（仅支持 POST）' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors({ 'content-type': 'application/json' }), body: JSON.stringify({ error: 'bad json' }) }; }

  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  if (!jobs.length) return { statusCode: 400, headers: cors({ 'content-type': 'application/json' }), body: JSON.stringify({ error: 'jobs 为空' }) };
  if (jobs.length > 25) return { statusCode: 400, headers: cors({ 'content-type': 'application/json' }), body: JSON.stringify({ error: '单次最多 25 个测试目标（防滥用）' }) };

  const doms = allowedDomains();
  const results = [];

  for (const job of jobs) {
    const testEmail = String(job.testEmail || '').trim().toLowerCase();
    const account_id = String(job.account || DEFAULT_ACCOUNT) === '2' ? '2' : '1';

    if (!testEmail || !testEmail.includes('@')) { results.push({ name: job.name || '', testEmail, status: 'error', error: 'testEmail 无效（必须含 @）' }); continue; }
    if (doms.length && !doms.some((d) => testEmail.endsWith('@' + d) || testEmail.endsWith('.' + d))) {
      results.push({ name: job.name || '', testEmail, status: 'error', error: 'testEmail 域名不在白名单 TEST_ALLOWED_DOMAINS 内' }); continue;
    }

    // ---- 模式 A：社媒链接分析 + 多轮触达（虚拟红人）----
    if (job.link) {
      const analysis = await analyzeLink(String(job.link));
      const name = String(job.name || '').trim() || analysis.handle || analysis.title || 'Test Influencer';
      const niche = analysis.niche || String(job.niche || '').trim() || 'creator';
      const handle = analysis.handle || name;
      const oneLine = buildOneLine(analysis, name);
      const conn = NICHE_CONN[niche.toLowerCase()] || GENERIC_CONN;
      const touches = Math.max(1, Math.min(3, parseInt(job.touches, 10) || 3));
      // onlyTouch：前端逐轮分请求调用时指定单轮（规避 10s 函数时限），0 = 单请求连发全部
      const onlyTouch = Math.max(0, Math.min(3, parseInt(job.onlyTouch, 10) || 0));
      const tFrom = onlyTouch || 1;
      const tTo = onlyTouch || touches;
      const acct = ACCOUNTS[account_id];
      const pass = secrets[acct.email.toLowerCase()];
      if (!pass) { results.push({ name, testEmail, status: 'error', error: '账号 ' + acct.email + ' 未在 GMAIL_SECRETS 配置 App Password' }); continue; }
      const sentMails = [];
      let lastErr = '';
      const reqStart = Date.now();
      for (let t = tFrom; t <= tTo; t++) {
        // 10s 函数时限护栏：开始新一轮发送前若已超 8.5s，停止并如实回报 partial
        if (Date.now() - reqStart > 8500) { lastErr = '接近函数 10s 时限，本轮未尝试'; break; }
        const { subj, body: mailBody, sender } = render({ name, niche, handle }, t, account_id, { oneLine, conn });
        const banner = '[TEST MODE · 虚拟红人·社媒分析触达] 轮次 ' + t + '/' + touches + '。原定收件人：' + name + '（来自链接 ' + job.link + '）；实际发往测试箱 ' + testEmail + '。\n\n';
        try {
          const r = await smtpSend({ user: acct.email, pass, to: testEmail, subject: subj, text: banner + mailBody, senderName: sender });
          sentMails.push({ touch: t, subject: subj, messageId: r.messageId });
        } catch (e) { lastErr = e.message; break; }
        if (t < tTo && !onlyTouch) await new Promise((res) => setTimeout(res, 400)); // 连发模式下轮次间轻微间隔（单轮分请求时无需等待）
      }
      const touchedN = sentMails.length;
      if (touchedN > 0) {
        const attempted = tTo - tFrom + 1;
        results.push({
          name, testEmail, account: acct.email, mode: 'link-compose',
          niche: niche, handle: handle, link: job.link,
          analysisNote: analysis.note || ('已分析链接，标题：' + (analysis.title || analysis.description || '(无标题)').slice(0, 60)),
          touches: touchedN, sentMails: sentMails,
          status: touchedN === attempted ? 'sent' : 'partial', messageId: sentMails[0].messageId,
        });
      } else {
        results.push({ name, testEmail, account: acct.email, status: 'error', error: lastErr || '未知发送失败' });
      }
      continue;
    }

    // ---- 模式 B：原测试面板（手动填 niche/handle，单轮）----
    const name = String(job.name || '').trim();
    const touch = Math.max(1, Math.min(3, parseInt(job.touch, 10) || 1));
    const rec = { name, niche: job.niche || 'creator', handle: job.handle || name };
    if (!name) { results.push({ name: '', testEmail, status: 'error', error: '缺少 name' }); continue; }
    const acct = ACCOUNTS[account_id];
    const pass = secrets[acct.email.toLowerCase()];
    if (!pass) { results.push({ name, testEmail, status: 'error', error: '账号 ' + acct.email + ' 未在 GMAIL_SECRETS 配置 App Password' }); continue; }

    const { subj, body: mailBody, sender } = render(rec, touch, account_id);
    const banner = '[TEST MODE] 本邮件为测试件，原定收件人：' + name + '；实际已发往你的测试收件箱 ' + testEmail + '。\n\n';
    try {
      const r = await smtpSend({ user: acct.email, pass, to: testEmail, subject: subj, text: banner + mailBody, senderName: sender });
      results.push({ name, testEmail, account: acct.email, touch, subject: subj, status: 'sent', messageId: r.messageId });
    } catch (e) {
      results.push({ name, testEmail, account: acct.email, status: 'error', error: e.message });
    }
  }

  const sent = results.filter((r) => r.status === 'sent').length;
  const failed = results.length - sent;
  return {
    statusCode: 200,
    headers: cors({ 'content-type': 'application/json' }),
    body: JSON.stringify({ sent, failed, total: results.length, results }),
  };
};

// 导出供本地单元测试（不影响函数运行）
exports.render = render;
exports.analyzeLink = analyzeLink;
exports.inferNiche = inferNiche;
exports.deriveHandleFromUrl = deriveHandleFromUrl;
exports.buildOneLine = buildOneLine;
