"""Goldfish local server: stdlib-only static + deck API server."""
import argparse
import json
import re
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, quote, urlsplit

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"

SUFFIX_RE = re.compile(r"[\s_][xX](\d+)$")
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".svg"}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


def safe_join(root: Path, *parts: str):
    """Join url-decoded path parts onto root, rejecting traversal. Returns
    resolved Path inside root, or None if rejected/missing/outside root."""
    root = root.resolve()
    current = root
    for raw in parts:
        part = unquote(raw)
        if part == "" or part == ".." or "\\" in part or ":" in part or "/" in part:
            return None
        current = current / part
    try:
        resolved = current.resolve()
    except OSError:
        return None
    try:
        resolved.relative_to(root)
    except ValueError:
        return None
    return resolved


def parse_stem(stem: str):
    """Return (display_name, count) from a card filename stem."""
    m = SUFFIX_RE.search(stem)
    if m:
        count = int(m.group(1))
        name = stem[: m.start()]
        return name, count
    return stem, 1


def scan_decks(decks_dir: Path):
    """Return sorted list of {"name","cardCount","uniqueCount"} dicts."""
    decks_dir = Path(decks_dir)
    result = []
    if not decks_dir.is_dir():
        return result
    for deck_path in sorted(decks_dir.iterdir(), key=lambda p: p.name):
        if not deck_path.is_dir():
            continue
        if deck_path.name.startswith("."):
            continue
        unique_count = 0
        card_count = 0
        for f in deck_path.iterdir():
            if not f.is_file():
                continue
            if f.suffix.lower() not in IMAGE_EXTS:
                continue
            if f.stem.lower() == "cardback":
                continue
            _, count = parse_stem(f.stem)
            unique_count += 1
            card_count += count
        result.append({
            "name": deck_path.name,
            "cardCount": card_count,
            "uniqueCount": unique_count,
        })
    return result


def load_deck(decks_dir: Path, name: str):
    """Return deck detail dict, or None if deck does not exist."""
    decks_dir = Path(decks_dir)
    if name.startswith("."):
        return None
    deck_path = decks_dir / name
    if not deck_path.is_dir():
        return None
    card_back = None
    cards = []
    for f in sorted(deck_path.iterdir(), key=lambda p: p.name):
        if not f.is_file():
            continue
        if f.suffix.lower() not in IMAGE_EXTS:
            continue
        if f.stem.lower() == "cardback":
            card_back = "/cards/" + quote(name) + "/" + quote(f.name)
            continue
        display_name, count = parse_stem(f.stem)
        cards.append({
            "id": f"{name}/{f.name}",
            "name": display_name,
            "count": count,
            "image": "/cards/" + quote(name) + "/" + quote(f.name),
        })
    cards.sort(key=lambda c: c["name"])
    return {"name": name, "cardBack": card_back, "cards": cards}


class Handler(BaseHTTPRequestHandler):
    server_version = "GoldfishHTTP/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send_json(self, obj, status=HTTPStatus.OK, no_store=True):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if no_store:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path, no_store=True):
        try:
            data = path.read_bytes()
        except OSError:
            self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        ctype = CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if no_store:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        split = urlsplit(self.path)
        path = split.path
        segments = [s for s in path.split("/") if s != ""]

        if path == "/":
            index_path = self.server.static_dir / "index.html"
            self._send_file(index_path)
            return

        if segments and segments[0] == "static":
            resolved = safe_join(self.server.static_dir, *segments[1:])
            if resolved is None or not resolved.is_file():
                self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
                return
            self._send_file(resolved)
            return

        if path == "/api/config" or path == "/config.json":
            try:
                cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            except OSError:
                self._send_json({"error": "config not found"}, HTTPStatus.NOT_FOUND)
                return
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                self._send_json({"error": f"invalid config: {exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)
                return
            self._send_json(cfg)
            return

        if path == "/api/decks":
            decks = scan_decks(self.server.decks_dir)
            self._send_json({"decks": decks})
            return

        if len(segments) == 3 and segments[0] == "api" and segments[1] == "decks":
            resolved = safe_join(self.server.decks_dir, segments[2])
            if resolved is None or not resolved.is_dir():
                self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
                return
            name = resolved.name
            deck = load_deck(self.server.decks_dir, name)
            if deck is None:
                self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
                return
            self._send_json(deck)
            return

        if len(segments) >= 3 and segments[0] == "cards":
            resolved = safe_join(self.server.decks_dir, *segments[1:])
            if resolved is None or not resolved.is_file():
                self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
                return
            self._send_file(resolved)
            return

        self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_PUT(self):
        segments = [s for s in urlsplit(self.path).path.split("/") if s != ""]
        if len(segments) != 4 or segments[0] != "api" or segments[1] != "decks":
            self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        deck_name, file_name = unquote(segments[2]), unquote(segments[3])
        if safe_join(self.server.decks_dir, segments[2], segments[3]) is None or deck_name.startswith("."):
            self._send_json({"error": "invalid path"}, HTTPStatus.BAD_REQUEST)
            return
        if Path(file_name).suffix.lower() not in IMAGE_EXTS:
            self._send_json({"error": "unsupported file type"}, HTTPStatus.BAD_REQUEST)
            return
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            self._send_json({"error": "invalid Content-Length"}, HTTPStatus.BAD_REQUEST)
            return
        data = self.rfile.read(length) if length > 0 else b""
        deck_dir = Path(self.server.decks_dir) / deck_name
        try:
            deck_dir.mkdir(parents=True, exist_ok=True)
            (deck_dir / file_name).write_bytes(data)
        except OSError as exc:
            self._send_json({"error": f"write failed: {exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        self._send_json({"ok": True})

    def do_POST(self):
        split = urlsplit(self.path)
        path = split.path

        self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)


def make_server(port=8000, decks_dir="decks", static_dir="static"):
    server = ThreadingHTTPServer(("localhost", port), Handler)
    server.decks_dir = Path(decks_dir)
    server.static_dir = Path(static_dir)
    return server


def main():
    parser = argparse.ArgumentParser(description="Goldfish local server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--decks", default="decks")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    server = make_server(port=args.port, decks_dir=args.decks, static_dir="static")
    url = f"http://localhost:{server.server_address[1]}"
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    print(f"Serving on {url}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
