# ADR-014: Specialist review protocol

## Status

Accepted

Date: 2026-09-13. The protocol implementation is planned; activation needs a separate reviewed change.

## Context

The legacy matrix repeats four review lenses for three models. Duplicate analysis
and unconditional chair calls increase latency. Inconsistent documentation also
causes false positives. The owner requested specialist routing and English-only
repository documentation, including ADRs, to reduce repeated context tokens.

## Options Considered

- Keep the matrix: retains repeated coverage but also its latency and duplication.
- Remove panel members: reduces latency but loses independent model families.
- Keep independent primary roles and route specialists: chosen; preserves the
  pool while avoiding clearly irrelevant specialist work and empty chair calls.

## Decision

Assign distinct responsibilities to the supported model pool instead of repeating
every lens. Codex uses GPT-6 Astra, Kiro uses Opus 5 and GPT-5.6 Sol, and the Claude
role uses Fable 5.1. Require complete, immutable-scope reports and independent
OpenAI/Anthropic primary coverage. Only trusted routing can mark a role inactive.
Use random-nonce input boundaries and bind invocation nonces into result digests.

A complete report without blocking candidates or uncertainty may receive a
deterministic summary. A chair adjudicates substantive candidates, but cannot
waive missing or invalid coverage. Preserve existing project input exclusions,
secret/state custody, context and budgets. No quota or billing limits are raised.
Review instructions and output are English to avoid duplicate translations.

This records the approved protocol design; it does not supersede the live legacy
workflow yet. The activation change must identify which older execution/coverage
rules it replaces and preserve their remaining security and ownership decisions.
See [the module contract](../../scripts/pr-review/README.md) for current interfaces
and offline checks. Model access and production execution require separate evidence.

The target Sol configuration intentionally replaces the legacy Terra review slot
for consistent fleet configuration. This is an explicit target selection, not a
claim that Sol is already LIVE or a change to the application inference models.

A scope containing only files excluded by the existing, base-approved project
input policy may complete as NOT_APPLICABLE with a PASS gate result. The trusted
collector must account for every path and record the policy hash; the report
identifies excluded paths and claims no model review. Any reviewable source,
unknown exclusion, source omission or failed collector remains blocking. New
exclusions require their own reviewed policy change.

## Consequences

The new protocol keeps immutable scope and blocked execution visible. App Router
React files are treated conservatively because they may be server components.
Codex/Claude remain mandatory independent primary roles. The shared `kiro-fable` tag maps to Opus and replaces the local `kiro-opus` tag;
`claude-self` identifies Fable.

English-only ADRs supersede the old bilingual template for new/updated records;
operator Korean and product i18n remain supported. Existing historical records
need no duplicate rewrite. English review output becomes active only with the
executor rollout. Missing Korean duplicates are not review defects. Deterministic
summaries reduce chair authority to substantive adjudication; they cannot waive
missing coverage. The legacy workflow remains active during this staging phase.

## References

- [Protocol contract](../../scripts/pr-review/README.md)
- [Current workflow](../../.github/workflows/pr-review.yml)
- [Project context](../../CLAUDE.md)

For future edits to README, CHANGELOG, architecture and other current guides,
update the English text and remove its stale Korean duplicate. Translate Korean-only
material when revising it. Untouched legacy text and immutable historical evidence
may retain their original language; new templates and new content are English.
The runbook template follows this policy. Product UI localization is unchanged.
