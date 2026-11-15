#!/usr/bin/env python3
from contextlib import redirect_stdout
import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import scan


def jsonl(*items):
    return ("\n".join(json.dumps(item) for item in items) + "\n").encode()


class TraexScanTest(unittest.TestCase):
    def test_delete_cli_reports_recoverable_destination(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = os.path.join(temp_dir, "sessions")
            os.makedirs(root)
            session = os.path.join(root, "session.jsonl")
            with open(session, "w", encoding="utf-8") as f:
                f.write("{}\n")
            output = io.StringIO()

            with patch.object(scan, "ROOTS", [("traex", root, 1)]), redirect_stdout(output):
                code = scan.main(["--delete", "traex", session])

            result = json.loads(output.getvalue())
            self.assertEqual(code, 0)
            self.assertFalse(os.path.exists(session))
            self.assertTrue(os.path.isfile(result["deleted_to"]))

    def test_delete_session_removes_only_jsonl_inside_matching_cli_root(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = os.path.join(temp_dir, "sessions")
            os.makedirs(root)
            session = os.path.join(root, "session.jsonl")
            with open(session, "w", encoding="utf-8") as f:
                f.write("{}\n")

            deleted = scan.delete_session("traex", session, [("traex", root, 1)])

            self.assertFalse(os.path.exists(session))
            self.assertTrue(os.path.isfile(deleted))
            self.assertEqual(os.path.dirname(deleted), os.path.realpath(os.path.join(root, ".deleted")))
            self.assertTrue(os.path.basename(deleted).startswith("session.jsonl.deleted-"))

    def test_delete_session_rejects_paths_outside_matching_cli_root(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = os.path.join(temp_dir, "sessions")
            os.makedirs(root)
            outside = os.path.join(temp_dir, "outside.jsonl")
            with open(outside, "w", encoding="utf-8") as f:
                f.write("{}\n")

            with self.assertRaises(ValueError):
                scan.delete_session("traex", outside, [("traex", root, 1)])
            with self.assertRaises(ValueError):
                scan.delete_session("codex", outside, [("traex", root, 1)])

            self.assertTrue(os.path.exists(outside))

    def test_delete_session_rejects_non_jsonl_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = os.path.join(temp_dir, "sessions")
            os.makedirs(root)
            other = os.path.join(root, "notes.txt")
            with open(other, "w", encoding="utf-8") as f:
                f.write("keep me\n")

            with self.assertRaises(ValueError):
                scan.delete_session("traex", other, [("traex", root, 1)])

            self.assertTrue(os.path.exists(other))

    def test_extracts_real_id_cwd_and_first_user_input(self):
        head = jsonl(
            {
                "type": "session_meta",
                "payload": {
                    "id": "session-123",
                    "cwd": "/work/project",
                    "source": "cli",
                    "thread_source": "user",
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "injected context"}],
                },
            },
            {
                "type": "response_item",
                "metadata": {"user_input_order": 0},
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "real task"}],
                },
            },
        )
        self.assertEqual(
            scan.traex_head_metadata(head),
            ("real task", "/work/project", "session-123", False),
        )

    def test_marks_subagent_rollout(self):
        head = jsonl(
            {
                "type": "session_meta",
                "payload": {
                    "id": "child-123",
                    "cwd": "/work/project",
                    "source": {"subagent": {"other": "guardian"}},
                    "thread_source": "subagent",
                },
            }
        )
        self.assertEqual(
            scan.traex_head_metadata(head),
            (None, "/work/project", "child-123", True),
        )

    def test_history_index_keeps_first_prompt(self):
        with tempfile.TemporaryDirectory() as trae_home:
            cli_dir = os.path.join(trae_home, "cli")
            os.makedirs(cli_dir)
            history = os.path.join(cli_dir, "history.jsonl")
            with open(history, "w", encoding="utf-8") as f:
                f.write(json.dumps({"session_id": "a", "text": "first", "ts": 1}) + "\n")
                f.write(json.dumps({"session_id": "a", "text": "second", "ts": 2}) + "\n")
                f.write("not json\n")
            self.assertEqual(scan.load_traex_titles(trae_home), {"a": "first"})

    def test_extracts_resume_id_from_rollout_filename(self):
        filename = "rollout-2026-11-16T10-28-50-01a1e22f-9075-7b92-8eea-5ec2be125a9a.jsonl"
        self.assertEqual(
            scan.traex_id_from_filename(filename),
            "01a1e22f-9075-7b92-8eea-5ec2be125a9a",
        )


if __name__ == "__main__":
    unittest.main()
