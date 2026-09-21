# Goldfish

日本語: [README.ja.md](README.ja.md)

Solo playtesting for a trading card game in your browser: draw, shuffle, play
cards to a field, manage hand, deck and trash, and optionally show a
spectator view for streaming.

## Getting a deck

A deck is a folder of card images: one image per distinct card, named
`<card name> xN.png` (`.jpg`, `.jpeg`, `.webp`, `.svg` also work), where `N` is how
many copies are in the deck, e.g. `Dragon x4.png`. Omit ` xN` for a single
copy. An optional `cardback.png` in the same folder is used as the deck's
card back.

Use ☰ → **Import from disk…** to pick a deck folder on your computer.

### Sample deck

No deck yet? Generate a standard 54-card poker deck (drawn by the app,
no copyrighted art):

```
python tools/make_poker_deck.py --out <your decks folder>
```

Then import that `Poker` folder with **Import from disk…**. Running the app
locally, omit `--out` and it lands in `decks/` directly.

### Where decks are stored

- **Chrome / Edge**: you choose a folder on your computer (☰ → Decks folder
  → Choose…). Decks are read from and imported into that folder. After a
  reload, click **Reconnect** once so the browser may read it again.
- **Firefox / Safari**: decks are kept inside the browser in a storage area
  called IndexedDB. It survives reloads but lives only in that browser
  profile; clearing site data or using ☰ → **Reset app data…** removes it.

## Your data

Everything the app remembers stays on your machine: the current game and
your settings in the browser's local storage, and decks either in the folder
you chose or in IndexedDB. Nothing is sent anywhere.

To wipe it all, use ☰ → **Reset app data…**. This deletes the saved game,
settings and any decks stored in the browser, and forgets the chosen decks
folder. Files in that folder on your disk are left untouched.

## Playing

- **☰ menu**: choose a deck, New game (also restarts), import, stream
  window, log, language, reset.
- **Field**: drop cards anywhere. Double-click to tap, right-click for a
  card's menu. Drag on empty space to select several cards; they move
  together. Its menu can untap all, or move everything to hand or trash.
- **Groups**: select cards and press `Ctrl+G` to group them. A group moves as
  one and keeps its stacking order; tapping is still per card. `Ctrl+Shift+G`
  ungroups.
- **Swap**: select two cards or groups and press `X`, or hold `Alt` while
  dropping a card onto another, to swap their positions.
- **Hand**: drag to reorder. Its menu moves all cards to the deck top or
  bottom (in order or shuffled), to trash, or discards one at random.
- **Deck / Trash**: click the deck to draw, the trash to view it. Their menus
  cover drawing, placing the top card face up or face down, looking at or
  searching the deck, milling and shuffling. Drag a pile onto the field to
  place its top card there; hold `Shift` from the deck to place it face down.
  Cards in the deck and trash viewers can be dragged straight onto the field,
  hand, deck or trash.
- **Counters**: the top bar starts with a Health counter. The ⚙ button next to it
  lets you rename it, change its starting value and limits, or add more; the
  list is saved in your browser.

Hotkeys:

- `D` draw, `S` shuffle, `N` next turn, `Ctrl+Z` undo, `Esc` close
- On a hovered card: `B` to field, `T` tap, `F` flip, `R` to hand, `G` to
  trash, `L` deck top, `Shift+L` deck bottom
- Selection: `Shift`+click adds or removes a card, `Ctrl+G` group,
  `Ctrl+Shift+G` ungroup, `X` swap two

## Streaming

☰ → **Open stream window** opens a second window to share on stream. It hides
your hand and face-down cards, mirrors the trash viewer, and shows only a
notice while you are looking through your deck.

## Language

☰ → **Language / 言語** switches between English and Japanese. The app picks
your browser's language the first time.

## Running locally instead

If you prefer not to use the website, run the app on your own computer. You
need Python 3; nothing else to install.

```
python server.py
```

This opens `http://localhost:8000`. Decks live in the `decks/` folder next to
the script.

`config.json` sets the default counters and the opening hand size; counters
edited in the app override it.
