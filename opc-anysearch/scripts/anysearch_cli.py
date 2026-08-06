#!/usr/bin/env python3
"""AnySearch CLI: public web search backend with pluggable providers."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any

USER_AGENT = "opc-anysearch/1.0 (+public read-only web search)"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
DEFAULT_TIMEOUT = 15

# -- predefined vertical domains --
VERTICAL_DOMAINS: dict[str, dict[str, Any]] = {
    "finance": {
        "description": "Financial news, markets, and economic data",
        "sub_domains": {
            "markets": {
                "label": "Markets",
                "description": "Stock market data and analysis",
                "required_params": ["ticker"],
            },
            "news": {
                "label": "Financial News",
                "description": "Financial and economic news",
                "required_params": [],
            },
            "regulatory": {
                "label": "Regulatory",
                "description": "SEC filings and regulatory documents",
                "required_params": ["jurisdiction"],
            },
        },
    },
    "legal": {
        "description": "Legal cases, statutes, and regulations",
        "sub_domains": {
            "case_law": {
                "label": "Case Law",
                "description": "Court opinions and case law",
                "required_params": ["jurisdiction"],
            },
            "statutes": {
                "label": "Statutes",
                "description": "Statutory law and codes",
                "required_params": ["jurisdiction"],
            },
            "patents": {
                "label": "Patents",
                "description": "Patent filings and intellectual property",
                "required_params": [],
            },
        },
    },
    "academic": {
        "description": "Academic papers, journals, and research",
        "sub_domains": {
            "papers": {
                "label": "Papers",
                "description": "Scholarly articles and conference papers",
                "required_params": [],
            },
            "citations": {
                "label": "Citations",
                "description": "Citation graphs and references",
                "required_params": [],
            },
        },
    },
    "security": {
        "description": "Security advisories, CVEs, and threat intelligence",
        "sub_domains": {
            "cve": {
                "label": "CVE",
                "description": "Common Vulnerabilities and Exposures",
                "required_params": [],
            },
            "advisories": {
                "label": "Advisories",
                "description": "Security advisories and bulletins",
                "required_params": [],
            },
        },
    },
    "social_media": {
        "description": "Public social media discussions across platforms",
        "sub_domains": {
            "discussions": {
                "label": "Discussions",
                "description": "Public social media posts and threads",
                "required_params": [],
            },
        },
    },
}


class SearchResultParser(HTMLParser):
    """Extract search results from DuckDuckGo Lite HTML."""

    def __init__(self) -> None:
        super().__init__()
        self.results: list[dict[str, str | None]] = []
        self._current: dict[str, str | None] | None = None
        self._field: str | None = None
        self._in_result = False
        self._in_link = False
        self._in_snippet = False
        self._result_count = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = dict(attrs)
        classes = (attr_map.get("class") or "").split()
        href = attr_map.get("href")

        if tag == "tr" and "result-snippet" not in classes:
            self._in_result = True
            self._current = {"title": None, "url": None, "snippet": None}
        elif tag == "a" and self._in_result and href and "result-link" in classes:
            self._in_link = True
            self._current["url"] = href  # URL from attribute
            self._field = "title"  # link text is the title
        elif tag == "a" and self._in_result and href:
            self._in_link = True
            self._field = "title"
        elif tag == "td" and "result-snippet" in classes:
            self._in_snippet = True
            self._field = "snippet"

    def handle_data(self, data: str) -> None:
        if self._current is not None and self._field and self._in_result:
            text = data.strip()
            if text:
                cur = self._current[self._field]
                self._current[self._field] = (cur + " " + text).strip() if cur else text

    def handle_endtag(self, tag: str) -> None:
        if tag == "a":
            self._in_link = False
            if self._field == "title":
                self._field = None
        elif tag == "td":
            self._in_snippet = False
            self._field = None
        elif tag == "tr" and self._in_result:
            self._in_result = False
            if self._current and self._current.get("title") and self._current.get("url"):
                self.results.append(self._current)
                self._result_count += 1
            self._current = None
            self._field = None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def url_hash(url: str) -> str:
    return format(abs(hash(url)), "x")


def _clean_url(raw: str) -> str | None:
    parsed = urllib.parse.urlparse(raw.strip())
    if parsed.scheme not in ("http", "https"):
        return None
    return urllib.parse.urlunparse(
        (parsed.scheme, parsed.netloc.lower(), parsed.path or "/", parsed.params, parsed.query, None)
    )


def _clean_title(raw: str | None) -> str | None:
    if not raw:
        return None
    cleaned = " ".join(raw.split())
    return cleaned if len(cleaned) <= 300 else f"{cleaned[:297]}..."


def _clean_snippet(raw: str | None) -> str | None:
    if not raw:
        return None
    cleaned = " ".join(raw.split())
    return cleaned if len(cleaned) <= 500 else f"{cleaned[:497]}..."


def _make_candidate(
    query: str,
    url: str,
    title: str | None,
    snippet: str | None,
    *,
    rank: int,
    retrieved_at: str,
    backend: str = "anysearch",
    source_id: str | None = None,
) -> dict[str, Any]:
    canonical = _clean_url(url)
    return {
        "candidate_id": source_id or f"web:{url_hash(canonical or url)}",
        "query": query,
        "platform": "web",
        "backend": backend,
        "rank": rank,
        "title": _clean_title(title) or "Untitled",
        "url": canonical or url,
        "canonical_url": canonical or url,
        "snippet": _clean_snippet(snippet),
        "author": None,
        "published_at": None,
        "content_type": "web_page",
        "language": None,
        "metrics": {
            "likes": None, "comments": None, "collects": None, "shares": None, "views": None,
        },
        "access": {"visibility": "public", "login_state_used": False},
        "verification": {"status": "candidate", "opened_original": False, "checked_at": None},
        "provenance": {
            "source_id": source_id or url_hash(canonical or url),
            "retrieved_at": retrieved_at,
            "route_reason": "public_web_search",
        },
        "limitations": ["AnySearch uses a third-party public web index; results are not exhaustive."],
    }


# -- search --

def _ddg_lite_search(query: str, max_results: int, *, timeout: int) -> list[dict[str, str | None]]:
    url = "https://lite.duckduckgo.com/lite/?" + urllib.parse.urlencode({"q": query})
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(MAX_RESPONSE_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, urllib.error.HTTPError) as exc:
        raise SearchError("network_error", f"Search request failed: {exc}") from exc

    if len(body) > MAX_RESPONSE_BYTES:
        raise SearchError("response_too_large", "Response exceeded safety limit.")

    parser = SearchResultParser()
    parser.feed(body.decode("utf-8", errors="replace"))
    return parser.results[:max_results]


def cmd_search(args: argparse.Namespace) -> int:
    query = args.query.strip()
    if not query:
        print(json.dumps({"error": "query is required"}, ensure_ascii=False))
        return 1
    max_results = min(args.max_results, 10)
    retrieved_at = utc_now_iso()

    try:
        raw = _ddg_lite_search(query, max_results, timeout=args.timeout)
    except SearchError as exc:
        envelope = make_error_envelope(query, max_results, exc)
        print(json.dumps(envelope, ensure_ascii=False, indent=2))
        return 1

    candidates = []
    for idx, item in enumerate(raw, start=1):
        cand = _make_candidate(
            query, item["url"] or "", item["title"], item["snippet"],
            rank=idx, retrieved_at=retrieved_at,
        )
        candidates.append(cand)

    envelope = {
        "schema_version": "1.0",
        "request": {"queries": [query], "platforms": ["web"], "time_range": None, "requested_limit": max_results},
        "routes": [{"platform": "web", "backend": "anysearch", "mode": "search", "login_state_used": False, "status": "completed", "limitations": ["DuckDuckGo public web index."]}],
        "candidates": candidates,
        "coverage": [{"platform": "web", "backend": "anysearch", "query_count": 1, "raw_result_count": len(raw), "returned_count": len(candidates), "truncated": len(raw) >= max_results, "login_state_used": False, "limitations": ["DuckDuckGo public web index."]}],
        "errors": [],
    }
    print(json.dumps(envelope, ensure_ascii=False, indent=2))
    return 0


# -- extract --

def cmd_extract(args: argparse.Namespace) -> int:
    url = args.url.strip()
    if not url or not url.startswith("http"):
        print(json.dumps({"error": "valid URL is required"}, ensure_ascii=False))
        return 1

    retrieved_at = utc_now_iso()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as resp:
            body = resp.read(MAX_RESPONSE_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, urllib.error.HTTPError) as exc:
        envelope = {
            "schema_version": "1.0",
            "request": {"queries": [url], "platforms": ["web"], "time_range": None, "requested_limit": 1},
            "routes": [{"platform": "web", "backend": "anysearch", "mode": "extract", "login_state_used": False, "status": "failed", "limitations": []}],
            "candidates": [],
            "coverage": [],
            "errors": [{"backend": "anysearch", "category": "network_error", "message": str(exc)}],
        }
        print(json.dumps(envelope, ensure_ascii=False, indent=2))
        return 1

    if len(body) > MAX_RESPONSE_BYTES:
        body = body[:MAX_RESPONSE_BYTES]

    text = body.decode("utf-8", errors="replace")
    title_match = re.search(r"<title[^>]*>(.*?)</title>", text, re.IGNORECASE | re.DOTALL)
    title = title_match.group(1).strip() if title_match else "Untitled"
    title = " ".join(title.split())[:300]

    cand = _make_candidate(
        "extract", url, title, None,
        rank=1, retrieved_at=retrieved_at, backend="anysearch-extract",
        source_id=f"extract:{url_hash(url)}",
    )
    cand["verification"] = {"status": "verified", "opened_original": True, "checked_at": retrieved_at}

    envelope = {
        "schema_version": "1.0",
        "request": {"queries": [url], "platforms": ["web"], "time_range": None, "requested_limit": 1},
        "routes": [{"platform": "web", "backend": "anysearch", "mode": "extract", "login_state_used": False, "status": "completed", "limitations": ["Basic HTML title extraction only; not full content."]}],
        "candidates": [cand],
        "coverage": [{"platform": "web", "backend": "anysearch", "query_count": 1, "returned_count": 1, "login_state_used": False, "limitations": ["Title-only extraction."]}],
        "errors": [],
    }
    print(json.dumps(envelope, ensure_ascii=False, indent=2))
    return 0


# -- batch_search --

def cmd_batch_search(args: argparse.Namespace) -> int:
    try:
        payload = json.loads(args.queries)
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"Invalid JSON for --queries: {exc}"}, ensure_ascii=False))
        return 1
    if not isinstance(payload, list) or not payload:
        print(json.dumps({"error": "--queries must be a non-empty JSON array"}, ensure_ascii=False))
        return 1

    all_envelopes = []
    exit_code = 0

    for item in payload:
        if not isinstance(item, dict) or "query" not in item:
            all_envelopes.append({"schema_version": "1.0", "error": "Each item must have a 'query' field", "candidates": []})
            exit_code = 1
            continue
        query = str(item["query"]).strip()
        max_results = min(int(item.get("max_results", 10)), 10)
        retrieved_at = utc_now_iso()

        try:
            raw = _ddg_lite_search(query, max_results, timeout=args.timeout)
        except SearchError as exc:
            all_envelopes.append(make_error_envelope(query, max_results, exc))
            exit_code = 1
            continue

        candidates = []
        for idx, r in enumerate(raw, start=1):
            candidates.append(_make_candidate(
                query, r["url"] or "", r["title"], r["snippet"],
                rank=idx, retrieved_at=retrieved_at,
            ))

        all_envelopes.append({
            "schema_version": "1.0",
            "request": {"queries": [query], "platforms": ["web"], "time_range": None, "requested_limit": max_results},
            "routes": [{"platform": "web", "backend": "anysearch", "mode": "batch_search", "login_state_used": False, "status": "completed", "limitations": ["Batch via DuckDuckGo public index."]}],
            "candidates": candidates,
            "coverage": [{"platform": "web", "backend": "anysearch", "query_count": 1, "returned_count": len(candidates), "login_state_used": False, "limitations": []}],
            "errors": [],
        })

    print(json.dumps({"batch_results": all_envelopes, "total_queries": len(payload)}, ensure_ascii=False, indent=2))
    return exit_code


# -- get_sub_domains --

def cmd_get_sub_domains(args: argparse.Namespace) -> int:
    domain = args.domain.strip()
    if domain not in VERTICAL_DOMAINS:
        available = ", ".join(sorted(VERTICAL_DOMAINS.keys()))
        print(json.dumps({
            "error": f"Unknown domain '{domain}'. Available: {available}",
            "available_domains": sorted(VERTICAL_DOMAINS.keys()),
        }, ensure_ascii=False, indent=2))
        return 1

    info = VERTICAL_DOMAINS[domain]
    print(json.dumps({
        "domain": domain,
        "description": info["description"],
        "sub_domains": [
            {
                "name": name,
                "label": sd["label"],
                "description": sd["description"],
                "required_params": sd["required_params"],
            }
            for name, sd in info["sub_domains"].items()
        ],
    }, ensure_ascii=False, indent=2))
    return 0


# -- helpers --

class SearchError(RuntimeError):
    def __init__(self, category: str, message: str) -> None:
        super().__init__(message)
        self.category = category
        self.message = message


def make_error_envelope(query: str, max_results: int, error: SearchError) -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "request": {"queries": [query], "platforms": ["web"], "time_range": None, "requested_limit": max_results},
        "routes": [{"platform": "web", "backend": "anysearch", "mode": "search", "login_state_used": False, "status": "failed", "limitations": []}],
        "candidates": [],
        "coverage": [],
        "errors": [{"backend": "anysearch", "category": error.category, "message": error.message}],
    }


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="AnySearch: public web search backend",
        prog="anysearch",
    )
    sub = parser.add_subparsers(dest="subcommand", required=True)

    p = sub.add_parser("search", help="Search the public web")
    p.add_argument("query", help="Search query")
    p.add_argument("--max_results", type=int, default=10)
    p.add_argument("--domain")
    p.add_argument("--sub_domain")
    p.add_argument("--sub_domain_params", default="{}")
    p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("extract", help="Fetch and verify a URL")
    p.add_argument("url", help="URL to extract")
    p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    p.set_defaults(func=cmd_extract)

    p = sub.add_parser("batch_search", help="Search multiple queries")
    p.add_argument("--queries", required=True, help="JSON array of query objects")
    p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    p.set_defaults(func=cmd_batch_search)

    p = sub.add_parser("get_sub_domains", help="List sub-domains for a vertical")
    p.add_argument("--domain", required=True, help="Vertical domain name")
    p.set_defaults(func=cmd_get_sub_domains)

    return parser


def main() -> int:
    parser = make_parser()
    if len(sys.argv) == 1:
        parser.print_help()
        return 1
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
