# PR review module

[README.md](README.md) owns the interfaces, limits and staged rollout. This change selects
`ROLE_REVIEW=1` in CI; legacy entrypoints remain for compatibility and regression
fixtures. Keep instructions, docs and review output in English. Preserve complete
required-role coverage, nonce framing and the project review policy.

The installed specialist path is `run-specialists.sh` → `prepare_roles.py` /
`run_role.py` → `role_review.py` / `synthesize_roles.py`. These executors fetch Git
objects and invoke providers; only the protocol library itself is offline.
`role-controls.sh` owns control stripping, and `role-input-scope.json` records
BASE-approved exclusions. The README documents context hashes, environment
settings and optional base-verified project/context adapters.

Run `python3 -m unittest discover -s scripts/pr-review -p 'test_*.py'` and the
README shell checks. Tests use stubs; passing them is not proof of live model
execution. Preserve provider bindings, source custody and existing budgets.
