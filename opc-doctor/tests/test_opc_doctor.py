"""Tests for opc_doctor.py — offline contract and unit tests."""

import importlib.util
import json
import pathlib
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "opc_doctor", ROOT / "scripts" / "opc_doctor.py"
)
DOCTOR = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = DOCTOR
SPEC.loader.exec_module(DOCTOR)


class DoctorReportTests(unittest.TestCase):
    def test_report_returns_all_skills(self):
        data = DOCTOR.report()
        self.assertIn("opcflow_version", data)
        self.assertIn("skills", data)
        self.assertIn("summary", data)
        self.assertIn("recommendations", data)
        for key in ("unified-search", "content-archive", "anysearch"):
            self.assertIn(key, data["skills"])

    def test_summary_counts_match_backend_statuses(self):
        data = DOCTOR.report()
        counts = {"ok": 0, "warn": 0, "error": 0}
        for skill_data in data["skills"].values():
            for result in skill_data["backends"].values():
                counts[result["status"]] += 1
        self.assertEqual(counts["ok"], data["summary"]["ok"])
        self.assertEqual(counts["warn"], data["summary"]["warn"])
        self.assertEqual(counts["error"], data["summary"]["error"])

    def test_report_is_valid_json(self):
        data = DOCTOR.report()
        encoded = json.dumps(data, ensure_ascii=False, indent=2)
        json.loads(encoded)  # roundtrip

    def test_skill_scope_filter(self):
        data = DOCTOR.report()
        full_total = sum(data["summary"].values())
        self.assertGreater(full_total, 0)


class CheckTests(unittest.TestCase):
    def test_which_check_found(self):
        with mock.patch("shutil.which", return_value="/usr/bin/curl"):
            check = DOCTOR.WhichCheck("curl", "curl")
            result = check.run()
            self.assertEqual(result["status"], "ok")

    def test_which_check_not_found(self):
        with mock.patch("shutil.which", return_value=None):
            check = DOCTOR.WhichCheck("nonexistent-tool-xyz", "nonexistent")
            result = check.run()
            self.assertEqual(result["status"], "error")

    def test_script_check_exists(self):
        check = DOCTOR.ScriptCheck("scripts/route_search.py", "router", "unified-search")
        result = check.run()
        self.assertEqual(result["status"], "ok")

    def test_script_check_missing(self):
        check = DOCTOR.ScriptCheck("scripts/nonexistent.py", "missing", "unified-search")
        result = check.run()
        self.assertEqual(result["status"], "error")

    def test_config_check_complete(self):
        check = DOCTOR.ConfigCheck("runtime.conf", "runtime", ("Command=",), "anysearch")
        result = check.run()
        self.assertEqual(result["status"], "ok")

    def test_config_check_missing_field(self):
        check = DOCTOR.ConfigCheck("runtime.conf", "runtime", ("NonExistentField=",), "anysearch")
        result = check.run()
        self.assertEqual(result["status"], "warn")

    def test_env_check_set(self):
        with mock.patch.dict("os.environ", {"OPCFLOW_ROOT": "/test"}):
            check = DOCTOR.EnvCheck("OPCFLOW_ROOT", "opcflow root")
            result = check.run()
            self.assertEqual(result["status"], "ok")

    def test_env_check_unset(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            if "OPCFLOW_ROOT" in __import__("os").environ:
                del __import__("os").environ["OPCFLOW_ROOT"]
        check = DOCTOR.EnvCheck("OPCFLOW_ROOT", "opcflow root")
        result = check.run()
        self.assertEqual(result["status"], "warn")


class ContractTests(unittest.TestCase):
    def test_all_checks_have_unique_keys(self):
        keys = [c.key for c in DOCTOR.CHECKS]
        self.assertEqual(len(keys), len(set(keys)))

    def test_all_checks_have_labels(self):
        for check in DOCTOR.CHECKS:
            self.assertTrue(check.label, f"{check.key} missing label")

    def test_skill_checks_reference_valid_skills(self):
        for check in DOCTOR.CHECKS:
            if check.skill:
                self.assertIn(check.skill, DOCTOR.SKILLS)

    def test_no_network_imports(self):
        source = (ROOT / "scripts" / "opc_doctor.py").read_text(encoding="utf-8")
        for forbidden in ("requests", "urllib.request", "http.client", "socket"):
            self.assertNotIn(f"import {forbidden}", source)

    def test_cli_help(self):
        proc = __import__("subprocess").run(
            [sys.executable, str(ROOT / "scripts" / "opc_doctor.py"), "--help"],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 0)
        self.assertIn("opcflow", proc.stdout)


if __name__ == "__main__":
    unittest.main()
