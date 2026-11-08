'use strict';
/*
 * 百亿补贴 · API 路由中心 —— 纯 Node.js 后端（零第三方依赖）
 * 运行：node server.js   默认端口 3000
 * 数据落盘：data/routes.json、data/accounts.json
 *
 * 登录方式：
 *   1. 账号密码登录（服务端 scrypt 加盐校验，签发会话 Token）
 *   2. 邮箱验证码登录（QQ 邮箱 SMTP 发送 6 位验证码，零依赖手写 SMTP 客户端）
 *   3. 第三方 OAuth2 登录（GitHub / 微信 / Google），在环境变量配置
 *      client_id / secret 后走真实授权码流程；未配置时使用内置演示
 *      身份完成完整登录闭环，便于本地与演示环境联调。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const os = require('os');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'routes.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const MAIL_CONFIG_FILE = path.join(DATA_DIR, 'mail-config.json');
const LEGACY_ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12h
const OAUTH_STATE_TTL = 10 * 60 * 1000;

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const STATUSES = ['online', 'offline', 'deprecated'];

/* ------------------------------ 账号与持久化 ------------------------------ */

function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}

function verifyPassword(user, pw) {
  if (!user || !user.hash) return false;
  const hash = hashPassword(pw, user.salt);
  const a = Buffer.from(hash);
  const b = Buffer.from(user.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function seedAdminUser() {
  const user = process.env.ADMIN_USER || 'hub_ops';
  const pass = process.env.ADMIN_PASS || 'K7xQ-2mW9-Pz41';
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    id: 'u_' + crypto.randomBytes(6).toString('hex'),
    username: user,
    displayName: user,
    email: '',
    salt,
    hash: hashPassword(pass, salt),
    role: 'admin',
    providers: {},
    createdAt: new Date().toISOString()
  };
}

function seedRoutes() {
  const now = '2026-11-01T09:00:00.000Z';
  const mk = (id, name, model, vendor, path, group, desc, opts) => Object.assign({
    id, name, model, vendor, path, group,
    description: desc,
    version: 'v1',
    baseUrl: 'https://api.baiyi.example.com',
    rateLimit: 1000,
    authRequired: true,
    status: 'online',
    calls: 0,
    latency: 42,
    context: 0,
    priceIn: 0,
    priceOut: 0,
    balance: 0,
    tags: [],
    createdAt: now,
    updatedAt: now
  }, opts || {});

  return [
    /* 对话补全 */
    mk('r_2001', 'GPT-4o', 'gpt-4o', 'OpenAI', '/v1/chat/completions', '对话补全', '多模态旗舰模型，支持文本、图像与工具调用，适合复杂推理与生产场景。', { context: 128000, priceIn: 18, priceOut: 72, balance: 128000, calls: 482130, latency: 68, tags: ['多模态', '旗舰'] }),
    mk('r_2002', 'GPT-4o Mini', 'gpt-4o-mini', 'OpenAI', '/v1/chat/completions', '对话补全', '轻量高性价比模型，速度快、成本低，适合日常对话与分类抽取任务。', { context: 128000, priceIn: 1.2, priceOut: 4.8, balance: 320000, calls: 921450, latency: 32, tags: ['轻量', '高性价比'] }),
    mk('r_2003', 'o1 Preview', 'o1-preview', 'OpenAI', '/v1/responses', '对话补全', '深度推理模型，擅长数学、代码与科学推理，响应耗时较长。', { context: 200000, priceIn: 60, priceOut: 240, balance: 42000, calls: 38420, latency: 210, tags: ['推理', '代码'] }),
    mk('r_2004', 'Claude 3.5 Sonnet', 'claude-3.5-sonnet', 'Anthropic', '/v1/messages', '对话补全', '平衡能力与速度的旗舰模型，长文写作、代码与分析表现优异。', { context: 200000, priceIn: 22, priceOut: 110, balance: 86000, calls: 267840, latency: 84, tags: ['长文', '代码'] }),
    mk('r_2005', 'Claude 3 Haiku', 'claude-3-haiku', 'Anthropic', '/v1/messages', '对话补全', 'Anthropic 轻量模型，低延迟、低成本，适合高并发在线场景。', { context: 200000, priceIn: 3, priceOut: 15, balance: 210000, calls: 158230, latency: 41, tags: ['轻量'] }),
    mk('r_2006', 'Gemini 1.5 Pro', 'gemini-1.5-pro', 'Google', '/v1beta/models/gemini-1.5-pro:generateContent', '对话补全', '百万级上下文多模态模型，适合长文档、音视频理解与复杂规划。', { context: 1000000, priceIn: 24, priceOut: 96, balance: 64000, calls: 96740, latency: 92, tags: ['超长上下文', '多模态'] }),
    mk('r_2007', 'Gemini 1.5 Flash', 'gemini-1.5-flash', 'Google', '/v1beta/models/gemini-1.5-flash:generateContent', '对话补全', '高速轻量多模态模型，极低延迟，适合批量处理与实时交互。', { context: 1000000, priceIn: 0.8, priceOut: 3.2, balance: 280000, calls: 312560, latency: 28, tags: ['轻量', '高速'] }),
    mk('r_2008', 'DeepSeek Chat', 'deepseek-chat', 'DeepSeek', '/v1/chat/completions', '对话补全', '通用对话模型，价格低廉，中文表现优秀，适合客服与内容生成。', { context: 64000, priceIn: 1, priceOut: 2, balance: 196000, calls: 204380, latency: 45, tags: ['中文', '低价'] }),
    mk('r_2009', 'DeepSeek Reasoner', 'deepseek-reasoner', 'DeepSeek', '/v1/chat/completions', '对话补全', '带思维链的推理模型，擅长数学、逻辑与代码调试。', { context: 64000, priceIn: 4, priceOut: 16, balance: 78000, calls: 76210, latency: 130, tags: ['推理', '代码'] }),
    mk('r_2010', 'Qwen Max', 'qwen-max', '阿里通义', '/v1/chat/completions', '对话补全', '通义千问旗舰模型，中文理解与生成能力突出，支持插件调用。', { context: 32000, priceIn: 20, priceOut: 60, balance: 52000, calls: 118450, latency: 71, tags: ['中文', '旗舰'] }),
    mk('r_2011', 'Doubao Pro 32k', 'doubao-pro-32k', '字节豆包', '/v1/chat/completions', '对话补全', '豆包 Pro 对话模型，当前渠道维护中，暂不可用。', { context: 32000, priceIn: 8, priceOut: 20, balance: 12000, calls: 64320, latency: 88, status: 'offline', tags: ['中文'] }),
    mk('r_2012', 'Claude 2.1', 'claude-2.1', 'Anthropic', '/v1/messages', '对话补全', '旧版模型，已被 3.x 系列替代，仅保留兼容旧应用调用。', { context: 100000, priceIn: 11, priceOut: 32, balance: 3000, calls: 12040, latency: 96, status: 'deprecated', tags: ['旧版', '兼容'] }),

    /* 图像生成 */
    mk('r_2013', 'DALL·E 3', 'dall-e-3', 'OpenAI', '/v1/images/generations', '图像生成', '文本生成图像，支持高清构图与文字渲染，按张计费。', { priceIn: 0, priceOut: 0, balance: 26000, calls: 41280, latency: 240, tags: ['文生图', '按张计费'] }),
    mk('r_2014', 'Stable Diffusion XL', 'stable-diffusion-xl', 'Stability', '/v1/images/generations', '图像生成', '开源文生图模型，风格可控、可本地部署，按张计费。', { priceIn: 0, priceOut: 0, balance: 18000, calls: 28760, latency: 310, tags: ['文生图', '开源'] }),

    /* 向量嵌入 */
    mk('r_2015', 'Text Embedding 3 Large', 'text-embedding-3-large', 'OpenAI', '/v1/embeddings', '向量嵌入', '高维度文本向量模型，用于语义检索、RAG 与聚类，按 token 计费。', { context: 8191, priceIn: 0.13, priceOut: 0, balance: 410000, calls: 521900, latency: 22, tags: ['RAG', '检索'] }),
    mk('r_2016', 'BGE Large 中文', 'bge-large-zh', '智谱 AI', '/v1/embeddings', '向量嵌入', '中文向量嵌入模型，检索效果好，部署成本低，按 token 计费。', { context: 512, priceIn: 0.05, priceOut: 0, balance: 260000, calls: 187430, latency: 19, tags: ['中文', 'RAG'] }),

    /* 语音服务 */
    mk('r_2017', 'Whisper 1', 'whisper-1', 'OpenAI', '/v1/audio/transcriptions', '语音服务', '语音转文字模型，支持多语言识别与时间戳返回，按音频分钟计费。', { priceIn: 0, priceOut: 0, balance: 34000, calls: 36820, latency: 150, tags: ['ASR', '语音转写'] }),
    mk('r_2018', 'Text Davinci 003', 'text-davinci-003', 'OpenAI', '/v1/completions', '对话补全', '旧版补全模型，已停止新用户开通，保留历史兼容。', { context: 4096, priceIn: 20, priceOut: 20, balance: 2000, calls: 8930, latency: 70, status: 'offline', tags: ['旧版', '兼容'] })
  ];
}

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(seedRoutes(), null, 2));
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    let users = [];
    // 兼容旧版单管理员文件
    if (fs.existsSync(LEGACY_ADMIN_FILE)) {
      try {
        const old = JSON.parse(fs.readFileSync(LEGACY_ADMIN_FILE, 'utf8'));
        users.push({
          id: 'u_' + crypto.randomBytes(6).toString('hex'),
          username: old.username,
          displayName: old.username,
          salt: old.salt,
          hash: old.hash,
          role: 'admin',
          providers: {},
          createdAt: new Date().toISOString()
        });
      } catch { users = []; }
    }
    if (!users.length) users.push(seedAdminUser());
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ users }, null, 2));
  }
}

function loadRoutes() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function saveRoutes(list) { fs.writeFileSync(DB_FILE, JSON.stringify(list, null, 2)); }
function loadAccounts() { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); }
function saveAccounts(acc) { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(acc, null, 2)); }

/* ------------------------------ 邮件（QQ SMTP，零依赖） ------------------------------ */

function loadMailConfig() {
  let fileCfg = {};
  try { fileCfg = JSON.parse(fs.readFileSync(MAIL_CONFIG_FILE, 'utf8')); } catch { /* 未配置时走环境变量 */ }
  return {
    host: process.env.SMTP_HOST || fileCfg.host || 'smtp.qq.com',
    port: Number(process.env.SMTP_PORT || fileCfg.port || 465),
    user: process.env.MAIL_USER || fileCfg.user || '729594565@qq.com',
    pass: process.env.MAIL_CODE || fileCfg.pass || ''
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function b64(str) { return Buffer.from(String(str), 'utf8').toString('base64'); }

function buildMailMessage(to, subject, text, fromUser) {
  const headers = [
    `From: =?UTF-8?B?${b64('百亿补贴')}?= <${fromUser}>`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text)
  ];
  return headers.join('\r\n') + '\r\n.';
}

function sendMail({ to, subject, text }) {
  const cfg = loadMailConfig();
  if (!cfg.pass) return Promise.reject(new Error('邮件服务未配置授权码'));
  return new Promise((resolve, reject) => {
    const sock = tls.connect(cfg.port, cfg.host, { servername: cfg.host });
    sock.setEncoding('utf8');
    let buffer = '';
    let stage = -1; // -1：等待 220 问候
    let settled = false;
    const hello = os.hostname() || 'localhost';

    const commands = [
      { cmd: `EHLO ${hello}`, expect: 250 },
      { cmd: 'AUTH LOGIN', expect: 334 },
      { cmd: b64(cfg.user), expect: 334 },
      { cmd: b64(cfg.pass), expect: 235 },
      { cmd: `MAIL FROM:<${cfg.user}>`, expect: 250 },
      { cmd: `RCPT TO:<${to}>`, expect: 250 },
      { cmd: 'DATA', expect: 354 },
      { cmd: buildMailMessage(to, subject, text, cfg.user), expect: 250 },
      { cmd: 'QUIT', expect: null }
    ];

    function cleanup() { try { sock.end(); } catch { /* ignore */ } }
    function fail(err) { if (settled) return; settled = true; cleanup(); reject(err); }
    function done() { if (settled) return; settled = true; cleanup(); resolve(); }

    sock.on('error', fail);
    sock.on('close', () => { if (!settled) fail(new Error('SMTP 连接已关闭')); });
    sock.setTimeout(15000, () => fail(new Error('SMTP 连接超时')));

    sock.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\r\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const code = Number(line.slice(0, 3));
        const sep = line[3]; // '-' 表示多行响应续行，空格表示响应结束
        if (stage === -1) {
          if (sep === ' ') {
            if (code === 220) { stage = 0; sock.write(commands[0].cmd + '\r\n'); }
            else return fail(new Error('SMTP 问候异常: ' + line));
          }
          continue;
        }
        const cmd = commands[stage];
        if (!cmd || sep === '-') continue;
        if (cmd.expect && code !== cmd.expect) {
          return fail(new Error(`SMTP 命令被拒 (${cmd.cmd.slice(0, 24)}): ${line}`));
        }
        stage++;
        if (stage >= commands.length) return done();
        sock.write(commands[stage].cmd + '\r\n');
      }
    });
  });
}

/* 邮箱验证码：email -> { code, exp, attempts, nextAllowed } */
const emailCodes = new Map();
const CODE_TTL = 10 * 60 * 1000;
const CODE_RESEND = 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;

function newCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

/* ------------------------------ 第三方 OAuth 配置 ------------------------------ */

const OAUTH_PROVIDERS = {
  github: {
    label: 'GitHub',
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    profile: 'https://api.github.com/user',
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    scope: 'read:user',
    uid: (u) => u.id,
    name: (u) => u.name || u.login,
    email: (u) => u.email || ''
  },
  wechat: {
    label: '微信',
    authorize: 'https://open.weixin.qq.com/connect/qrconnect',
    token: 'https://api.weixin.qq.com/sns/oauth2/access_token',
    profile: 'https://api.weixin.qq.com/sns/userinfo',
    clientId: process.env.WECHAT_APP_ID || '',
    clientSecret: process.env.WECHAT_APP_SECRET || '',
    scope: 'snsapi_login',
    uid: (u) => u.openid,
    name: (u) => u.nickname,
    email: () => ''
  },
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    profile: 'https://www.googleapis.com/oauth2/v3/userinfo',
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    scope: 'openid profile email',
    uid: (u) => u.sub,
    name: (u) => u.name,
    email: (u) => u.email || ''
  }
};

// 未配置真实应用时的演示身份（结构与真实回调一致，服务端签发会话）
const DEMO_PROFILES = {
  github: { uid: 'demo-gh-001', name: 'GitHub 演示用户', email: 'demo@github.example' },
  wechat: { uid: 'demo-wx-001', name: '微信演示用户', email: '' },
  google: { uid: 'demo-goog-001', name: 'Google 演示用户', email: 'demo@gmail.example' }
};

const oauthStates = new Map();   // state -> { provider, exp }
const oauthCodes = new Map();    // 演示模式一次性 code -> { provider, profile, exp }

function sweepExpired(map) {
  const now = Date.now();
  for (const [k, v] of map) if (v.exp < now) map.delete(k);
}

async function exchangeCode(provider, code, redirectUri) {
  const cfg = OAUTH_PROVIDERS[provider];
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: redirectUri
  });
  const res = await fetch(cfg.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('授权码交换失败');
  return data.access_token;
}

async function fetchProfile(provider, accessToken) {
  const cfg = OAUTH_PROVIDERS[provider];
  const res = await fetch(cfg.profile, {
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Accept': 'application/json', 'User-Agent': 'baiyi-api-center' }
  });
  if (!res.ok) throw new Error('获取第三方用户信息失败');
  const u = await res.json();
  return { uid: String(cfg.uid(u)), name: cfg.name(u) || provider, email: cfg.email(u) || '' };
}

function findOrCreateByProvider(provider, profile) {
  const acc = loadAccounts();
  let user = acc.users.find((u) => u.providers && u.providers[provider] && u.providers[provider].uid === profile.uid);
  if (!user) {
    user = {
      id: 'u_' + crypto.randomBytes(6).toString('hex'),
      username: 'oauth_' + String(profile.uid).slice(-8),
      displayName: profile.name,
      email: profile.email || '',
      salt: crypto.randomBytes(16).toString('hex'),
      hash: '',
      role: 'member',
      providers: { [provider]: { uid: profile.uid, name: profile.name, email: profile.email } },
      createdAt: new Date().toISOString()
    };
    acc.users.push(user);
    saveAccounts(acc);
  }
  return user;
}

/* ------------------------------ 会话管理 ------------------------------ */

const sessions = new Map(); // token -> { accountId, username, displayName, provider, role, exp }

function issueToken(user, provider) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, {
    accountId: user.id,
    username: user.username,
    displayName: user.displayName,
    provider: provider || 'password',
    role: user.role,
    email: user.email || '',
    exp: Date.now() + SESSION_TTL
  });
  return token;
}

function resolveAuth(req) {
  const header = req.headers['authorization'] || '';
  const m = /^Bearer\s+([a-f0-9]+)$/i.exec(header.trim());
  if (!m) return null;
  const sess = sessions.get(m[1]);
  if (!sess) return null;
  if (sess.exp < Date.now()) { sessions.delete(m[1]); return null; }
  return { token: m[1], ...sess };
}

/* ------------------------------ HTTP 工具 ------------------------------ */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function originOf(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

function redirectToCallback(res, origin, hash) {
  const dest = new URL('/oauth-callback.html', origin);
  dest.hash = hash;
  res.writeHead(302, { Location: dest.toString() });
  res.end();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel).replace(/\\/g, '/');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ------------------------------ 校验与业务 ------------------------------ */

function cleanRoute(body, existing) {
  const errors = [];
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

  const name = str(body.name, 40);
  const routePath = str(body.path, 120);
  const method = String(body.method || '').toUpperCase();
  const group = str(body.group, 20);

  if (!name) errors.push('模型名称不能为空');
  if (!routePath) errors.push('接入路径不能为空');
  else if (!routePath.startsWith('/')) errors.push('路径必须以 / 开头');
  if (!METHODS.includes(method)) errors.push('请求方法不合法');
  if (!group) errors.push('渠道分组不能为空');

  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
  };
  const dec = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : fallback;
  };

  const tags = Array.isArray(body.tags)
    ? body.tags.map((t) => str(t, 16)).filter(Boolean).slice(0, 8)
    : [];

  return {
    errors,
    data: {
      name,
      model: str(body.model, 60),
      vendor: str(body.vendor, 30),
      path: routePath,
      method,
      group,
      description: str(body.description, 300),
      version: str(body.version, 12) || 'v1',
      baseUrl: str(body.baseUrl, 200) || 'https://api.baiyi.example.com',
      rateLimit: num(body.rateLimit, 1000),
      authRequired: Boolean(body.authRequired),
      status: STATUSES.includes(body.status) ? body.status : 'online',
      latency: existing ? existing.latency : num(body.latency, 40),
      calls: existing ? existing.calls : num(body.calls, 0),
      context: num(body.context, 0),
      priceIn: dec(body.priceIn, 0),
      priceOut: dec(body.priceOut, 0),
      balance: num(body.balance, existing ? existing.balance : 0),
      tags
    }
  };
}

function applyFilters(list, q, method, group, status) {
  let out = list;
  if (q) {
    const kw = q.toLowerCase();
    out = out.filter((r) =>
      r.name.toLowerCase().includes(kw) ||
      (r.model || '').toLowerCase().includes(kw) ||
      (r.vendor || '').toLowerCase().includes(kw) ||
      r.path.toLowerCase().includes(kw) ||
      r.description.toLowerCase().includes(kw) ||
      r.tags.some((t) => t.toLowerCase().includes(kw))
    );
  }
  if (method) out = out.filter((r) => r.method === method);
  if (group) out = out.filter((r) => r.group === group);
  if (status) out = out.filter((r) => r.status === status);
  return out;
}

function computeStats(list) {
  const total = list.length;
  const byStatus = STATUSES.reduce((acc, s) => (acc[s] = list.filter((r) => r.status === s).length, acc), {});
  const totalCalls = list.reduce((s, r) => s + r.calls, 0);
  const avgLatency = total ? Math.round(list.reduce((s, r) => s + r.latency, 0) / total) : 0;
  const groups = [...new Set(list.map((r) => r.group))];
  const vendors = [...new Set(list.map((r) => r.vendor).filter(Boolean))];
  const recent = [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  return { total, ...byStatus, totalCalls, avgLatency, groupCount: groups.length, vendorCount: vendors.length, recent };
}

/* ------------------------------ 路由分发 ------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p.startsWith('/api/')) {
      /* ---- 健康检查 ---- */
      if (p === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, name: '百亿补贴 · API 路由中心', time: new Date().toISOString() });
      }

      /* ---- 第三方登录：提供商列表 ---- */
      if (p === '/api/oauth/providers' && req.method === 'GET') {
        const providers = Object.keys(OAUTH_PROVIDERS).map((k) => ({
          id: k,
          label: OAUTH_PROVIDERS[k].label,
          configured: Boolean(OAUTH_PROVIDERS[k].clientId)
        }));
        return sendJson(res, 200, { providers });
      }

      /* ---- 第三方登录：发起授权 ---- */
      const startMatch = /^\/api\/oauth\/([a-z]+)\/start$/.exec(p);
      if (startMatch && req.method === 'GET') {
        const provider = startMatch[1];
        if (!OAUTH_PROVIDERS[provider]) return sendJson(res, 404, { error: '不支持的登录渠道' });
        sweepExpired(oauthStates);
        sweepExpired(oauthCodes);

        const state = crypto.randomBytes(16).toString('hex');
        const origin = originOf(req);
        const redirectUri = `${origin}/api/oauth/${provider}/callback`;
        oauthStates.set(state, { provider, exp: Date.now() + OAUTH_STATE_TTL });
        const cfg = OAUTH_PROVIDERS[provider];

        if (cfg.clientId) {
          const authUrl = new URL(cfg.authorize);
          authUrl.searchParams.set('client_id', cfg.clientId);
          authUrl.searchParams.set('redirect_uri', redirectUri);
          authUrl.searchParams.set('scope', cfg.scope);
          authUrl.searchParams.set('state', state);
          res.writeHead(302, { Location: authUrl.toString() });
          return res.end();
        }

        // 演示模式：服务端生成一次性授权码，直接跳回回调地址
        const code = crypto.randomBytes(16).toString('hex');
        oauthCodes.set(code, { provider, profile: DEMO_PROFILES[provider], exp: Date.now() + OAUTH_STATE_TTL });
        const cb = new URL(redirectUri);
        cb.searchParams.set('code', code);
        cb.searchParams.set('state', state);
        res.writeHead(302, { Location: cb.toString() });
        return res.end();
      }

      /* ---- 第三方登录：回调 ---- */
      const cbMatch = /^\/api\/oauth\/([a-z]+)\/callback$/.exec(p);
      if (cbMatch && req.method === 'GET') {
        const provider = cbMatch[1];
        const origin = originOf(req);
        if (!OAUTH_PROVIDERS[provider]) return sendJson(res, 404, { error: '不支持的登录渠道' });

        const state = url.searchParams.get('state') || '';
        const code = url.searchParams.get('code') || '';
        const st = oauthStates.get(state);
        if (!st || st.exp < Date.now() || st.provider !== provider) {
          return redirectToCallback(res, origin, 'error=' + encodeURIComponent('登录状态已过期，请重试'));
        }
        oauthStates.delete(state);

        let profile;
        const cfg = OAUTH_PROVIDERS[provider];
        try {
          if (cfg.clientId) {
            const redirectUri = `${origin}/api/oauth/${provider}/callback`;
            const accessToken = await exchangeCode(provider, code, redirectUri);
            profile = await fetchProfile(provider, accessToken);
          } else {
            const dc = oauthCodes.get(code);
            if (!dc || dc.exp < Date.now()) {
              return redirectToCallback(res, origin, 'error=' + encodeURIComponent('授权码无效或已过期'));
            }
            oauthCodes.delete(code);
            profile = dc.profile;
          }
        } catch (err) {
          return redirectToCallback(res, origin, 'error=' + encodeURIComponent('第三方登录失败：' + (err.message || '请稍后重试')));
        }

        const account = findOrCreateByProvider(provider, profile);
        const token = issueToken(account, provider);
        return redirectToCallback(res, origin,
          `token=${token}&name=${encodeURIComponent(account.displayName)}&provider=${provider}`);
      }

      /* ---- 账号密码登录 ---- */
      if (p === '/api/login' && req.method === 'POST') {
        const body = await readBody(req);
        const acc = loadAccounts();
        const user = acc.users.find((u) => u.username === String(body.username || '').trim());
        if (!user || !verifyPassword(user, body.password)) {
          return sendJson(res, 401, { error: '账号或密码不正确' });
        }
        const token = issueToken(user, 'password');
        return sendJson(res, 200, { ok: true, token, username: user.username, displayName: user.displayName, provider: 'password' });
      }

      /* ---- 邮箱验证码登录 ---- */
      if (p === '/api/email/code' && req.method === 'POST') {
        const body = await readBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: '邮箱格式不正确' });
        const existing = emailCodes.get(email);
        const now = Date.now();
        if (existing && existing.nextAllowed > now) {
          const wait = Math.ceil((existing.nextAllowed - now) / 1000);
          return sendJson(res, 429, { error: `请 ${wait} 秒后再获取验证码`, retryAfter: wait });
        }
        const code = newCode();
        const text = `您正在登录「百亿补贴 · API 路由中心」，验证码：${code}\n\n验证码 10 分钟内有效，请勿泄露给他人。如非本人操作，请忽略本邮件。`;
        try {
          await sendMail({ to: email, subject: '【百亿补贴】登录验证码', text });
        } catch (e) {
          return sendJson(res, 502, { error: '验证码邮件发送失败：' + (e.message || '请稍后重试') });
        }
        emailCodes.set(email, { code, exp: now + CODE_TTL, attempts: 0, nextAllowed: now + CODE_RESEND });
        return sendJson(res, 200, { ok: true, cooldown: CODE_RESEND / 1000 });
      }

      if (p === '/api/email/login' && req.method === 'POST') {
        const body = await readBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        const code = String(body.code || '').trim();
        const entry = emailCodes.get(email);
        if (!entry || entry.exp < Date.now()) return sendJson(res, 401, { error: '验证码已过期，请重新获取' });
        if (entry.attempts >= CODE_MAX_ATTEMPTS) {
          emailCodes.delete(email);
          return sendJson(res, 429, { error: '尝试次数过多，请重新获取验证码' });
        }
        if (code !== entry.code) {
          entry.attempts++;
          return sendJson(res, 401, { error: '验证码不正确' });
        }
        emailCodes.delete(email);

        const acc = loadAccounts();
        let user = acc.users.find((u) => (u.email || '').toLowerCase() === email);
        if (!user) {
          user = {
            id: 'u_' + crypto.randomBytes(6).toString('hex'),
            username: 'mail_' + crypto.randomBytes(4).toString('hex'),
            displayName: email.split('@')[0],
            email,
            salt: crypto.randomBytes(16).toString('hex'),
            hash: '',
            role: 'member',
            providers: { email: { address: email } },
            createdAt: new Date().toISOString()
          };
          acc.users.push(user);
          saveAccounts(acc);
        }
        const token = issueToken(user, 'email');
        return sendJson(res, 200, { ok: true, token, username: user.username, displayName: user.displayName, provider: 'email' });
      }

      if (p === '/api/logout' && req.method === 'POST') {
        const auth = resolveAuth(req);
        if (auth) sessions.delete(auth.token);
        return sendJson(res, 200, { ok: true });
      }

      if (p === '/api/me' && req.method === 'GET') {
        const auth = resolveAuth(req);
        if (!auth) return sendJson(res, 401, { error: '未登录' });
        return sendJson(res, 200, {
          ok: true,
          username: auth.username,
          displayName: auth.displayName,
          provider: auth.provider,
          role: auth.role,
          email: auth.email || ''
        });
      }

      /* ---- 只读接口 ---- */
      if (p === '/api/stats' && req.method === 'GET') {
        return sendJson(res, 200, computeStats(loadRoutes()));
      }
      if (p === '/api/groups' && req.method === 'GET') {
        const groups = [...new Set(loadRoutes().map((r) => r.group))];
        return sendJson(res, 200, { groups });
      }
      if (p === '/api/routes' && req.method === 'GET') {
        const list = applyFilters(
          loadRoutes(),
          url.searchParams.get('q') || '',
          url.searchParams.get('method') || '',
          url.searchParams.get('group') || '',
          url.searchParams.get('status') || ''
        );
        return sendJson(res, 200, { routes: list, total: list.length });
      }

      const detail = /^\/api\/routes\/([a-z0-9_]+)$/i.exec(p);
      if (detail && req.method === 'GET') {
        const route = loadRoutes().find((r) => r.id === detail[1]);
        if (!route) return sendJson(res, 404, { error: '接口不存在' });
        return sendJson(res, 200, { route });
      }

      /* ---- 写接口（需鉴权） ---- */
      const auth = resolveAuth(req);
      if (!auth) return sendJson(res, 401, { error: '未登录或会话已过期' });

      if (p === '/api/routes' && req.method === 'POST') {
        const body = await readBody(req);
        const { errors, data } = cleanRoute(body, null);
        if (errors.length) return sendJson(res, 400, { errors });
        const list = loadRoutes();
        const now = new Date().toISOString();
        const route = Object.assign({
          id: 'r_' + crypto.randomBytes(6).toString('hex'),
          createdAt: now,
          updatedAt: now
        }, data);
        list.push(route);
        saveRoutes(list);
        return sendJson(res, 201, { route });
      }

      if (detail && (req.method === 'PUT' || req.method === 'PATCH')) {
        const list = loadRoutes();
        const idx = list.findIndex((r) => r.id === detail[1]);
        if (idx === -1) return sendJson(res, 404, { error: '接口不存在' });
        const body = await readBody(req);
        const merged = req.method === 'PATCH' ? Object.assign({}, list[idx], body) : body;
        const { errors, data } = cleanRoute(merged, list[idx]);
        if (errors.length) return sendJson(res, 400, { errors });
        list[idx] = Object.assign({}, list[idx], data, { updatedAt: new Date().toISOString() });
        saveRoutes(list);
        return sendJson(res, 200, { route: list[idx] });
      }

      if (detail && req.method === 'DELETE') {
        const list = loadRoutes();
        const idx = list.findIndex((r) => r.id === detail[1]);
        if (idx === -1) return sendJson(res, 404, { error: '接口不存在' });
        const [removed] = list.splice(idx, 1);
        saveRoutes(list);
        return sendJson(res, 200, { ok: true, removed });
      }

      return sendJson(res, 404, { error: '接口不存在' });
    }

    serveStatic(req, res, p);
  } catch (err) {
    sendJson(res, 500, { error: err.message || '服务器内部错误' });
  }
});

ensureData();
server.listen(PORT, () => {
  console.log(`百亿补贴 · API 路由中心已启动：http://localhost:${PORT}`);
  console.log(`管理后台：http://localhost:${PORT}/admin.html`);
});
