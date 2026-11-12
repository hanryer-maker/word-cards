/* 单词卡 · 界面与交互 */
(function () {
  'use strict';

  const {
    MARK_TARGET, esc, uid, letterOf, toCount, num, load, save, loadDeleted,
    merge, getPin, setPin, fetchRemote, pushRemote,
  } = window.WCStore;

  const el = {
    form: document.getElementById('addForm'),
    word: document.getElementById('wordInput'),
    pos: document.getElementById('posInput'),
    meaning: document.getElementById('meaningInput'),
    note: document.getElementById('noteInput'),
    submit: document.getElementById('submitBtn'),
    cancel: document.getElementById('cancelBtn'),
    grid: document.getElementById('grid'),
    letterBar: document.getElementById('letterBar'),
    sortSeg: document.getElementById('sortSeg'),
    folderSeg: document.getElementById('folderSeg'),
    flipAll: document.getElementById('flipAllBtn'),
    reshuffle: document.getElementById('reshuffleBtn'),
    search: document.getElementById('searchInput'),
    stats: document.getElementById('stats'),
    toast: document.getElementById('toast'),
  };

  /* ================= 状态 ================= */
  let cards = [];
  let sortMode = 'added';    // 'alpha' | 'added' | 'random'
  let activeLetter = 'all';  // 'all' | 'A'~'Z' | '#'
  let activeFolder = 'all';  // 'all' | 'learning' | 'archived'
  let editingId = null;
  let deleted = {};                 // 删除墓碑 {id: ts}
  const randKeys = new Map();
  const flippedIds = new Set();

  /* ================= 同步状态 ================= */
  let syncing = false;
  let pushTimer = null;
  let pollTimer = null;
  let lastVersion = 0;
  let dirty = false;          // 本地是否有未上传的改动
  let lastSyncAt = 0;
  let syncFailed = false;

  const rk = (id) => {
    if (!randKeys.has(id)) randKeys.set(id, Math.random());
    return randKeys.get(id);
  };

  /* ================= 同步 ================= */
  function setStatus(text, kind) {
    const el2 = document.getElementById('syncStatus');
    if (!el2) return;
    el2.textContent = text;
    el2.dataset.kind = kind || '';
  }

  function saveAll() {
    save(cards, deleted);
  }

  function schedulePush() {
    dirty = true;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { syncNow('push'); }, 700);
  }

  async function syncNow(reason) {
    if (syncing) return;
    syncing = true;
    setStatus('同步中…', 'busy');

    try {
      const remote = await fetchRemote();
      if (remote && remote.deleted && typeof remote.deleted === 'object') {
        deleted = Object.assign({}, deleted, remote.deleted);
      }
      let merged = merge(cards, remote.cards, deleted);
      cards = merged;

      if (dirty) {
        // 有本地改动：推上去并取回合并结果
        const res = await pushRemote(cards, deleted);
        if (res.deleted && typeof res.deleted === 'object') {
          deleted = Object.assign({}, deleted, res.deleted);
        }
        cards = merge(cards, res.cards, deleted);
        lastVersion = num(res.version);
        dirty = false;
      } else {
        // 只是别人改了：拉下来就行，不回写，避免版本号空转
        lastVersion = num(remote.version);
      }
      saveAll();
      render();

      lastSyncAt = Date.now();
      syncFailed = false;
      const t = new Date(lastSyncAt);
      setStatus('已同步 ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'), 'ok');
    } catch (e) {
      syncFailed = true;
      if (e && e.code === 'pin') {
        setStatus('需要同步口令', 'warn');
        promptPin();
      } else {
        setStatus('离线，本地已保存', 'warn');
      }
    } finally {
      syncing = false;
    }
  }

  // 轻量轮询：服务端版本没变就只返回 {unchanged:true}，不传词库
  async function pollCheck() {
    if (syncing || document.visibilityState !== 'visible') return;
    try {
      const r = await fetchRemote(lastVersion);
      if (r && r.unchanged) return;
      syncNow('poll');
    } catch {
      // 网络抖动不打扰用户，保留“已同步”状态
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(pollCheck, 20000);
  }

  // 服务端有变化会立即推送；断开时浏览器自动重连，轮询兼底
  function startEvents() {
    if (!window.EventSource) return;
    const pin = getPin();
    const url = '/api/events' + (pin ? '?pin=' + encodeURIComponent(pin) : '');
    const es = new EventSource(url);
    es.addEventListener('update', () => pollCheck());
    es.addEventListener('hello', () => {});
    es.onerror = () => { /* 自动重连中，轮询还在跑 */ };
  }

  function promptPin() {
    const pin = window.prompt('这台设备第一次同步，请输入同步口令（服务端未设置口令时留空即可）');
    if (pin === null) return;
    setPin(pin.trim());
    syncNow('pin');
  }

  /* ================= 提示 ================= */
  let toastTimer = null;
  function toast(msg) {
    const t = el.toast;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
  }

  /* ================= 渲染 ================= */
  function render() {
    renderLetters();
    renderGrid();
  }

  function renderLetters() {
    const folderCards = cards.filter((c) => {
      if (activeFolder === 'learning') return !c.isArchived;
      if (activeFolder === 'archived') return c.isArchived;
      return true;
    });

    const set = new Set(folderCards.map((c) => letterOf(c.word)));
    if (activeLetter !== 'all' && !set.has(activeLetter)) activeLetter = 'all';

    const letters = [...set].sort((a, b) => {
      if (a === '#') return 1;
      if (b === '#') return -1;
      return a.localeCompare(b);
    });

    let html = `<button type="button" class="chip ${activeLetter === 'all' ? 'active' : ''}" data-letter="all">全部</button>`;
    html += letters
      .map((l) => `<button type="button" class="chip ${activeLetter === l ? 'active' : ''}" data-letter="${esc(l)}">${esc(l)}</button>`)
      .join('');
    el.letterBar.innerHTML = html;
  }

  function getVisible() {
    const q = el.search.value.trim().toLowerCase();

    const list = cards.filter((c) => {
      if (activeFolder === 'learning' && c.isArchived) return false;
      if (activeFolder === 'archived' && !c.isArchived) return false;
      if (activeLetter !== 'all' && letterOf(c.word) !== activeLetter) return false;
      if (q) {
        const hay = (c.word + ' ' + c.pos + ' ' + c.meaning + ' ' + c.note).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (sortMode === 'alpha') {
      list.sort((a, b) => {
        const d = a.word.toLowerCase().localeCompare(b.word.toLowerCase(), 'en');
        return d !== 0 ? d : a.word.localeCompare(b.word);
      });
    } else if (sortMode === 'random') {
      list.sort((a, b) => rk(a.id) - rk(b.id));
    }
    return list;
  }

  function renderGrid() {
    const ids = new Set(cards.map((c) => c.id));
    for (const id of [...flippedIds]) if (!ids.has(id)) flippedIds.delete(id);

    const list = getVisible();
    el.grid.innerHTML = '';

    if (list.length === 0) {
      const d = document.createElement('div');
      d.className = 'empty';
      if (cards.length === 0) {
        d.innerHTML = '还没有单词卡<br><span>在上方输入第一个单词吧 ✨</span>';
      } else if (activeFolder === 'learning') {
        d.innerHTML = '没有正在背的单词了<br><span>去“背过了”文件夹看看吧</span>';
      } else if (activeFolder === 'archived') {
        d.innerHTML = '还没有背过的单词卡<br><span>两个方向各累计标记 5 次，或点卡片上的“归档”就会移到这里</span>';
      } else {
        d.innerHTML = '没有符合条件的单词卡<br><span>换个筛选条件试试</span>';
      }
      el.grid.appendChild(d);
    } else {
      const frag = document.createDocumentFragment();
      list.forEach((c) => frag.appendChild(buildCard(c)));
      el.grid.appendChild(frag);
    }

    const total = cards.length;
    const archived = cards.filter((c) => c.isArchived).length;
    el.stats.textContent = `总计 ${total} 张 · 正在背 ${total - archived} 张 · 背过了 ${archived} 张`;

    const allFlipped = total > 0 && cards.every((c) => flippedIds.has(c.id));
    el.flipAll.textContent = allFlipped ? '🔄 全部翻到正面' : '🔄 全部翻到背面';
  }

  function buildCard(c) {
    const isArchived = c.isArchived;

    const topActions = `
      <div class="actions">
        <div class="action-group">
          <button type="button" class="icon-btn edit" title="编辑" aria-label="编辑 ${esc(c.word)}">✎</button>
          <button type="button" class="icon-btn del" title="删除" aria-label="删除 ${esc(c.word)}">✕</button>
        </div>
        ${isArchived
          ? '<button type="button" class="icon-btn btn-restore" title="撤出背过文件夹（保留进度）">↩️ 撤出</button>'
          : '<button type="button" class="icon-btn btn-archive" title="直接移入背过文件夹（保留进度）">📁 归档</button>'
        }
      </div>`;

    const front = document.createElement('div');
    front.className = 'face front';
    front.innerHTML = `
      ${topActions}
      ${c.pos ? `<span class="pos">${esc(c.pos)}</span>` : ''}
      <div class="word">${esc(c.word)}</div>
      ${markRow(c, 'word', isArchived)}
      ${pairMeter(c)}
      <div class="hint">点击卡片翻转</div>`;

    const back = document.createElement('div');
    back.className = 'face back';
    back.innerHTML = `
      ${topActions}
      <div class="meaning">${esc(c.meaning) || '<span class="muted">（暂无释义）</span>'}</div>
      ${c.note ? `<div class="note">${esc(c.note)}</div>` : ''}
      ${markRow(c, 'meaning', isArchived)}
      ${pairMeter(c)}
      <div class="hint">点击卡片翻转</div>`;

    const inner = document.createElement('div');
    inner.className = 'card-inner';
    inner.append(front, back);

    const card = document.createElement('div');
    card.className = `card ${isArchived ? 'archived ' : ''}${flippedIds.has(c.id) ? 'flipped' : ''}`.trim();
    card.dataset.id = c.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${c.word}${c.meaning ? '，' + c.meaning : ''}，点击翻转`);
    card.appendChild(inner);
    return card;
  }

  function markRow(c, type, isArchived) {
    const key = type === 'word' ? 'markWord' : 'markMeaning';
    const label = type === 'word' ? '英→汉' : '汉→英';
    const count = c[key];
    const full = count >= MARK_TARGET;

    return `
      <div class="mark-row">
        <button type="button" class="mark-btn ${count ? 'done' : ''}${full ? ' full' : ''}"
          data-mark="${type}" title="点一次记一次，可反复累计"
          ${isArchived || full ? 'disabled' : ''}>
          ${count ? '✔️' : '○'} ${label} <b>${count}/${MARK_TARGET}</b>
        </button>
        ${count > 0 && !isArchived
          ? `<button type="button" class="undo-btn" data-unmark="${type}" title="取消一次标记">−</button>`
          : ''}
      </div>`;
  }

  function pairMeter(c) {
    const w = c.markWord;
    const m = c.markMeaning;
    return `
      <div class="pair" title="看单词背汉译 ${w}/${MARK_TARGET} 次 · 看汉译默写单词 ${m}/${MARK_TARGET} 次">
        <span class="${w >= MARK_TARGET ? 'ok' : ''}">英 ${w}/${MARK_TARGET}</span>
        <span class="sep">·</span>
        <span class="${m >= MARK_TARGET ? 'ok' : ''}">汉 ${m}/${MARK_TARGET}</span>
      </div>`;
  }

  /* ================= 交互 ================= */
  function onSubmit(e) {
    e.preventDefault();
    const word = el.word.value.trim();
    if (!word) { el.word.focus(); return; }

    const data = {
      word,
      pos: el.pos.value.trim(),
      meaning: el.meaning.value.trim(),
      note: el.note.value.trim(),
    };

    if (editingId) {
      const c = cards.find((x) => x.id === editingId);
      if (c) Object.assign(c, data);
    } else {
      cards.push({ id: uid(), ...data, markWord: 0, markMeaning: 0, isArchived: false, updatedAt: Date.now() });
    }
    if (editingId) {
      const c = cards.find((x) => x.id === editingId);
      if (c) c.updatedAt = Date.now();
    }

    saveAll();
    schedulePush();
    resetForm();
    render();
  }

  function resetForm() {
    editingId = null;
    el.form.reset();
    el.submit.textContent = '添加单词';
    el.cancel.hidden = true;
    el.word.focus({ preventScroll: true });
  }

  function startEdit(id) {
    const c = cards.find((x) => x.id === id);
    if (!c) return;
    editingId = id;
    el.word.value = c.word;
    el.pos.value = c.pos;
    el.meaning.value = c.meaning;
    el.note.value = c.note;
    el.submit.textContent = '保存修改';
    el.cancel.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    el.word.focus({ preventScroll: true });
  }

  function removeCard(id) {
    const c = cards.find((x) => x.id === id);
    if (!c) return;
    if (!confirm(`确定删除「${c.word}」吗？`)) return;

    cards = cards.filter((x) => x.id !== id);
    deleted[id] = Date.now();
    randKeys.delete(id);
    flippedIds.delete(id);
    if (editingId === id) resetForm();
    saveAll();
    schedulePush();
    render();
  }

  function markCard(id, type, decrement) {
    const c = cards.find((x) => x.id === id);
    if (!c || c.isArchived) return;

    const key = type === 'word' ? 'markWord' : 'markMeaning';
    const label = type === 'word' ? '英→汉' : '汉→英';

    if (decrement) {
      if (c[key] <= 0) return;
      c[key] = toCount(c[key]) - 1;
      c.updatedAt = Date.now();
      saveAll();
      schedulePush();
      render();
      toast(`「${c.word}」${label} 已取消 1 次 · 现在 ${c[key]}/${MARK_TARGET}`);
      return;
    }

    if (c[key] >= MARK_TARGET) return;
    c[key] += 1;
    c.updatedAt = Date.now();

    if (c.markWord >= MARK_TARGET && c.markMeaning >= MARK_TARGET) {
      c.isArchived = true;
      flippedIds.delete(id);
      saveAll();
      schedulePush();
      render();
      toast(`🎉 「${c.word}」两个方向各背满 ${MARK_TARGET} 次，已自动移入「背过了」`);
      return;
    }

    saveAll();
    schedulePush();
    render();

    let msg = `「${c.word}」${label} ${c[key]}/${MARK_TARGET}`;
    if (c[key] >= MARK_TARGET) {
      const otherKey = type === 'word' ? 'markMeaning' : 'markWord';
      const otherLabel = type === 'word' ? '汉→英' : '英→汉';
      msg += ` ✓ · ${otherLabel} 还差 ${MARK_TARGET - c[otherKey]} 次`;
    }
    toast(msg);
  }

  function toggleArchive(id) {
    const c = cards.find((x) => x.id === id);
    if (!c) return;

    if (c.isArchived) {
      if (!confirm(`确定将「${c.word}」撤出背过文件夹吗？\n（标记进度会保留，可继续累计或取消）`)) return;
      c.isArchived = false;
      c.updatedAt = Date.now();
      flippedIds.delete(id);
      saveAll();
      schedulePush();
      render();
      toast(`「${c.word}」已撤出，标记进度保留`);
    } else {
      c.isArchived = true;
      c.updatedAt = Date.now();
      flippedIds.delete(id);
      saveAll();
      schedulePush();
      render();
      toast(`「${c.word}」已移入「背过了」`);
    }
  }

  function toggleFlip(cardEl, id) {
    const flipped = cardEl.classList.toggle('flipped');
    if (flipped) flippedIds.add(id);
    else flippedIds.delete(id);
  }

  function onGridClick(e) {
    const cardEl = e.target.closest('.card');
    if (!cardEl) return;
    const id = cardEl.dataset.id;

    if (e.target.closest('.edit')) { startEdit(id); return; }
    if (e.target.closest('.del')) { removeCard(id); return; }
    if (e.target.closest('.btn-archive') || e.target.closest('.btn-restore')) {
      toggleArchive(id);
      return;
    }

    const markBtn = e.target.closest('.mark-btn');
    if (markBtn) {
      markCard(id, markBtn.dataset.mark, e.altKey);
      return;
    }

    const undoBtn = e.target.closest('[data-unmark]');
    if (undoBtn) {
      markCard(id, undoBtn.dataset.unmark, true);
      return;
    }

    toggleFlip(cardEl, id);
  }

  // 键盘：Enter / 空格翻转卡片
  function onGridKeydown(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const cardEl = e.target.closest('.card');
    if (!cardEl || e.target !== cardEl) return;
    e.preventDefault();
    toggleFlip(cardEl, cardEl.dataset.id);
  }

  function setSort(mode) {
    sortMode = mode;
    if (mode === 'random') randKeys.clear();
    [...el.sortSeg.children].forEach((b) => b.classList.toggle('active', b.dataset.sort === mode));
    render();
  }

  function setFolder(folder) {
    activeFolder = folder;
    [...el.folderSeg.children].forEach((b) => b.classList.toggle('active', b.dataset.folder === folder));
    render();
  }

  function toggleAllFlip() {
    if (cards.length === 0) return;

    const allFlipped = cards.every((c) => flippedIds.has(c.id));
    if (allFlipped) {
      cards.forEach((c) => flippedIds.delete(c.id));
      toast('已全部翻到正面 · 看单词');
    } else {
      cards.forEach((c) => flippedIds.add(c.id));
      toast('已全部翻到背面 · 看汉译');
    }
    render();
  }

  function bind() {
    el.form.addEventListener('submit', onSubmit);
    el.cancel.addEventListener('click', resetForm);

    el.folderSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-folder]');
      if (btn) setFolder(btn.dataset.folder);
    });

    el.sortSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sort]');
      if (btn) setSort(btn.dataset.sort);
    });

    el.reshuffle.addEventListener('click', () => setSort('random'));
    el.flipAll.addEventListener('click', toggleAllFlip);

    el.search.addEventListener('input', render);

    el.letterBar.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-letter]');
      if (!chip) return;
      activeLetter = chip.dataset.letter;
      render();
    });

    el.grid.addEventListener('click', onGridClick);
    el.grid.addEventListener('keydown', onGridKeydown);

    // 回到前台 / 网络恢复时拉一次，手机端也能看到最新
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pollCheck();
    });
    window.addEventListener('focus', () => pollCheck());
    window.addEventListener('online', () => pollCheck());
  }

  /* ================= 启动 ================= */
  cards = load();
  deleted = loadDeleted();
  bind();
  render();                 // 先渲染本地缓存，秒开
  syncNow('boot');          // 再和服务端对齐
  startEvents();            // 实时推送：别人一改，这边立刻跟上
  startPolling();           // 兼底：每 20 秒轻量检查一次版本
})();
