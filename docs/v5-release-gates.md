# V5 Release Gates

V5 is not published until every command below passes on the release commit.
The gate runner is fail-closed and stops at the first failure.

```bash
npm run release:check
# During the final release, also enforce the version:
npm run release:check -- --expect-version 5.4.0
```

Run the complete command once under each supported Node runtime. Rebuild the
native `better-sqlite3` addon after switching runtimes so the ABI matches:

```bash
nvm use 18.20.8
npm rebuild better-sqlite3
npm run release:check -- --expect-version 5.4.0

nvm use 24.21.0
npm rebuild better-sqlite3
npm run release:check -- --expect-version 5.4.0
```

The runner executes:

1. TypeScript build and UI copy.
2. Full Node test suite.
3. Tenant/security adversarial matrix, including `SEC-AUTH-001` through `SEC-AUTH-005`, `SEC-SENS-001`, `SEC-DOC-001`, the keyed-batch contract, and the signed-webhook suite.
4. Recovery/corruption/migration matrix, including durable restart state,
   read-only enforcement, staged restore reconciliation, and injected import
   failures.
5. Python SDK suite (`npm run python:test`), which needs no server and no
   third-party package.
6. Documentation-link check.
7. High-severity dependency audit.
8. Package dry-run and export-surface check.
9. Strict 10K/100K tenant benchmark.
10. Bounded 10K/50K scale benchmark.

A run that fails with `RemoveEnvironmentCleanupHook` in the native teardown is
retried per file by `scripts/run-tests.mjs` and reported; see
[troubleshooting](troubleshooting.md#a-test-run-aborts-with-removeenvironmentcleanuphook).

The release operator must additionally verify:

- V4.9 legacy-mode and Markdown fixtures remain green.
- Tenant isolation, poisoning, secret, authorization, and recovery tests are green.
- Signed migration and snapshot fixtures reject tampering and interruption.
- The package version, changelog, Git tag, npm artifact, and GitHub Release point to
  the same commit.
- No V5 tag or npm publication is created while any gate is failing.
- The compatibility report for the release line is accurate:
  [V5.4.0 compatibility](v5.4.0-compatibility.md).
