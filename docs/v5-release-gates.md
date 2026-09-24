# V5 Release Gates

V5 is not published until every command below passes on the release commit.
The gate runner is fail-closed and stops at the first failure.

```bash
npm run release:check
# During the final release, also enforce the version:
npm run release:check -- --expect-version 5.0.2
```

Run the complete command once under each supported Node runtime. Rebuild the
native `better-sqlite3` addon after switching runtimes so the ABI matches:

```bash
nvm use 18.20.8
npm rebuild better-sqlite3
npm run release:check -- --expect-version 5.0.2

nvm use 24.21.0
npm rebuild better-sqlite3
npm run release:check -- --expect-version 5.0.2
```

The runner executes:

1. TypeScript build and UI copy.
2. Full Node test suite.
3. Tenant/security adversarial matrix, including `SEC-AUTH-001` through `SEC-AUTH-005`, `SEC-SENS-001`, and `SEC-DOC-001`.
4. Recovery/corruption/migration matrix.
5. Documentation-link check.
6. High-severity dependency audit.
7. Package dry-run and export-surface check.
8. Strict 10K/100K tenant benchmark.
9. Bounded 10K/50K scale benchmark.

The release operator must additionally verify:

- V4.9 legacy-mode and Markdown fixtures remain green.
- Tenant isolation, poisoning, secret, authorization, and recovery tests are green.
- Signed migration and snapshot fixtures reject tampering and interruption.
- The package version, changelog, Git tag, npm artifact, and GitHub Release point to
  the same commit.
- No V5 tag or npm publication is created while any gate is failing.
