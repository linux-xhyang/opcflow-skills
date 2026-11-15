#!/usr/bin/env python3
from pathlib import Path
import unittest


class SessionsUiContractTest(unittest.TestCase):
    def test_delete_requires_inline_confirmation_and_uses_guarded_helper(self):
        source = Path(__file__).with_name("main.js").read_text(encoding="utf-8")
        self.assertIn("requestDelete(s, cx)", source)
        self.assertIn("this.pendingDelete?.path === s.path", source)
        self.assertIn('"确认删除"', source)
        self.assertIn('python3 "$1" --delete "$2" "$3"', source)
        self.assertIn('this.currentKey !== `${s.cli}:${s.id}`', source)

    def test_resume_uses_argv_vector_for_each_cli(self):
        source = Path(__file__).with_name("main.js").read_text(encoding="utf-8")
        expected = [
            'resume: (id) => ["traecli", "resume", id]',
            'resume: (id) => ["claude", "--resume", id]',
            'resume: (id) => ["codex", "resume", id]',
            'resume: (id) => ["grok", "resume", id]',
        ]
        for command in expected:
            with self.subTest(command=command):
                self.assertIn(command, source)
        self.assertIn("argv: cmd(s.id)", source)

    def test_nested_row_buttons_stop_click_propagation(self):
        source = Path(__file__).with_name("main.js").read_text(encoding="utf-8")
        btn = source[source.index("  btn(label, t, fn)") : source.index("  header(t, context)")]
        self.assertIn("cx.stop_propagation();", btn)
        self.assertIn("fn(cx);", btn)

    def test_popup_list_has_explicit_height(self):
        source = Path(__file__).with_name("main.js").read_text(encoding="utf-8")
        self.assertIn("const listHeight = Math.min(460, Math.max(96, rows.length * 46 + 12));", source)
        self.assertIn(".h(listHeight)", source)
        self.assertIn('this.scope = "space"', source)
        self.assertIn("const context = activeSpaceContext();", source)
        self.assertIn('scope === "all" || inSpace(s, context)', source)

        render_root = source[source.index("return v_flex()", source.index("render(cx)")) :]
        self.assertIn(".w_full()", render_root)
        self.assertNotIn(".size_full()", render_root)


if __name__ == "__main__":
    unittest.main()
