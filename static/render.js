// Pure DOM-building helpers. No event wiring, no global state.
import { t, getLang } from './i18n.js';

const FALLBACK_BACK = 'static/cardback.svg';

export function cardImageSrc(card, cardBack) {
  if (!card) return cardBack || FALLBACK_BACK;
  if (card.faceDown || !card.image) return cardBack || FALLBACK_BACK;
  return card.image;
}

export function handCount(state) {
  const hand = state.zones.hand;
  if (Array.isArray(hand)) return hand.length;
  return hand ? hand.count : 0;
}

export function deckCount(state) {
  const deck = state.zones.deck;
  if (Array.isArray(deck)) return deck.length;
  return deck ? deck.count : 0;
}

export function makeCardElement(instanceId, card, cardBack, { badge, draggable = true } = {}) {
  const el = document.createElement('div');
  el.className = 'card';
  if (card && card.tapped) el.classList.add('tapped');
  if (card && card.faceDown) el.classList.add('facedown');
  el.dataset.instanceId = instanceId;
  el.draggable = draggable;
  const img = document.createElement('img');
  img.src = cardImageSrc(card, cardBack);
  img.alt = card && !card.faceDown && card.name ? card.name : t('faceDownCard');
  img.loading = 'lazy';
  el.appendChild(img);
  if (badge) {
    const b = document.createElement('span');
    b.className = 'card-badge';
    b.textContent = badge;
    el.appendChild(b);
  }
  return el;
}

// Updates an existing card element in place (no new DOM nodes for the card's own
// identity) so callers keep the same <img> across re-renders and avoid a flash.
function updateCardElement(el, card, cardBack, { badge } = {}) {
  el.classList.toggle('tapped', !!(card && card.tapped));
  el.classList.toggle('facedown', !!(card && card.faceDown));
  const img = el.querySelector('img');
  const src = cardImageSrc(card, cardBack);
  if (img.getAttribute('src') !== src) img.src = src;
  const alt = card && !card.faceDown && card.name ? card.name : t('faceDownCard');
  if (img.alt !== alt) img.alt = alt;
  let badgeEl = el.querySelector('.card-badge');
  if (badge) {
    if (!badgeEl) {
      badgeEl = document.createElement('span');
      badgeEl.className = 'card-badge';
      el.appendChild(badgeEl);
    }
    if (badgeEl.textContent !== badge) badgeEl.textContent = badge;
  } else if (badgeEl) {
    badgeEl.remove();
  }
}

// Reconciles `container`'s card children against `ids` by data-instance-id: reuses
// existing elements (updating classes/img in place), creates only missing ones,
// removes leftovers, and reorders via insertBefore only where the order changed.
// Never touches container.innerHTML, so unrelated card elements (and their <img>)
// keep their identity across re-renders.
function reconcileCards(container, ids, cards, cardBack, { draggable, extraClass, badgeFor } = {}) {
  let map = container._cardEls;
  if (!map) { map = new Map(); container._cardEls = map; }
  const seen = new Set();
  let prevEl = null;
  ids.forEach((instanceId, i) => {
    seen.add(instanceId);
    const card = cards[instanceId];
    const badge = badgeFor ? badgeFor(instanceId, i) : undefined;
    let el = map.get(instanceId);
    if (!el) {
      el = makeCardElement(instanceId, card, cardBack, { badge, draggable });
      if (extraClass) el.classList.add(extraClass);
      map.set(instanceId, el);
    } else {
      updateCardElement(el, card, cardBack, { badge });
    }
    const ref = prevEl ? prevEl.nextSibling : container.firstChild;
    if (ref !== el) container.insertBefore(el, ref);
    prevEl = el;
  });
  for (const [id, el] of map) {
    if (!seen.has(id)) {
      el.remove();
      map.delete(id);
    }
  }
  return map;
}

// fieldIds: z-order array of instanceId (last = top). positions: {[instanceId]: {x,y}} —
// both x and y are fractions of the field's WIDTH times the current zoom (see
// --field-unit), y can exceed 1 on tall/zoomed fields.
export function renderField(container, fieldIds, positions, cards, cardBack, groups = []) {
  const map = reconcileCards(container, fieldIds, cards, cardBack, { draggable: false, extraClass: 'field-card' });
  const hueOf = new Map();
  groups.forEach((g) => {
    let h = 0;
    for (const ch of g[0] || '') h = (h * 31 + ch.charCodeAt(0)) % 360;
    g.forEach((id) => hueOf.set(id, h));
  });
  fieldIds.forEach((instanceId) => {
    const el = map.get(instanceId);
    const pos = positions[instanceId] || { x: 0, y: 0 };
    const left = `calc(var(--field-unit, var(--field-w, 1000px)) * ${pos.x})`;
    const top = `calc(var(--field-unit, var(--field-w, 1000px)) * ${pos.y})`;
    if (el.style.left !== left) el.style.left = left;
    if (el.style.top !== top) el.style.top = top;
    if (hueOf.has(instanceId)) {
      el.classList.add('grouped');
      el.style.setProperty('--group-hue', String(hueOf.get(instanceId)));
    } else {
      el.classList.remove('grouped');
      el.style.removeProperty('--group-hue');
    }
  });
}

// ids: ordered array of instanceId for a list zone (hand / trash).
export function renderListStrip(container, ids, cards, cardBack, zoneName) {
  container.dataset.zone = zoneName;
  reconcileCards(container, ids, cards, cardBack, { draggable: true });
}

// items: [{instanceId, card, badge?}] — used for search / look / trash modal grids.
export function renderModalGrid(container, items, cardBack) {
  container.innerHTML = '';
  for (const item of items) {
    container.appendChild(makeCardElement(item.instanceId, item.card, cardBack, { badge: item.badge }));
  }
}

export function renderDeckPile(state, { imgEl, badgeEl }) {
  const src = state.cardBack || FALLBACK_BACK;
  if (imgEl.getAttribute('src') !== src) imgEl.src = src;
  if (badgeEl) badgeEl.textContent = String(deckCount(state));
}

export function renderTrashPile(state, { imgEl, boxEl, badgeEl }) {
  if (badgeEl) badgeEl.textContent = String(state.zones.trash.length);
  const topId = state.zones.trash[state.zones.trash.length - 1];
  const card = topId ? state.cards[topId] : null;
  if (card) {
    const src = cardImageSrc(card, state.cardBack);
    if (imgEl.getAttribute('src') !== src) imgEl.src = src;
    imgEl.hidden = false;
    boxEl.hidden = true;
  } else {
    imgEl.hidden = true;
    boxEl.hidden = false;
  }
}

export function renderCounters(container, counters, countersConfig, { editingKey, readOnly } = {}) {
  container.innerHTML = '';
  for (const def of countersConfig) {
    const row = document.createElement('div');
    row.className = 'counter-row';
    row.dataset.key = def.key;

    const label = document.createElement('div');
    label.className = 'counter-label';
    label.textContent = getLang() === 'ja' ? (def.labelJa || def.label) : def.label;

    const valueWrap = document.createElement('div');
    valueWrap.className = 'counter-value-wrap';
    if (!readOnly && editingKey === def.key) {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'counter-input';
      input.value = counters[def.key];
      input.dataset.key = def.key;
      if (def.min != null) input.min = def.min;
      if (def.max != null) input.max = def.max;
      valueWrap.appendChild(input);
    } else {
      const value = document.createElement('div');
      value.className = 'counter-value' + (readOnly ? ' readonly' : '');
      value.textContent = String(counters[def.key]);
      value.dataset.key = def.key;
      valueWrap.appendChild(value);
    }

    row.appendChild(label);
    if (!readOnly) {
      const minus = document.createElement('button');
      minus.className = 'counter-btn counter-minus';
      minus.textContent = '−';
      minus.dataset.action = 'minus';
      minus.dataset.key = def.key;
      row.appendChild(minus);
    }
    row.appendChild(valueWrap);
    if (!readOnly) {
      const plus = document.createElement('button');
      plus.className = 'counter-btn counter-plus';
      plus.textContent = '+';
      plus.dataset.action = 'plus';
      plus.dataset.key = def.key;
      row.appendChild(plus);
    }
    container.appendChild(row);
  }
}

// Keys whose template needs {name}; stream redaction may have stripped it.
const NAME_KEYS = new Set(['log.moved', 'log.toDeckTop', 'log.toDeckBottom']);

export function renderLog(container, log, freshCount = 0) {
  container.innerHTML = '';
  const lines = (log || []).slice(-30);
  lines.forEach((entry, i) => {
    const li = document.createElement('li');
    if (i >= lines.length - freshCount) li.classList.add('fresh');
    if (typeof entry === 'string') {
      li.textContent = entry;
    } else if (entry && entry.key) {
      const vars = entry.vars ? { ...entry.vars } : {};
      if (vars.zone) vars.zone = t(vars.zone);
      if (NAME_KEYS.has(entry.key) && vars.name == null) vars.name = t('aCard');
      li.textContent = t(entry.key, vars);
    }
    container.appendChild(li);
  });
  const scroller = container.closest('#log-panel') || container;
  scroller.scrollTop = scroller.scrollHeight;
}

export function formatDiceRoll(lastRoll) {
  if (!lastRoll) return '';
  const { sides, count, results, total } = lastRoll;
  if (count === 1) return `d${sides}: ${results[0]}`;
  return `${count}d${sides} = ${total}`;
}

// -- dice --

const PIP_LAYOUTS = {
  1: [[50, 50]],
  2: [[30, 30], [70, 70]],
  3: [[30, 30], [50, 50], [70, 70]],
  4: [[30, 30], [70, 30], [30, 70], [70, 70]],
  5: [[30, 30], [70, 30], [50, 50], [30, 70], [70, 70]],
  6: [[30, 25], [70, 25], [30, 50], [70, 50], [30, 75], [70, 75]],
};

// Non-d6 dice are drawn as a regular polygon (vertex count below) with the number centred;
// d10 gets a hand-tuned kite shape instead of a regular polygon.
const POLY_SIDES = { 4: 3, 8: 4, 12: 5, 20: 6 };

function regularPolygonPoints(n, cx = 50, cy = 50, r = 42, rotateDeg = -90) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const angle = (rotateDeg + i * (360 / n)) * Math.PI / 180;
    pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  return pts;
}

function pointsToStr(pts) {
  return pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
}

function dieSvgMarkup(sides, value) {
  const v = value || 1;
  if (sides === 6) {
    const pips = PIP_LAYOUTS[v] || PIP_LAYOUTS[1];
    const pipCircles = pips.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7" class="die-pip"/>`).join('');
    return `<svg viewBox="0 0 100 100" class="die-svg die-d6">
      <rect x="6" y="6" width="88" height="88" rx="16" class="die-face"/>
      ${pipCircles}
    </svg>`;
  }
  const points = sides === 10
    ? [[50, 6], [90, 42], [50, 94], [10, 42]]
    : regularPolygonPoints(POLY_SIDES[sides] || 6);
  return `<svg viewBox="0 0 100 100" class="die-svg die-d${sides}">
    <polygon points="${pointsToStr(points)}" class="die-face"/>
    <text x="50" y="50" text-anchor="middle" dominant-baseline="central" class="die-number">${v}</text>
  </svg>`;
}

function createDie(sides, value) {
  const wrap = document.createElement('div');
  wrap.className = 'die-wrap';
  wrap.innerHTML = dieSvgMarkup(sides, value);
  return wrap;
}

function setDieFace(dieEl, sides, value) {
  dieEl.innerHTML = dieSvgMarkup(sides, value);
}

// Static preview stage (no animation) — used while the dice modal is idle/reconfigured.
export function renderDiceStage(container, sides, count) {
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    container.appendChild(createDie(sides, 1));
  }
}

// Plays the tumble/settle roll animation for {sides, count, results} into `container`,
// then calls opts.onDone(). Shared by the dice modal and the stream dice overlay.
export function playDiceAnimation(container, lastRoll, opts = {}) {
  const { sides, count, results } = lastRoll;
  container.innerHTML = '';
  const dice = [];
  for (let i = 0; i < count; i++) {
    const wrap = createDie(sides, 1);
    container.appendChild(wrap);
    dice.push(wrap);
  }
  const reduced = typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    dice.forEach((wrap, i) => setDieFace(wrap, sides, results[i]));
    if (opts.onDone) opts.onDone();
    return;
  }
  const STAGGER = 80;
  const TUMBLE_MS = 1200;
  dice.forEach((wrap, i) => {
    setTimeout(() => {
      wrap.classList.add('tumble');
      const iv = setInterval(() => {
        setDieFace(wrap, sides, 1 + Math.floor(Math.random() * sides));
      }, 60);
      setTimeout(() => {
        clearInterval(iv);
        wrap.classList.remove('tumble');
        setDieFace(wrap, sides, results[i]);
        wrap.classList.add('settle');
      }, TUMBLE_MS);
    }, i * STAGGER);
  });
  const totalMs = TUMBLE_MS + (dice.length - 1) * STAGGER + 50;
  if (opts.onDone) setTimeout(opts.onDone, totalMs);
}

export function renderPreview(container, card, cardBack) {
  container.innerHTML = '';
  if (!card) {
    container.hidden = true;
    return;
  }
  const img = document.createElement('img');
  img.src = card.faceDown ? (cardBack || FALLBACK_BACK) : (card.image || cardBack || FALLBACK_BACK);
  img.alt = card.faceDown ? t('faceDownCard') : (card.name || '');
  container.appendChild(img);
  container.hidden = false;
}
