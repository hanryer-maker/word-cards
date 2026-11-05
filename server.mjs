/* 单词卡 · 零依赖服务器：静态文件 + 知识库(noesis)后端
 * 卡片即笔记：<KB_DIR>/notes/*.md，noesis 负责索引；本服务负责读写与合并。
 * 用法: node server.mjs [root]
 *   PORT=80 HOST=0.0.0.0 SYNC_PIN=xxxx KB_DIR=/home/ubuntu/kb
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  createReadStream, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { extname, join, basename, normalize, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '.');
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';
const PIN = process.env.SYNC_PIN || '';
const KB_DIR = resolve(process.env.KB_DIR || '/home/ubuntu/kb');
const NOTES_DIR = join(KB_DIR, 'notes');
const TRASH_DIR = join(KB_DIR, '_trash');
const META_FILE = join(ROOT, 'data', 'meta.json');
const LEGACY_FILE = join(ROOT, 'data', 'state.json');
const NOESIS_BIN = process.env.NOESIS_BIN || '/home/ubuntu/noesis/bin/noesis.mjs';
const TOMBSTONE_TTL = 30 * 24 * 3600 * 1000;
const MAX_BODY = 2 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/* ---------------- 状态 ---------------- */
let state = { version: 0, updatedAt: 0, cards: [], deleted: {} };
const fileById = new Map(); // cardId -> 文件名

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clean = (s, max = 500) => String(s ?? '').slice(0, max);

/* ---------------- 实时推送 ---------------- */
const clients = new Set();

function broadcast() {
  const frame = `event: update\ndata: {"version":${state.version}}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}

function slugOf(card) {
  const base = card.word
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || card.id.slice(0, 12);
}

/* ---------------- 笔记读写 ---------------- */
function parseNote(text, file) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let raw = line.slice(i + 1).trim();
    if (!raw) { meta[key] = ''; continue; }
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith('[') || raw === 'true' || raw === 'false')) {
      try { meta[key] = JSON.parse(raw); } catch { meta[key] = raw; }
    } else if (/^-?\d+$/.test(raw)) {
      meta[key] = Number(raw);
    } else {
      meta[key] = raw;
    }
  }
  if (!meta.card_id || !meta.title) return null;
  return {
    id: String(meta.card_id),
    word: String(meta.title),
    pos: clean(meta.pos || '', 40),
    meaning: clean(meta.meaning || '', 300),
    note: clean(meta.note || '', 1000),
    markWord: num(meta.markWord) | 0,
    markMeaning: num(meta.markMeaning) | 0,
    isArchived: Boolean(meta.isArchived),
    updatedAt: num(meta.updatedAt),
    file,
  };
}

function noteText(card) {
  const q = (v) => JSON.stringify(String(v ?? ''));
  const date = new Date(card.updatedAt || Date.now()).toISOString().slice(0, 10);
  const tags = ['word', card.pos].filter(Boolean);
  return [
    '---',
    `title: ${q(card.word)}`,
    `tags: ${JSON.stringify(tags)}`,
    `date: ${q(date)}`,
    `card_id: ${q(card.id)}`,
    `pos: ${q(card.pos)}`,
    `meaning: ${q(card.meaning)}`,
    `note: ${q(card.note)}`,
    `markWord: ${card.markWord}`,
    `markMeaning: ${card.markMeaning}`,
    `isArchived: ${card.isArchived ? 'true' : 'false'}`,
    `updatedAt: ${card.updatedAt}`,
    '---',
    '',
    `释义：${card.meaning || '（暂无）'}`,
    card.pos ? `词性：${card.pos}` : '',
    card.note ? `备注：${card.note}` : '',
    `进度：英 ${card.markWord}/5 · 汉 ${card.markMeaning}/5`,
    '',
  ].filter((l) => l !== '').join('\n');
}

function writeNote(card) {
  mkdirSync(NOTES_DIR, { recursive: true });
  let name = fileById.get(card.id);
  if (!name) {
    const base = slugOf(card);
    name = base + '.md';
    // 同名不同词：追加 id 短码
    let n = 1;
    while (existsSync(join(NOTES_DIR, name))) {
      const other = parseNote(readFileSync(join(NOTES_DIR, name), 'utf8'), name);
      if (other && other.id === card.id) break;
      name = `${base}-${card.id.slice(0, 8)}${n > 1 ? '-' + n : ''}.md`;
      n += 1;
    }
    fileById.set(card.id, name);
  }
  writeFileSync(join(NOTES_DIR, name), noteText(card));
}

function trashNote(cardId) {
  const name = fileById.get(cardId);
  if (!name) return;
  const src = join(NOTES_DIR, name);
  if (existsSync(src)) {
    mkdirSync(TRASH_DIR, { recursive: true });
    const dest = join(TRASH_DIR, `${Date.now()}-${basename(src)}`);
    try { renameSync(src, dest); } catch { try { unlinkSync(src); } catch {} }
  }
  fileById.delete(cardId);
}

/* ---------------- 载入 ---------------- */
function loadMeta() {
  try {
    if (!existsSync(META_FILE)) return;
    const m = JSON.parse(readFileSync(META_FILE, 'utf8'));
    state.version = num(m.version);
    state.updatedAt = num(m.updatedAt);
    state.deleted = m.deleted && typeof m.deleted === 'object' ? m.deleted : {};
  } catch (e) {
    console.error('读取 meta 失败:', e.message);
  }
}

function loadNotes() {
  mkdirSync(NOTES_DIR, { recursive: true });
  const cards = [];
  for (const name of readdirSync(NOTES_DIR)) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    try {
      const card = parseNote(readFileSync(join(NOTES_DIR, name), 'utf8'), name);
      if (!card) continue;
      cards.push(card);
      fileById.set(card.id, name);
    } catch (e) {
      console.error('跳过损坏笔记:', name, e.message);
    }
  }
  cards.sort((a, b) => num(a.updatedAt) - num(b.updatedAt));
  state.cards = cards.filter((c) => {
    if (num(state.deleted[c.id]) >= num(c.updatedAt) && num(c.updatedAt) > 0) return false;
    return true;
  });
}

/** 首次启动：把旧的 data/state.json 迁移成笔记 */
function migrateLegacy() {
  if (state.cards.length > 0 || existsSync(META_FILE) || !existsSync(LEGACY_FILE)) return;
  try {
    const old = JSON.parse(readFileSync(LEGACY_FILE, 'utf8'));
    if (!old || !Array.isArray(old.cards) || old.cards.length === 0) return;
    for (const c of old.cards) {
      const card = {
        id: c.id || `legacy-${Math.random().toString(36).slice(2, 10)}`,
        word: clean(c.word, 120),
        pos: clean(c.pos, 40),
        meaning: clean(c.meaning, 300),
        note: clean(c.note, 1000),
        markWord: num(c.markWord) | 0,
        markMeaning: num(c.markMeaning) | 0,
        isArchived: Boolean(c.isArchived),
        updatedAt: num(c.updatedAt) || Date.now(),
      };
      if (!card.word) continue;
      writeNote(card);
      state.cards.push(card);
    }
    state.version = 1;
    state.updatedAt = Date.now();
    state.deleted = old.deleted || {};
    persistMeta();
    console.log(`已迁移 ${state.cards.length} 张卡片到知识库笔记`);
  } catch (e) {
    console.error('迁移旧数据失败:', e.message);
  }
}

let writeChain = Promise.resolve();
function persistMeta() {
  const snapshot = JSON.stringify({ version: state.version, updatedAt: state.updatedAt, deleted: state.deleted });
  writeChain = writeChain.then(() => {
    mkdirSync(join(ROOT, 'data'), { recursive: true });
    const tmp = META_FILE + '.tmp';
    writeFileSync(tmp, snapshot);
    renameSync(tmp, META_FILE);
  }).catch((e) => console.error('写入 meta 失败:', e.message));
  return writeChain;
}

/* ---------------- 合并 ---------------- */
function normalizeCard(c) {
  return {
    id: clean(c.id, 80),
    word: clean(c.word, 120),
    pos: clean(c.pos, 40),
    meaning: clean(c.meaning, 300),
    note: clean(c.note, 1000),
    markWord: Math.max(0, Math.min(999, num(c.markWord) | 0)),
    markMeaning: Math.max(0, Math.min(999, num(c.markMeaning) | 0)),
    isArchived: Boolean(c.isArchived),
    updatedAt: num(c.updatedAt) || Date.now(),
  };
}

function mergeState(incoming) {
  const now = Date.now();
  const beforeSig = JSON.stringify({ c: state.cards.map((c) => [c.id, c.updatedAt]), d: state.deleted });
  const incomingCards = Array.isArray(incoming?.cards) ? incoming.cards : [];
  const incomingDeleted = incoming?.deleted && typeof incoming.deleted === 'object' ? incoming.deleted : {};

  for (const [id, ts] of Object.entries(incomingDeleted)) {
    const t = num(ts);
    if (t > num(state.deleted[id])) {
      state.deleted[id] = t;
      trashNote(id);
    }
  }
  for (const [id, ts] of Object.entries(state.deleted)) {
    const t = num(ts);
    if (t > 1e12 && now - t > TOMBSTONE_TTL) delete state.deleted[id];
  }

  const byId = new Map(state.cards.map((c) => [c.id, c]));
  const added = [];

  for (const raw of incomingCards) {
    if (!raw || !raw.id || !raw.word) continue;
    const card = normalizeCard(raw);
    const cur = byId.get(card.id);
    if (!cur) {
      added.push(card);
      byId.set(card.id, card);
    } else if (num(card.updatedAt) > num(cur.updatedAt)) {
      byId.set(card.id, card);
    }
  }

  added.sort((a, b) => num(a.updatedAt) - num(b.updatedAt));
  const seen = new Set();
  const cards = [];
  for (const c of [...state.cards, ...added]) {
    const cur = byId.get(c.id);
    if (!cur || seen.has(c.id)) continue;
    seen.add(c.id);
    if (num(state.deleted[c.id]) >= num(cur.updatedAt) && num(cur.updatedAt) > 0) continue;
    cards.push(cur);
  }

  state.cards = cards;

  const afterSig = JSON.stringify({ c: state.cards.map((c) => [c.id, c.updatedAt]), d: state.deleted });
  if (afterSig === beforeSig) return state; // 没变化就不加版本、不广播、不重建

  state.version += 1;
  state.updatedAt = now;

  // 只写变更的笔记
  for (const c of cards) {
    const existing = fileById.get(c.id);
    if (!existing) { writeNote(c); continue; }
    const path = join(NOTES_DIR, existing);
    let old = null;
    try { old = parseNote(readFileSync(path, 'utf8'), existing); } catch {}
    if (!old || old.updatedAt !== c.updatedAt || old.word !== c.word || old.meaning !== c.meaning ||
        old.pos !== c.pos || old.note !== c.note || old.markWord !== c.markWord ||
        old.markMeaning !== c.markMeaning || old.isArchived !== c.isArchived) {
      writeNote(c);
    }
  }

  persistMeta();
  scheduleBuild();
  broadcast();
  return state;
}

/* ---------------- noesis 索引 ---------------- */
let buildTimer = null;
function scheduleBuild() {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(runBuild, 1500);
}

function runBuild() {
  if (!existsSync(NOESIS_BIN)) return;
  const child = spawn(process.execPath, [NOESIS_BIN, 'build', KB_DIR], { stdio: 'ignore' });
  child.on('error', (e) => console.error('索引构建失败:', e.message));
  child.on('exit', (code) => {
    if (code !== 0) console.error('索引构建退出码', code);
  });
}

/* ---------------- HTTP ---------------- */
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req, url) {
  if (!PIN) return true;
  if (req.headers['x-sync-pin'] === PIN) return true;
  return Boolean(url && url.searchParams.get('pin') === PIN);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);

    // 实时推送：卡片一变就通知所有在线页面
    if (path === '/api/events') {
      if (!authorized(req, url)) return send(res, 401, 'pin required');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 2000\n\nevent: hello\ndata: {"version":${state.version}}\n\n`);
      clients.add(res);
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* 下一次写失败会清理 */ }
      }, 25000);
      req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return;
    }

    if (path === '/api/state') {
      if (!authorized(req, url)) return json(res, 401, { error: 'pin required' });

      if (req.method === 'GET') {
        const since = url.searchParams.get('since');
        if (since !== null && num(since) === state.version) {
          return json(res, 200, { unchanged: true, version: state.version });
        }
        const cards = state.cards.map(({ file, ...c }) => c);
        return json(res, 200, { version: state.version, updatedAt: state.updatedAt, cards, deleted: state.deleted });
      }

      if (req.method === 'POST') {
        let body;
        try {
          body = await readBody(req);
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
        const merged = mergeState(body);
        const cards = merged.cards.map(({ file, ...c }) => c);
        return json(res, 200, { version: merged.version, updatedAt: merged.updatedAt, cards, deleted: merged.deleted });
      }

      return send(res, 405, 'Method Not Allowed', { Allow: 'GET, POST' });
    }

    if (path === '/api/health') {
      return json(res, 200, { ok: true, version: state.version, cards: state.cards.length, kb: KB_DIR });
    }

    let rel = path;
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel.split('/').includes('data')) return send(res, 404, 'Not Found');

    const filePath = normalize(join(ROOT, rel));
    if (!filePath.startsWith(ROOT)) return send(res, 403, 'Forbidden');

    let st;
    try { st = statSync(filePath); } catch { return send(res, 404, 'Not Found'); }
    if (st.isDirectory()) return send(res, 404, 'Not Found');

    const ext = extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-store, no-cache, must-revalidate' : (ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=600'),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (ext === '.html') headers.Pragma = 'no-cache';
    res.writeHead(200, headers);
    createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, 500, 'Internal Server Error');
  }
});

loadMeta();
loadNotes();
migrateLegacy();
server.listen(PORT, HOST, () => {
  console.log(`单词卡 on http://${HOST}:${PORT}  cards=${state.cards.length}  kb=${KB_DIR}  pin=${PIN ? 'on' : 'off'}`);
  runBuild();
});
