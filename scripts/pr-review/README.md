# Specialist review protocol

CI selects `ROLE_REVIEW=1`. Trusted inputs feed specialist executors; validated
results feed aggregation and, when needed, the chair. See
[the project contract](../../docs/pr-review-specialists.md).
The protocol library itself performs no Git or provider calls; its installed
executors fetch Git data and invoke provider CLIs.

| Tag | Requested model | Scope |
| --- | --- | --- |
| codex | `global.openai.gpt-6-astra` | Implementation/tests |
| kiro-fable | `claude-opus-5` | AWS/IAM/network |
| kiro-sol | `gpt-5.6-sol` | Deployment/contracts/recovery |
| claude-self | `global.anthropic.claude-fable-5-1` | Auth/data/API/ADR |

`kiro-fable` means Opus. `ROLES` governs specialists; legacy files govern legacy
execution. Kiro/Bedrock IDs differ. English is requested, not validated; configured
IDs do not attest model weights.

## Installed executors

- `run-specialists.sh DIFF LENSES WORK` coordinates preparation, required-role
  processes and aggregation. `LENSES` retains the legacy positional interface.
- `prepare_roles.py` requires the trusted BASE checkout. CI's earlier token-bearing
  step resolves/fetches immutable Git objects and supplies `MERGE_BASE_SHA`.
  Preparation validates the SHA and local commits, then reconstructs the diff
  without network access or a GitHub token. Standalone calls without this trusted
  handoff retain API/fetch compatibility. PR-head code is never checked out.
- `run_role.py` invokes one configured provider for each required role. Kiro uses
  private HOME/cwd and a no-tools preflight; Codex uses JSONL events and its final
  reply file. `role-controls.sh` strips control bytes before publication.
- `synthesize_roles.py` publishes a deterministic result or invokes a bounded
  chair for substantive candidates. Its default primary/fallback are
  `global.anthropic.claude-fable-5-1` / `global.anthropic.claude-opus-5` (Runtime IDs).

Inputs use `HEAD_SHA`, `BASE_SHA`, and `GH_REPO` (or `GITHUB_REPOSITORY`).
`REVIEW_CONTEXT_CAP` defaults to 24,000 bytes and may only be lowered.
`PANEL_TIMEOUT`, `PANEL_RETRIES` and `KIRO_PREFLIGHT_TIMEOUT` retain their bounded
executor settings. Chair time/turn/fallback settings come from project policy or
legacy `synthesize.sh`; do not raise limits to obtain a passing review.

Base `AGENTS.md` takes precedence over `CLAUDE.md`. Generated co-agent context
must contain a `claude-md-sha` matching the first 12 SHA-256 characters of its
canonical CLAUDE source. Missing, oversized or stale context blocks preparation;
candidate context is checked but does not become trusted instructions.

`role-input-scope.json` schema 1 records the existing exclusions: `package-lock.json`,
the listed image/font/archive/PDF extensions, and generated dependency/build/test
folders. `basenames`, `extensions`, parent `directories`, `prefixes` and optional
`path_regexes` are string arrays. Only BASE policy narrows review scope; provenance
lists exclusions. This keeps the existing input policy, not a new lockfile exemption.

Optional `role-project.json` selects `prepare_project_roles.py` and chair/context
policy. The adapter must match BASE bytes. Without an adapter, an optional
`prepare_context_roles.py` hook must also match BASE bytes and cannot increase the
context cap. These are extension contracts; this repository uses generic preparation.

## API and input

`python3 scripts/pr-review/role_review.py COMMAND --help` lists flags.

| Command | Contract |
| --- | --- |
| prepare | Diff/context, HEAD/base, work; optional paths/provenance → `role-plan.json`, `roles/TAG.txt/.diff`. |
| issue | Work/tag → nonce, exact `requests/TAG.prompt/.input`, `slot/TAG-request.json`. Call before each attempt. |
| record | Tag, output/stderr, exit code, issued nonce → validated, scrubbed `slot/TAG-result.json`. |
| aggregate | Validate results/receipts → `role-summary.json`, `responded.txt`, `chair-mode.txt`, applicable report/flag. |

The executor sends issued bytes; hashes bind inputs, not transport. Keep tool data
out of diagnostics.

`--paths`: UTF-8 JSON array of unique repository-relative paths matching the patch,
e.g. `["src/api.ts"]`. Renames use destinations; the collector checks both sides.
Omit only for authoritative, unambiguous patch paths.

`--provenance`: JSON object. Required `head_sha`/`base_sha` equal the lowercase
40-character CLI revisions; `diff_sha256` hashes exact raw diff bytes. Example:

```json
{"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","base_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","diff_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
```

Optional `input_failures` contains codes matching `[a-z][a-z0-9_:.-]{0,63}`; any code
blocks. Invalid provenance is discarded and blocks; stored values are scrubbed.
Optional `path_only: list[str]` identifies collector-approved metadata-only
deletions. Verify eligibility before withholding bodies.

## Coverage and lifecycle

Codex/Claude are required for reviewable source; trusted routing may deactivate
irrelevant Kiro roles. App Router React is conservative. Failed output is never
N/A. Parsing misses whole omissions/some cut prefixes: verify Git scope/hashes.

BASE-approved exclusions-only scope may yield NOT_APPLICABLE/PASS without models.
Require empty diff/paths, `scope_exception: configured_exclusions_only`, lowercase
64-character `input_policy_sha256`, and identical nonempty unique safe
`scope_paths`/`excluded_paths`. The collector verifies policy/all paths; the report
shows exclusions/hash. Accidental empty input never qualifies. New exclusions
need policy review; project-specific exceptions remain.

Start fresh work before collection. `prepare` clears owned results/receipts, claims,
duplicate/terminal flags and histories; upstream flags remain. Issue/record exclude
each other; interrupted operations require fresh work. Duplicate records retain
the first result and block. Finish writers before aggregation. Reissue archives
32 prior results in `slot/TAG-attempts.json`; model-selection/fallback/quota/preflight
failures block until new preparation. Summaries retain history. All `*.flag` files
block except the aggregator's own root `coverage-severe.flag`, which it rewrites from
current evidence; upstream flags are never exempt. `failure_codes` is canonical; `failures` aliases it.

Exit 2 means blocked. Aggregate exit 0: `deterministic` permits the report when no
blocking candidate/uncertainty exists (Minor/Info remain); `review` needs a chair.
Blocked input yields deterministic FAIL; the chair cannot waive coverage failures.

Publish scrubbed reports/receipts/metadata only; never raw `roles/*.diff` or
`requests/*.input/.prompt`.

Review examples use closed top-level backtick or tilde fences, with both delimiters
at column one on their own lines. Inline code is limited to single-line,
whitespace-free symbol/path references; an empty `()` suffix is allowed. Use a
longer outer fence around examples containing fences. Reproducers use synthetic
values, never credentials. Bare colon section labels and Setext heading underlines
remain prose.

`review_format.py` validates decoded specialist prose and chair output before and
after confidentiality filtering. Unsupported inline commands, malformed/multiline
delimiters and unfenced sensitive assignments invalidate coverage with the static
`unsupported_review_format` code, or fail chair adjudication. Metadata paths retain
their existing schema validation. Deterministic findings use fenced canonical JSON
so embedded examples cannot add verdict lines.

Complete JSON objects or arrays inside closed fences use the existing structured
scrubber before prose filtering can erase sensitive labels. Malformed JSON and
non-JSON bodies retain their existing filtering; this helper does not repair them.

This is an intentional narrowing of the publication format, not a general code
parser or a confidentiality guarantee. Existing redaction, original/filtered verdict
checks, provider diagnostics, scope custody and budgets remain mandatory. Raw
confidentiality regression fixtures remain tested separately from fenced publication
examples.

## Limits and checks

Limits: 95,000 diff bytes (UTF-8), 3,000 lines, 24,000 context bytes, <128 KiB
request; projects may lower them. Oversize blocks. No chunk coordinator or
combining partial PASS results; preserve custody/budgets.

Run `python3 -m unittest discover -s scripts/pr-review -p 'test_*.py'`.
Check each shell entrypoint with `bash -n`: `run-specialists.sh`, `run-panel.sh`,
`synthesize.sh`, `role-controls.sh` and `lib.sh`. Offline CI is
`.github/workflows/pr-review-roles-tests.yml`; local success does not establish
live provider execution. Verify exact-head publication and runtime evidence.

Sol replaces this repository's legacy Terra slot in this workflow; application
inference models remain unchanged.

Exclusions-only review requires both `--allow-exclusions-only --policy FILE`.
The trusted BASE collector supplies a schema-1 policy; its exact bytes must match
`input_policy_sha256`. The private `exclusions-policy.json` anchor is rechecked
during aggregation. Missing or mismatched opt-in blocks. The collector, not this
offline library, must establish complete Git scope and approved exclusions.

A valid result cannot be reissued to discard findings or uncertainty. Start a new
preparation for a new review; failed attempts retain their diagnostic history.

Codex/Claude rows use Bedrock Runtime IDs; Kiro rows use Kiro catalog aliases.
Local Codex on Mantle uses `openai.gpt-6-astra`; these namespaces are distinct.

Codex uses structured transport events plus its CLI-designated final-output file.
Tool output and progress text are not review results. Recovered transport notices
remain visible; terminal provider errors still block.
