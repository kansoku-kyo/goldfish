// Pure, DOM-free game-state module for the Goldfish TCG playtesting sandbox.
// No DOM access.

export const ZONES = Object.freeze(['deck', 'hand', 'trash', 'field']);

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

// Crypto-backed uniform [0, 1) — Math.random's quality varies by engine.
export function secureRandom() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] / 4294967296;
  }
  return Math.random();
}

function fisherYates(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

function pushLog(next, key, vars) {
  next.logTotal = (next.logTotal == null ? next.log.length : next.logTotal) + 1;
  next.log.push(vars ? { key, vars } : { key });
  while (next.log.length > 200) next.log.shift();
}

function clampValue(value, min, max) {
  let v = value;
  if (min != null && v < min) v = min;
  if (max != null && v > max) v = max;
  return v;
}

function locate(state, instanceId) {
  for (const zone of ZONES) {
    const idx = state.zones[zone].indexOf(instanceId);
    if (idx !== -1) return { zone, index: idx };
  }
  return null;
}

function sameBoard(a, b) {
  return JSON.stringify([a.zones, a.positions, a.cards]) === JSON.stringify([b.zones, b.positions, b.cards]);
}

function deepEqualOrder(a, b) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

// Mutates `next` in place; returns the moved card object (or null if unknown).
function moveCardImpl(next, instanceId, to, index, x, y) {
  const card = next.cards[instanceId];
  if (!card) return null;

  const loc = locate(next, instanceId);
  if (loc) {
    next.zones[loc.zone].splice(loc.index, 1);
    if (loc.zone === 'field') delete next.positions[instanceId];
  }

  if (to === 'hand') {
    card.tapped = false;
    card.faceDown = false;
  } else if (to === 'deck') {
    card.tapped = false;
  } else if (to === 'trash') {
    card.tapped = false;
    card.faceDown = false;
  }

  if (to === 'field') {
    next.zones.field.push(instanceId);
    next.positions[instanceId] = { x: clampValue(x, 0, 1), y: clampValue(y, 0, 2) };
  } else {
    const list = next.zones[to];
    let insertIndex;
    if (to === 'deck') {
      insertIndex = index == null ? 0 : index;
    } else {
      insertIndex = index == null ? list.length : index;
    }
    list.splice(insertIndex, 0, instanceId);
  }

  return card;
}

export function newGame(deckJson, config, rng = secureRandom) {
  const cards = {};
  const deckIds = [];
  for (const c of deckJson.cards) {
    for (let n = 1; n <= c.count; n++) {
      const instanceId = `${c.id}#${n}`;
      cards[instanceId] = { id: c.id, name: c.name, image: c.image, faceDown: false, tapped: false };
      deckIds.push(instanceId);
    }
  }
  fisherYates(deckIds, rng);

  const startingHand = config.startingHand || 0;
  const hand = deckIds.splice(0, startingHand);

  const counters = {};
  for (const c of (config.counters || [])) counters[c.key] = c.default;

  return {
    deckName: deckJson.name,
    cardBack: deckJson.cardBack ?? null,
    cards,
    zones: {
      deck: deckIds,
      hand,
      trash: [],
      field: [],
    },
    positions: {},
    coordVersion: 2,
    groups: [],
    counters,
    turn: 1,
    log: [{ key: 'log.newGame', vars: { deck: deckJson.name } }],
    lastRoll: null,
    meta: { deckJson, config },
  };
}

const DICE_SIDES = [4, 6, 8, 10, 12, 20];

function applyRollDice(state, action) {
  const { sides, count } = action;
  if (!DICE_SIDES.includes(sides)) return state;
  if (typeof count !== 'number' || count < 1 || count > 10) return state;
  const rng = action.rng || secureRandom;
  const next = cloneState(state);
  const results = [];
  for (let i = 0; i < count; i++) results.push(Math.floor(rng() * sides) + 1);
  const total = results.reduce((a, b) => a + b, 0);
  const seq = (state.lastRoll ? state.lastRoll.seq : 0) + 1;
  next.lastRoll = { sides, count, results, total, seq };
  pushLog(next, 'log.dice', { count, sides, results: results.join(', '), total });
  return next;
}

function applyShuffle(state, action) {
  const next = cloneState(state);
  fisherYates(next.zones.deck, action.rng || secureRandom);
  pushLog(next, 'log.shuffled');
  return next;
}

function applyDraw(state, action) {
  const next = cloneState(state);
  if (next.zones.deck.length === 0) {
    pushLog(next, 'log.deckEmpty');
    return next;
  }
  const count = Math.min(action.n, next.zones.deck.length);
  for (let i = 0; i < count; i++) {
    const instanceId = next.zones.deck.shift();
    const card = next.cards[instanceId];
    if (card) {
      card.tapped = false;
      card.faceDown = false;
    }
    next.zones.hand.push(instanceId);
  }
  pushLog(next, 'log.drew', { n: count });
  return next;
}

function applyMulligan(state, action) {
  const next = cloneState(state);
  while (next.zones.hand.length > 0) {
    const instanceId = next.zones.hand.pop();
    const card = next.cards[instanceId];
    if (card) card.tapped = false;
    next.zones.deck.unshift(instanceId);
  }
  fisherYates(next.zones.deck, action.rng || secureRandom);

  const startingHand = next.meta.config.startingHand || 0;
  const count = Math.min(startingHand, next.zones.deck.length);
  for (let i = 0; i < count; i++) {
    const instanceId = next.zones.deck.shift();
    const card = next.cards[instanceId];
    if (card) {
      card.tapped = false;
      card.faceDown = false;
    }
    next.zones.hand.push(instanceId);
  }
  pushLog(next, 'log.mulligan');
  return next;
}

function applyMoveCard(state, action) {
  const { instanceId, to, index, x, y, faceDown } = action;
  if (!ZONES.includes(to)) return state;
  if (!state.cards[instanceId]) return state;
  if (to === 'field' && (typeof x !== 'number' || typeof y !== 'number')) return state;

  const loc0 = locate(state, instanceId);
  const isHandReorder = to === 'hand' && loc0 && loc0.zone === 'hand';

  const next = cloneState(state);
  let insertAt = index;
  if (insertAt == null && to !== 'field') {
    const loc = locate(state, instanceId);
    if (loc && loc.zone === to) insertAt = loc.index;
  }
  const card = moveCardImpl(next, instanceId, to, insertAt, x, y);
  if (!card) return state;
  if (to === 'field' && faceDown) card.faceDown = true;
  if (isHandReorder) {
    if (deepEqualOrder(state.zones.hand, next.zones.hand)) return state;
    return next;
  }
  if (sameBoard(state, next)) return state;

  if (to === 'deck') {
    const wasTop = index == null || index === 0;
    pushLog(next, wasTop ? 'log.toDeckTop' : 'log.toDeckBottom', { name: card.name });
  } else if (to === 'field' && faceDown) {
    pushLog(next, 'log.movedFaceDown', {});
  } else {
    pushLog(next, 'log.moved', { name: card.name, zone: to });
  }
  return next;
}

function applyMoveOnField(state, action) {
  const { instanceId, x, y } = action;
  if (!state.cards[instanceId]) return state;
  if (typeof x !== 'number' || typeof y !== 'number') return state;
  const idx = state.zones.field.indexOf(instanceId);
  if (idx === -1) return state;

  const clampedX = clampValue(x, 0, 1);
  const clampedY = clampValue(y, 0, 2);
  const alreadyOnTop = idx === state.zones.field.length - 1;
  const pos = state.positions[instanceId];
  const samePos = pos && pos.x === clampedX && pos.y === clampedY;
  if (alreadyOnTop && samePos) return state;

  const next = cloneState(state);
  const nextIdx = next.zones.field.indexOf(instanceId);
  next.zones.field.splice(nextIdx, 1);
  next.zones.field.push(instanceId);
  next.positions[instanceId] = { x: clampedX, y: clampedY };
  return next;
}

function applyMoveCardsOnField(state, action) {
  const moves = action.moves;
  if (!Array.isArray(moves) || moves.length === 0) return state;
  const valid = moves.filter((m) => m && state.cards[m.instanceId]
    && state.zones.field.includes(m.instanceId)
    && typeof m.x === 'number' && typeof m.y === 'number');
  if (valid.length === 0) return state;

  const next = cloneState(state);
  const movedIds = [];
  for (const m of valid) {
    next.positions[m.instanceId] = { x: clampValue(m.x, 0, 1), y: clampValue(m.y, 0, 2) };
    movedIds.push(m.instanceId);
  }
  const movedSet = new Set(movedIds);
  const remaining = next.zones.field.filter((id) => !movedSet.has(id));
  const movedInFieldOrder = next.zones.field.filter((id) => movedSet.has(id));
  next.zones.field = [...remaining, ...movedInFieldOrder];
  if (sameBoard(state, next)) return state;
  return next;
}

// The group containing `id` (in stored group order), or `[id]` if ungrouped.
function unitOf(state, id) {
  const g = (state.groups || []).find((grp) => grp.includes(id));
  return g || [id];
}

function applySwapOnField(state, action) {
  const { a, b } = action;
  const fieldSet = new Set(state.zones.field);
  if (!fieldSet.has(a) || !fieldSet.has(b)) return state;

  const unitA = unitOf(state, a);
  if (unitA.includes(b)) return state;
  const unitB = unitOf(state, b);

  const anchorA = unitA[0];
  const anchorB = unitB[0];
  const posA = state.positions[anchorA];
  const posB = state.positions[anchorB];
  if (!posA || !posB) return state;
  const dx = posB.x - posA.x;
  const dy = posB.y - posA.y;

  const next = cloneState(state);
  for (const id of unitA) {
    const p = state.positions[id];
    if (!p) continue;
    next.positions[id] = { x: clampValue(p.x + dx, 0, 1), y: clampValue(p.y + dy, 0, 2) };
  }
  for (const id of unitB) {
    const p = state.positions[id];
    if (!p) continue;
    next.positions[id] = { x: clampValue(p.x - dx, 0, 1), y: clampValue(p.y - dy, 0, 2) };
  }
  const nameA = next.cards[anchorA] ? next.cards[anchorA].name : anchorA;
  const nameB = next.cards[anchorB] ? next.cards[anchorB].name : anchorB;
  pushLog(next, 'log.swapped', { a: nameA, b: nameB });
  return next;
}

function applyGroupCards(state, action) {
  const ids = action.instanceIds;
  if (!Array.isArray(ids)) return state;
  const fieldSet = new Set(state.zones.field);
  const wanted = new Set(ids.filter((id) => fieldSet.has(id)));
  if (wanted.size < 2) return state;

  const next = cloneState(state);
  next.groups = next.groups
    .map((g) => g.filter((id) => !wanted.has(id)))
    .filter((g) => g.length >= 2);
  const ordered = next.zones.field.filter((id) => wanted.has(id));
  next.groups.push(ordered);
  pushLog(next, 'log.grouped', { n: ordered.length });
  return next;
}

function applyUngroupCards(state, action) {
  const ids = action.instanceIds;
  if (!Array.isArray(ids) || ids.length === 0) return state;
  const idSet = new Set(ids);
  let removed = 0;
  for (const g of state.groups) {
    for (const id of g) if (idSet.has(id)) removed++;
  }
  if (removed === 0) return state;

  const next = cloneState(state);
  next.groups = next.groups
    .map((g) => g.filter((id) => !idSet.has(id)))
    .filter((g) => g.length >= 2);
  pushLog(next, 'log.ungrouped', { n: removed });
  return next;
}

// Mutates `next.groups` in place (dropping members off the field and groups
// left with <2 members); keeps the same array reference when nothing changes.
function pruneGroups(next) {
  const groups = next.groups || [];
  if (groups.length === 0) return next;
  const fieldSet = new Set(next.zones.field);
  let changed = false;
  const filtered = [];
  for (const group of groups) {
    const kept = group.filter((id) => fieldSet.has(id));
    if (kept.length !== group.length) changed = true;
    if (kept.length >= 2) filtered.push(kept);
    else changed = true;
  }
  if (!changed) return next;
  next.groups = filtered;
  return next;
}

function applyToggleTap(state, action) {
  if (!state.cards[action.instanceId] || !state.zones.field.includes(action.instanceId)) return state;
  const next = cloneState(state);
  const card = next.cards[action.instanceId];
  card.tapped = !card.tapped;
  pushLog(next, card.tapped ? 'log.tapped' : 'log.untapped', { name: card.name });
  return next;
}

function applyToggleFaceDown(state, action) {
  if (!state.cards[action.instanceId]) return state;
  const next = cloneState(state);
  const card = next.cards[action.instanceId];
  card.faceDown = !card.faceDown;
  pushLog(next, card.faceDown ? 'log.faceDown' : 'log.faceUp', { name: card.name });
  return next;
}

function applySetCounter(state, action) {
  const def = (state.meta.config.counters || []).find((c) => c.key === action.key);
  if (!def) return state;
  const value = clampValue(action.value, def.min, def.max);
  if (value === state.counters[action.key]) return state;
  const next = cloneState(state);
  next.counters[action.key] = value;
  pushLog(next, 'log.counter', { label: def.label, value });
  return next;
}

function applyAdjustCounter(state, action) {
  const def = (state.meta.config.counters || []).find((c) => c.key === action.key);
  if (!def) return state;
  const value = clampValue(state.counters[action.key] + action.delta, def.min, def.max);
  if (value === state.counters[action.key]) return state;
  const next = cloneState(state);
  next.counters[action.key] = value;
  pushLog(next, 'log.counter', { label: def.label, value });
  return next;
}

function applyNextTurn(state) {
  const next = cloneState(state);
  next.turn += 1;
  for (const instanceId of next.zones.field) {
    if (next.cards[instanceId]) next.cards[instanceId].tapped = false;
  }
  pushLog(next, 'log.turn', { n: next.turn });
  return next;
}

function applyDiscardHand(state) {
  const next = cloneState(state);
  const n = next.zones.hand.length;
  while (next.zones.hand.length > 0) {
    const instanceId = next.zones.hand.shift();
    const card = next.cards[instanceId];
    if (card) {
      card.tapped = false;
      card.faceDown = false;
    }
    next.zones.trash.push(instanceId);
  }
  pushLog(next, 'log.discardHand', { n });
  return next;
}

// Whole hand to the deck bottom in random order (the order is not revealed).
function applyHandToDeckBottomRandom(state, action) {
  if (state.zones.hand.length === 0) return state;
  const next = cloneState(state);
  const ids = [...next.zones.hand];
  fisherYates(ids, action.rng || secureRandom);
  next.zones.hand = [];
  for (const instanceId of ids) {
    const card = next.cards[instanceId];
    if (card) card.tapped = false;
    next.zones.deck.push(instanceId);
  }
  pushLog(next, 'log.handToBottomRandom', { n: ids.length });
  return next;
}

function applyReorderDeckTop(state, action) {
  const ids = action.ids;
  if (!Array.isArray(ids)) return state;
  if (ids.length === 0) return state;
  const prefix = state.zones.deck.slice(0, ids.length);
  const sortedPrefix = [...prefix].sort();
  const sortedIds = [...ids].sort();
  if (sortedPrefix.length !== sortedIds.length) return state;
  for (let i = 0; i < sortedPrefix.length; i++) {
    if (sortedPrefix[i] !== sortedIds[i]) return state;
  }
  const next = cloneState(state);
  next.zones.deck.splice(0, ids.length, ...ids);
  if (action.toBottom) {
    const moved = next.zones.deck.splice(0, ids.length);
    next.zones.deck.push(...moved);
    pushLog(next, 'log.toBottom', { n: ids.length });
  } else {
    pushLog(next, 'log.reorderedTop', { n: ids.length });
  }
  return next;
}

function applyDeckTopToBottom(state, action) {
  const n = action.n;
  if (typeof n !== 'number' || n <= 0) return state;
  const next = cloneState(state);
  const count = Math.min(n, next.zones.deck.length);
  const moved = next.zones.deck.splice(0, count);
  next.zones.deck.push(...moved);
  pushLog(next, 'log.toBottom', { n: count });
  return next;
}

function applyReset(state, action) {
  if (!state.meta) return state;
  return newGame(state.meta.deckJson, state.meta.config, action.rng || secureRandom);
}

function applyAction(state, action) {
  switch (action.type) {
    case 'rollDice':
      return applyRollDice(state, action);
    case 'shuffle':
      return applyShuffle(state, action);
    case 'draw':
      return applyDraw(state, action);
    case 'mulligan':
      return applyMulligan(state, action);
    case 'moveCard':
      return applyMoveCard(state, action);
    case 'moveOnField':
      return applyMoveOnField(state, action);
    case 'moveCardsOnField':
      return applyMoveCardsOnField(state, action);
    case 'swapOnField':
      return applySwapOnField(state, action);
    case 'groupCards':
      return applyGroupCards(state, action);
    case 'ungroupCards':
      return applyUngroupCards(state, action);
    case 'toggleTap':
      return applyToggleTap(state, action);
    case 'toggleFaceDown':
      return applyToggleFaceDown(state, action);
    case 'setCounter':
      return applySetCounter(state, action);
    case 'adjustCounter':
      return applyAdjustCounter(state, action);
    case 'nextTurn':
      return applyNextTurn(state);
    case 'toDeckTop':
      return applyMoveCard(state, { instanceId: action.instanceId, to: 'deck', index: 0 });
    case 'toDeckBottom':
      return applyMoveCard(state, { instanceId: action.instanceId, to: 'deck', index: state.zones.deck.length });
    case 'discardHand':
      return applyDiscardHand(state);
    case 'handToDeckBottomRandom':
      return applyHandToDeckBottomRandom(state, action);
    case 'reorderDeckTop':
      return applyReorderDeckTop(state, action);
    case 'deckTopToBottom':
      return applyDeckTopToBottom(state, action);
    case 'reset':
      return applyReset(state, action);
    default:
      return state;
  }
}

export function reduce(state, action) {
  if (!action || typeof action.type !== 'string') return state;
  const next = applyAction(state, action);
  if (next === state) return state;
  return pruneGroups(next);
}

// Strips the card name from log entries that would otherwise leak a hidden
// card's identity to stream viewers (a card entering the hand, or a hand
// card returning to the deck).
function redactLogEntry(entry) {
  if (typeof entry === 'string' || !entry || !entry.key) return entry;
  const copy = { key: entry.key };
  if (entry.vars) copy.vars = { ...entry.vars };
  const hidesName = (copy.key === 'log.moved' && copy.vars && copy.vars.zone === 'hand')
    || copy.key === 'log.toDeckTop'
    || copy.key === 'log.toDeckBottom';
  if (hidesName && copy.vars) delete copy.vars.name;
  return copy;
}

export function serializeForStream(state) {
  const trashIds = state.zones.trash;
  const fieldIds = state.zones.field;
  const visibleIds = new Set([...trashIds, ...fieldIds]);

  const cards = {};
  for (const instanceId of visibleIds) {
    const card = state.cards[instanceId];
    if (!card) continue;
    const copy = { ...card };
    if (copy.faceDown) {
      copy.name = null;
      copy.image = null;
      delete copy.id;
    }
    cards[instanceId] = copy;
  }

  const positions = {};
  for (const instanceId of fieldIds) {
    if (state.positions[instanceId]) positions[instanceId] = { ...state.positions[instanceId] };
  }

  const fieldIdSet = new Set(fieldIds);
  const groups = (state.groups || [])
    .map((g) => g.filter((id) => fieldIdSet.has(id)))
    .filter((g) => g.length >= 2);

  return {
    deckName: state.deckName,
    cardBack: state.cardBack,
    counters: { ...state.counters },
    turn: state.turn,
    lastRoll: state.lastRoll ? { ...state.lastRoll, results: [...state.lastRoll.results] } : null,
    log: state.log.slice(-30).map(redactLogEntry),
    logTotal: state.logTotal || state.log.length,
    zones: {
      deck: { count: state.zones.deck.length },
      hand: { count: state.zones.hand.length },
      trash: [...trashIds],
      field: [...fieldIds],
    },
    cards,
    positions,
    groups,
  };
}
