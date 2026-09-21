"""Generate an original 54-card poker deck as SVG files (Goldfish deck folder format)."""
import argparse
import json
from pathlib import Path

W, H = 630, 880
RED = "#c8102e"
BLACK = "#111111"

RANKS = ["Ace", "2", "3", "4", "5", "6", "7", "8", "9", "10", "Jack", "Queen", "King"]
SUITS = ["Spades", "Hearts", "Diamonds", "Clubs"]
SUIT_COLOR = {"Spades": BLACK, "Hearts": RED, "Diamonds": RED, "Clubs": BLACK}
RANK_LETTER = {"Ace": "A", "Jack": "J", "Queen": "Q", "King": "K"}

SUIT_PATHS = {
    "Spades": (
        "M0,-34 C-24,-8 -34,10 -34,24 C-34,40 -20,50 -6,50 C-2,50 2,49 5,47 "
        "C2,58 -6,66 -16,70 L16,70 C6,66 -2,58 -5,47 C-2,49 2,50 6,50 "
        "C20,50 34,40 34,24 C34,10 24,-8 0,-34 Z"
    ),
    "Hearts": (
        "M0,64 C-30,38 -46,18 -46,-4 C-46,-24 -32,-38 -14,-38 C-4,-38 4,-32 0,-20 "
        "C-4,-32 4,-38 14,-38 C32,-38 46,-24 46,-4 C46,18 30,38 0,64 Z"
    ),
    "Diamonds": "M0,-52 L34,0 L0,52 L-34,0 Z",
    "Clubs": (
        "M0,-8 C0,-24 -14,-36 -28,-36 C-44,-36 -56,-24 -56,-8 "
        "C-56,6 -46,16 -34,18 C-40,30 -48,42 -58,52 L-16,52 "
        "C-14,38 -12,24 0,16 C12,24 14,38 16,52 L58,52 "
        "C48,42 40,30 34,18 C46,16 56,6 56,-8 "
        "C56,-24 44,-36 28,-36 C14,-36 0,-24 0,-8 Z"
    ),
}


def _defs():
    parts = ["<defs>"]
    for suit, path in SUIT_PATHS.items():
        parts.append(f'<symbol id="{suit}" viewBox="-60 -60 120 130">'
                      f'<path d="{path}" fill="currentColor"/></symbol>')
    parts.append("</defs>")
    return "".join(parts)


def _suit_use(suit, x, y, scale=1.0, rotate=0):
    color = SUIT_COLOR[suit]
    transform = f"translate({x},{y}) rotate({rotate}) scale({scale})"
    return (f'<use href="#{suit}" width="120" height="130" x="-60" y="-65" '
            f'transform="{transform}" color="{color}"/>')


def _corner_index(rank, suit):
    letter = RANK_LETTER.get(rank, rank)
    color = SUIT_COLOR[suit]
    return (
        f'<text x="0" y="0" font-family="sans-serif" font-size="52" font-weight="700" '
        f'fill="{color}" text-anchor="middle">{letter}</text>'
        + _suit_use(suit, 0, 58, 0.55)
    )


def _corners(rank, suit):
    parts = [f'<g transform="translate(56,74)">{_corner_index(rank, suit)}</g>']
    parts.append(
        f'<g transform="translate({W - 56},{H - 74}) rotate(180)">{_corner_index(rank, suit)}</g>'
    )
    return "".join(parts)


PIP_LAYOUTS = {
    2: [(0, -260), (0, 260)],
    3: [(0, -260), (0, 0), (0, 260)],
    4: [(-100, -260), (100, -260), (-100, 260), (100, 260)],
    5: [(-100, -260), (100, -260), (0, 0), (-100, 260), (100, 260)],
    6: [(-100, -260), (100, -260), (-100, 0), (100, 0), (-100, 260), (100, 260)],
    7: [(-100, -260), (100, -260), (0, -130), (-100, 0), (100, 0), (-100, 260), (100, 260)],
    8: [(-100, -260), (100, -260), (0, -130), (-100, 0), (100, 0), (0, 130), (-100, 260), (100, 260)],
    9: [(-100, -260), (100, -260), (-100, -87), (100, -87), (0, 0),
        (-100, 87), (100, 87), (-100, 260), (100, 260)],
    10: [(-100, -300), (100, -300), (0, -195), (-100, -95), (100, -95),
         (-100, 95), (100, 95), (0, 195), (-100, 300), (100, 300)],
}


def _pips(rank, suit):
    n = {"2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10}[rank]
    cx, cy = W / 2, H / 2
    parts = []
    for x, y in PIP_LAYOUTS[n]:
        rotate = 180 if y < 0 else 0
        parts.append(_suit_use(suit, cx + x, cy + y, 0.85, rotate))
    return "".join(parts)


def _face(rank, suit):
    cx, cy = W / 2, H / 2
    letter = RANK_LETTER[rank]
    color = SUIT_COLOR[suit]
    box = (
        f'<rect x="{cx - 140}" y="{cy - 190}" width="280" height="380" '
        f'fill="none" stroke="{color}" stroke-width="4"/>'
    )
    text = (
        f'<text x="{cx}" y="{cy + 70}" font-family="serif" font-size="220" '
        f'font-weight="700" fill="{color}" text-anchor="middle">{letter}</text>'
    )
    return box + text + _suit_use(suit, cx, cy - 130, 1.3)


def _ace(suit):
    cx, cy = W / 2, H / 2
    return _suit_use(suit, cx, cy, 2.6)


def card_svg(rank, suit):
    body = _corners(rank, suit)
    if rank == "Ace":
        body += _ace(suit)
    elif rank in ("Jack", "Queen", "King"):
        body += _face(rank, suit)
    else:
        body += _pips(rank, suit)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}">'
        f"{_defs()}"
        f'<rect x="4" y="4" width="{W - 8}" height="{H - 8}" rx="36" ry="36" '
        f'fill="#ffffff" stroke="#222222" stroke-width="1.5"/>'
        f"{body}"
        f"</svg>"
    )


def _star_path(cx, cy, r_outer, r_inner):
    import math

    points = []
    for i in range(10):
        r = r_outer if i % 2 == 0 else r_inner
        angle = -math.pi / 2 + i * math.pi / 5
        points.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    d = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in points) + " Z"
    return d


def joker_svg(color_name):
    cx, cy = W / 2, H / 2
    fill = RED if color_name == "Red" else BLACK
    star = _star_path(cx, cy - 40, 130, 55)
    letters = "JOKER"
    corner_text = "".join(
        f'<text x="0" y="{i * 56}" font-family="sans-serif" font-size="48" '
        f'font-weight="700" fill="{fill}" text-anchor="middle">{ch}</text>'
        for i, ch in enumerate(letters)
    )
    top = f'<g transform="translate(60,70)">{corner_text}</g>'
    bottom = f'<g transform="translate({W - 60},{H - 70}) rotate(180)">{corner_text}</g>'
    star_shape = f'<path d="{star}" fill="{fill}"/>'
    hat = (
        f'<path d="M{cx - 90},{cy + 160} Q{cx},{cy + 40} {cx + 90},{cy + 160} Z" '
        f'fill="{fill}"/>'
        f'<circle cx="{cx - 80}" cy="{cy + 160}" r="14" fill="{fill}"/>'
        f'<circle cx="{cx}" cy="{cy + 45}" r="14" fill="{fill}"/>'
        f'<circle cx="{cx + 80}" cy="{cy + 160}" r="14" fill="{fill}"/>'
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}">'
        f'<rect x="4" y="4" width="{W - 8}" height="{H - 8}" rx="36" ry="36" '
        f'fill="#ffffff" stroke="#222222" stroke-width="1.5"/>'
        f"{top}{bottom}{star_shape}{hat}"
        f"</svg>"
    )


def back_svg():
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}">'
        "<defs>"
        '<pattern id="lattice" width="60" height="60" patternUnits="userSpaceOnUse">'
        '<path d="M30,0 L60,30 L30,60 L0,30 Z" fill="none" stroke="#3a5aa0" stroke-width="2"/>'
        "</pattern>"
        "</defs>"
        f'<rect x="4" y="4" width="{W - 8}" height="{H - 8}" rx="36" ry="36" fill="#1f3a70"/>'
        f'<rect x="26" y="26" width="{W - 52}" height="{H - 52}" rx="24" ry="24" '
        'fill="none" stroke="#ffffff" stroke-width="6"/>'
        f'<rect x="40" y="40" width="{W - 80}" height="{H - 80}" fill="url(#lattice)"/>'
        "</svg>"
    )


def write_deck(out_dir: Path, name: str) -> Path:
    deck_dir = out_dir / name
    deck_dir.mkdir(parents=True, exist_ok=True)
    for rank in RANKS:
        for suit in SUITS:
            (deck_dir / f"{rank} of {suit}.svg").write_text(card_svg(rank, suit), encoding="utf-8")
    (deck_dir / "Joker (Red).svg").write_text(joker_svg("Red"), encoding="utf-8")
    (deck_dir / "Joker (Black).svg").write_text(joker_svg("Black"), encoding="utf-8")
    (deck_dir / "cardback.svg").write_text(back_svg(), encoding="utf-8")
    return deck_dir


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".svg"}


def write_manifest(out_dir: Path) -> Path:
    """Scan out_dir for deck subfolders and write out_dir/index.json."""
    decks = []
    for deck_dir in sorted(out_dir.iterdir(), key=lambda p: p.name):
        if not deck_dir.is_dir() or deck_dir.name.startswith("."):
            continue
        files = sorted(
            f.name for f in deck_dir.iterdir()
            if f.is_file() and f.suffix.lower() in IMAGE_EXTS
        )
        decks.append({"name": deck_dir.name, "files": files})
    manifest_path = out_dir / "index.json"
    manifest_path.write_text(json.dumps({"decks": decks}, indent=2), encoding="utf-8")
    return manifest_path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=None, help="Output decks directory")
    parser.add_argument("--name", default="Poker", help="Deck folder name")
    parser.add_argument("--manifest", action="store_true", help="Write decks/index.json manifest")
    args = parser.parse_args(argv)

    repo_root = Path(__file__).resolve().parent.parent
    out_dir = Path(args.out) if args.out else repo_root / "decks"
    deck_dir = write_deck(out_dir, args.name)
    count = len(list(deck_dir.iterdir()))
    print(f"{deck_dir} ({count} files)")
    if args.manifest:
        write_manifest(out_dir)


if __name__ == "__main__":
    main()
