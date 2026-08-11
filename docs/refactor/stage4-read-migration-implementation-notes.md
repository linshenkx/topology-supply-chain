# Stage 4 Read Migration Implementation Notes

## Source

- User-approved continuation of the frontend/backend separation: migrate active legacy GET handlers to the Fastify `/api/v1` boundary while preserving existing business behavior and leaving write operations on the legacy boundary.
- Six domain implementation tasks run in isolated Codex worktrees from baseline `6b0d6ce`; the main task owns review, integration, frontend GET switching, runtime registration, and release gates.

## Design Decisions

- Keep write operations on the legacy `/api` boundary and switch only active GET consumers to Fastify `/api/v1` during this stage.
- Treat internal `admin`, `supply_chain`, and `company_qc` roles as full-scope readers for production and quality data; external factory and supplier quality roles must have a valid organization identifier and are filtered in SQL before applying the result limit.
- Preserve the current single-company internal scope for finance and approvals (`admin`, `supply_chain`, `finance`) in Stage 4; field minimization remains a separately visible security/UAT item.
- Use one shared parameterized Fastify audit writer for migrated read modules; the writer verifies a single inserted row and keeps the legacy five-year retention rule.
- Keep local development usable through a fixed-origin, exact-path allowlist that exports only GET; production refuses the bridge and Nginx remains the production `/api/v1` router.

## Deviations

- Fix confirmed legacy authorization failures instead of copying them: supplier quality users no longer receive all quality inspections, and factory users without a valid `factoryId` no longer receive all production orders.
- Reject a malformed inventory `warehouseId` with 400 instead of silently treating it as an omitted filter.
- Factory purchase-order views will contain only their allocated items and links; shared quantities and order totals are recalculated from the visible allocations instead of exposing whole-order values.

## Tradeoffs

- Authorized scope filters run before `ORDER BY ... LIMIT`, so scoped users receive the latest 200 rows in their own scope instead of a filtered subset of the global latest 200. This is an intentional security and availability correction.
- Finance keeps `bankReference` because both current finance screens consume the field; unrelated sensitive fields were removed from the v1 contract. This remains a UAT/security review item rather than a claim of full finance readiness.

## Open Questions

- Confirm the least-privilege production adapters needed by the account/platform module for audit XLSX generation and object reads after its contract is reviewed.
- Reassess legacy organization rules preserved by the inventory/logistics slice: factory asset ownership visibility, warehouse-derived stocktake scope, and receiver authorization by organization name.

## Verification Notes

- Legacy route evidence confirmed the production and quality authorization failures before implementation was authorized.
- Finance/Approvals and Inventory/Logistics domain commits were independently re-read and re-tested before cherry-pick. Their contracts/API builds, 25 domain tests, scoped ESLint, and diff checks passed.
- Shared audit/runtime/frontend integration currently passes 23 focused tests, contracts/API compilation, repository TypeScript, scoped ESLint, and `git diff --check`.
- The allowlisted local bridge passes two security regressions and a full `build:aliyun` (37 routes); final gates will be rerun after all domains are integrated.
