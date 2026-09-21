// Deck storage backends. Server mode talks to server.py; static mode (e.g. GitHub Pages)
// keeps decks in a user-chosen folder (File System Access API) or in IndexedDB.
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.svg'];
const SUFFIX_RE = /[\s_][xX](\d+)$/;
const DB_NAME = 'goldfish';
const DB_VERSION = 1;

export const hasFsAccess = typeof window.showDirectoryPicker === 'function';

function splitName(fileName) {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? [fileName.slice(0, dot), fileName.slice(dot).toLowerCase()] : [fileName, ''];
}

function parseStem(stem) {
  const m = SUFFIX_RE.exec(stem);
  return m ? { name: stem.slice(0, m.index), count: parseInt(m[1], 10) } : { name: stem, count: 1 };
}

function isImage(name) {
  return IMAGE_EXTS.includes(splitName(name)[1]);
}

// Build a deck from a folder name and a list of {name, blob}. Shared by static backends.
function buildDeck(deckName, files, toUrl) {
  let cardBack = null;
  const cards = [];
  let cardCount = 0;
  for (const f of files) {
    const [stem, ext] = splitName(f.name);
    if (!IMAGE_EXTS.includes(ext)) continue;
    if (stem.toLowerCase() === 'cardback') { cardBack = toUrl(f); continue; }
    const { name, count } = parseStem(stem);
    cards.push({ id: `${deckName}/${f.name}`, name, count, image: toUrl(f) });
    cardCount += count;
  }
  cards.sort((a, b) => a.name.localeCompare(b.name));
  return { name: deckName, cardBack, cards, cardCount, uniqueCount: cards.length };
}

function applyDeckImages(state, deck) {
  if (!deck) return false;
  const byId = new Map(deck.cards.map((c) => [c.id, c.image]));
  for (const inst of Object.values(state.cards)) {
    if (byId.has(inst.id)) inst.image = byId.get(inst.id);
  }
  state.cardBack = deck.cardBack;
  return true;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files'); // "deck/file" -> Blob
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(storeName, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const out = fn(tx.objectStore(storeName));
    tx.oncomplete = () => { db.close(); resolve(out instanceof IDBRequest ? out.result : out); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

class BlobUrlCache {
  constructor() { this.urls = new Map(); }
  resolver(deckName) {
    return (f) => {
      const key = `${deckName}/${f.name}`;
      if (!this.urls.has(key)) this.urls.set(key, URL.createObjectURL(f.blob));
      return this.urls.get(key);
    };
  }
}

// ---------------------------------------------------------------- server ---

export class ServerStore {
  kind = 'server';

  async list() {
    const res = await fetch('api/decks');
    return (await res.json()).decks;
  }

  async load(name) {
    const res = await fetch('api/decks/' + encodeURIComponent(name));
    if (!res.ok) return null;
    return res.json();
  }

  async importFiles(deckName, files) {
    for (const f of files) {
      if (!isImage(f.name)) continue;
      const res = await fetch('api/decks/' + encodeURIComponent(deckName) + '/' + encodeURIComponent(f.name), {
        method: 'PUT', body: f,
      });
      if (!res.ok) throw new Error(`upload failed: ${f.name}`);
    }
    return this.load(deckName);
  }

  // Server URLs are stable across reloads.
  async rehydrate() { return true; }
}

// -------------------------------------------------------- chosen folder ---

export class FolderStore {
  kind = 'folder';

  constructor() { this.dir = null; this.cache = new BlobUrlCache(); }

  async restore() {
    try {
      this.dir = (await idb('handles', 'readonly', (s) => s.get('decksDir'))) || null;
    } catch { this.dir = null; }
    return !!this.dir;
  }

  // Must be called from a user gesture.
  async pick() {
    this.dir = await window.showDirectoryPicker({ id: 'goldfish-decks', mode: 'readwrite' });
    await idb('handles', 'readwrite', (s) => s.put(this.dir, 'decksDir'));
    return this.dir.name;
  }

  async hasPermission(request = false) {
    if (!this.dir) return false;
    const opts = { mode: 'readwrite' };
    if ((await this.dir.queryPermission(opts)) === 'granted') return true;
    if (!request) return false;
    return (await this.dir.requestPermission(opts)) === 'granted';
  }

  get label() { return this.dir ? this.dir.name : ''; }

  async _files(deckName) {
    const dh = await this.dir.getDirectoryHandle(deckName);
    const out = [];
    for await (const [name, h] of dh.entries()) {
      if (h.kind === 'file' && isImage(name)) out.push({ name, blob: await h.getFile() });
    }
    return out;
  }

  async list() {
    if (!(await this.hasPermission())) return [];
    const decks = [];
    for await (const [name, h] of this.dir.entries()) {
      if (h.kind !== 'directory' || name.startsWith('.')) continue;
      const d = buildDeck(name, await this._files(name), () => '');
      decks.push({ name, cardCount: d.cardCount, uniqueCount: d.uniqueCount });
    }
    return decks.sort((a, b) => a.name.localeCompare(b.name));
  }

  async load(name) {
    if (!(await this.hasPermission())) return null;
    let files;
    try { files = await this._files(name); } catch { return null; }
    return buildDeck(name, files, this.cache.resolver(name));
  }

  async importFiles(deckName, files) {
    if (!(await this.hasPermission(true))) throw new Error('folder access denied');
    const dh = await this.dir.getDirectoryHandle(deckName, { create: true });
    for (const f of files) {
      if (!isImage(f.name)) continue;
      const fh = await dh.getFileHandle(f.name, { create: true });
      const w = await fh.createWritable();
      await w.write(f);
      await w.close();
    }
    return this.load(deckName);
  }

  // Blob URLs do not survive a reload; re-resolve them from the folder.
  async rehydrate(state) {
    return applyDeckImages(state, await this.load(state.deckName));
  }
}

// -------------------------------------------------------------- IndexedDB ---

export class IdbStore {
  kind = 'idb';

  constructor() { this.cache = new BlobUrlCache(); }

  async _all() {
    const rows = await idb('files', 'readonly', (s) => {
      const out = [];
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) { out.push({ key: c.key, blob: c.value }); c.continue(); }
      };
      return out;
    });
    const byDeck = new Map();
    for (const r of rows) {
      const i = r.key.indexOf('/');
      const deck = r.key.slice(0, i);
      if (!byDeck.has(deck)) byDeck.set(deck, []);
      byDeck.get(deck).push({ name: r.key.slice(i + 1), blob: r.blob });
    }
    return byDeck;
  }

  async list() {
    const byDeck = await this._all();
    return [...byDeck.entries()].map(([name, files]) => {
      const d = buildDeck(name, files, () => '');
      return { name, cardCount: d.cardCount, uniqueCount: d.uniqueCount };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  async load(name) {
    const files = (await this._all()).get(name);
    return files ? buildDeck(name, files, this.cache.resolver(name)) : null;
  }

  async importFiles(deckName, files) {
    const imgs = [...files].filter((f) => isImage(f.name));
    await idb('files', 'readwrite', (s) => { for (const f of imgs) s.put(f, `${deckName}/${f.name}`); });
    return this.load(deckName);
  }

  async rehydrate(state) {
    return applyDeckImages(state, await this.load(state.deckName));
  }
}

// Deck name for a picked folder: the top-level folder of the selected files.
export function deckNameFromFiles(files) {
  for (const f of files) {
    const rel = f.webkitRelativePath || '';
    const i = rel.indexOf('/');
    if (i > 0) return rel.slice(0, i);
  }
  return '';
}

export async function isServerAvailable() {
  try {
    const res = await fetch('api/decks', { cache: 'no-store' });
    return res.ok && (res.headers.get('Content-Type') || '').includes('json');
  } catch { return false; }
}
