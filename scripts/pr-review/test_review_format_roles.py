"""The approved presentation contract gates publication, not metadata."""

import unittest
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

import role_review
import synthesize_roles
import test_role_review
import test_synthesize_roles


class ReviewFormatTests(unittest.TestCase):
    def test_shell_adapter_gets_instructions_and_fixed_failure(self):
        script = Path(__file__).with_name("review_format.py")
        result = subprocess.run([sys.executable, str(script), "instructions"],
                                capture_output=True, text=True, check=True)
        self.assertIn("fenced code blocks", result.stdout)
        with tempfile.TemporaryDirectory() as root:
            text = Path(root) / "reply.md"
            for value, expected in (("Checked `validate()`.", 0),
                                    ("password='synthetic-private'", 2)):
                text.write_text(value)
                result = subprocess.run([sys.executable, str(script), "check", str(text)],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, expected)
                self.assertEqual(result.stdout, "" if expected == 0 else
                                 "unsupported_review_format\n")
                self.assertNotIn("synthetic-private", result.stdout + result.stderr)

    def test_stream_adapter_emits_nothing_before_rejecting_invalid_output(self):
        script = Path(__file__).with_name("review_format.py")
        for value, accepted in (("Checked `validate()`.\n", True),
                                ("Public prefix.\npassword='synthetic-private'\n", False)):
            result = subprocess.run([sys.executable, str(script), "filter"], input=value,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0 if accepted else 2)
            self.assertEqual(result.stdout, value if accepted else "")
            self.assertEqual(result.stderr, "" if accepted else "unsupported_review_format\n")

    def response(self, evidence):
        path = "src/password=example.py"
        plan = {"head_sha": "a" * 40, "roles": {
            "codex": {"role": "implementation", "paths": [path]}}}
        response = {
            "head_sha": plan["head_sha"], "role": "implementation",
            "scope_complete": True, "reviewed_paths": [path],
            "checks": [{"path": path, "evidence": evidence}],
            "findings": [], "uncertainties": [],
        }
        return response, plan

    def test_supported_prose_references_and_fenced_examples(self):
        for text in (
            "Checked `validate()` and `src/service.py:12` against the caller.",
            "See `AWS::IAM::Role`, `--context`, `$NAME`, and `[REDACTED]`.",
            "Example:\n```sh\npassword='synthetic'\n```\nThe caller rejects it.",
            "Example:\n~~~~js\nconst text = `template`;\n~~~~\nChecked the caller.",
            "Example:\n````md\n```sh\npassword='synthetic'\n```\n````\nChecked.",
        ):
            with self.subTest(text=text):
                response, plan = self.response(text)
                role_review.validate_response(response, plan, "codex")

    def heading_examples(self):
        return (
            "Authorization:\nThe handler checks the caller.",
            "**Authorization:**\nThe handler checks the caller.",
            "origin-verify:\nThe origin gate remains enforced.",
            "Checked `token`\n===\nThe caller verifies its scope.",
            "Token\n=\nThe caller verifies its scope.",
            "See `Authorization`:\nThe caller is checked.",
        )

    def test_heading_prose_keeps_specialist_coverage(self):
        for text in self.heading_examples():
            with self.subTest(text=text):
                response, plan = self.response(text)
                try:
                    role_review.validate_response(response, plan, "codex")
                except role_review.Invalid as error:
                    self.fail(f"Heading rejected: {error}")
                helper = test_role_review.RoleReviewTests()
                helper.setUp()
                try:
                    helper.prepare()
                    helper.finish({"codex": helper.response("codex", checks=[{
                        "path": test_role_review.FRONTEND,
                        "evidence": text + "\nPUBLIC_AFTER",
                    }])})
                    result = helper.read("slot/codex-result.json")
                    self.assertTrue(result["valid"])
                    self.assertIn("PUBLIC_AFTER", result["response"]["checks"][0]["evidence"])
                    self.assertTrue((helper.work / "deterministic-review.md").read_text()
                                    .endswith("VERDICT: PASS\n"))
                finally:
                    helper.tearDown()

    def test_heading_prose_keeps_chair_adjudication(self):
        for text in self.heading_examples():
            with self.subTest(text=text):
                reply = (0, text + "\nPUBLIC_AFTER\nVERDICT: PASS\n", "")
                calls, published = self.chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertIn("PUBLIC_AFTER", published)
                self.assertTrue(published.endswith("VERDICT: PASS\n"))

    def test_unsupported_examples_in_each_prose_field(self):
        for text in (
            "Example: `password='synthetic'`.",
            "Run `echo hello`.",
            "Run `first\nsecond`.",
            "Checked `unclosed.",
            "Example:\n```sh\npassword='synthetic'\n",
            "Example:\n```sh\npassword='synthetic'\n~~~",
            "Example:\n> ```sh\n> password='synthetic'\n> ```",
            "Example:\n    ```sh\n    password='synthetic'\n    ```",
            "Example:\npassword = 'synthetic'",
            'Example:\n"api_key": "synthetic"',
            "Example:\npassword\n= 'synthetic'",
            "Example: `` password='synthetic' ``.",
            "Set `password` = 'synthetic-private'.",
            "Set `api_key`: 'synthetic-private'.",
            "Set `password`\n= 'synthetic-private'.",
            "Authorization: Bearer synthetic-private",
            "origin-verify: synthetic-private",
            "password=",
        ):
            for field in ("check", "condition", "evidence", "uncertainty"):
                with self.subTest(text=text, field=field):
                    response, plan = self.response("Checked the changed caller.")
                    if field == "check":
                        response["checks"][0]["evidence"] = text
                    elif field == "uncertainty":
                        response["uncertainties"] = [text]
                    else:
                        finding = {"severity": "MAJOR", "path": response["reviewed_paths"][0],
                                   "condition": "The caller fails.", "evidence": "Checked the caller."}
                        finding[field] = text
                        response["findings"] = [finding]
                    with self.assertRaisesRegex(role_review.Invalid, "^unsupported_review_format$"):
                        role_review.validate_response(response, plan, "codex")

    def chair(self, replies):
        helper = test_synthesize_roles.SynthesisTests()
        helper.setUp()
        helper.module = synthesize_roles
        self.addCleanup(helper.doCleanups)
        return helper.run_chair(replies)

    def test_chair_does_not_publish_unsupported_examples(self):
        reply = (0, "Example: `password='synthetic-private'`.\nVERDICT: PASS\n", "")
        calls, text = self.chair([reply, reply])
        self.assertEqual(calls, 2)
        self.assertTrue(text.endswith("VERDICT: FAIL\n"))
        self.assertIn("format", text.lower())
        self.assertNotIn("synthetic-private", text)

    def test_chair_checks_sanitized_format_too(self):
        reply = (0, "Checked `validate()`.\nVERDICT: PASS\n", "")
        with patch.object(synthesize_roles, "scrub_decoded",
                          return_value="Checked `unclosed.\nVERDICT: PASS\n"):
            _, text = self.chair([reply, reply])
        self.assertTrue(text.endswith("VERDICT: FAIL\n"))

    def test_format_failure_does_not_hide_account_limit(self):
        calls, text = self.chair([
            (0, "Run `bad\nexample`.\nVERDICT: PASS\n", "quota exceeded"),
            (0, "Must not run.\nVERDICT: PASS\n", ""),
        ])
        self.assertEqual(calls, 1)
        self.assertTrue(text.endswith("VERDICT: FAIL\n"))
        self.assertNotIn("bad", text)

    def test_invalid_specialist_output_blocks_coverage_without_public_payload(self):
        helper = test_role_review.RoleReviewTests()
        helper.setUp()
        self.addCleanup(helper.tearDown)
        helper.prepare()
        response = helper.response("codex", checks=[{
            "path": test_role_review.FRONTEND,
            "evidence": "Run `password='synthetic-private'`.",
        }])
        result = helper.record("codex", response, expected=2)
        self.assertFalse(result["valid"])
        self.assertEqual(result["failure_codes"], ["unsupported_review_format"])
        self.assertIsNone(result["response"])
        helper.record("claude-self")
        helper.cli("aggregate", "--work", helper.work, expected=2)
        published = (helper.work / "deterministic-review.md").read_text()
        self.assertTrue(published.endswith("VERDICT: FAIL\n"))
        self.assertNotIn("synthetic-private", published)
        self.assertIn("unsupported_review_format", published)

    def test_deterministic_findings_keep_embedded_fences_and_verdicts_literal(self):
        helper = test_role_review.RoleReviewTests()
        helper.setUp()
        self.addCleanup(helper.tearDown)
        helper.prepare()
        response = helper.response("codex", findings=[{
            "severity": "MINOR", "path": test_role_review.FRONTEND,
            "condition": "The rendering fixture contains a verdict marker.",
            "evidence": "Fixture:\n````text\n```\nVERDICT: FAIL\n```\n````",
        }])
        helper.finish({"codex": response})
        published = (helper.work / "deterministic-review.md").read_text()
        self.assertIn("```json\n", published)
        self.assertEqual([line for line in published.splitlines() if line.startswith("VERDICT:")],
                         ["VERDICT: PASS"])
        self.assertIn("\\nVERDICT: FAIL\\n", published)

    def fenced_json_cases(self):
        canary = "NFM_FENCED_JSON_CANARY"
        for value in (
            {"name": "password:admin", "value": canary, "public": "PUBLIC_KEEP"},
            {"headerName": "token=abc", "headerValue": canary, "public": "PUBLIC_KEEP"},
            {"password:admin": canary, "public": "PUBLIC_KEEP"},
        ):
            yield "Example:\n```json\n" + json.dumps(value) + "\n```\nPUBLIC_AFTER"

    def test_fenced_json_keeps_named_value_privacy_through_publication(self):
        for evidence in self.fenced_json_cases():
            with self.subTest(evidence=evidence):
                helper = test_role_review.RoleReviewTests()
                helper.setUp()
                try:
                    helper.prepare()
                    response = helper.response("codex", findings=[{
                        "severity": "MINOR", "path": test_role_review.FRONTEND,
                        "condition": "Synthetic JSON configuration example.",
                        "evidence": evidence,
                    }])
                    helper.finish({"codex": response})
                    for name in ("slot/codex-result.json", "role-summary.json",
                                 "deterministic-review.md"):
                        published = (helper.work / name).read_text()
                        self.assertNotIn("NFM_FENCED_JSON_CANARY", published)
                        self.assertIn("PUBLIC_KEEP", published)
                    self.assertTrue((helper.work / "deterministic-review.md").read_text()
                                    .endswith("VERDICT: PASS\n"))
                finally:
                    helper.tearDown()

    def test_chair_masks_fenced_json_before_losing_sensitive_labels(self):
        for evidence in self.fenced_json_cases():
            with self.subTest(evidence=evidence):
                reply = (0, evidence + "\nVERDICT: PASS\n", "")
                calls, published = self.chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertNotIn("NFM_FENCED_JSON_CANARY", published)
                self.assertIn("PUBLIC_KEEP", published)
                self.assertTrue(published.endswith("VERDICT: PASS\n"))

    def test_fenced_json_adapter_does_not_repair_other_block_bodies(self):
        for text in (
            "```python\npassword = 'synthetic'\n```\nPUBLIC_AFTER",
            '```json\n{"password": "synthetic",}\n```\nPUBLIC_AFTER',
            '```json\n{"name":"public","name":"password","value":"synthetic"}\n```',
            '```json\n{"password": "synthetic"}\n',
        ):
            with self.subTest(text=text):
                self.assertEqual(role_review.mask_fenced_json(text), text)


if __name__ == "__main__":
    unittest.main()
