"""The approved presentation contract gates publication, not metadata."""

import unittest
import review_format
import re
import random
import itertools
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
    def test_role_format_validation_bounds_operator_free_key_runs(self):
        script = (
            "import sys\n"
            "from role_review import validate_response\n"
            "path='src/app.py';head='a'*40\n"
            "plan={'head_sha':head,'roles':{'codex':"
            "{'role':'implementation','paths':[path]}}}\n"
            "response={'head_sha':head,'role':'implementation','scope_complete':True,"
            "'reviewed_paths':[path],'checks':[{'path':path,'evidence':"
            "'token-'*(int(sys.argv[1])//6)}],'findings':[],'uncertainties':[]}\n"
            "validate_response(response,plan,'codex')\n"
        )
        for size in (6000, 36000):
            with self.subTest(bytes=size):
                try:
                    result = subprocess.run(
                        [sys.executable, "-c", script, str(size)],
                        cwd=Path(__file__).parent, capture_output=True,
                        text=True, timeout=2,
                    )
                except subprocess.TimeoutExpired:
                    self.fail(f"Role format validation stalled on {size} operator-free bytes")
                self.assertEqual(result.returncode, 0, result.stderr)


    def test_opted_format_bounds_plain_inline_and_assignment_key_runs(self):
        script = (
            "import re,sys\n"
            "from role_review import SENSITIVE_KEY\n"
            "from review_format import format_violation\n"
            "tokens=re.compile(r'[A-Za-z0-9_.:-]+',re.I)\n"
            "text='token-'*(int(sys.argv[1])//6)\n"
            "for pattern in (SENSITIVE_KEY,None):\n"
            " def check(value):\n"
            "  return (format_violation(value,pattern,key_token_pattern=tokens)"
            " if pattern is not None else format_violation(value))\n"
            " assert check(text) is None\n"
            " assert check('`'+text+'`') is None\n"
            " assert check(text+\"='synthetic'\") == 'unsupported_review_format'\n"
            " assert check('`'+text+\"`='synthetic'\") == 'unsupported_review_format'\n"
        )
        for size in (6000, 36000):
            with self.subTest(bytes=size):
                try:
                    result = subprocess.run(
                        [sys.executable, "-c", script, str(size)],
                        cwd=Path(__file__).parent, capture_output=True,
                        text=True, timeout=2,
                    )
                except subprocess.TimeoutExpired:
                    self.fail(f"Explicit/default key matching stalled on {size} bytes")
                self.assertEqual(result.returncode, 0, result.stderr)


    def test_role_and_original_filtered_chair_calls_declare_key_alphabet(self):
        calls = []

        def checked(text, pattern, **kwargs):
            tokens = kwargs.get("key_token_pattern")
            self.assertIsNotNone(tokens, "Production format validation omitted the opt-in")
            self.assertEqual(tokens.pattern, r"[A-Za-z0-9_.:-]+")
            self.assertEqual(tokens.flags, re.compile(tokens.pattern, re.I).flags)
            self.assertIs(pattern, role_review.SENSITIVE_KEY)
            calls.append(text)
            return review_format.format_violation(text, pattern, **kwargs)

        response, plan = self.response("Checked the caller.")
        with patch.object(role_review, "format_violation", side_effect=checked):
            role_review.validate_response(response, plan, "codex")
        self.assertEqual(len(calls), 1)
        calls.clear()
        reply = (0, "Checked the caller.\nVERDICT: PASS\n", "")
        with patch.object(synthesize_roles, "format_violation", side_effect=checked):
            provider_calls, published = self.chair([reply, reply])
        self.assertEqual(provider_calls, 1)
        self.assertEqual(len(calls), 2)
        self.assertTrue(published.endswith("VERDICT: PASS\n"))


    def test_opted_matching_keeps_existing_classification_and_key_positions(self):
        pattern = role_review.SENSITIVE_KEY
        tokens = re.compile(r"[A-Za-z0-9_.:-]+", re.I)
        keys = ("token", "token-token", "authentic", "auth", "password", "plain",
                "config.password", "AWS::SecretsManager::Secret", "apiKey", "paſſword",
                "épassword", "İtoken", "_token", "token:plain", ":token")
        tails = ("", ":42", ":L42-L45", ":42:7", "='x'", ": none.", ": bare",
                 ": checked here", ": [file](auth.ts)", '" : "x"', "\\\"='x'",
                 " :token='x'", "\n===\n", " ordinary: prose")
        corpus = [prefix + key + tail for prefix, key, tail in
                  itertools.product(("", "/", "\\", '"', "a "), keys, tails)]
        randomizer = random.Random(234)
        fragments = ("token", "auth", "plain", "-", "_", ".", ":", "=", " ", "\n", '"', "\\", "é")
        corpus.extend("".join(randomizer.choices(fragments, k=12)) for _ in range(1000))
        corpus.extend((
            "some (token), label : none.", "api \t-key = 'x'",
            "token [item], name: value", "a token \t: bare", "token \t\n= 'x'",
            "token:'x', password = 'y'", "See `src/token.py:42` for the caller.",
            "Checked ``src/token.py:42`` for the caller.", "password: !!str synthetic",
            "Authorization: [implementation](src/auth.py)", "Secrets: none.",
            "```text\npassword='synthetic'\n```",
        ))
        # No opt-in retains the old matcher for this non-default caller policy.
        legacy = re.compile(pattern.pattern + r"""(?:\\?["'])?"""
                            + review_format.ASSIGNMENT_TAIL.pattern, pattern.flags)
        for text in corpus:
            with self.subTest(text=text):
                expected = [(m.start(), m.start("spacing"), m.end(),
                             m["spacing"], m["operator"]) for m in legacy.finditer(text)]
                actual = [(start, m.start("spacing"), m.end(), m["spacing"], m["operator"])
                          for start, m in review_format.assignment_matches(text, pattern, tokens)]
                self.assertEqual(actual, expected)
                self.assertEqual(
                    bool(review_format.sensitive_reference(text, pattern, tokens)),
                    bool(pattern.search(text)),
                )
                self.assertEqual(
                    review_format.format_violation(text, pattern, key_token_pattern=tokens),
                    review_format.format_violation(text, pattern),
                )


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

    def citation_examples(self):
        return (
            "See [auth.ts](web/lib/auth.ts:42) for the missing guard.",
            "Authorization: The caller is checked.",
            "Checked `web/lib/token.ts`: the guard is missing.",
            "Per `docs/decisions/002-auth-and-login.md`: signup is closed.",
            "The guard at web/lib/auth.ts:42 is missing.",
            "See `app/src/lib/chart-tokens.ts:42` for palette mapping.",
            "See `AWS::SecretsManager::Secret` for the resource type.",
            "See `web/lib/token.ts:42-45` for token validation.",
            "See `web/lib/token.ts:42:7` for token validation.",
            "Authorization:\n```http\nGET /health HTTP/1.1\n```",
        )

    def test_native_citations_and_prose_keep_specialist_coverage(self):
        for text in self.citation_examples():
            with self.subTest(text=text):
                response, plan = self.response(text)
                try:
                    role_review.validate_response(response, plan, "codex")
                except role_review.Invalid as error:
                    self.fail(f"Citation/prose rejected: {error}")
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

    def test_native_citations_and_prose_keep_chair_adjudication(self):
        for text in self.citation_examples():
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
            "password:admin",
            "password: admin",
            "See web/lib/auth.ts:42; password='synthetic-private'.",
            "Authorization: The caller is checked; token=synthetic-private",
            "Checked `web/lib/token.ts`: the guard is missing; api_key='synthetic-private'.",
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


    def test_delimiter_preservation_does_not_exempt_actual_values(self):
        canary = "DELIMITER_PRIVATE_CANARY"
        for value in ("prefix`" + canary + "`", "`" + canary + "`",
                      "prefix`path/token.ts:42`" + canary,
                      "prefix`AWS::SecretsManager::Secret`" + canary,
                      "prefix`web/lib/token.ts:42-45`" + canary):
            with self.subTest(value=value):
                text = "password=" + value + "\nPUBLIC_AFTER"
                filtered = role_review.scrub(text)
                self.assertNotIn(canary, filtered)
                self.assertIn("PUBLIC_AFTER", filtered)



    def qualified_yaml_examples(self):
        return (
            'db.password: "FMT_V4_PRIVATE"',
            '/prod/db/password: "FMT_V4_PRIVATE"',
            '`config.password`: "FMT_V4_PRIVATE"',
            '`/prod/db/password` = "FMT_V4_PRIVATE"',
            'password: !!str "FMT_V4_PRIVATE"',
            'password: &credential "FMT_V4_PRIVATE"',
        )

    def test_v4_rejects_qualified_and_yaml_forms_in_each_prose_field(self):
        for text in self.qualified_yaml_examples():
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

    def test_v4_invalid_forms_never_enter_published_role_results(self):
        for evidence in self.qualified_yaml_examples():
            with self.subTest(evidence=evidence):
                helper = test_role_review.RoleReviewTests()
                helper.setUp()
                try:
                    helper.prepare()
                    response = helper.response("codex", checks=[{
                        "path": test_role_review.FRONTEND, "evidence": evidence}])
                    result = helper.record("codex", response, expected=2)
                    self.assertEqual(result["failure_codes"], ["unsupported_review_format"])
                    self.assertIsNone(result["response"])
                    helper.record("claude-self")
                    helper.cli("aggregate", "--work", helper.work, expected=2)
                    for name in ("slot/codex-result.json", "role-summary.json", "deterministic-review.md"):
                        self.assertNotIn("FMT_V4_PRIVATE", (helper.work / name).read_text())
                    self.assertTrue((helper.work / "deterministic-review.md").read_text()
                                    .endswith("VERDICT: FAIL\n"))
                finally:
                    helper.tearDown()

    def test_v4_chair_rejects_qualified_and_yaml_examples(self):
        for evidence in self.qualified_yaml_examples():
            with self.subTest(evidence=evidence):
                reply = (0, evidence + "\nVERDICT: PASS\n", "")
                calls, published = self.chair([reply, reply])
                self.assertEqual(calls, 2)
                self.assertTrue(published.endswith("VERDICT: FAIL\n"))
                self.assertNotIn("FMT_V4_PRIVATE", published)

    def sensitive_fence_info_examples(self):
        for label, marker in (("password", "```"), ("api_key", "~~~~"),
                              ("Authorization", "````")):
            for newline in ("\n", "\r\n"):
                yield newline.join((label + ":", marker + "FENCE_INFO_CANARY",
                                    "EXAMPLE_BODY", marker, "PUBLIC_AFTER"))

    def test_sensitive_fence_info_is_masked_before_role_publication(self):
        for text in self.sensitive_fence_info_examples():
            with self.subTest(text=text):
                helper = test_role_review.RoleReviewTests()
                helper.setUp()
                try:
                    helper.prepare()
                    response = helper.response("codex", findings=[{
                        "severity": "MINOR", "path": test_role_review.FRONTEND,
                        "condition": "Synthetic fence info example", "evidence": text}])
                    helper.finish({"codex": response})
                    for name in ("slot/codex-result.json", "role-summary.json", "deterministic-review.md"):
                        published = (helper.work / name).read_text()
                        self.assertNotIn("FENCE_INFO_CANARY", published)
                        self.assertIn("EXAMPLE_BODY", published)
                        self.assertIn("PUBLIC_AFTER", published)
                    self.assertTrue((helper.work / "deterministic-review.md").read_text()
                                    .endswith("VERDICT: PASS\n"))
                finally:
                    helper.tearDown()

    def test_sensitive_fence_info_is_masked_by_real_chair_filtering(self):
        for text in self.sensitive_fence_info_examples():
            with self.subTest(text=text):
                reply = (0, text + "\nVERDICT: PASS\n", "")
                calls, published = self.chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertNotIn("FENCE_INFO_CANARY", published)
                self.assertIn("EXAMPLE_BODY", published)
                self.assertIn("PUBLIC_AFTER", published)
                self.assertTrue(published.endswith("VERDICT: PASS\n"))

    def test_fence_info_masking_keeps_empty_and_nested_delimiters(self):
        for text in ("```text\npassword:\n```\nPUBLIC_AFTER",
                     "~~~~text\napi_key:\n~~~~\nPUBLIC_AFTER",
                     "````text\npassword:\n```FENCE_INFO_CANARY\nEXAMPLE_BODY\n```\n````\nPUBLIC_AFTER"):
            with self.subTest(text=text):
                clean = role_review.scrub(text)
                self.assertNotIn("FENCE_INFO_CANARY", clean)
                self.assertEqual(role_review.scrub(clean), clean)
                reply = (0, text + "\nVERDICT: PASS\n", "")
                calls, published = self.chair([reply, reply])
                self.assertEqual(calls, 1)
                self.assertNotIn("FENCE_INFO_CANARY", published)
                self.assertIn("PUBLIC_AFTER", published)
                self.assertTrue(published.endswith("VERDICT: PASS\n"))

    def test_original_fail_with_invalid_format_cannot_fall_back_to_pass(self):
        first = (0, "Blocking issue remains. Run `echo details`.\nVERDICT: FAIL\n", "")
        fallback = (0, "Fallback must not approve this review.\nVERDICT: PASS\n", "")
        calls, published = self.chair([first, fallback])
        self.assertEqual(calls, 1)
        self.assertTrue(published.endswith("VERDICT: FAIL\n"))
        self.assertIn("withheld", published.lower())
        self.assertNotIn("echo details", published)

    def test_original_fail_format_error_keeps_quota_precedence(self):
        first = (0, "Blocking issue remains. Run `echo details`.\nVERDICT: FAIL\n",
                 "Error: insufficient credits")
        fallback = (0, "Must not run.\nVERDICT: PASS\n", "")
        calls, published = self.chair([first, fallback])
        self.assertEqual(calls, 1)
        self.assertTrue(published.endswith("VERDICT: FAIL\n"))
        self.assertNotIn("details were withheld", published.lower())



if __name__ == "__main__":
    unittest.main()
