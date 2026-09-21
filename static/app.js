// Wiring: events, history, persistence, mode dispatch (player vs stream).
import * as GameState from './state.js';
import * as R from './render.js';
import { publish, onHello, onState, sendHello } from './sync.js';
import { t, getLang, setLang, applyStatic } from './i18n.js';
import { ServerStore, FolderStore, IdbStore, hasFsAccess, isServerAvailable, deckNameFromFiles, BundledDecks, rehydrateFrom } from './decks.js';

const STORAGE_KEY = 'goldfish-save';
const MAX_HISTORY = 100;

// Which card-context-menu / hotkey actions are valid from each zone.
const ZONE_ACTIONS = {
  field: ['toggleTap', 'toggleFaceDown', 'toHand', 'toTrash', 'toDeckTop', 'toDeckBottom', 'groupSelected', 'ungroup', 'swapPositions'],
  hand: ['toField', 'toTrash', 'toDeckTop', 'toDeckBottom'],
  trash: ['toHand', 'toField', 'toDeckTop', 'toDeckBottom'],
  deck: ['toHand', 'toField', 'toTrash'],
};

const params = new URLSearchParams(location.search);
const mode = params.get('view') === 'stream' ? 'stream' : 'player';
document.body.classList.add(mode === 'stream' ? 'mode-stream' : 'mode-player');

let config = null;
let store = null; // deck storage backend (server, chosen folder, or IndexedDB)
let bundled = null; // decks shipped with the static site (server mode: unused)

async function initStore() {
  if (await isServerAvailable()) return new ServerStore();
  if (hasFsAccess) {
    const fs = new FolderStore();
    await fs.restore();
    return fs;
  }
  return new IdbStore();
}

async function fetchConfig() {
  const res = await fetch(store.kind === 'server' ? 'api/config' : 'config.json', { cache: 'no-store' });
  return res.json();
}

function emptyCounters(cfg) {
  const c = {};
  for (const def of (cfg.counters || [])) c[def.key] = def.default;
  return c;
}

// Player-defined counter list saved in this browser, overriding config.json.
function loadCounterOverride() {
  try {
    const raw = localStorage.getItem('goldfish-counters');
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    for (const c of arr) {
      if (!c || typeof c !== 'object') return null;
      if (typeof c.key !== 'string' || !c.key) return null;
      if (typeof c.label !== 'string' || !c.label) return null;
      if (c.labelJa != null && typeof c.labelJa !== 'string') return null;
      if (!Number.isFinite(c.default)) return null;
      if (c.min != null && !Number.isFinite(c.min)) return null;
      if (c.max != null && !Number.isFinite(c.max)) return null;
    }
    return arr;
  } catch (e) { return null; }
}

function applyCounterConfig(cfg) {
  const override = loadCounterOverride();
  if (override) cfg.counters = override;
  return cfg;
}

function syncCounters(state, cfg) {
  if (!state) return;
  state.meta = state.meta || {};
  state.meta.config = cfg;
  state.counters = state.counters || {};
  const keys = new Set((cfg.counters || []).map((d) => d.key));
  for (const key of Object.keys(state.counters)) {
    if (!keys.has(key)) delete state.counters[key];
  }
  for (const def of (cfg.counters || [])) {
    if (!(def.key in state.counters)) state.counters[def.key] = def.default;
    else {
      let v = state.counters[def.key];
      if (def.min != null && v < def.min) v = def.min;
      if (def.max != null && v > def.max) v = def.max;
      state.counters[def.key] = v;
    }
  }
}

function applyBodyLangClass() {
  document.body.classList.toggle('lang-ja', getLang() === 'ja');
  document.body.classList.toggle('lang-en', getLang() !== 'ja');
}
applyBodyLangClass();

// Old-schema saves (pre free-field redesign) lack zones.field; discard those outright.
function migrateState(state, cfg) {
  if (!state || !state.cards || !state.zones) return null;
  if (!Array.isArray(state.zones.field)) return null;
  if (!Array.isArray(state.zones.deck) || !Array.isArray(state.zones.hand) || !Array.isArray(state.zones.trash)) return null;
  if (!state.positions || typeof state.positions !== 'object') state.positions = {};
  if (!Array.isArray(state.groups)) state.groups = [];
  syncCounters(state, cfg);
  if (!Array.isArray(state.log)) state.log = [];
  if (typeof state.turn !== 'number') state.turn = 1;
  if (!state.lastRoll || typeof state.lastRoll !== 'object') state.lastRoll = null;
  // Old saves store y as a fraction of field HEIGHT; convert to fraction of field WIDTH.
  if (state.coordVersion !== 2) {
    const rect = fieldEl ? fieldEl.getBoundingClientRect() : null;
    if (rect && rect.width > 0 && rect.height > 0) {
      const ratio = rect.height / rect.width;
      for (const id in state.positions) {
        const p = state.positions[id];
        if (p && typeof p.y === 'number') p.y = p.y * ratio;
      }
    }
    state.coordVersion = 2;
  }
  return state;
}

// Field-relative card sizing: --card-w derives from #field's rendered width so
// cards occupy the same fraction of the field in both player and stream modes.
// x and y (positions) are both fractions of this same width, so --field-w also
// drives vertical placement (see render.js renderField). --field-unit applies the
// per-mode zoom factor on top of --field-w; render and drag math key off it.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;
const ZOOM_KEY = 'goldfish-zoom-' + mode;

function clampZoom(z) {
  let v = Math.round(z * 10) / 10;
  if (v < ZOOM_MIN) v = ZOOM_MIN;
  if (v > ZOOM_MAX) v = ZOOM_MAX;
  return v;
}

function loadZoom() {
  try {
    const v = parseFloat(localStorage.getItem(ZOOM_KEY));
    if (Number.isFinite(v)) return clampZoom(v);
  } catch (e) { /* ignore */ }
  return 1;
}

function saveZoom(z) {
  try { localStorage.setItem(ZOOM_KEY, String(z)); } catch (e) { /* ignore */ }
}

let zoom = loadZoom();

const fieldEl = document.getElementById('field');
let setFieldWidthVar = () => {};
if (fieldEl && 'ResizeObserver' in window) {
  setFieldWidthVar = () => {
    const w = fieldEl.getBoundingClientRect().width;
    if (!w) return;
    document.documentElement.style.setProperty('--field-w', w + 'px');
    document.documentElement.style.setProperty('--field-unit', (w * zoom) + 'px');
  };
  new ResizeObserver(setFieldWidthVar).observe(fieldEl);
  setFieldWidthVar();
}

const zoomOutBtn = document.getElementById('zoom-out');
const zoomInBtn = document.getElementById('zoom-in');
const zoomValueEl = document.getElementById('zoom-value');

function updateZoomUi() {
  if (zoomValueEl) zoomValueEl.textContent = Math.round(zoom * 100) + '%';
  if (zoomOutBtn) zoomOutBtn.disabled = zoom <= ZOOM_MIN;
  if (zoomInBtn) zoomInBtn.disabled = zoom >= ZOOM_MAX;
}

function setZoom(z) {
  zoom = clampZoom(z);
  saveZoom(zoom);
  setFieldWidthVar();
  updateZoomUi();
}

if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => setZoom(zoom - ZOOM_STEP));
if (zoomInBtn) zoomInBtn.addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
if (zoomValueEl) zoomValueEl.addEventListener('click', () => setZoom(1));
if (fieldEl) {
  fieldEl.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  }, { passive: false });
}
updateZoomUi();

if (mode === 'stream') {
  initStream();
} else {
  initPlayer();
}

// ---------------------------------------------------------------- stream ---

async function initStream() {
  store = await initStore();
  config = await fetchConfig();
  const defaultCounters = config.counters || [];
  applyCounterConfig(config);
  applyStatic(document);

  const sidePiles = document.getElementById('side-piles');
  const pileDeck = document.getElementById('pile-deck');
  const pileTrash = document.getElementById('pile-trash');
  if (sidePiles && pileDeck && pileTrash) {
    sidePiles.appendChild(pileDeck);
    sidePiles.appendChild(pileTrash);
  }
  setFieldWidthVar();

  window.addEventListener('storage', (e) => {
    if (e.key === 'goldfish-lang') {
      applyBodyLangClass();
      applyStatic(document);
      renderStream(lastStreamState, lastStreamUi);
    }
    if (e.key === 'goldfish-counters') {
      config.counters = defaultCounters;
      applyCounterConfig(config);
      renderStream(lastStreamState, lastStreamUi);
    }
  });
  let lastStreamState = null;
  let lastStreamUi = null;
  let logHovered = false;
  let logDirty = false;
  let logFadeTimer = null;
  let lastLogLength = -1;
  let freshCount = 0;
  const els = {
    waiting: document.getElementById('waiting-banner'),
    fieldCards: document.getElementById('field-cards'),
    deckBackImg: document.getElementById('deck-back-img'),
    deckCount: document.getElementById('deck-count'),
    deckCountBadge: document.getElementById('deck-count-badge'),
    trashCount: document.getElementById('trash-count'),
    trashCountBadge: document.getElementById('trash-count-badge'),
    trashTopImg: document.getElementById('trash-top-img'),
    trashPileBox: document.getElementById('trash-pile-box'),
    countersRow: document.getElementById('stream-counters-row'),
    logPanel: document.getElementById('log-panel'),
    logList: document.getElementById('log-list'),
    streamHandBadge: document.getElementById('stream-hand-badge'),
    streamTurn: document.getElementById('stream-turn-indicator'),
    streamDeckName: document.getElementById('stream-deck-name'),
    trashModal: document.getElementById('trash-modal'),
    trashGrid: document.getElementById('trash-grid'),
    streamNotice: document.getElementById('stream-notice'),
    streamNoticeText: document.getElementById('stream-notice-text'),
    diceOverlay: document.getElementById('dice-overlay'),
    diceOverlayStage: document.getElementById('dice-overlay-stage'),
    diceOverlayResult: document.getElementById('dice-overlay-result'),
  };

  els.logPanel.addEventListener('mouseenter', () => { logHovered = true; });
  els.logPanel.addEventListener('mouseleave', () => {
    logHovered = false;
    if (logDirty && lastStreamState) { logDirty = false; R.renderLog(els.logList, lastStreamState.log || [], freshCount); }
  });

  // -- log fade (mirrors the player window's fresh-entries/fade behaviour) --

  function restartLogFade() {
    if (logFadeTimer) clearTimeout(logFadeTimer);
    els.logPanel.classList.remove('faded');
    logFadeTimer = setTimeout(() => {
      freshCount = 0;
      els.logPanel.classList.add('faded');
      if (lastStreamState && !logHovered) R.renderLog(els.logList, lastStreamState.log || [], 0);
    }, 6000);
  }

  function checkLogFade() {
    const len = lastStreamState ? (lastStreamState.logTotal || (lastStreamState.log || []).length) : 0;
    if (len !== lastLogLength) {
      if (lastLogLength >= 0 && len > lastLogLength) freshCount += len - lastLogLength;
      else freshCount = 0;
      lastLogLength = len;
      restartLogFade();
    }
  }

  let diceOverlayHideTimer = null;
  let lastSeenRollSeq = null;
  function showDiceOverlay(lastRoll) {
    if (diceOverlayHideTimer) clearTimeout(diceOverlayHideTimer);
    els.diceOverlay.classList.remove('fade-out');
    els.diceOverlay.hidden = false;
    els.diceOverlayResult.textContent = '';
    R.playDiceAnimation(els.diceOverlayStage, lastRoll, {
      onDone: () => {
        els.diceOverlayResult.textContent = R.formatDiceRoll(lastRoll);
        diceOverlayHideTimer = setTimeout(() => {
          els.diceOverlay.classList.add('fade-out');
          diceOverlayHideTimer = setTimeout(() => { els.diceOverlay.hidden = true; }, 600);
        }, 4000);
      },
    });
  }

  function updateViewing(state, ui) {
    const viewing = ui;
    if (state && viewing && viewing.kind === 'trash') {
      const items = state.zones.trash.map((id) => ({ instanceId: id, card: state.cards[id] }));
      R.renderModalGrid(els.trashGrid, items, state.cardBack);
      els.trashModal.hidden = false;
    } else {
      els.trashModal.hidden = true;
    }
    if (viewing && viewing.kind === 'deck') {
      els.streamNoticeText.textContent = typeof viewing.n === 'number'
        ? t('lookingAtDeckTop', { n: viewing.n })
        : t('lookingAtDeck');
      els.streamNotice.hidden = false;
    } else {
      els.streamNotice.hidden = true;
    }
  }

  function renderStream(state, ui) {
    lastStreamState = state;
    lastStreamUi = ui;
    if (!state) {
      R.renderField(els.fieldCards, [], {}, {}, null);
      els.deckBackImg.src = 'static/cardback.svg';
      els.deckCountBadge.textContent = '0';
      els.trashCountBadge.textContent = '0';
      els.trashTopImg.hidden = true;
      els.trashPileBox.hidden = false;
      R.renderCounters(els.countersRow, emptyCounters(config), config.counters || [], { readOnly: true });
      els.streamHandBadge.textContent = t('streamHandBadge', { n: 0 });
      els.streamTurn.textContent = '';
      els.streamDeckName.textContent = '';
      els.trashModal.hidden = true;
      els.streamNotice.hidden = true;
      els.logPanel.hidden = true;
      R.renderLog(els.logList, []);
      return;
    }
    const cardBack = state.cardBack || 'static/cardback.svg';
    R.renderField(els.fieldCards, state.zones.field, state.positions || {}, state.cards, cardBack, state.groups || []);
    R.renderDeckPile(state, { imgEl: els.deckBackImg, badgeEl: els.deckCountBadge });
    R.renderTrashPile(state, { imgEl: els.trashTopImg, boxEl: els.trashPileBox, badgeEl: els.trashCountBadge });
    R.renderCounters(els.countersRow, { ...emptyCounters(config), ...(state.counters || {}) }, config.counters || [], { readOnly: true });
    els.streamHandBadge.textContent = t('streamHandBadge', { n: R.handCount(state) });
    els.streamTurn.textContent = t('turnIndicator', { n: state.turn });
    els.streamDeckName.textContent = state.deckName || '';
    updateViewing(state, ui);
    els.logPanel.hidden = false;
    checkLogFade();
    if (logHovered) logDirty = true; else R.renderLog(els.logList, state.log || [], freshCount);
    if (state.lastRoll && state.lastRoll.seq !== lastSeenRollSeq) {
      lastSeenRollSeq = state.lastRoll.seq;
      showDiceOverlay(state.lastRoll);
    }
  }

  onState((redactedState, ui) => {
    els.waiting.hidden = true;
    renderStream(redactedState, ui);
  });

  renderStream(null, null);
  sendHello();
}

// ---------------------------------------------------------------- player ---

function getEls() {
  return {
    btnBurger: document.getElementById('btn-burger'),
    burgerMenu: document.getElementById('burger-menu'),
    deckSelect: document.getElementById('deck-select'),
    btnNewGame: document.getElementById('btn-new-game'),
    importStatus: document.getElementById('import-status'),
    importDisk: document.getElementById('import-disk'),
    btnPickFolder: document.getElementById('btn-pick-folder'),
    folderLabel: document.getElementById('folder-label'),
    folderBanner: document.getElementById('folder-banner'),
    btnReconnectFolder: document.getElementById('btn-reconnect-folder'),
    btnOpenStream: document.getElementById('btn-open-stream'),
    btnToggleLog: document.getElementById('btn-toggle-log'),
    btnLanguage: document.getElementById('btn-language'),
    btnCounters: document.getElementById('btn-counters'),
    btnResetData: document.getElementById('btn-reset-data'),

    btnNextTurn: document.getElementById('btn-next-turn'),
    btnUndo: document.getElementById('btn-undo'),
    btnDice: document.getElementById('btn-dice'),
    deckNameLabel: document.getElementById('deck-name-label'),
    countersRow: document.getElementById('counters-row'),

    btnFieldMenu: document.getElementById('btn-field-menu'),
    fieldMenu: document.getElementById('field-menu'),
    field: document.getElementById('field'),
    fieldCards: document.getElementById('field-cards'),
    cardPreview: document.getElementById('card-preview'),
    logPanel: document.getElementById('log-panel'),
    logList: document.getElementById('log-list'),

    btnHandMenu: document.getElementById('btn-hand-menu'),
    handMenu: document.getElementById('hand-menu'),
    handStrip: document.getElementById('hand-strip'),
    handCountBadge: document.getElementById('hand-count-badge'),

    pileDeck: document.getElementById('pile-deck'),
    btnDeckMenu: document.getElementById('btn-deck-menu'),
    deckMenu: document.getElementById('deck-menu'),
    deckCount: document.getElementById('deck-count'),
    deckCountBadge: document.getElementById('deck-count-badge'),
    deckBackImg: document.getElementById('deck-back-img'),

    pileTrash: document.getElementById('pile-trash'),
    btnTrashMenu: document.getElementById('btn-trash-menu'),
    trashMenu: document.getElementById('trash-menu'),
    trashCount: document.getElementById('trash-count'),
    trashCountBadge: document.getElementById('trash-count-badge'),
    trashTopImg: document.getElementById('trash-top-img'),
    trashPileBox: document.getElementById('trash-pile-box'),

    cardContextMenu: document.getElementById('card-context-menu'),

    searchModal: document.getElementById('search-modal'),
    searchGrid: document.getElementById('search-grid'),
    searchInput: document.getElementById('search-input'),
    searchNoMatches: document.getElementById('search-no-matches'),
    searchClose: document.getElementById('search-close'),

    lookModal: document.getElementById('look-modal'),
    lookGrid: document.getElementById('look-grid'),
    lookShuffle: document.getElementById('look-shuffle'),
    lookPutbackTop: document.getElementById('look-putback-top'),
    lookPutbackBottom: document.getElementById('look-putback-bottom'),
    lookClose: document.getElementById('look-close'),

    trashModal: document.getElementById('trash-modal'),
    trashGrid: document.getElementById('trash-grid'),
    trashClose: document.getElementById('trash-close'),

    countersModal: document.getElementById('counters-modal'),
    countersClose: document.getElementById('counters-close'),
    countersTbody: document.getElementById('counters-tbody'),
    countersAdd: document.getElementById('counters-add'),
    countersReset: document.getElementById('counters-reset'),
    countersSave: document.getElementById('counters-save'),
    countersError: document.getElementById('counters-error'),

    diceModal: document.getElementById('dice-modal'),
    diceClose: document.getElementById('dice-close'),
    diceSidesRow: document.getElementById('dice-sides-row'),
    diceCountMinus: document.getElementById('dice-count-minus'),
    diceCountValue: document.getElementById('dice-count-value'),
    diceCountPlus: document.getElementById('dice-count-plus'),
    diceRollBtn: document.getElementById('dice-roll-btn'),
    diceStage: document.getElementById('dice-stage'),
    diceResult: document.getElementById('dice-result'),

    shufflePrompt: document.getElementById('shuffle-prompt'),
    shufflePromptYes: document.getElementById('shuffle-prompt-yes'),
    shufflePromptNo: document.getElementById('shuffle-prompt-no'),

    cardMeasure: document.getElementById('card-measure'),
    app: document.getElementById('app'),
    tutorial: document.getElementById('tutorial'),
    selectRect: document.getElementById('select-rect'),
    tutorialNoDecks: document.getElementById('tutorial-no-decks'),
  };
}

async function initPlayer() {
  store = await initStore();
  bundled = new BundledDecks();
  if (store.kind !== 'server') await bundled.init();
  config = await fetchConfig();
  const defaultCounters = config.counters || [];
  applyCounterConfig(config);
  const els = getEls();
  document.body.classList.toggle('static-mode', store.kind !== 'server');
  document.body.classList.toggle('folder-mode', store.kind === 'folder');

  let state = null;
  let logHovered = false;
  let logDirty = false;
  els.logPanel.addEventListener('mouseenter', () => {
    if (!showLog) {
      if (logFadeTimer) clearTimeout(logFadeTimer);
      freshCount = 0;
      els.logPanel.classList.add('faded');
      if (state) R.renderLog(els.logList, state.log, 0);
      return;
    }
    logHovered = true;
  });
  els.logPanel.addEventListener('mouseleave', () => {
    logHovered = false;
    if (logDirty && state) { logDirty = false; R.renderLog(els.logList, state.log, freshCount); }
  });
  let showLog = false;
  let history = [];
  let editingCounterKey = null;
  let countersWorking = []; // local working copy while the counters modal is open, discarded unless Save is pressed
  let contextCardId = null;
  let hoveredInstanceId = null;
  let lookIds = [];
  let lookDragId = null;
  let lookDidDrag = false;
  let uiViewing = null; // null | {kind:'trash'} | {kind:'deck', n:null|number} — mirrored to stream via publish()
  let dragState = null;
  const selectedIds = new Set(); // field cards selected for group drag (UI-only, not persisted)
  // Selection is group-aware: selecting any member selects the whole group.
  function applySelectionClasses() {
    for (const id of [...selectedIds]) if (!state || !state.zones.field.includes(id)) selectedIds.delete(id);
    for (const id of [...selectedIds]) for (const m of (groupOf(id) || [])) selectedIds.add(m);
    els.fieldCards.querySelectorAll('.field-card').forEach((el) => {
      el.classList.toggle('selected', selectedIds.has(el.dataset.instanceId));
    });
  }
  let dragGrab = null; // {fx, fy} grab point as a fraction of the dragged card's own size (HTML5 DnD)
  let activeCountPrompt = null; // {li, restore} for the currently open inline count-entry form, if any
  let deckListEmpty = false;
  let deckCardMoved = false; // set when a card leaves the deck via the search/look modal; checked on modal close
  let shuffleTimer = null;
  let logFadeTimer = null;
  let lastLogLength = -1;
  let freshCount = 0;
  let diceSides = 6;
  let diceCount = 1;
  let diceRolling = false;

  loadDicePrefs();
  loadPersisted();
  wireEvents();
  if ('ResizeObserver' in window) new ResizeObserver(() => fitHand()).observe(els.handStrip.parentElement);
  // Fallback for hands too large to fit even at maximum overlap: wheel scrolls the strip.
  els.handStrip.parentElement.addEventListener('wheel', (e) => {
    const sc = els.handStrip.parentElement;
    if (sc.scrollWidth <= sc.clientWidth) return;
    sc.scrollLeft += e.deltaY + e.deltaX;
    e.preventDefault();
  }, { passive: false });
  applyStatic(document);
  onHello(() => publish(state, uiViewing));
  render();
  connectStore();
  checkLogFade();

  // Static mode: saved card images are blob URLs that died with the previous page, so
  // re-resolve them from the store; a chosen folder may first need the user to re-grant access.
  async function connectStore() {
    const needsGesture = store.kind === 'folder' && store.dir && !(await store.hasPermission());
    els.folderBanner.hidden = !needsGesture;
    if (needsGesture) { render(); return; }
    if (state && store.kind !== 'server') {
      let ok = await store.rehydrate(state);
      if (!ok && bundled.has(state.deckName)) ok = rehydrateFrom(state, bundled.load(state.deckName));
      if (!ok) { state = null; history = []; }
    }
    await loadDeckList();
    render();
    publish(state, uiViewing);
  }

  async function reconnectFolder() {
    if (!(await store.hasPermission(true))) return;
    await connectStore();
  }

  async function pickFolder() {
    try {
      await store.pick();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      els.importStatus.textContent = t('importFailedWithMsg', { msg: e.message });
      return;
    }
    if (state) { state = null; history = []; }
    await connectStore();
  }

  // -- log fade --

  function restartLogFade() {
    if (logFadeTimer) clearTimeout(logFadeTimer);
    els.logPanel.classList.remove('faded');
    logFadeTimer = setTimeout(() => {
      freshCount = 0;
      els.logPanel.classList.add('faded');
      if (state && !logHovered) R.renderLog(els.logList, state.log, 0);
    }, showLog ? 6000 : 2500);
  }

  function checkLogFade() {
    const len = state ? (state.logTotal || state.log.length) : 0;
    if (len !== lastLogLength) {
      if (lastLogLength >= 0 && len > lastLogLength) freshCount += len - lastLogLength;
      else freshCount = 0;
      lastLogLength = len;
      restartLogFade();
    }
  }

  function showCardPreview(card, cardBack, clientX) {
    if (typeof clientX === 'number') {
      const fr = els.field.getBoundingClientRect();
      els.cardPreview.classList.toggle('preview-left', clientX > fr.left + fr.width / 2);
    }
    R.renderPreview(els.cardPreview, card, cardBack);
  }

  function hideCardPreview() {
    R.renderPreview(els.cardPreview, null, null);
  }

  // Flips the preview to the opposite edge as soon as the pointer enters it
  // (e.g. a hovered card sits right under where the preview docked). Cooldown
  // avoids rapid flip-flop right at the boundary between the two positions.
  let lastPreviewFlip = 0;
  function maybeFlipPreview(clientX, clientY) {
    if (els.cardPreview.hidden) return;
    const r = els.cardPreview.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return;
    const now = performance.now();
    if (now - lastPreviewFlip < 150) return;
    els.cardPreview.classList.toggle('preview-left');
    lastPreviewFlip = now;
  }

  // -- persistence --

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, showLog }));
    } catch (e) { /* ignore quota / privacy errors */ }
  }

  function loadPersisted() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && data.state) {
        state = migrateState(data.state, config);
        if (typeof data.showLog === 'boolean') showLog = data.showLog;
      }
    } catch (e) { /* ignore corrupt save */ }
  }

  // -- dispatch / history --

  function pushHistory() {
    history.push(state);
    if (history.length > MAX_HISTORY) history.shift();
  }

  function dispatch(action) {
    if (!state) return;
    const next = GameState.reduce(state, action);
    if (next === state) return;
    pushHistory();
    state = next;
    afterChange();
    sparkle([action]);
  }

  function dispatchBatch(actions) {
    if (!state || actions.length === 0) return;
    let s = state;
    for (const a of actions) s = GameState.reduce(s, a);
    if (s === state) return;
    pushHistory();
    state = s;
    afterChange();
    sparkle(actions);
  }

  const CHARM = new TextDecoder().decode(Uint8Array.from(atob('6Iqx6K2c'), (c) => c.charCodeAt(0)));
  function sparkle(actions) {
    const ids = new Set();
    for (const a of actions) {
      if (a.instanceId) ids.add(a.instanceId);
      if (Array.isArray(a.instanceIds)) a.instanceIds.forEach((id) => ids.add(id));
      if (Array.isArray(a.moves)) a.moves.forEach((m) => ids.add(m.instanceId));
      if (a.a) ids.add(a.a);
      if (a.b) ids.add(a.b);
    }
    for (const id of ids) {
      const card = state.cards[id];
      if (!card || !(card.name || '').includes(CHARM)) continue;
      const el = document.querySelector(`.card[data-instance-id="${CSS.escape(id)}"]`);
      const r = el ? el.getBoundingClientRect() : null;
      const cx = r && r.width ? r.left + r.width / 2 : window.innerWidth / 2;
      const cy = r && r.height ? r.top + r.height / 2 : window.innerHeight / 2;
      for (let i = 0; i < 8; i++) {
        const h = document.createElement('span');
        h.className = 'heart-particle';
        h.textContent = '♥';
        const ang = (Math.PI * 2 * i) / 8 + Math.random() * 0.6;
        const dist = 40 + Math.random() * 40;
        h.style.left = cx + 'px';
        h.style.top = cy + 'px';
        h.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
        h.style.setProperty('--dy', Math.sin(ang) * dist - 30 + 'px');
        h.style.animationDelay = (Math.random() * 120) + 'ms';
        document.body.appendChild(h);
        h.addEventListener('animationend', () => h.remove());
      }
    }
  }

  function undo() {
    if (history.length === 0) return;
    state = history.pop();
    afterChange();
  }

  function markDeckShuffled() {
    deckCardMoved = false;
    hideShufflePrompt();
  }

  function shuffleDeck() {
    dispatch({ type: 'shuffle' });
    markDeckShuffled();
  }

  function afterChange() {
    persist();
    render();
    publish(state, uiViewing);
    checkLogFade();
    if (!els.lookModal.hidden) renderLookGrid();
    if (!els.trashModal.hidden) renderTrashGrid();
    if (!els.searchModal.hidden) renderSearchGrid();
    // The hovered card may have just left the pointer (moved to another zone).
    if (hoveredInstanceId && !document.querySelector('.card:hover')) {
      hoveredInstanceId = null;
      hideCardPreview();
    }
  }

  // -- deck list / new game / import --

  async function loadDeckList() {
    let decks = [];
    try { decks = await store.list(); } catch (e) { /* no access yet */ }
    try {
      const names = new Set(decks.map((d) => d.name));
      decks = bundled.list().filter((d) => !names.has(d.name)).concat(decks);
    } catch (e) { /* bad manifest */ }
    els.deckSelect.innerHTML = '';
    for (const d of decks) {
      const opt = document.createElement('option');
      opt.value = d.name;
      opt.textContent = `${d.name} (${d.cardCount})`;
      els.deckSelect.appendChild(opt);
    }
    if (state && state.deckName) els.deckSelect.value = state.deckName;
    deckListEmpty = decks.length === 0;
    els.folderLabel.textContent = store.kind === 'folder' ? (store.label || t('noFolderChosen')) : '';
  }

  async function loadDeck(deckName) {
    let deck = null;
    try { deck = await store.load(deckName); } catch (e) { /* no access */ }
    return deck || (bundled.has(deckName) ? bundled.load(deckName) : null);
  }

  async function newGame(deckName) {
    const deckJson = await loadDeck(deckName);
    if (!deckJson) return;
    history = [];
    state = GameState.newGame(deckJson, config);
    hideShufflePrompt();
    deckCardMoved = false;
    afterChange();
  }

  // Import a deck folder chosen via the file picker (webkitdirectory): the folder name
  // becomes the deck name and its images are copied into the deck store.
  async function doImportDisk(files) {
    if (!files || files.length === 0) return;
    const deckName = deckNameFromFiles(files);
    if (!deckName) { els.importStatus.textContent = t('importFailed'); return; }
    els.importStatus.textContent = t('importing');
    try {
      if (store.kind === 'folder' && !store.dir) await store.pick();
      const deck = await store.importFiles(deckName, files);
      if (!deck || deck.cards.length === 0) throw new Error(t('noCardImages'));
      els.importStatus.textContent = t('imported', { name: deck.name });
      await loadDeckList();
      els.deckSelect.value = deck.name;
      render();
    } catch (e) {
      if (e && e.name === 'AbortError') { els.importStatus.textContent = ''; return; }
      els.importStatus.textContent = t('importFailedWithMsg', { msg: e.message });
    }
  }

  // -- render --

  // Overlap hand cards just enough that the whole hand fits the strip width, so
  // every card stays visible and clickable however many are held.
  // First by overlapping harder, then by shrinking the cards (down to half size).
  function fitHand() {
    const n = state ? state.zones.hand.length : 0;
    const strip = els.handStrip;
    strip.style.removeProperty('--hand-card-scale');
    const first = strip.querySelector('.card');
    if (n < 2 || !first) { strip.style.removeProperty('--hand-overlap'); return; }
    const MIN_VISIBLE = 8; // px of each overlapped card left showing
    const cw0 = first.offsetWidth;
    const room = strip.parentElement.clientWidth - 36;
    // Width at which n cards fit showing MIN_VISIBLE each: cw + (n-1)*MIN_VISIBLE <= room
    const scale = Math.max(0.5, Math.min(1, (room - (n - 1) * MIN_VISIBLE) / cw0));
    if (scale < 1) strip.style.setProperty('--hand-card-scale', String(scale));
    const cw = cw0 * scale;
    const avail = room - (n - 1) * 8;
    const needed = (n * cw - avail) / (n - 1);
    const overlap = Math.min(cw + 8 - MIN_VISIBLE, Math.max(22, needed)); // +8 offsets the flex gap
    strip.style.setProperty('--hand-overlap', overlap + 'px');
    if (needed <= overlap) strip.parentElement.scrollLeft = 0;
  }

  function render() {
    if (state) {
      const label = t('turnIndicator', { n: state.turn });
      els.btnNextTurn.innerHTML = label.replace(String(state.turn), `<b>${state.turn}</b>`) + ' <span class="turn-arrow">›</span>';
    } else {
      els.btnNextTurn.textContent = t('noGame');
    }
    els.btnNextTurn.title = t('nextTurn');
    els.deckNameLabel.textContent = state ? state.deckName : '';
    els.btnUndo.disabled = history.length === 0;
    els.btnNextTurn.disabled = !state;
    els.btnDice.disabled = !state;
    els.btnToggleLog.textContent = showLog ? t('hideLog') : t('showLog');
    els.logPanel.hidden = false;
    els.logPanel.classList.toggle('collapsed', !showLog);

    if (!state) {
      R.renderField(els.fieldCards, [], {}, {}, null);
      els.deckBackImg.src = 'static/cardback.svg';
      els.deckCountBadge.textContent = '0';
      els.trashCountBadge.textContent = '0';
      els.trashTopImg.hidden = true;
      els.trashPileBox.hidden = false;
      els.handCountBadge.textContent = '0';
      R.renderCounters(els.countersRow, emptyCounters(config), config.counters || [], { editingKey: editingCounterKey });
      R.renderLog(els.logList, []);
      els.handStrip.innerHTML = '';
      els.handStrip.hidden = false;
      els.tutorial.hidden = false;
      els.tutorialNoDecks.hidden = !deckListEmpty;
      els.cardPreview.hidden = true;
      return;
    }

    els.tutorial.hidden = true;
    const cardBack = state.cardBack || 'static/cardback.svg';
    R.renderField(els.fieldCards, state.zones.field, state.positions, state.cards, cardBack, state.groups || []);
    applySelectionClasses();
    R.renderDeckPile(state, { imgEl: els.deckBackImg, badgeEl: els.deckCountBadge });
    R.renderTrashPile(state, { imgEl: els.trashTopImg, boxEl: els.trashPileBox, badgeEl: els.trashCountBadge });
    els.handCountBadge.textContent = String(R.handCount(state));
    R.renderCounters(els.countersRow, state.counters, config.counters || [], { editingKey: editingCounterKey });
    checkLogFade();
    if (logHovered) logDirty = true; else R.renderLog(els.logList, state.log, freshCount);

    els.handStrip.hidden = false;
    R.renderListStrip(els.handStrip, state.zones.hand, state.cards, cardBack, 'hand');
    fitHand();
  }

  // -- helpers --


  // Turns a dropdown <li> into an inline number-entry mini-form (no window.prompt: unsupported
  // in the embedded browser). Dropdown stays open until the user confirms or cancels.
  function openCountPrompt(li, { def = 1, max = null } = {}, onConfirm) {
    if (activeCountPrompt) activeCountPrompt.restore();
    li.classList.add('count-form-li');
    const label = document.createElement('span');
    label.className = 'count-form-label';
    label.textContent = t('count') + ':';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    if (max != null) input.max = String(max);
    input.value = String(Math.min(def, max || def));
    input.className = 'count-form-input';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'count-form-ok';
    okBtn.textContent = t('ok');
    li.appendChild(label);
    li.appendChild(input);
    li.appendChild(okBtn);

    function stopClick(e) { e.stopPropagation(); }

    function restore() {
      li.classList.remove('count-form-li');
      li.removeEventListener('click', stopClick);
      label.remove();
      input.remove();
      okBtn.remove();
      if (activeCountPrompt && activeCountPrompt.li === li) activeCountPrompt = null;
    }
    function confirmValue() {
      let n = parseInt(input.value, 10);
      if (Number.isFinite(n) && max != null) n = Math.min(n, max);
      closeMenus();
      if (Number.isFinite(n) && n > 0) onConfirm(n);
    }
    function cancel() {
      closeMenus();
    }
    li.addEventListener('click', stopClick);
    okBtn.addEventListener('click', (e) => { e.stopPropagation(); confirmValue(); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); confirmValue(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.focus();
    input.select();
    activeCountPrompt = { li, restore };
  }

  // -- dice modal --

  const DICE_SIDES = [4, 6, 8, 10, 12, 20];
  const DICE_PREFS_KEY = 'goldfish-dice';

  function loadDicePrefs() {
    try {
      const raw = localStorage.getItem(DICE_PREFS_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && DICE_SIDES.includes(data.sides)) diceSides = data.sides;
      if (data && Number.isFinite(data.count)) diceCount = Math.max(1, Math.min(10, data.count));
    } catch (e) { /* ignore corrupt prefs */ }
  }

  function persistDicePrefs() {
    try { localStorage.setItem(DICE_PREFS_KEY, JSON.stringify({ sides: diceSides, count: diceCount })); } catch (e) { /* ignore */ }
  }

  function renderDiceChips() {
    els.diceSidesRow.innerHTML = '';
    for (const sides of DICE_SIDES) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'dice-chip' + (sides === diceSides ? ' active' : '');
      chip.textContent = 'd' + sides;
      chip.dataset.sides = String(sides);
      els.diceSidesRow.appendChild(chip);
    }
  }

  function renderDiceCount() {
    els.diceCountValue.textContent = String(diceCount);
    els.diceCountMinus.disabled = diceCount <= 1;
    els.diceCountPlus.disabled = diceCount >= 10;
  }

  function renderDiceStageIdle() {
    R.renderDiceStage(els.diceStage, diceSides, diceCount);
    els.diceResult.textContent = '';
  }

  function openDiceModal() {
    closeMenus();
    renderDiceChips();
    renderDiceCount();
    renderDiceStageIdle();
    els.diceModal.hidden = false;
  }

  function rollDiceNow() {
    if (!state || diceRolling) return;
    dispatch({ type: 'rollDice', sides: diceSides, count: diceCount });
    if (!state.lastRoll) return;
    diceRolling = true;
    els.diceRollBtn.disabled = true;
    els.diceResult.textContent = '';
    R.playDiceAnimation(els.diceStage, state.lastRoll, {
      onDone: () => {
        diceRolling = false;
        els.diceRollBtn.disabled = false;
        els.diceResult.textContent = R.formatDiceRoll(state.lastRoll);
      },
    });
  }

  // Top-left corner, cascading down-right by a quarter card while the spot is
  // taken; when a cascade runs off the field, start a new one a card to the
  // right. Always clamped so the card stays fully inside the field.
  function findFreeSpot() {
    const rect = els.field.getBoundingClientRect();
    const unit = rect.width * zoom || 1;
    const cw = (els.cardMeasure.offsetWidth || 100) / unit;
    const ch = (els.cardMeasure.offsetHeight || 140) / unit;
    const maxX = Math.max(0, rect.width / unit - cw);
    const maxY = Math.max(0, rect.height / unit - ch);
    const margin = 0.01;
    const step = cw * 0.25;
    const positions = state.zones.field.map((id) => state.positions[id]).filter(Boolean);
    const taken = (x, y) => positions.some((p) => Math.abs(p.x - x) < step / 2 && Math.abs(p.y - y) < step / 2);
    for (let x0 = margin; x0 <= maxX; x0 += cw * 1.1) {
      for (let x = x0, y = margin; x <= maxX && y <= maxY; x += step, y += step) {
        if (!taken(x, y)) return { x, y };
      }
    }
    return { x: Math.min(margin, maxX), y: Math.min(margin, maxY) };
  }

  function zoneOfCard(id) {
    if (!state) return null;
    if (state.zones.field.includes(id)) return 'field';
    if (state.zones.hand.includes(id)) return 'hand';
    if (state.zones.trash.includes(id)) return 'trash';
    if (state.zones.deck.includes(id)) return 'deck';
    return null;
  }

  function groupOf(id) {
    if (!state) return null;
    return (state.groups || []).find((g) => g.includes(id)) || null;
  }

  // Distinct units (a unit = its group, or a lone card) covering selectedIds.
  // Grouping is only meaningful when the selection spans more than one unit.
  function canGroupSelection() {
    return selectedIds.size >= 2 && selectedUnits().length >= 2;
  }

  function selectedUnits() {
    const units = [];
    const seen = new Set();
    for (const id of selectedIds) {
      if (!state.zones.field.includes(id)) continue;
      const unit = groupOf(id) || [id];
      if (seen.has(unit[0])) continue;
      seen.add(unit[0]);
      units.push(unit);
    }
    return units;
  }

  function swapSelected() {
    const units = selectedUnits();
    if (units.length !== 2) return;
    dispatch({ type: 'swapOnField', a: units[0][0], b: units[1][0] });
  }

  function applyCardAction(action, id) {
    if (!state || !state.cards[id]) return;
    const zone = zoneOfCard(id);
    if (zone && !(ZONE_ACTIONS[zone] || []).includes(action)) return;
    if (action === 'toField') {
      const spot = findFreeSpot();
      dispatch({ type: 'moveCard', instanceId: id, to: 'field', x: spot.x, y: spot.y });
    } else if (action === 'toggleTap') {
      dispatch({ type: 'toggleTap', instanceId: id });
    } else if (action === 'toggleFaceDown') {
      dispatch({ type: 'toggleFaceDown', instanceId: id });
    } else if (action === 'toHand') {
      dispatch({ type: 'moveCard', instanceId: id, to: 'hand' });
    } else if (action === 'toTrash') {
      dispatch({ type: 'moveCard', instanceId: id, to: 'trash' });
    } else if (action === 'toDeckTop') {
      dispatch({ type: 'toDeckTop', instanceId: id });
    } else if (action === 'toDeckBottom') {
      dispatch({ type: 'toDeckBottom', instanceId: id });
    } else if (action === 'groupSelected') {
      if (selectedIds.size >= 2) dispatch({ type: 'groupCards', instanceIds: [...selectedIds] });
    } else if (action === 'ungroup') {
      const g = groupOf(id);
      if (g) dispatch({ type: 'ungroupCards', instanceIds: g });
    } else if (action === 'swapPositions') {
      swapSelected();
    }
  }

  function closeMenus() {
    if (activeCountPrompt) activeCountPrompt.restore();
    els.burgerMenu.hidden = true;
    els.fieldMenu.hidden = true;
    els.handMenu.hidden = true;
    els.deckMenu.hidden = true;
    els.trashMenu.hidden = true;
    els.cardContextMenu.hidden = true;
  }

  function closeModals() {
    els.searchModal.hidden = true;
    els.searchInput.value = '';
    els.lookModal.hidden = true;
    els.trashModal.hidden = true;
    els.diceModal.hidden = true;
    els.countersModal.hidden = true;
    lookIds = [];
    lookDragId = null;
    lookDidDrag = false;
    uiViewing = null;
    publish(state, uiViewing);
    if (deckCardMoved) {
      deckCardMoved = false;
      if (state && state.zones.deck.length > 0) showShufflePrompt();
    }
  }

  function showShufflePrompt() {
    els.shufflePrompt.hidden = false;
    if (shuffleTimer) clearTimeout(shuffleTimer);
    shuffleTimer = setTimeout(hideShufflePrompt, 8000);
  }
  function hideShufflePrompt() {
    els.shufflePrompt.hidden = true;
    if (shuffleTimer) { clearTimeout(shuffleTimer); shuffleTimer = null; }
  }

  function toggleDropdown(menuEl, anchorEl) {
    const wasHidden = menuEl.hidden;
    closeMenus();
    if (!wasHidden) return;
    const r = anchorEl.getBoundingClientRect();
    menuEl.style.position = 'fixed';
    menuEl.style.top = (r.bottom + 4) + 'px';
    menuEl.hidden = false;
    const w = menuEl.offsetWidth;
    const h = menuEl.offsetHeight;
    if (r.bottom + 4 + h > window.innerHeight - 4) {
      menuEl.style.top = Math.max(4, r.top - 4 - h) + 'px';
    }
    menuEl.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4)) + 'px';
  }

  function openMenu(menuEl, x, y) {
    closeMenus();
    menuEl.hidden = false;
    menuEl.style.position = 'fixed';
    const maxX = window.innerWidth - menuEl.offsetWidth - 4;
    const maxY = window.innerHeight - menuEl.offsetHeight - 4;
    menuEl.style.left = Math.min(x, Math.max(0, maxX)) + 'px';
    menuEl.style.top = Math.min(y, Math.max(0, maxY)) + 'px';
  }

  function normalizeSearchText(s) {
    return String(s || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }

  function renderSearchGrid() {
    if (!state) return;
    const query = normalizeSearchText(els.searchInput.value.trim());
    const allItems = state.zones.deck.map((instanceId, i) => ({
      instanceId,
      card: state.cards[instanceId],
      badge: String(i + 1),
    }));
    const items = query
      ? allItems.filter((item) => normalizeSearchText(item.card && item.card.name).includes(query))
      : allItems;
    R.renderModalGrid(els.searchGrid, items, state.cardBack);
    els.searchNoMatches.hidden = items.length > 0;
  }

  function openSearchModal() {
    if (!state) return;
    deckCardMoved = false;
    renderSearchGrid();
    els.searchModal.hidden = false;
    els.searchInput.focus();
    uiViewing = { kind: 'deck', n: null };
    publish(state, uiViewing);
  }

  function openLookModal(n) {
    if (!state) return;
    deckCardMoved = false;
    lookIds = state.zones.deck.slice(0, n);
    renderLookGrid();
    els.lookModal.hidden = false;
    uiViewing = { kind: 'deck', n };
    publish(state, uiViewing);
  }

  function renderLookGrid() {
    // Drop ids that left the deck's top-N since the modal opened (context
    // menu / hotkeys / drag), keeping the user's local reorder otherwise.
    const prefix = new Set(state.zones.deck.slice(0, lookIds.length));
    lookIds = lookIds.filter((id) => prefix.has(id));
    const items = lookIds
      .filter((id) => state.cards[id])
      .map((id, i) => ({ instanceId: id, card: state.cards[id], badge: String(i + 1) }));
    R.renderModalGrid(els.lookGrid, items, state.cardBack);
  }

  function renderTrashGrid() {
    const items = state.zones.trash.map((id) => ({ instanceId: id, card: state.cards[id] }));
    R.renderModalGrid(els.trashGrid, items, state.cardBack);
  }

  function openTrashModal() {
    if (!state) return;
    renderTrashGrid();
    els.trashModal.hidden = false;
    uiViewing = { kind: 'trash' };
    publish(state, uiViewing);
  }

  function commitCounterInput(input) {
    const key = input.dataset.key;
    const value = parseInt(input.value, 10);
    editingCounterKey = null;
    if (Number.isFinite(value)) dispatch({ type: 'setCounter', key, value });
    else render();
  }

  // -- counters modal --

  function openCountersModal() {
    closeMenus();
    countersWorking = (config.counters || []).map((c) => ({
      key: c.key, label: c.label, labelJa: c.labelJa, default: c.default, min: c.min ?? null, max: c.max ?? null,
    }));
    els.countersError.textContent = '';
    renderCountersTable();
    els.countersModal.hidden = false;
  }

  function renderCountersTable() {
    els.countersTbody.innerHTML = '';
    countersWorking.forEach((row) => {
      const tr = document.createElement('tr');
      tr.className = 'counters-row';

      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.value = row.label;
      labelInput.addEventListener('input', () => { row.label = labelInput.value; delete row.labelJa; });
      const labelTd = document.createElement('td');
      labelTd.appendChild(labelInput);
      tr.appendChild(labelTd);

      const startInput = document.createElement('input');
      startInput.type = 'number';
      startInput.value = Number.isFinite(row.default) ? String(row.default) : '';
      startInput.addEventListener('input', () => { row.default = startInput.value === '' ? NaN : Number(startInput.value); });
      const startTd = document.createElement('td');
      startTd.appendChild(startInput);
      tr.appendChild(startTd);

      const minInput = document.createElement('input');
      minInput.type = 'number';
      minInput.value = row.min == null ? '' : String(row.min);
      minInput.addEventListener('input', () => { row.min = minInput.value === '' ? null : Number(minInput.value); });
      const minTd = document.createElement('td');
      minTd.appendChild(minInput);
      tr.appendChild(minTd);

      const maxInput = document.createElement('input');
      maxInput.type = 'number';
      maxInput.value = row.max == null ? '' : String(row.max);
      maxInput.addEventListener('input', () => { row.max = maxInput.value === '' ? null : Number(maxInput.value); });
      const maxTd = document.createElement('td');
      maxTd.appendChild(maxInput);
      tr.appendChild(maxTd);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'counters-remove-btn';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        countersWorking = countersWorking.filter((r) => r !== row);
        renderCountersTable();
      });
      const removeTd = document.createElement('td');
      removeTd.appendChild(removeBtn);
      tr.appendChild(removeTd);

      els.countersTbody.appendChild(tr);
    });
  }

  function validateCountersWorking() {
    let ok = true;
    const labelCounts = new Map();
    for (const row of countersWorking) {
      const label = row.label.trim().toLowerCase();
      labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
    }
    els.countersTbody.querySelectorAll('tr').forEach((tr, i) => {
      const row = countersWorking[i];
      const invalid = !row.label.trim() || !Number.isInteger(row.default) ||
        (row.min != null && !Number.isInteger(row.min)) ||
        (row.max != null && !Number.isInteger(row.max)) ||
        (row.min != null && row.default < row.min) ||
        (row.max != null && row.default > row.max) ||
        (row.min != null && row.max != null && row.min > row.max) ||
        labelCounts.get(row.label.trim().toLowerCase()) > 1;
      tr.classList.toggle('invalid', invalid);
      if (invalid) ok = false;
    });
    return ok;
  }

  function saveCounters() {
    if (!validateCountersWorking()) {
      els.countersError.textContent = t('countersInvalid');
      return;
    }
    const ts = Date.now().toString(36);
    const newCounters = countersWorking.map((row, i) => {
      const out = {
        key: row.key || ('c' + ts + i),
        label: row.label.trim(),
        default: row.default,
        min: row.min,
        max: row.max,
      };
      if (row.labelJa) out.labelJa = row.labelJa;
      return out;
    });
    try { localStorage.setItem('goldfish-counters', JSON.stringify(newCounters)); } catch (e) { /* ignore quota / privacy errors */ }
    config.counters = newCounters;
    syncCounters(state, config);
    for (const entry of history) syncCounters(entry, config);
    els.countersModal.hidden = true;
    afterChange();
  }

  function resetCountersToDefaults() {
    try { localStorage.removeItem('goldfish-counters'); } catch (e) { /* ignore */ }
    config.counters = defaultCounters;
    syncCounters(state, config);
    for (const entry of history) syncCounters(entry, config);
    els.countersModal.hidden = true;
    afterChange();
  }

  // -- events --

  function wireEvents() {
    els.btnBurger.addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown(els.burgerMenu, els.btnBurger); });
    els.btnFieldMenu.addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown(els.fieldMenu, els.btnFieldMenu); });
    els.btnHandMenu.addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown(els.handMenu, els.btnHandMenu); });
    els.btnDeckMenu.addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown(els.deckMenu, els.btnDeckMenu); });
    els.btnTrashMenu.addEventListener('click', (e) => { e.stopPropagation(); toggleDropdown(els.trashMenu, els.btnTrashMenu); });

    els.btnNewGame.addEventListener('click', () => {
      const name = els.deckSelect.value;
      closeMenus();
      if (name) newGame(name);
    });
    els.importDisk.addEventListener('change', () => {
      const files = [...els.importDisk.files];
      els.importDisk.value = '';
      doImportDisk(files);
    });
    els.btnPickFolder.addEventListener('click', pickFolder);
    els.btnReconnectFolder.addEventListener('click', reconnectFolder);
    els.btnOpenStream.addEventListener('click', () => { window.open('?view=stream', 'goldfish-stream'); closeMenus(); });
    els.btnToggleLog.addEventListener('click', () => { showLog = !showLog; persist(); render(); closeMenus(); });
    els.btnResetData.addEventListener('click', async () => {
      closeMenus();
      if (!window.confirm(t('resetConfirm'))) return;
      for (const k of Object.keys(localStorage)) if (k.startsWith('goldfish')) localStorage.removeItem(k);
      await new Promise((res) => { const r = indexedDB.deleteDatabase('goldfish'); r.onsuccess = r.onerror = r.onblocked = () => res(); });
      location.reload();
    });
    els.btnLanguage.addEventListener('click', () => {
      setLang(getLang() === 'ja' ? 'en' : 'ja');
      applyBodyLangClass();
      applyStatic(document);
      render();
      hideCardPreview();
      closeMenus();
    });
    els.btnCounters.addEventListener('click', openCountersModal);

    els.btnNextTurn.addEventListener('click', () => dispatch({ type: 'nextTurn' }));
    els.btnUndo.addEventListener('click', undo);
    els.btnDice.addEventListener('click', () => { if (state) openDiceModal(); });

    els.fieldMenu.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-action]');
      if (!li) return;
      e.stopPropagation();
      const action = li.dataset.action;
      closeMenus();
      if (!state) return;
      const ids = [...state.zones.field];
      if (action === 'untapAll') {
        const tapped = ids.filter((id) => state.cards[id] && state.cards[id].tapped);
        if (tapped.length) dispatchBatch(tapped.map((id) => ({ type: 'toggleTap', instanceId: id })));
      } else if (action === 'toHand') {
        dispatchBatch(ids.map((id) => ({ type: 'moveCard', instanceId: id, to: 'hand' })));
      } else if (action === 'toTrash') {
        dispatchBatch(ids.map((id) => ({ type: 'moveCard', instanceId: id, to: 'trash' })));
      }
    });

    els.handMenu.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-action]');
      if (!li) return;
      e.stopPropagation();
      const action = li.dataset.action;
      closeMenus();
      if (!state || state.zones.hand.length === 0) return;
      const ids = [...state.zones.hand];
      if (action === 'toDeckTop') dispatchBatch(ids.map((id) => ({ type: 'toDeckTop', instanceId: id })));
      else if (action === 'toDeckBottom') dispatchBatch(ids.map((id) => ({ type: 'toDeckBottom', instanceId: id })));
      else if (action === 'toDeckBottomRandom') dispatch({ type: 'handToDeckBottomRandom' });
      else if (action === 'toTrash') dispatchBatch(ids.map((id) => ({ type: 'moveCard', instanceId: id, to: 'trash' })));
      else if (action === 'discardRandom') {
        const pick = ids[Math.floor(GameState.secureRandom() * ids.length)];
        dispatch({ type: 'moveCard', instanceId: pick, to: 'trash' });
      }
    });

    els.deckMenu.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-action]');
      if (!li) return;
      e.stopPropagation();
      const action = li.dataset.action;
      if (!state) { closeMenus(); return; }
      if (action === 'draw') {
        closeMenus();
        dispatch({ type: 'draw', n: 1 });
        hideShufflePrompt();
      } else if (action === 'viewTop') {
        openCountPrompt(li, { def: 1, max: state.zones.deck.length }, (n) => openLookModal(n));
      } else if (action === 'viewAll') {
        closeMenus();
        openSearchModal();
      } else if (action === 'millTop') {
        openCountPrompt(li, { def: 1, max: state.zones.deck.length }, (n) => {
          const ids = state.zones.deck.slice(0, n);
          dispatchBatch(ids.map((id) => ({ type: 'moveCard', instanceId: id, to: 'trash' })));
        });
      } else if (action === 'topToField' || action === 'topToFieldFaceDown') {
        closeMenus();
        const topId = state.zones.deck[0];
        if (topId) {
          const spot = findFreeSpot();
          dispatch({ type: 'moveCard', instanceId: topId, to: 'field', x: spot.x, y: spot.y, faceDown: action === 'topToFieldFaceDown' });
        }
      } else if (action === 'shuffle') {
        closeMenus();
        shuffleDeck();
      }
    });

    els.trashMenu.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-action]');
      if (!li) return;
      e.stopPropagation();
      const action = li.dataset.action;
      closeMenus();
      if (!state) return;
      if (action === 'view') {
        openTrashModal();
      } else if (action === 'shuffleIntoDeck') {
        const ids = [...state.zones.trash];
        if (ids.length) {
          dispatchBatch([
            ...ids.map((id) => ({ type: 'moveCard', instanceId: id, to: 'deck', index: 0 })),
            { type: 'shuffle' },
          ]);
          markDeckShuffled();
        }
      } else if (action === 'allToHand') {
        const ids = [...state.zones.trash];
        if (ids.length) dispatchBatch(ids.map((id) => ({ type: 'moveCard', instanceId: id, to: 'hand' })));
      } else if (action === 'topToHand') {
        const topId = state.zones.trash[state.zones.trash.length - 1];
        if (topId) dispatch({ type: 'moveCard', instanceId: topId, to: 'hand' });
      }
    });

    els.pileDeck.addEventListener('click', (e) => {
      if (e.target.closest('.pile-header, .dropdown-menu, .pile-menu-btn')) return;
      if (!state) return;
      dispatch({ type: 'draw', n: 1 });
      hideShufflePrompt();
    });

    els.pileTrash.addEventListener('click', (e) => {
      if (e.target.closest('.dropdown-menu, .pile-menu-btn')) return;
      if (!state) return;
      openTrashModal();
    });

    function updateContextMenuForCard(id) {
      const card = state && state.cards[id];
      const zone = zoneOfCard(id);
      const allowed = ZONE_ACTIONS[zone] || [];
      els.cardContextMenu.querySelectorAll('li[data-action]').forEach((li) => {
        li.hidden = !allowed.includes(li.dataset.action);
      });
      const tapLi = els.cardContextMenu.querySelector('li[data-action="toggleTap"]');
      if (tapLi) tapLi.textContent = card && card.tapped ? t('setActive') : t('setStandby');
      const flipLi = els.cardContextMenu.querySelector('li[data-action="toggleFaceDown"]');
      if (flipLi) flipLi.textContent = card && card.faceDown ? t('turnFaceUp') : t('turnFaceDown');
      const groupLi = els.cardContextMenu.querySelector('li[data-action="groupSelected"]');
      if (groupLi && !groupLi.hidden) groupLi.hidden = !(selectedIds.has(id) && canGroupSelection());
      const ungroupLi = els.cardContextMenu.querySelector('li[data-action="ungroup"]');
      if (ungroupLi && !ungroupLi.hidden) ungroupLi.hidden = !groupOf(id);
      const swapLi = els.cardContextMenu.querySelector('li[data-action="swapPositions"]');
      if (swapLi && !swapLi.hidden) swapLi.hidden = !(selectedIds.has(id) && selectedUnits().length === 2);
    }

    document.addEventListener('contextmenu', (e) => {
      const cardEl = e.target.closest('.card');
      if (!cardEl || !state) return;
      e.preventDefault();
      contextCardId = cardEl.dataset.instanceId;
      updateContextMenuForCard(contextCardId);
      openMenu(els.cardContextMenu, e.clientX, e.clientY);
    });

    els.cardContextMenu.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-action]');
      if (!li || !contextCardId) return;
      const action = li.dataset.action;
      const id = contextCardId;
      const zoneBefore = zoneOfCard(id);
      closeMenus();
      contextCardId = null;
      applyCardAction(action, id);
      if (zoneBefore === 'deck') deckCardMoved = true;
    });

    els.app.addEventListener('dblclick', (e) => {
      const cardEl = e.target.closest('.field-card');
      if (!cardEl) return;
      dispatch({ type: 'toggleTap', instanceId: cardEl.dataset.instanceId });
    });

    els.app.addEventListener('mouseover', (e) => {
      const cardEl = e.target.closest('.card');
      if (!cardEl || !state) return;
      hoveredInstanceId = cardEl.dataset.instanceId;
      const card = state.cards[hoveredInstanceId];
      if (card) showCardPreview(card, state.cardBack, e.clientX);
    });
    els.app.addEventListener('mouseout', (e) => {
      const cardEl = e.target.closest('.card');
      if (!cardEl) return;
      const related = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.card') : null;
      if (!related) {
        hoveredInstanceId = null;
        hideCardPreview();
      }
    });

    els.app.addEventListener('mousemove', (e) => maybeFlipPreview(e.clientX, e.clientY));

    els.pileTrash.addEventListener('mouseenter', (e) => {
      if (!state) return;
      const topId = state.zones.trash[state.zones.trash.length - 1];
      const card = topId ? state.cards[topId] : null;
      if (card) showCardPreview(card, state.cardBack, e.clientX);
    });
    els.pileTrash.addEventListener('mouseleave', () => {
      if (!hoveredInstanceId) hideCardPreview();
    });

    // -- hand -> field / deck / trash drag-and-drop (HTML5 DnD) --
    els.app.addEventListener('dragstart', (e) => {
      let cardEl = e.target.closest('.card');
      let instanceId = cardEl && cardEl.dataset.instanceId;
      if (!cardEl) {
        // Dragging the deck/trash pile drags its top card.
        const pile = e.target.closest('#pile-deck .pile-body, #pile-trash .pile-body');
        if (!pile || !state) return;
        const isDeck = pile.parentElement === els.pileDeck;
        instanceId = isDeck ? state.zones.deck[0] : state.zones.trash[state.zones.trash.length - 1];
        if (!instanceId) { e.preventDefault(); return; }
        cardEl = isDeck ? els.deckBackImg : els.trashTopImg;
        // setDragImage on an <img> uses its natural size; use a clone sized
        // like the displayed pile image instead.
        const r0 = cardEl.getBoundingClientRect();
        const ghost = cardEl.cloneNode();
        ghost.hidden = false;
        ghost.style.cssText = `position:fixed;left:-9999px;top:-9999px;width:${r0.width}px;height:auto;border-radius:6px;`;
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, e.clientX - r0.left, e.clientY - r0.top);
        setTimeout(() => ghost.remove(), 0);
      }
      if (!cardEl) return;
      if (cardEl.classList.contains('field-card')) { e.preventDefault(); return; }
      if (cardEl.closest('.modal')) document.body.classList.add('modal-dragging');
      e.dataTransfer.setData('text/plain', instanceId);
      e.dataTransfer.effectAllowed = 'move';
      const r = cardEl.getBoundingClientRect();
      dragGrab = {
        fx: r.width ? (e.clientX - r.left) / r.width : 0.5,
        fy: r.height ? (e.clientY - r.top) / r.height : 0.5,
        faceDown: e.shiftKey && cardEl === els.deckBackImg, // Shift+drag from the deck: place face down
      };
    });
    els.app.addEventListener('dragend', () => {
      dragGrab = null;
      document.body.classList.remove('modal-dragging', 'modal-drag-out');
      clearHandDragIndicators();
    });
    function clearHandDragIndicators() {
      els.handStrip.querySelectorAll('.card').forEach((el) => {
        el.classList.remove('drag-before', 'drag-after');
      });
    }
    // While dragging out of a viewer, dim its panel only once the cursor has left it.
    document.addEventListener('dragover', (e) => {
      if (!document.body.classList.contains('modal-dragging')) return;
      const panel = document.querySelector('.modal-overlay:not([hidden]) .modal');
      const r = panel && panel.getBoundingClientRect();
      const inside = r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      document.body.classList.toggle('modal-drag-out', !inside);
    });
    els.app.addEventListener('dragover', (e) => {
      maybeFlipPreview(e.clientX, e.clientY);
      const zoneEl = e.target.closest('[data-zone]');
      if (!zoneEl) return;
      e.preventDefault();
      if (zoneEl.dataset.zone !== 'hand') return;
      const cardEl = e.target.closest('#hand-strip .card');
      clearHandDragIndicators();
      if (!cardEl) return;
      const r = cardEl.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      cardEl.classList.add(before ? 'drag-before' : 'drag-after');
    });
    els.handStrip.addEventListener('dragleave', (e) => {
      if (els.handStrip.contains(e.relatedTarget)) return;
      clearHandDragIndicators();
    });
    els.app.addEventListener('drop', (e) => {
      const zoneEl = e.target.closest('[data-zone]');
      if (!zoneEl || zoneEl.closest('.modal')) return;
      e.preventDefault();
      const instanceId = e.dataTransfer.getData('text/plain');
      const grab = dragGrab || { fx: 0.5, fy: 0.5 };
      dragGrab = null;
      // The source card may be re-rendered away before dragend fires, so clear here too.
      document.body.classList.remove('modal-dragging', 'modal-drag-out');
      clearHandDragIndicators();
      if (!instanceId || !state || !state.cards[instanceId]) return;
      const sourceZone = zoneOfCard(instanceId);
      const zone = zoneEl.dataset.zone;
      if (zone === 'field') {
        const rect = els.field.getBoundingClientRect();
        const unit = rect.width * zoom;
        const cw = els.cardMeasure.offsetWidth || 100;
        const ch = els.cardMeasure.offsetHeight || 140;
        const left = e.clientX - rect.left - grab.fx * cw;
        const top = e.clientY - rect.top - grab.fy * ch;
        const maxX = Math.max(0, (rect.width - cw) / unit);
        const maxY = Math.max(0, (rect.height - ch) / unit);
        const x = Math.min(maxX, Math.max(0, left / unit));
        const y = Math.min(maxY, Math.max(0, top / unit));
        dispatch({ type: 'moveCard', instanceId, to: 'field', x, y, faceDown: !!grab.faceDown });
      } else if (zone === 'deck') {
        dispatch({ type: 'moveCard', instanceId, to: 'deck', index: 0 });
      } else if (zone === 'hand') {
        const cardEl = e.target.closest('#hand-strip .card');
        const targetId = cardEl && cardEl.dataset.instanceId;
        if (targetId && targetId !== instanceId) {
          const r = cardEl.getBoundingClientRect();
          const after = e.clientX >= r.left + r.width / 2;
          const order = state.zones.hand.filter((id) => id !== instanceId);
          const idx = order.indexOf(targetId) + (after ? 1 : 0);
          dispatch({ type: 'moveCard', instanceId, to: 'hand', index: idx });
        } else if (!targetId) {
          dispatch({ type: 'moveCard', instanceId, to: 'hand' });
        }
      } else {
        dispatch({ type: 'moveCard', instanceId, to: zone });
      }
      if (sourceZone === 'deck') deckCardMoved = true;
      lookIds = lookIds.filter((id) => id !== instanceId);
      if (!els.lookModal.hidden) renderLookGrid();
      if (!els.searchModal.hidden) renderSearchGrid();
      if (!els.trashModal.hidden) renderTrashGrid();
    });

    // -- field -> anywhere drag (pointer events, live drag + drop-anywhere) --
    // Dragging a selected card carries the whole selection along.
    function fieldMetrics(el) {
      const fieldRect = els.field.getBoundingClientRect();
      const unit = fieldRect.width * zoom;
      const cw = (el && el.offsetWidth) || els.cardMeasure.offsetWidth || 100;
      const ch = (el && el.offsetHeight) || els.cardMeasure.offsetHeight || 140;
      return {
        fieldRect,
        unit,
        maxX: Math.max(0, (fieldRect.width - cw) / unit),
        maxY: Math.max(0, (fieldRect.height - ch) / unit),
      };
    }
    function dragTargets(ds) {
      const idSet = new Set(selectedIds.has(ds.instanceId) ? selectedIds : [ds.instanceId]);
      for (const id of [...idSet]) {
        const g = groupOf(id);
        if (g) for (const gid of g) idSet.add(gid);
      }
      return [...idSet].map((id) => ({ id, el: els.fieldCards.querySelector(`.field-card[data-instance-id="${CSS.escape(id)}"]`), pos: state.positions[id] }))
        .filter((t) => t.el && t.pos);
    }
    function dragDelta(ds, e) {
      const m = fieldMetrics(ds.el);
      const leftPx = e.clientX - ds.offsetX - m.fieldRect.left;
      const topPx = e.clientY - ds.offsetY - m.fieldRect.top;
      const fx = Math.min(m.maxX, Math.max(0, leftPx / m.unit));
      const fy = Math.min(m.maxY, Math.max(0, topPx / m.unit));
      const origin = state.positions[ds.instanceId] || { x: fx, y: fy };
      return { dx: fx - origin.x, dy: fy - origin.y, m };
    }

    els.fieldCards.addEventListener('pointerdown', (e) => {
      const cardEl = e.target.closest('.field-card');
      if (!cardEl || e.button !== 0 || !state) return;
      const id = cardEl.dataset.instanceId;
      if (e.shiftKey) {
        const unit = groupOf(id) || [id];
        if (selectedIds.has(id)) unit.forEach((m) => selectedIds.delete(m)); else unit.forEach((m) => selectedIds.add(m));
        applySelectionClasses();
        return;
      }
      if (!selectedIds.has(id) && selectedIds.size) { selectedIds.clear(); applySelectionClasses(); }
      const rect = cardEl.getBoundingClientRect();
      dragState = {
        instanceId: id,
        el: cardEl,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        targets: null,
      };
      cardEl.setPointerCapture(e.pointerId);
    });

    els.fieldCards.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      if (!dragState.moved) {
        const totalMove = Math.abs(e.clientX - dragState.startX) + Math.abs(e.clientY - dragState.startY);
        if (totalMove < 4) return;
        dragState.moved = true;
        dragState.targets = dragTargets(dragState);
        for (const tg of dragState.targets) { tg.el.classList.add('dragging'); tg.el.style.zIndex = 9999; }
      }
      const { dx, dy, m } = dragDelta(dragState, e);
      for (const tg of dragState.targets) {
        const fx = Math.min(m.maxX, Math.max(0, tg.pos.x + dx));
        const fy = Math.min(m.maxY, Math.max(0, tg.pos.y + dy));
        tg.el.style.left = `calc(var(--field-unit, var(--field-w, 1000px)) * ${fx})`;
        tg.el.style.top = `calc(var(--field-unit, var(--field-w, 1000px)) * ${fy})`;
      }
    });

    function endFieldDrag(ds) {
      for (const tg of ds.targets || [ds]) { tg.el.classList.remove('dragging'); tg.el.style.zIndex = ''; }
    }

    els.fieldCards.addEventListener('pointerup', (e) => {
      if (!dragState) return;
      const ds = dragState;
      dragState = null;
      if (ds.el.hasPointerCapture && ds.el.hasPointerCapture(e.pointerId)) ds.el.releasePointerCapture(e.pointerId);
      endFieldDrag(ds);
      if (!ds.moved) return;
      const ids = ds.targets.map((tg) => tg.id);
      for (const tg of ds.targets) tg.el.style.pointerEvents = 'none';
      const dropTarget = document.elementFromPoint(e.clientX, e.clientY);
      for (const tg of ds.targets) tg.el.style.pointerEvents = '';
      if (e.altKey) {
        const targetCardEl = dropTarget && dropTarget.closest && dropTarget.closest('.field-card');
        const targetId = targetCardEl && targetCardEl.dataset.instanceId;
        if (targetId && !ids.includes(targetId)) {
          const prev = state;
          dispatch({ type: 'swapOnField', a: ds.instanceId, b: targetId });
          if (state === prev) render();
          applySelectionClasses();
          return;
        }
      }
      const zoneEl = dropTarget && dropTarget.closest && dropTarget.closest('[data-zone]');
      const zone = zoneEl && zoneEl.dataset.zone;
      if (zone === 'trash' || zone === 'hand') {
        dispatchBatch(ids.map((id) => ({ type: 'moveCard', instanceId: id, to: zone })));
        selectedIds.clear();
      } else if (zone === 'deck') {
        dispatchBatch(ids.map((id) => ({ type: 'moveCard', instanceId: id, to: 'deck', index: 0 })));
        selectedIds.clear();
      } else {
        const { dx, dy, m } = dragDelta(ds, e);
        const moves = ds.targets.map((tg) => ({
          instanceId: tg.id,
          x: Math.min(m.maxX, Math.max(0, tg.pos.x + dx)),
          y: Math.min(m.maxY, Math.max(0, tg.pos.y + dy)),
        }));
        if (moves.length === 1) {
          dispatch({ type: 'moveOnField', instanceId: moves[0].instanceId, x: moves[0].x, y: moves[0].y });
        } else {
          dispatch({ type: 'moveCardsOnField', moves });
        }
      }
      applySelectionClasses();
    });

    els.fieldCards.addEventListener('pointercancel', () => {
      if (!dragState) return;
      endFieldDrag(dragState);
      dragState = null;
    });

    // -- rubber-band selection on empty field space --
    let selectDrag = null;
    els.field.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !state || dragState) return;
      if (e.target.closest('.card, #tutorial, #log-panel, #card-preview, #shuffle-prompt, button')) return;
      e.preventDefault();
      selectDrag = { startX: e.clientX, startY: e.clientY, moved: false, additive: e.shiftKey };
      els.field.setPointerCapture(e.pointerId);
    });
    els.field.addEventListener('pointermove', (e) => {
      if (!selectDrag) return;
      if (!selectDrag.moved) {
        if (Math.abs(e.clientX - selectDrag.startX) + Math.abs(e.clientY - selectDrag.startY) < 4) return;
        selectDrag.moved = true;
        els.selectRect.hidden = false;
      }
      els.selectRect.style.left = Math.min(e.clientX, selectDrag.startX) + 'px';
      els.selectRect.style.top = Math.min(e.clientY, selectDrag.startY) + 'px';
      els.selectRect.style.width = Math.abs(e.clientX - selectDrag.startX) + 'px';
      els.selectRect.style.height = Math.abs(e.clientY - selectDrag.startY) + 'px';
    });
    function endSelectDrag(e, commit) {
      const sd = selectDrag;
      selectDrag = null;
      els.selectRect.hidden = true;
      if (!sd || !commit) return;
      if (!sd.moved) {
        if (selectedIds.size) { selectedIds.clear(); applySelectionClasses(); }
        return;
      }
      const box = {
        left: Math.min(e.clientX, sd.startX), right: Math.max(e.clientX, sd.startX),
        top: Math.min(e.clientY, sd.startY), bottom: Math.max(e.clientY, sd.startY),
      };
      if (!sd.additive) selectedIds.clear();
      els.fieldCards.querySelectorAll('.field-card').forEach((el) => {
        const r = el.getBoundingClientRect();
        const hit = r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
        if (hit) selectedIds.add(el.dataset.instanceId);
      });
      applySelectionClasses();
    }
    els.field.addEventListener('pointerup', (e) => endSelectDrag(e, true));
    els.field.addEventListener('pointercancel', (e) => endSelectDrag(e, false));

    els.searchClose.addEventListener('click', closeModals);
    els.searchModal.addEventListener('click', (e) => {
      if (e.target === els.searchModal) closeModals();
    });
    els.searchInput.addEventListener('input', renderSearchGrid);
    els.searchGrid.addEventListener('click', (e) => {
      const cardEl = e.target.closest('.card');
      if (!cardEl || !state) return;
      const instanceId = cardEl.dataset.instanceId;
      dispatch({ type: 'moveCard', instanceId, to: 'hand' });
      deckCardMoved = true;
      renderSearchGrid();
    });

    els.trashGrid.addEventListener('click', (e) => {
      const cardEl = e.target.closest('.card');
      if (!cardEl || !state) return;
      dispatch({ type: 'moveCard', instanceId: cardEl.dataset.instanceId, to: 'hand' });
      renderTrashGrid();
    });

    els.lookGrid.addEventListener('click', (e) => {
      if (lookDidDrag) { lookDidDrag = false; return; }
      const cardEl = e.target.closest('.card');
      if (!cardEl || !state) return;
      const instanceId = cardEl.dataset.instanceId;
      dispatch({ type: 'moveCard', instanceId, to: 'hand' });
      deckCardMoved = true;
      lookIds = lookIds.filter((id) => id !== instanceId);
      renderLookGrid();
    });

    function clearLookDragIndicators() {
      els.lookGrid.querySelectorAll('.card').forEach((el) => {
        el.classList.remove('drag-before', 'drag-after');
      });
    }
    els.lookGrid.addEventListener('dragstart', (e) => {
      const cardEl = e.target.closest('.card');
      if (!cardEl) return;
      e.stopPropagation();
      lookDidDrag = true;
      lookDragId = cardEl.dataset.instanceId;
      e.dataTransfer.setData('text/plain', lookDragId);
      e.dataTransfer.effectAllowed = 'move';
      document.body.classList.add('modal-dragging');
    });
    els.lookGrid.addEventListener('dragover', (e) => {
      const cardEl = e.target.closest('.card');
      if (!cardEl || !lookDragId) return;
      e.preventDefault();
      e.stopPropagation();
      clearLookDragIndicators();
      if (cardEl.dataset.instanceId === lookDragId) return;
      const r = cardEl.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      cardEl.classList.add(before ? 'drag-before' : 'drag-after');
    });
    els.lookGrid.addEventListener('drop', (e) => {
      const cardEl = e.target.closest('.card');
      e.preventDefault();
      e.stopPropagation();
      clearLookDragIndicators();
      const draggedId = lookDragId;
      lookDragId = null;
      if (!draggedId || !cardEl || cardEl.dataset.instanceId === draggedId) return;
      const targetId = cardEl.dataset.instanceId;
      const r = cardEl.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      const without = lookIds.filter((id) => id !== draggedId);
      let targetIndex = without.indexOf(targetId);
      if (!before) targetIndex += 1;
      without.splice(targetIndex, 0, draggedId);
      lookIds = without;
      renderLookGrid();
      lookDidDrag = false;
    });
    els.lookGrid.addEventListener('dragend', (e) => {
      e.stopPropagation();
      lookDragId = null;
      clearLookDragIndicators();
      document.body.classList.remove('modal-dragging', 'modal-drag-out');
      setTimeout(() => { lookDidDrag = false; }, 0);
    });

    els.lookShuffle.addEventListener('click', () => { shuffleDeck(); closeModals(); });
    function putBack(toBottom) {
      const prefix = state.zones.deck.slice(0, lookIds.length);
      const ids = lookIds.filter((id) => prefix.includes(id));
      const stale = ids.length !== lookIds.length || !ids.every((id, i) => id === prefix[i]);
      if (stale) {
        lookIds = state.zones.deck.slice(0, ids.length);
        renderLookGrid();
        return;
      }
      dispatch(toBottom ? { type: 'reorderDeckTop', ids, toBottom: true } : { type: 'reorderDeckTop', ids });
      closeModals();
    }
    els.lookPutbackTop.addEventListener('click', () => putBack(false));
    els.lookPutbackBottom.addEventListener('click', () => putBack(true));
    els.lookClose.addEventListener('click', closeModals);
    els.lookModal.addEventListener('click', (e) => {
      if (e.target === els.lookModal) closeModals();
    });

    els.trashClose.addEventListener('click', closeModals);
    els.trashModal.addEventListener('click', (e) => {
      if (e.target === els.trashModal) closeModals();
    });

    els.diceClose.addEventListener('click', closeModals);
    els.diceModal.addEventListener('click', (e) => {
      if (e.target === els.diceModal) closeModals();
    });
    els.diceSidesRow.addEventListener('click', (e) => {
      const chip = e.target.closest('.dice-chip');
      if (!chip || diceRolling) return;
      diceSides = parseInt(chip.dataset.sides, 10);
      persistDicePrefs();
      renderDiceChips();
      renderDiceStageIdle();
    });
    els.diceCountMinus.addEventListener('click', () => {
      if (diceRolling) return;
      diceCount = Math.max(1, diceCount - 1);
      persistDicePrefs();
      renderDiceCount();
      renderDiceStageIdle();
    });
    els.diceCountPlus.addEventListener('click', () => {
      if (diceRolling) return;
      diceCount = Math.min(10, diceCount + 1);
      persistDicePrefs();
      renderDiceCount();
      renderDiceStageIdle();
    });
    els.diceRollBtn.addEventListener('click', rollDiceNow);
    els.diceModal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); rollDiceNow(); }
    });

    els.countersClose.addEventListener('click', closeModals);
    els.countersModal.addEventListener('click', (e) => {
      if (e.target === els.countersModal) closeModals();
    });
    els.countersAdd.addEventListener('click', () => {
      countersWorking.push({ key: null, label: '', default: 0, min: null, max: null });
      renderCountersTable();
    });
    els.countersReset.addEventListener('click', resetCountersToDefaults);
    els.countersSave.addEventListener('click', saveCounters);

    els.shufflePromptYes.addEventListener('click', shuffleDeck);
    els.shufflePromptNo.addEventListener('click', hideShufflePrompt);

    els.app.addEventListener('click', (e) => {
      const btn = e.target.closest('#counters-row button[data-action]');
      if (btn) {
        const key = btn.dataset.key;
        const delta = btn.dataset.action === 'plus' ? 1 : -1;
        dispatch({ type: 'adjustCounter', key, delta });
        return;
      }
      const valEl = e.target.closest('#counters-row .counter-value');
      if (valEl) {
        editingCounterKey = valEl.dataset.key;
        render();
        const input = document.querySelector('#counters-row .counter-input');
        if (input) { input.focus(); input.select(); }
      }
    });
    els.app.addEventListener('keydown', (e) => {
      if (!e.target.classList.contains('counter-input')) return;
      if (e.key === 'Enter') commitCounterInput(e.target);
      else if (e.key === 'Escape') { editingCounterKey = null; render(); }
    });
    document.addEventListener('blur', (e) => {
      if (e.target.classList && e.target.classList.contains('counter-input')) commitCounterInput(e.target);
    }, true);

    document.addEventListener('click', (e) => {
      if (e.target.closest('.dropdown-menu, .context-menu, .burger-btn, .menu-btn, .pile-menu-btn')) return;
      closeMenus();
    });

    document.addEventListener('keydown', (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'Escape') {
        if (selectedIds.size) { selectedIds.clear(); applySelectionClasses(); }
        closeMenus();
        hideShufflePrompt();
        closeModals();
        if (inInput) document.activeElement.blur();
        return;
      }
      if (inInput) return;
      const modalOpen = !els.searchModal.hidden || !els.lookModal.hidden || !els.trashModal.hidden || !els.diceModal.hidden || !els.countersModal.hidden;
      if (modalOpen) return;
      if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        undo();
        return;
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        const ids = new Set();
        for (const id of selectedIds) {
          const g = groupOf(id);
          if (g) for (const gid of g) ids.add(gid);
        }
        if (ids.size) dispatch({ type: 'ungroupCards', instanceIds: [...ids] });
        return;
      }
      if (e.ctrlKey && !e.shiftKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        if (canGroupSelection()) dispatch({ type: 'groupCards', instanceIds: [...selectedIds] });
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case 'd': case 'D': dispatch({ type: 'draw', n: 1 }); hideShufflePrompt(); return;
        case 's': case 'S': shuffleDeck(); return;
        case 'n': case 'N': dispatch({ type: 'nextTurn' }); return;
        case 'x': case 'X': swapSelected(); return;
        default: break;
      }
      if (hoveredInstanceId && state && state.cards[hoveredInstanceId]) {
        const allowed = ZONE_ACTIONS[zoneOfCard(hoveredInstanceId)] || [];
        switch (e.key) {
          case 'b': case 'B': if (allowed.includes('toField')) applyCardAction('toField', hoveredInstanceId); break;
          case 't': case 'T': if (allowed.includes('toggleTap')) applyCardAction('toggleTap', hoveredInstanceId); break;
          case 'f': case 'F': if (allowed.includes('toggleFaceDown')) applyCardAction('toggleFaceDown', hoveredInstanceId); break;
          case 'g': case 'G': if (allowed.includes('toTrash')) applyCardAction('toTrash', hoveredInstanceId); break;
          case 'r': case 'R': if (allowed.includes('toHand')) applyCardAction('toHand', hoveredInstanceId); break;
          case 'l': if (allowed.includes('toDeckTop')) applyCardAction('toDeckTop', hoveredInstanceId); break;
          case 'L': if (allowed.includes('toDeckBottom')) applyCardAction('toDeckBottom', hoveredInstanceId); break;
          default: break;
        }
      }
    });
  }
}
