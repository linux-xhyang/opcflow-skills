#!/usr/bin/env python3
from pathlib import Path
import unittest


class EmacsFilesUiContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = Path(__file__).with_name("main.js").read_text(encoding="utf-8")

    def test_regular_file_click_uses_emacsclient(self):
        self.assertIn(
            "entry.dir ? this.toggle(path, cx) : this.openInEmacs(path, cx)",
            self.source,
        )
        self.assertIn(
            'exec("emacsclient", ["--no-wait", "--", fullPath], '
            "{ cwd: root, on, timeout: 10000 })",
            self.source,
        )

    def test_exec_uses_argv_and_captures_click_context(self):
        opener = self.source[
            self.source.index("  openInEmacs(path, cx)") : self.source.index(
                "  rows(prefix", self.source.index("  openInEmacs(path, cx)")
            )
        ]
        self.assertIn("const root = this.root, on = this.on", opener)
        self.assertNotIn('exec("sh"', opener)
        self.assertIn('notify({', opener)

    def test_assets_reference_owned_mod(self):
        self.assertIn("mods/emacs-files/chevron-", self.source)
        self.assertIn("mods/emacs-files/${entry.dir", self.source)
        self.assertNotIn("mods/files/", self.source)


if __name__ == "__main__":
    unittest.main()
