# scripts — Operational Shell Scripts

## Role
Operational shell scripts for building/deploying the app image, running the live smoke gate, provisioning the AgentCore gateway, and one-time developer/credential setup. Account `<ACCOUNT_ID>`, region `ap-northeast-2`.

## Key Files
- `build-push.sh` — builds the arm64 app image (`app/Dockerfile`, Next.js standalone) and pushes to ECR repo `nfm-dashboard-app`. Tag defaults to the current git short SHA. Repo is tag-IMMUTABLE: a new commit = a new tag; re-pushing an existing SHA is rejected. Also pushes a convenience `latest` (warn-only on failure; the SHA tag is authoritative).
- `smoke.sh` — live E2E gate: resolves `APP_URL` from the `NfmDash-App` `AppUrl` output, mirrors the `authDisabled` CDK context into `E2E_AUTH_DISABLED` (skipping the Secrets Manager password fetch when auth is off), otherwise pulls `E2E_PASSWORD` from `nfm-dashboard/cognito-admin`, then runs `npx playwright test --config e2e/playwright.config.ts` (extra args pass through). See `e2e/CLAUDE.md`.
- `setup-gateway.sh` — AgentCore gateway provisioning: reads `GatewayRoleArn` from the `NfmDash-AgentCore` stack output and runs `python3 tools/create_gateway.py <role-arn>`.
- `save-cognito-secret.sh` — prompts for the Cognito admin password and stores it in Secrets Manager `nfm-dashboard/cognito-admin` (create-or-put). The AppStack custom resource reads it at deploy time; never echo or commit secrets.
- `setup.sh` — new-dev setup: `npm install` (all workspaces), builds the collector bundle, seeds `.env` from `.env.example`, then runs `install-hooks.sh`.
- `install-hooks.sh` — installs a `.git/hooks/commit-msg` hook that strips `Co-Authored-By:` lines from commit messages.
- `pr-review/` — AI review panel used by `.github/workflows/pr-review.yml` (runs the **base-branch** copy via `pull_request_target`): `run-panel.sh` fans out lens×model cells (Codex + 2 Kiro, tool-enabled by design — diff passed by file path), `synthesize.sh` runs the Claude chair, `lib.sh` holds `record_result`/`scrub_secrets`. File contract between them in `$WORK`: `responded.txt`, `degraded-models.txt`, `degraded-lenses.txt`, `coverage-severe.flag` (forces `VERDICT: FAIL`) and `kiro-quota.flag` (Kiro monthly quota exhausted — non-transient, fail-fast, no retry); all flags are reset at the start of every run. Failure modes: `docs/runbooks/pr-review-panel.md`; tests: `tests/structure/test-pr-review-panel.sh`.

## Rules
- Deploys go in order: `bash scripts/build-push.sh <sha>` then `cd infra && npx cdk deploy <Stack> -c imageTag=<sha>` (all cdk commands need `-c imageTag`; non-App stacks may use `-c imageTag=unused`).
- Secrets live only in Secrets Manager / process env — never on disk, never in git or CFN templates.
