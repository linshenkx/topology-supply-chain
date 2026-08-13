# Stage 9 T2 Quality and Security Final Report

## Result

- Base: accepted T1 `228de77b97e42e8b571871048c425ebd5712cbc0`.
- Branch: `codex/stage9-t2-quality-security`; all commits are one linear parent chain.
- Scope: non-business quality/security debt only. Business rules, public API/response/authorization semantics, schema, migration bytes, writer/command/resource identity, deploy/rollback behavior and Scope A ownership remain frozen.

## Batch results

1. Preserved the full accepted-T1 source of 18 retired routes in a deterministic source snapshot, with per-member manifest, SHA-256, sensitive scan, closure assertions and byte-exact restore dry-run.
2. Reduced the live retired routes to method-level 410 shims that keep `WRITER_MOVED` and successor `Link` semantics.
3. Reduced ESLint from 102 warnings to 0 errors / 0 warnings. Hook lifecycle regressions cover cleanup abort, callback-identity request replay and stale tier response overwrite.
4. Split production preflight from migration. The migrator has no `env_file` and receives only `DATABASE_URL`, `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED`; deploy ordering, writer fences and rollback remain unchanged.
5. Processed security dependencies in four serial clusters: ESLint, Wrangler/Undici, Vinext/Vite/RSC and Drizzle/esbuild. Production audit is zero; every project-controllable Critical/High/Moderate/Low is zero.
6. Removed project-controlled dynamic-import and large-chunk warnings. XLSX is a lazy dynamic entry after the existing file validation; the initial page chunk is 181,718 bytes.

## Time-bound upstream exception

The only full-tree High findings are dev-only `@topology/web -> vinext@0.0.50 -> image-size@2.0.2`:

- `GHSA-w3rx-r6r6-pgpr`: ICNS parser infinite-loop denial of service.
- `GHSA-5p2g-fcmc-qvqq`: JXL/HEIF parser infinite-loop denial of service.

The advisories request `image-size >=2.0.3`, but npm has no formal `2.0.3` release and latest is `2.0.2`; both current Vinext `0.0.50` and upstream `1.0.0-beta.5` pin `2.0.2`. The dependency is in the Vinext development/preview metadata image-dimension chain and is absent from the production audit. No override, patch-package, private/Git fork, invented version, ignore rule or framework replacement is used.

`pnpm audit:policy` fails for any additional Critical/High, any production finding, either dependency-path/version/advisory drift, or on `2026-09-12`. Earlier review is required when image-size publishes a formal fix, Vinext changes the dependency, or the advisory/input surface changes.

## Verification counts

- Environment: Node `v24.19.0` (contract `>=22.13.0`), pnpm `11.9.0`; frozen install and lockfile supply-chain policy pass.
- ESLint: 0 errors / 0 warnings; baseline 0 / 0.
- Audit: production 0 Critical / 0 High / 0 Moderate / 0 Low; full tree 0 Critical / 2 adjudicated High / 0 Moderate / 0 Low.
- TypeScript: Contracts, shared config, Web, API and Worker all pass.
- Architecture: 179 files, 143 internal edges, 0 cycles, 0 database-to-Web imports.
- Non-MySQL: 54 files, 357 tests, 0 fail, 0 skip; Web system 4/4.
- Real MySQL 8.4: 8 files, 21 tests, 0 fail, 0 skip; temporary loopback-only container deleted.
- Legacy/R3 targeted: 10/10; all 18 legacy business GETs are exact thin 410 boundaries.
- Hooks lifecycle: 3/3, including 14 cleanup abort paths.
- MySQL migration history: 19/19; isolated Drizzle generate reports no change; repository migration closure remains 22 files.
- Web builds: Next production 47/47 with 0 warnings; Vinext preview 46 routes with 0 project-controlled warnings.
- Docker: fresh API, Worker, Web runner and migrator target builds pass; runtime closure/user probes pass; all task-tagged images deleted.
- Archive: source snapshot 18 routes / 184,320 bytes / SHA-256 `df2605b0471e3d8f1be7146c3404dbe65a972d958159112c009844b6771a94a9`; sensitive clean and excluded from runtime/build/lint/Docker/release. Asset-owner checkout verifies 343 archived assets.

## Frozen identities and residual warnings

- Release manifest stdout SHA-256 remains `50225ce306a5ecf965099bd54d776fa5b31c69ea5a52c777474625cf8f0c94bc` with 5 migrations, 35 commands, 29 resources, writer generation 2 and `legacyWriterCompatible=false`.
- Relative to accepted T1, migration SQL, journals, snapshots, migration manifest and release/command/resource identity sources have no diff.
- Remaining non-project warnings are exact and non-semantic: Wrangler `4.120.0` proxy-environment notification at `wrangler-dist/cli.js:432180`, and Vinext `0.0.50` route-classification limitation at `dist/build/report.js:614`. Clearing proxy variables would change network behavior; adding `dynamic`/`revalidate` would change cache semantics, so neither is used as a warning workaround.
