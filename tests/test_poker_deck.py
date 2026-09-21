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


if __name__ == "__main__":
    unittest.main()
