"""Static contract tests for opc-anysearch skill."""

import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class StaticContractTests(unittest.TestCase):
    def test_frontmatter_has_name_and_description(self):
        skill = ROOT / "SKILL.md"
        text = skill.read_text(encoding="utf-8")
        match = re.match(r"^---\n(.*?)\n---\n", text, flags=re.DOTALL)
        self.assertIsNotNone(match)
        self.assertIn("name: opc-anysearch", match.group(1))

    def test_runtime_conf_exists(self):
        conf = ROOT / "runtime.conf"
        self.assertTrue(conf.is_file())
        content = conf.read_text(encoding="utf-8")
        self.assertIn("Command=", content)

    def test_cli_script_has_all_subcommands(self):
        script = ROOT / "scripts" / "anysearch_cli.py"
        source = script.read_text(encoding="utf-8")
        for subcommand in ("search", "extract", "batch_search", "get_sub_domains"):
            with self.subTest(subcommand=subcommand):
                self.assertIn(f'add_parser("{subcommand}"', source)

    def test_skill_md_mentions_runtime_conf(self):
        skill = ROOT / "SKILL.md"
        text = skill.read_text(encoding="utf-8")
        self.assertIn("runtime.conf", text)

    def test_vertical_domains_covered_in_skill_md(self):
        skill = ROOT / "SKILL.md"
        text = skill.read_text(encoding="utf-8")
        for domain in ("academic", "finance", "legal", "security", "social_media"):
            with self.subTest(domain=domain):
                self.assertIn(domain, text.lower())

    def test_cli_does_not_require_external_dependencies(self):
        script = ROOT / "scripts" / "anysearch_cli.py"
        source = script.read_text(encoding="utf-8")
        forbidden = ("requests", "selenium", "playwright", "beautifulsoup", "scrapy")
        for lib in forbidden:
            with self.subTest(lib=lib):
                self.assertNotIn(f"import {lib}", source)

    def test_error_envelope_is_safe(self):
        script = ROOT / "scripts" / "anysearch_cli.py"
        source = script.read_text(encoding="utf-8")
        self.assertIn("make_error_envelope", source)
        self.assertNotIn("password", source.lower())
        self.assertNotIn("cookie", source.lower())


if __name__ == "__main__":
    unittest.main()
