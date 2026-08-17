# Implementation Notes

## Source
- Delegated T3 task: desktop-only usability closeout from exact clean detached baseline `138e258`.

## Design Decisions
- Add shared `min-width: 0` guards to the shell header and reusable panels so a child grid or table cannot force document-level horizontal overflow.
- Preserve each workspace's existing table wrapper and its intentional horizontal scrolling; the change only constrains the containing page.
- Make the global import and approval dialogs scroll inside a viewport-constrained overlay, which keeps their close and submit controls reachable at 720px height.
- Keep the account-operation column within the 1280px desktop content width by replacing its fixed 1040px row minimum with explicit shrinkable columns and a 210px action-column floor.

## Deviations
- None.

## Tradeoffs
- Preserve intentional workspace-level horizontal table scrolling while preventing page-level overflow and inaccessible controls.

## Open Questions
- None within the frozen desktop-only scope.

## Verification Notes
- Baseline confirmed: detached `138e258`, clean worktree.
- `pnpm typecheck:web`: passed.
- `pnpm lint:baseline`: passed, 0 errors and 0 warnings.
- `pnpm build:web:production`: passed.
- `pnpm test:non-mysql`: 400 pass, 0 fail, 0 skip; Web system checks 4 pass, 0 fail, 0 skip.
- First HTTP browser run found the 1280px account-action column was only reachable after internal horizontal scrolling; it was corrected before final verification.
- Final real-browser HTTP/loopback verification used the isolated `e2e-20260817-b2205` fixture at runtime commit `e1a90ca` (the final amendment after verification is docs-only). At 1280x720, 1366x768, 1440x900, and 1920x1080, the shell document width did not exceed the viewport, every import modal stayed within the viewport, and the account table client width equalled its scroll width. The 1280px account actions were fully visible after the correction.
