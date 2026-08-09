"""Unit tests for AnySearch CLI. Does not require network access."""

import importlib.util
import json
import pathlib
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "anysearch_cli", ROOT / "scripts" / "anysearch_cli.py"
)
CLI = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = CLI
SPEC.loader.exec_module(CLI)


class SearchParserTests(unittest.TestCase):
    def test_parser_extracts_title_url_snippet(self):
        html = (
            "<table>"
            '<tr><td><a rel="nofollow" class="result-link" href="https://example.com">Example Title</a></td></tr>'
            '<tr><td class="result-snippet">This is a snippet about the example.</td></tr>'
            "</table>"
        )
        parser = CLI.SearchResultParser()
        parser.feed(html)
        self.assertEqual(len(parser.results), 1)
        self.assertEqual(parser.results[0]["title"], "Example Title")
        self.assertEqual(parser.results[0]["url"], "https://example.com")
        self.assertIn("snippet", parser.results[0])

    def test_parser_skips_results_without_url(self):
        html = '<tr><td><a>No Link</a></td></tr>'
        parser = CLI.SearchResultParser()
        parser.feed(html)
        self.assertEqual(len(parser.results), 0)

    def test_parser_handles_empty_html(self):
        parser = CLI.SearchResultParser()
        parser.feed("")
        self.assertEqual(len(parser.results), 0)


class CandidateTests(unittest.TestCase):
    def test_candidate_structure(self):
        cand = CLI._make_candidate(
            query="test query",
            url="https://example.com/article",
            title="Example Article",
            snippet="A test result.",
            rank=1,
            retrieved_at="2026-08-06T12:00:00Z",
        )
        self.assertEqual(cand["candidate_id"], "web:" + CLI.url_hash("https://example.com/article"))
        self.assertEqual(cand["platform"], "web")
        self.assertEqual(cand["backend"], "anysearch")
        self.assertEqual(cand["rank"], 1)
        self.assertEqual(cand["title"], "Example Article")
        self.assertEqual(cand["url"], "https://example.com/article")
        self.assertEqual(cand["canonical_url"], "https://example.com/article")
        self.assertEqual(cand["snippet"], "A test result.")
        self.assertEqual(cand["content_type"], "web_page")
        self.assertFalse(cand["access"]["login_state_used"])
        self.assertEqual(cand["verification"]["status"], "candidate")

    def test_candidate_with_none_fields(self):
        cand = CLI._make_candidate(
            query="q",
            url="https://x.com",
            title=None,
            snippet=None,
            rank=1,
            retrieved_at="2026-08-06T12:00:00Z",
        )
        self.assertEqual(cand["title"], "Untitled")
        self.assertIsNone(cand["snippet"])

    def test_candidate_title_truncation(self):
        long_title = "A" * 500
        cand = CLI._make_candidate(
            query="q", url="https://x.com", title=long_title, snippet="s",
            rank=1, retrieved_at="2026-08-06T12:00:00Z",
        )
        self.assertLess(len(cand["title"]), 400)

    def test_candidate_snippet_truncation(self):
        long_snippet = "B" * 1000
        cand = CLI._make_candidate(
            query="q", url="https://x.com", title="t", snippet=long_snippet,
            rank=1, retrieved_at="2026-08-06T12:00:00Z",
        )
        self.assertLess(len(cand["snippet"] or ""), 600)

    def test_url_clean_lowercases_netloc(self):
        cand = CLI._make_candidate(
            query="q", url="https://EXAMPLE.COM/Path", title="t", snippet="s",
            rank=1, retrieved_at="2026-08-06T12:00:00Z",
        )
        self.assertEqual(cand["canonical_url"], "https://example.com/Path")


class VerticalDomainTests(unittest.TestCase):
    def test_get_sub_domains_returns_structured_data(self):
        self.assertIn("legal", CLI.VERTICAL_DOMAINS)
        domain = CLI.VERTICAL_DOMAINS["legal"]
        self.assertIn("sub_domains", domain)
        self.assertIn("case_law", domain["sub_domains"])
        self.assertEqual(
            domain["sub_domains"]["case_law"]["required_params"],
            ["jurisdiction"],
        )

    def test_all_domains_have_sub_domains_with_required_params(self):
        for name, domain in CLI.VERTICAL_DOMAINS.items():
            self.assertIn("description", domain)
            self.assertIn("sub_domains", domain)
            for sd_name, sd in domain["sub_domains"].items():
                self.assertIn("label", sd)
                self.assertIn("required_params", sd)


class ErrorEnvelopeTests(unittest.TestCase):
    def test_error_envelope_structure(self):
        error = CLI.SearchError("network_error", "Test error")
        envelope = CLI.make_error_envelope("test", 5, error)
        self.assertEqual(envelope["schema_version"], "1.0")
        self.assertEqual(envelope["routes"][0]["status"], "failed")
        self.assertEqual(envelope["candidates"], [])
        self.assertEqual(len(envelope["errors"]), 1)
        self.assertEqual(envelope["errors"][0]["category"], "network_error")


class ParserArgTests(unittest.TestCase):
    def test_all_subcommands_defined(self):
        parser = CLI.make_parser()
        choices = list(parser._subparsers._group_actions[0].choices.keys())
        self.assertIn("search", choices)
        self.assertIn("extract", choices)
        self.assertIn("batch_search", choices)
        self.assertIn("get_sub_domains", choices)


class DDGLiteSearchMockedTests(unittest.TestCase):
    def test_search_returns_candidates_on_valid_html(self):
        html = (
            "<table>"
            '<tr><td><a rel="nofollow" class="result-link" href="https://example.com">Example</a></td></tr>'
            '<tr><td class="result-snippet">A snippet.</td></tr>'
            "</table>"
        )
        with mock.patch("urllib.request.urlopen") as mock_open:
            mock_open.return_value.__enter__.return_value.read.return_value = html.encode()
            results = CLI._ddg_lite_search("test", 5, timeout=10)
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]["title"], "Example")

    def test_search_returns_empty_on_no_results(self):
        html = "<table></table>"
        with mock.patch("urllib.request.urlopen") as mock_open:
            mock_open.return_value.__enter__.return_value.read.return_value = html.encode()
            results = CLI._ddg_lite_search("xyznonexistent12345", 5, timeout=10)
            self.assertEqual(len(results), 0)

    def test_search_clamps_to_max_results(self):
        html = "".join(
            "<table>"
            + "".join(
                f'<tr><td><a rel="nofollow" class="result-link" href="https://example.com/{i}">Title {i}</a></td></tr>'
                f'<tr><td class="result-snippet">snippet {i}</td></tr>'
                for i in range(15)
            )
            + "</table>"
        )
        with mock.patch("urllib.request.urlopen") as mock_open:
            mock_open.return_value.__enter__.return_value.read.return_value = html.encode()
            results = CLI._ddg_lite_search("test", 5, timeout=10)
            self.assertLessEqual(len(results), 5)


if __name__ == "__main__":
    unittest.main()
