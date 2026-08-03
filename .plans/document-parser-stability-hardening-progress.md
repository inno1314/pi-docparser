# Implementation Progress

- **Template loaded from:** `implement-plan/assets/progress-tracker-template.md`
- **Plan:** `.plans/document-parser-stability-hardening.md`
- **Status:** `Complete`
- **Updated:** 2026-08-03

`Complete` = all rows `Verified` or user-approved `Descoped` + validation passed + final review `Clear` + nothing material open.

Parent = sole tracker writer under concurrency.

## Tasks / subtasks

Status: `Pending` | `In progress` | `Blocked` | `Verified` | `Descoped`

| ID   | Plan ref / requirement                                                                | Deps    | Status   | Acceptance check                            | Evidence                                                                             |
| ---- | ------------------------------------------------------------------------------------- | ------- | -------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| T1.1 | Preserve existing manifest/lock changes; pin LiteParse/Pi/peers/Node/tsx              | —       | Verified | Metadata assertions and installed versions  | `tests/package-metadata.test.ts`; `pnpm list`; preserved `@types/node`/`oxlint`      |
| T1.2 | Add test/runtime scripts and JS typechecking                                          | T1.1    | Verified | Package test and typecheck                  | `package.json`; `tsconfig.json`; final checks                                        |
| T2.1 | Centralize limits/defaults and schema maxima                                          | T1      | Verified | Config/policy tests                         | `tests/config-policy.test.ts`                                                        |
| T2.2 | Strict bounded page/phrase/screenshot validation                                      | T2.1    | Verified | Input boundary tests                        | `tests/input-policy.test.ts`                                                         |
| T2.3 | Require readable regular-file targets                                                 | T2.1    | Verified | File/symlink/special-file tests             | `tests/input-policy.test.ts`                                                         |
| T3.1 | Versioned bounded length-prefixed protocol                                            | T2      | Verified | Protocol/executor tests                     | `native-protocol.mjs`; malformed/oversized/trailing tests                            |
| T3.2 | Fair one-active-job FIFO with abort/timeout/disposal                                  | T3.1    | Verified | Executor lifecycle tests                    | `tests/native-executor.test.ts`                                                      |
| T3.3 | Cross-platform child/process-tree teardown and poison on uncertainty                  | T3.2    | Verified | Root/grandchild/uncertain teardown tests    | POSIX tests pass; Windows implementation covered by CI workflow                      |
| T3.4 | One executor per activation; awaited shutdown; worker-only LiteParse import           | T3.2    | Verified | Runtime import/grep/tests                   | `index.ts`; import grep; `check:runtime`                                             |
| T4.1 | Worker parse/search/screenshot operations with strict validation                      | T3      | Verified | Worker integration tests                    | `tests/native-worker.integration.test.ts`                                            |
| T4.2 | Stream bounded stable `{ pages, text }` JSON/text artifacts                           | T4.1    | Verified | Projection/escaping/byte-limit tests        | `tests/parse-output.test.ts`                                                         |
| T4.3 | Atomic job-owned staging/publication and failure cleanup                              | T4.1    | Verified | Cleanup/preservation tests                  | Parse atomic tests; screenshot preservation integration test                         |
| T4.4 | Bounded search metadata and one-page-at-a-time screenshots                            | T4.1    | Verified | Count/byte/PNG-limit tests                  | Worker boundary tests with fake LiteParse                                            |
| T5.1 | Route all tools through shared executor/signals/internal timeout; no broad sequential | T4      | Verified | Tool tests/runtime import                   | `tests/tools.test.ts`; actual Pi concurrent smoke                                    |
| T5.2 | Bounded parse preview and optional screenshot warning isolation                       | T5.1    | Verified | Tool tests                                  | Parse tool focused test                                                              |
| T5.3 | Bounded search truncation and screenshot inline/path behavior                         | T5.1    | Verified | Tool tests                                  | Search/screenshot focused tests                                                      |
| T5.4 | Distinguish cancellation/timeout/crash/protocol/ordinary errors                       | T5.1    | Verified | Tool and executor tests                     | Error-category tests; actual Pi RPC cancellation smoke                               |
| T6.1 | Remove ImageMagick handling; retain LibreOffice only                                  | T1      | Verified | Dependency tests/grep                       | `tests/deps.test.ts`; source grep                                                    |
| T7.1 | Deterministic fixtures and full policy/executor/worker/tools/deps/metadata suites     | T2–T6   | Verified | `bun run test`                              | 57-test suite                                                                        |
| T7.2 | Cross-platform CI and complete check scripts                                          | T7.1    | Verified | Workflow/config and local Node 22.19 checks | `.github/workflows/ci.yml`; Node 22.19 suite; remote matrix pending GitHub execution |
| T7.3 | Packed-install and package-content smoke tests                                        | T7.1    | Verified | `test:packed`, `test:package`, `pack:dry`   | Isolated real worker install and tarball assertions                                  |
| T7.4 | Manual Pi parse/search/screenshot/concurrency/cancellation/process cleanup smoke      | T1–T7.3 | Verified | Actual Pi print/JSON/RPC smoke              | Three concurrent tool starts/successes; RPC cancellation; no worker remains          |
| T8.1 | README safety/breaking/runtime/contract documentation                                 | T7      | Verified | Stale-claim grep/docs review                | `README.md`                                                                          |
| T8.2 | Skill bounded-page/inline/path/network guidance                                       | T7      | Verified | Skill checklist/manual validation           | `skills/parse-document/SKILL.md`                                                     |
| T8.3 | Unreleased changelog and notices/license review                                       | T7      | Verified | Docs review/package contents                | `CHANGELOG.md`; notice updated to 2.10.1; license unchanged                          |
| F1   | Required format/lint/typecheck plus full plan acceptance commands                     | T1–T8   | Verified | All final commands pass                     | Format/lint/typecheck/57 tests/runtime/packed/Node 22.19/check/diff checks pass      |
| F2   | Final plan-backed independent code review and finding closure                         | F1      | Verified | Reviewer state `Clear`                      | Release gate resolved at 4.0.0; focused closure review `Clear`                       |
| F3   | Final diff hygiene, full-plan reread, cleanup                                         | F2      | Verified | No pending rows/resources                   | Diff/pack hygiene passed; all delegated runs stopped; no worker processes remain     |

## Loop log

| ID     | Owner                                  | Worktree / isolation           | Checks                                 | Review                                      | Cleanup                   |
| ------ | -------------------------------------- | ------------------------------ | -------------------------------------- | ------------------------------------------- | ------------------------- |
| T1     | delegated worker                       | Shared cwd; bounded files      | Metadata/dependency checks             | Parent inspection                           | Run stopped               |
| T2     | delegated worker                       | Shared cwd; bounded files      | Policy tests/lint/typecheck            | Parent inspection                           | Run stopped               |
| T3–T5  | delegated worker + focused fix worker  | Shared cwd; sequential writers | Core/full tests/lint/typecheck/runtime | Independent review; F1/F2 fixed and cleared | All runs stopped          |
| T6     | delegated worker                       | Shared cwd; bounded files      | Dependency tests/grep                  | Parent inspection                           | Run stopped               |
| T7/T8  | two delegated workers, non-overlapping | Package/CI vs docs             | Packed/docs/full checks                | Parent inspection                           | Both runs stopped         |
| Manual | parent                                 | Actual current Pi CLI/RPC      | Parse/search/screenshot/cancel/process | N/A                                         | No Pi/worker process left |

## Reviews

| Checkpoint           | Reviewer                                                    | Findings                                   | Disposition                     | Closure |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------ | ------------------------------- | ------- |
| Plan complexity      | `.reviews/document-parser-stability-hardening-decomplex.md` | DEX-001 internal timeout; DEX-002 no RSS   | Acted                           | Clear   |
| Core T3–T5           | fresh scout subagent                                        | F1 close wait; F2 crash descendant cleanup | Fix now                         | Clear   |
| Final implementation | Fresh code-review subagent                                  | F1 major-version release gate              | User chose 4.0.0; fix validated | Clear   |

## Decisions / deviations

| Item                  | Need / change                                                                     | Evidence                             | Status            |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------ | ----------------- |
| Existing user changes | Preserve `@types/node ^25.9.5`, `oxlint ^1.76.0`, and lockfile updates            | Startup diff and metadata test       | Verified          |
| Public timeout        | No `timeoutMs` schema; one internal 10-minute timeout                             | Complexity review DEX-001            | Accepted          |
| Memory validation     | Deterministic protocol/result/import/process-exit invariants, no RSS threshold    | Complexity review DEX-002            | Accepted          |
| Aggregate inline test | Four pages × 3 MiB per-image equals the 12 MiB aggregate cap; path is unreachable | Implemented limits and worker review | Accepted          |
| Remote CI             | Workflow added; Linux/Windows/macOS GitHub-hosted run cannot be launched locally  | `.github/workflows/ci.yml`           | Report limitation |
| Release version       | Release as next major version `4.0.0`; finalize changelog for 2026-08-03          | User decision and closure review     | Verified          |
