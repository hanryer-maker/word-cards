/* 单词卡 · 数据层：本地缓存、离线兜底、与服务端同步 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'wordcard.site.v2';   // 沿用 v2 键，旧数据自动迁移
  const LEGACY_KEY = 'wordcard.site.v1';
  const DELETED_KEY = 'wordcard.site.deleted';
  const PIN_KEY = 'wordcard.sync.pin';
  const MARK_TARGET = 5;
  const API = '/api/state';

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ESC_MAP[m]);

  function uid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function letterOf(word) {
    const ch = (word || '').trim().charAt(0).toUpperCase();
    return /[A-Z]/.test(ch) ? ch : '#';
  }

  function toCount(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  /* ---------------- 本地存储 ---------------- */
  function load() {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      const cards = parsed
        .filter((c) => c && typeof c === 'object' && c.word)
        .map((c) => ({
          id: c.id || uid(),
          word: String(c.word),
          pos: String(c.pos || ''),
          meaning: String(c.meaning || ''),
          note: String(c.note || ''),
          markWord: c.markWord !== undefined ? toCount(c.markWord) : (c.reviewedWord ? MARK_TARGET : 0),
          markMeaning: c.markMeaning !== undefined ? toCount(c.markMeaning) : (c.reviewedMeaning ? MARK_TARGET : 0),
          isArchived: Boolean(c.isArchived),
          updatedAt: num(c.updatedAt),
        }));

      cards.forEach((c) => {
        if (c.markWord >= MARK_TARGET && c.markMeaning >= MARK_TARGET) c.isArchived = true;
      });
      return cards;
    } catch (e) {
      console.warn('读取本地数据失败：', e);
      return [];
    }
  }

  function save(cards, deleted) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
      if (deleted) localStorage.setItem(DELETED_KEY, JSON.stringify(deleted));
      return true;
    } catch (e) {
      console.warn('保存失败：', e);
      return false;
    }
  }

  function loadDeleted() {
    try {
      const raw = localStorage.getItem(DELETED_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  }

  /* ---------------- 合并规则 ---------------- */
  // 同一 id 取 updatedAt 较新者；墓碑时间 >= 卡片更新时间则视为已删除。
  function merge(local, remote, deletedMap) {
    const cards = Array.isArray(local) ? local : [];
    const remoteCards = Array.isArray(remote) ? remote : [];
    const deleted = deletedMap && typeof deletedMap === 'object' ? deletedMap : loadDeleted();

    const byId = new Map();
    const order = [];

    for (const c of cards) {
      if (!c || !c.id) continue;
      byId.set(c.id, c);
      order.push(c.id);
    }
    for (const c of remoteCards) {
      if (!c || !c.id) continue;
      const cur = byId.get(c.id);
      if (!cur || num(c.updatedAt) > num(cur.updatedAt)) {
        if (!cur) order.push(c.id);
        byId.set(c.id, c);
      }
    }

    const out = [];
    const seen = new Set();
    for (const id of order) {
      if (seen.has(id)) continue;
      seen.add(id);
      const c = byId.get(id);
      if (!c) continue;
      if (num(deleted[id]) >= num(c.updatedAt) && num(c.updatedAt) > 0) continue;
      out.push(c);
    }
    return out;
  }

  /* ---------------- 同步 ---------------- */
  function getPin() {
    try { return localStorage.getItem(PIN_KEY) || ''; } catch { return ''; }
  }
  function setPin(v) {
    try {
      if (v) localStorage.setItem(PIN_KEY, v);
      else localStorage.removeItem(PIN_KEY);
    } catch {}
  }

  async function request(method, body, since) {
    const headers = { 'Content-Type': 'application/json' };
    const pin = getPin();
    if (pin) headers['x-sync-pin'] = pin;

    const url = since === undefined || since === null ? API : API + '?since=' + encodeURIComponent(since);
    const res = await fetch(url, {
      method,
      headers,
      cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 401) {
      const err = new Error('pin');
      err.code = 'pin';
      throw err;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  const fetchRemote = (since) => request('GET', undefined, since);
  const pushRemote = (cards, deleted) => request('POST', { cards, deleted });

  global.WCStore = {
    STORAGE_KEY, DELETED_KEY, MARK_TARGET, API,
    esc, uid, letterOf, toCount, num,
    load, save, loadDeleted, merge,
    getPin, setPin, fetchRemote, pushRemote,
  };
})(window);
