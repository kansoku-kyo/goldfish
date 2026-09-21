import json
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))
sys.path.insert(0, str(BASE_DIR / "tools"))

import server as srv  # noqa: E402
import make_poker_deck as poker  # noqa: E402


class PokerDeckTests(unittest.TestCase):
    def test_write_deck_produces_valid_svgs(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            deck_dir = poker.write_deck(tmp_path, "Poker")
            files = list(deck_dir.iterdir())
            self.assertEqual(len(files), 55)
            for f in files:
                root = ET.fromstring(f.read_text(encoding="utf-8"))
                self.assertTrue(root.tag.endswith("svg"))

            decks = srv.scan_decks(tmp_path)
            poker_deck = next(d for d in decks if d["name"] == "Poker")
            self.assertEqual(poker_deck["cardCount"], 54)
            self.assertEqual(poker_deck["uniqueCount"], 54)

            detail = srv.load_deck(tmp_path, "Poker")
            self.assertIsNotNone(detail["cardBack"])

    def test_write_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            poker.write_deck(tmp_path, "Poker")
            manifest_path = poker.write_manifest(tmp_path)
            self.assertTrue(manifest_path.is_file())
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            deck = next(d for d in manifest["decks"] if d["name"] == "Poker")
            self.assertIn("cardback.svg", deck["files"])
            self.assertEqual(len(deck["files"]), 55)
            self.assertEqual(deck["files"], sorted(deck["files"]))

    def test_ensure_bundled_decks_creates_poker(self):
        with tempfile.TemporaryDirectory() as tmp:
            decks_dir = Path(tmp) / "decks"
            srv.ensure_bundled_decks(decks_dir)
            poker_dir = decks_dir / "Poker"
            self.assertTrue(poker_dir.is_dir())
            self.assertEqual(len(list(poker_dir.iterdir())), 55)

    def test_ensure_bundled_decks_noop_if_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            decks_dir = Path(tmp) / "decks"
            poker_dir = decks_dir / "Poker"
            poker_dir.mkdir(parents=True)
            srv.ensure_bundled_decks(decks_dir)
            self.assertEqual(list(poker_dir.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
