# Specialist PR review

CI enables `ROLE_REVIEW=1` for distinct specialist responsibilities. Legacy
matrix entrypoints remain for regression fixtures.

| Slot | Configured model | Responsibility |
| --- | --- | --- |
| `codex` | `global.openai.gpt-6-astra` | Implementation, concurrency, errors and tests |
| `kiro-fable` | `claude-opus-5` | AWS architecture, IAM, networking and service constraints |
| `kiro-sol` | `gpt-5.6-sol` | Deployment order, component contracts, lifecycle and recovery |
| `claude-self` | `global.anthropic.claude-fable-5-1` | Authentication, data boundaries, requirements, API and ADR consistency |

`kiro-fable` identifies Opus. Kiro aliases and Bedrock IDs are separate;
configured names do not attest provider routing or weights.

## Routing and evidence

Trusted code determines which roles apply. Codex and Claude review the full change
boundary, retaining independent OpenAI/Anthropic checks for sensitive changes.
Kiro roles run for applicable AWS and operational changes, including relevant
documentation. Unfamiliar paths route conservatively. Only deterministic routing
may record NOT_APPLICABLE; provider failures never do.

Trusted Get PR diff resolves/fetches Git objects and passes `MERGE_BASE_SHA`.
Preparation validates local commits from pinned BASE; the review step has no
GitHub token and never fetches or checks out HEAD. Standalone calls without this
handoff retain API/fetch compatibility. Instructions come from BASE objects;
candidate context must exist, fit the 24,000-byte ceiling and match its generated
source hash, then is discarded. Projects may lower that ceiling.

Every result confirms its role, HEAD and reviewed paths. Host metadata binds it
to the prepared request and records the process status. Nonzero exits, malformed
or empty reports, missing paths, invalid fingerprints, model selection errors,
quota exhaustion and failed required roles block coverage. A JSON shape is
evidence of protocol completion, not proof that the model found every defect.

One complete filtered diff may contain at most 3,000 lines and 95,000 UTF-8
bytes. Larger input blocks; this path does not combine partial chunks or raise
budgets.

## Execution and synthesis

Each required model receives one request. Kiro uses private HOME/cwd and an empty
tool/MCP/resource/hook catalog. Each active Kiro model must first return the exact
successful no-tools response to a fixed canary without PR data. Its child
environment excludes AWS and GitHub credentials. Failures remain visible;
quota and billing limits never change automatically.

Codex retains its read-only sandbox and configured Bedrock provider. Claude's
specialist has no tools. The review step and its reviewer/chair process environments
carry no GitHub token; the chair retains bounded local read tools. Review output is scrubbed before becoming a public artifact.

Code/configuration examples use closed top-level fences at column one. Inline code
is only for single-line symbol/path references; use synthetic values, never credentials.
Specialist prose and chair output must satisfy this format before and after filtering.
Unsupported examples fail coverage or adjudication. Metadata paths keep their existing
validation. The format gate does not replace confidentiality checks or promise a
general language parser; see the [module contract](../scripts/pr-review/README.md).

Complete, valid results with no Critical/Major candidate or uncertainty receive
a deterministic summary. Other valid results require chair adjudication. A
coverage failure receives a deterministic failure; a chair cannot waive it.
Minor/Info findings remain in the report.

A successful run with all four roles uses four review calls and two Kiro startup
checks. Adjudication, retries and fallback add calls only as needed. Timing
artifacts measure runtime.

## Maintenance and release

Run `python3 -m unittest discover -s scripts/pr-review -p 'test_*.py' -v`
and the repository's existing review tests. Offline fake CLIs validate routing,
scope, subprocess status and safety boundaries without spending model credits.
They do not establish successful live model execution.

Native `pull_request_target` uses base scripts, so a workflow-changing PR must
also have offline checks for the candidate implementation. Review the latest HEAD,
resolve real Critical/Major findings, satisfy required CI and branch rules, and
verify the integration path before merge. Missing review or quota failure is not
a clean result. Model limits and required gates remain in force.

## Approved source scope

`role-input-scope.json` preserves this repository's existing lockfile/generated-
asset exclusions. The trusted base copy classifies immutable Git paths before
requests are prepared. Provenance records every excluded path and both raw and
approved diff hashes. Renames are expanded into deletion/addition records so a
source path cannot disappear through an artifact rename. A verified exclusions-
only change is explicitly NOT_APPLICABLE and invokes no model; missing inputs,
unknown exclusions and truncated required source remain blocked. The policy does
not authorize excluding additional source merely to obtain a pass.

Approved exclusions-only input explicitly supplies `--allow-exclusions-only` and
a private `--policy` file copied from Git BASE. The engine checks its byte hash
and retains an anchor through aggregation; arbitrary provenance cannot opt in.

[ADR-014](decisions/ADR-014-specialist-review-protocol.md) records the accepted
role, coverage and language decisions.
