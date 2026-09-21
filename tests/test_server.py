import json
import struct
import sys
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
import zlib
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

import server as srv  # noqa: E402


def write_png(path: Path, width: int = 1, height: int = 1):
    """Write a minimal valid 1x1 RGB PNG using only stdlib."""
    raw = bytes([0, 200, 100, 50])  # filter byte + one RGB pixel

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    path.write_bytes(png)


def make_sample_decks_dir() -> Path:
    """Create a temp decks dir with a "Sample" deck: 3 unique cards, 6 total."""
    tmp_dir = Path(tempfile.mkdtemp())
    sample_dir = tmp_dir / "Sample"
    sample_dir.mkdir(parents=True)
    write_png(sample_dir / "card01 x3.png")
    write_png(sample_dir / "card02 x2.png")
    write_png(sample_dir / "card03.png")
    write_png(sample_dir / "cardback.png")
    return tmp_dir


class ScanDecksTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.decks_dir = make_sample_decks_dir()

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(cls.decks_dir, ignore_errors=True)

    def test_sample_deck_counts(self):
        decks = srv.scan_decks(self.decks_dir)
        sample = next((d for d in decks if d["name"] == "Sample"), None)
        self.assertIsNotNone(sample)
        self.assertEqual(sample["uniqueCount"], 3)
        self.assertEqual(sample["cardCount"], 6)

    def test_suffix_parsing(self):
        self.assertEqual(srv.parse_stem("foo x3"), ("foo", 3))
        self.assertEqual(srv.parse_stem("foo_x3"), ("foo", 3))
        self.assertEqual(srv.parse_stem("foo_X3"), ("foo", 3))
        self.assertEqual(srv.parse_stem("foo"), ("foo", 1))

    def test_cardback_excluded_from_scan(self):
        deck = srv.load_deck(self.decks_dir, "Sample")
        names = [c["name"] for c in deck["cards"]]
        self.assertNotIn("cardback", names)
        self.assertIsNotNone(deck["cardBack"])

    def test_scan_decks_ignores_dot_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            (tmp_path / ".tmp-x").mkdir()
            (tmp_path / ".old-x").mkdir()
            (tmp_path / "Real").mkdir()
            decks = srv.scan_decks(tmp_path)
            names = [d["name"] for d in decks]
            self.assertEqual(names, ["Real"])

    def test_load_deck_ignores_dot_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            (tmp_path / ".tmp-x").mkdir()
            self.assertIsNone(srv.load_deck(tmp_path, ".tmp-x"))


class LoadDeckTests(unittest.TestCase):
    def test_missing_deck_returns_none(self):
        result = srv.load_deck(BASE_DIR / "decks", "NoSuchDeck")
        self.assertIsNone(result)


class ServerHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.decks_dir = make_sample_decks_dir()
        cls.server = srv.make_server(port=0, decks_dir=cls.decks_dir, static_dir=BASE_DIR / "static")
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        import shutil
        shutil.rmtree(cls.decks_dir, ignore_errors=True)

    def get(self, path):
        req = urllib.request.Request(self.base_url + path)
        return urllib.request.urlopen(req)

    def get_status(self, path):
        try:
            resp = self.get(path)
            return resp.status, resp
        except urllib.error.HTTPError as e:
            return e.code, e

    def test_path_traversal_dotdot_rejected(self):
        status, _ = self.get_status("/cards/Sample/../../server.py")
        self.assertEqual(status, 404)

    def test_path_traversal_encoded_slash_rejected(self):
        status, _ = self.get_status("/cards/..%2F..%2Fserver.py")
        self.assertEqual(status, 404)

    def test_api_decks_shape(self):
        resp = self.get("/api/decks")
        data = json.loads(resp.read())
        self.assertIn("decks", data)
        sample = next(d for d in data["decks"] if d["name"] == "Sample")
        self.assertEqual(sample["cardCount"], 6)
        self.assertEqual(sample["uniqueCount"], 3)

    def test_api_decks_name_shape(self):
        resp = self.get("/api/decks/Sample")
        data = json.loads(resp.read())
        self.assertEqual(data["name"], "Sample")
        self.assertIn("cardBack", data)
        self.assertIn("cards", data)
        card = data["cards"][0]
        self.assertIn("id", card)
        self.assertIn("name", card)
        self.assertIn("count", card)
        self.assertIn("image", card)
        self.assertTrue(card["id"].startswith("Sample/"))

    def test_api_decks_unknown_404(self):
        status, resp = self.get_status("/api/decks/NoSuchDeck")
        self.assertEqual(status, 404)
        data = json.loads(resp.read())
        self.assertIn("error", data)

    def test_api_config(self):
        resp = self.get("/api/config")
        data = json.loads(resp.read())
        self.assertIn("counters", data)
        self.assertEqual(data["startingHand"], 7)
        self.assertEqual(resp.headers.get("Cache-Control"), "no-store")

    def test_image_served_with_content_type(self):
        deck = json.loads(self.get("/api/decks/Sample").read())
        image_path = deck["cards"][0]["image"]
        resp = self.get(image_path)
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Content-Type"), "image/png")

    def test_svg_card_served_with_content_type(self):
        (self.decks_dir / "Sample" / "foo.svg").write_text(
            '<svg xmlns="http://www.w3.org/2000/svg"></svg>', encoding="utf-8"
        )
        deck = json.loads(self.get("/api/decks/Sample").read())
        card = next(c for c in deck["cards"] if c["name"] == "foo")
        resp = self.get(card["image"])
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers.get("Content-Type"), "image/svg+xml")

    def test_api_decks_name_traversal_rejected(self):
        status, _ = self.get_status("/api/decks/..%2F..%2Ftests")
        self.assertEqual(status, 404)

    def put(self, path, body):
        req = urllib.request.Request(self.base_url + path, data=body, method="PUT")
        try:
            resp = urllib.request.urlopen(req)
            return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_put_card_creates_deck(self):
        status, data = self.put("/api/decks/Uploaded/hero%20x2.png", b"PNGDATA")
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertEqual((self.decks_dir / "Uploaded" / "hero x2.png").read_bytes(), b"PNGDATA")
        decks = {d["name"]: d for d in json.loads(self.get("/api/decks").read())["decks"]}
        self.assertEqual(decks["Uploaded"]["cardCount"], 2)

    def test_put_rejects_non_image_and_traversal(self):
        status, _ = self.put("/api/decks/Uploaded/evil.py", b"x")
        self.assertEqual(status, 400)
        status, _ = self.put("/api/decks/..%2F..%2Fx/a.png", b"x")
        self.assertIn(status, (400, 404))
        status, _ = self.put("/api/decks/.hidden/a.png", b"x")
        self.assertEqual(status, 400)

    def test_config_json_alias(self):
        resp = self.get("/config.json")
        self.assertEqual(resp.status, 200)
        self.assertIn("counters", json.loads(resp.read()))

    def test_config_malformed_returns_500_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad_config = Path(tmp) / "config.json"
            bad_config.write_text("{not valid json", encoding="utf-8")
            original = srv.CONFIG_PATH
            srv.CONFIG_PATH = bad_config
            try:
                status, resp = self.get_status("/api/config")
                self.assertEqual(status, 500)
                data = json.loads(resp.read())
                self.assertIn("error", data)
            finally:
                srv.CONFIG_PATH = original


class DotDirApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmpdir = tempfile.TemporaryDirectory()
        decks_dir = Path(cls.tmpdir.name)
        (decks_dir / ".tmp-abc").mkdir()
        (decks_dir / ".old-abc").mkdir()
        (decks_dir / "Real").mkdir()
        cls.server = srv.make_server(port=0, decks_dir=decks_dir, static_dir=BASE_DIR / "static")
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls.tmpdir.cleanup()

    def test_api_decks_omits_dot_dirs(self):
        req = urllib.request.Request(self.base_url + "/api/decks")
        data = json.loads(urllib.request.urlopen(req).read())
        names = [d["name"] for d in data["decks"]]
        self.assertEqual(names, ["Real"])


if __name__ == "__main__":
    unittest.main()
