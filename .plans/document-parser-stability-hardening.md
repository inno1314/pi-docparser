# Harden document parsing against native crashes and resource exhaustion

> **Status:** Ready for implementation

## Outcome and boundaries

- **Problem and target:** LiteParse 2.0.1 runs PDFium/Tesseract in Pi’s process, concurrent tool calls can corrupt PDFium state, and unbounded parsing, screenshots, and serialization can terminate Pi. Move every native call behind one serialized child-process boundary, upgrade to a fixed LiteParse release, and enforce explicit resource budgets so failures become tool errors instead of Pi crashes.
- **In scope:** `document_parse`, `document_search`, `document_screenshot`, shared input/configuration/dependency handling, package/runtime metadata, native worker protocol, timeout/abort/crash handling, stable JSON output, tests, README/skill/changelog updates.
- **Out of scope:** machine-wide locking across independent Pi processes; changing LiteParse internals; resumable parsing; persistent output outside the existing temp-artifact model; arbitrary OS memory limits; automatic cleanup of successful artifacts; new output formats such as Markdown.
- **Approach:** test against Pi 0.83 on Node 22.19, pin mature LiteParse 2.10.1 containing its global PDFium lock, and route each native operation through one extension-owned FIFO executor that launches a fresh plain-JavaScript Node worker. The worker writes bounded artifacts and returns only bounded metadata; the parent never loads LiteParse or receives full parse/image payloads. Do not use Pi’s broad `executionMode: "sequential"`: the executor serializes only native document work instead of unrelated sibling tools.

## Key files, evidence, and decisions

| File or source                                                                                                                                                                      | Why it matters                                                                                                                                                                              | Decision or plan impact                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`                                                                                                                             | LiteParse is pinned to affected `2.0.1`; Pi dev/peer packages are `0.74.0`; the workspace enforces a three-day release age.                                                                 | Pin mature LiteParse `2.10.1` now; upgrading to 2.11.0 after its age gate is a separate maintenance change. Use Pi dev packages `0.83.0`, core peer ranges `"*"`, and Node `>=22.19.0`. Preserve the user-owned `@types/node`/`oxlint` changes already present in the manifest and lockfile. |
| LiteParse [PR #280](https://github.com/run-llama/liteparse/pull/280) and commit [`d7ccc5e`](https://github.com/run-llama/liteparse/commit/d7ccc5e58cdf092cf55166ee0f9c441be01517b4) | Upstream confirms PDFium is not thread-safe and adds the process-global lock missing from 2.0.1.                                                                                            | Dependency upgrade is mandatory, but remains defense-in-depth rather than the crash-containment boundary.                                                                                                                                                                                    |
| `extensions/docparser/tool.ts`, `search-tool.ts`, `screenshot-tool.ts`                                                                                                              | All three currently instantiate LiteParse in Pi; parse performs whole-result `JSON.stringify`, and screenshots return every PNG as base64.                                                  | Remove direct native imports/calls; pass the one executor created by `index.ts` into each registration function and consume only bounded worker results/artifacts.                                                                                                                           |
| `extensions/docparser/liteparse-module.ts`                                                                                                                                          | Caches the native module in Pi’s long-lived process.                                                                                                                                        | Delete it after the worker owns the only LiteParse import.                                                                                                                                                                                                                                   |
| `extensions/docparser/input.ts`, `schema.ts`, `liteparse-config.ts`, `constants.ts`                                                                                                 | Page syntax is permissive/eagerly expanded; page/worker/DPI/result limits are absent or unsafe.                                                                                             | Centralize strict limits and reject invalid/oversized requests before worker launch; never silently clamp.                                                                                                                                                                                   |
| `extensions/docparser/deps.ts`, `doctor.ts`, `types.ts`                                                                                                                             | The extension still requires and installs ImageMagick for images.                                                                                                                           | Remove ImageMagick integration; LiteParse 2.8+ handles image conversion natively. Keep LibreOffice for Office-family conversion.                                                                                                                                                             |
| Pi 0.83 extension types, runner, and package docs                                                                                                                                   | Core package peers should use `"*"`; Pi 0.83 requires Node 22.19; `session_shutdown` is awaitable. Pi’s sequential tool mode serializes an entire sibling batch, including unrelated tools. | Use 0.83 as the development/test baseline and register executor disposal on `session_shutdown`, but keep peer ranges `"*"` and rely on the document-only FIFO rather than broad host scheduling.                                                                                             |
| `README.md`, `skills/parse-document/SKILL.md`, `CHANGELOG.md`                                                                                                                       | Public behavior currently promises 1000-page defaults, all-page screenshots, raw upstream JSON, ImageMagick, and Node 20.6.                                                                 | Document the breaking limits, isolation semantics, stable JSON contract, timeout behavior, native image support, and major-version impact.                                                                                                                                                   |

- **Resource policy:** default/hard `maxPages` 100/1000, measured as pages parsed/selected rather than highest sparse page number; OCR workers `min(4, max(1, availableParallelism() - 1))` with hard maximum 8; DPI 150 with range 72–300; search results 50 with maximum 200; nonblank search phrase maximum 4 KiB UTF-8; page-selection input maximum 16 KiB UTF-8, 1000 tokens, 1000 pre-dedup expansion work, and page numbers `1..2^32-1`; screenshots default to page 1 with at most four explicit pages and reject `all`/`*`; internal worker timeout 10 minutes; request/response frames 64 KiB/1 MiB; retained stderr tail 64 KiB; parsed artifact 256 MiB; saved PNG 25 MiB each/64 MiB per job; inline PNG 3 MiB each/12 MiB raw total. All byte limits count encoded UTF-8 or raw file bytes as applicable.
- **Compatibility decision:** preserve `document_parse` JSON as a versioned project-owned `{ pages, text }` contract. Each page contains `pageNum`, `width`, `height`, `text`, and `textItems`; each text item keeps `text`, `x`, `y`, `width`, `height`, and optional `fontName`, `fontSize`, and `confidence`. Do not expose new upstream `markdown`, `images`, `imageErrorCount`, or metadata fields implicitly.
- **Release decision:** the Node floor, safer defaults, removal of all-page screenshots, bounded details, and stable projected JSON are breaking changes; release as the next major version.
- **Open gate:** None. LiteParse 2.10.1 is mature under the current policy and contains the confirmed PDFium lock; 2.11.0 is deliberately deferred until a later dependency-only change after its age gate.

## Tasks

#### T1 — Upgrade the supported runtime and native dependency

- **Change:**
  - Before dependency work, capture `git status --short` and `git diff -- package.json pnpm-lock.yaml`; never reset, checkout, clean, or overwrite the current user-owned changes. Repository formatting may normalize those files, so preservation is judged by the original dependency values/resolutions plus the planned edits, not byte-identical diffs.
  - Pin `@llamaindex/liteparse` to exact `2.10.1`.
  - Set `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` dev dependencies to exact `0.83.0`, their peer ranges to `"*"`, and `engines.node` to `>=22.19.0`; this is the development/runtime baseline, while `"*"` follows Pi’s core-package resolution policy rather than promising every historical Pi version.
  - Add `tsx` as a dev dependency for the Node test runner, add unit/native/packed-install scripts, include tests in `check`, and enable `allowJs`/`checkJs` so `tests/**/*.ts` and all runtime `.mjs` modules are typechecked.
  - Regenerate `pnpm-lock.yaml`, preserving `@types/node: ^25.9.5`, `oxlint: ^1.76.0`, and their existing lockfile updates.
- **Starts at:** `package.json`; `pnpm-lock.yaml`; `tsconfig.json`; `pnpm-workspace.yaml` (policy evidence only; do not change it).
- **Verify:**
  - Run `git status --short && git diff -- package.json pnpm-lock.yaml` before and after installation; expect the original tool-version updates to remain plus only planned dependency/script changes.
  - Run `pnpm install`; expect successful resolution without a release-age exception.
  - Run `pnpm list @llamaindex/liteparse @earendil-works/pi-ai @earendil-works/pi-coding-agent --depth 0`; expect `2.10.1`, `0.83.0`, and `0.83.0`.
  - Run `node -e "const p=require('./package.json'); if(p.dependencies['@llamaindex/liteparse']!=='2.10.1'||p.devDependencies['@types/node']!=='^25.9.5'||p.devDependencies.oxlint!=='^1.76.0'||p.peerDependencies['@earendil-works/pi-ai']!=='*'||p.peerDependencies['@earendil-works/pi-coding-agent']!=='*'||p.engines.node!=='>=22.19.0') process.exit(1)"`; expect exit 0.
- **Tests:** Add a package-metadata test protecting the exact LiteParse/dev baseline, Pi peer policy, Node floor, and preserved user-owned dependency versions.
- **Risk/recovery:** Do not weaken the supply-chain age policy or claim 2.11 behavior while the lockfile selects 2.10.1.

#### T2 — Centralize and enforce resource/input policy

- **Change:**
  - Replace CPU-minus-one defaults with `availableParallelism()` capped at four; define named defaults and maxima for pages, workers, DPI, results, screenshots, output bytes, IPC bytes, and inline PNG bytes, plus one internal 10-minute worker timeout.
  - Add schema maxima to all three tools; add `maxPages` to `document_search`; cap phrase length to keep search responses bounded.
  - Rewrite `parsePageSelection` to reject inputs over 16 KiB UTF-8 before splitting, then validate complete decimal/range tokens. Reject empty segments, signs, decimals, junk suffixes, zero, page numbers above `2^32-1`, descending/multi-hyphen ranges, more than 1000 tokens, and more than 1000 pages of expansion work before deduplication; apply the caller’s lower count limit afterward.
  - Normalize and validate `targetPages` against the effective selected-page count budget before passing it to LiteParse; sparse page numbers do not consume intermediate-page budget.
  - Reject blank search phrases and phrases over 4 KiB UTF-8 before worker launch.
  - Default `document_screenshot` to page 1; require explicit, at-most-four pages for other screenshot requests; reject `all` and `*` in both screenshot entry points with guidance to make bounded repeated calls.
  - Require `resolveDocumentTarget` inputs to resolve to readable regular files; allow symlinks that resolve to regular files and reject directories, FIFOs, sockets, and devices before native work.
- **Starts at:** `extensions/docparser/constants.ts`; `schema.ts:DocumentParseSchema`; `input.ts:ensureReadableFile`, `parsePageSelection`, `resolveScreenshotSelection`; `liteparse-config.ts:buildLiteParseConfig`; schemas in `search-tool.ts` and `screenshot-tool.ts`.
- **Depends on:** T1.
- **Verify:**
  - Run `bun run test -- tests/input-policy.test.ts tests/config-policy.test.ts`; expect all valid boundary cases to pass and malformed/over-budget cases to reject without iterating huge ranges.
  - Run `bun run typecheck`; expect TypeBox-derived parameters and LiteParse config types to compile.
- **Tests:** Cover deduplication/sorting, exact byte/token/expansion/page-number boundaries, huge and duplicate-heavy ranges, oversized multibyte selections/phrases, blank phrases, malformed tokens, selected-page budgets, screenshot defaults/rejections, all schema maxima, regular files, symlink-to-file, and directory rejection.
- **Risk/recovery:** Reject rather than clamp so callers are never told a partial result is complete. Do not add a universal source-file byte cap without format-specific evidence.

#### T3 — Add one serialized, abortable native-process executor

- **Change:**
  - Implement `NativeExecutor`/`createNativeExecutor` as a fair FIFO. `parseDocumentExtension` creates exactly one instance per extension activation, passes it explicitly to all three `registerDocument*Tool` functions, and registers an awaited `pi.on("session_shutdown", ...)` disposal before a reload/new session can activate another instance.
  - Launch one fresh `native-worker.mjs` child per native operation with `spawn(process.execPath, ...)`, a URL relative to `import.meta.url`, sanitized `execArgv`, a detached POSIX process group, and no inherited protocol stdout. A plain `.mjs` worker is mandatory because Node refuses type stripping for `.ts` beneath installed `node_modules`.
  - Exchange one versioned request and one response over dedicated length-prefixed pipes, not Node object IPC. Reject a request over 64 KiB, a declared/received response over 1 MiB, trailing frames, version/operation mismatches, and invalid decoded data before use. Drain stdout; retain only the final 64 KiB of stderr. Send passwords only through the request pipe, never argv/environment.
  - Keep all LiteParse imports inside the worker and delete `liteparse-module.ts` once parent modules no longer import it.
  - Define race precedence: timeout starts only after FIFO activation; queued abort removes the entry without spawn; success requires one valid matching response, exit code 0, and `close`; abort/timeout initiated before clean close wins; the slot releases only after teardown confirmation.
  - On abort/timeout/disposal or any protocol failure before root exit, POSIX sends `SIGTERM` to the negative process-group PID, waits two seconds, sends `SIGKILL`, then probes the group; Windows runs `taskkill /PID <pid> /T /F` while the root lives and waits for both command/root close. If teardown is still uncertain after five seconds, poison/dispose the executor and reject queued/future work. A native crash may end the Windows root before `taskkill` can address its descendants; report the crash and treat orphaned converter cleanup as best effort rather than adding a new native Job Object dependency.
  - Job cleanup removes only job-owned staging paths/listeners/timers. It must never remove a caller-owned output directory or an artifact atomically published by an earlier job.
- **Starts at:** add checked runtime `extensions/docparser/native-protocol.mjs`, typed parent `native-executor.ts`, and executable `native-worker.mjs`; delete `extensions/docparser/liteparse-module.ts`; update `index.ts:parseDocumentExtension` and all three registration function signatures. Every module imported by the worker must be `.mjs` so the packed install never imports project `.ts` beneath `node_modules`.
- **Depends on:** T1, T2.
- **Verify:**
  - Run `bun run test -- tests/native-executor.test.ts`; expect FIFO ordering, no overlap, queued/active abort, timeout, process-tree removal, abnormal exit, malformed/oversized/trailing response, cleanup ownership, disposal, and post-failure behavior tests to pass with no live child processes.
  - Run `grep -R "@llamaindex/liteparse" extensions/docparser --exclude=native-worker.mjs --exclude=types.ts`; expect no runtime LiteParse import outside the worker (a type-only import in `types.ts` is acceptable).
- **Tests:** Use an injectable worker URL with a fake `.mjs` worker that logs overlap, delays, spawns a long-lived grandchild, emits malformed/oversized frames, exits abnormally, and aborts itself. Assert abort/timeout removes root and grandchild on every CI OS; separately assert a simulated native crash becomes a rejected job while the parent remains alive and later work follows the executor’s clean/poisoned state.
- **Risk/recovery:** Serialization is per extension activation/Pi process, with awaited shutdown preventing reload overlap. Cross-process lockfiles and persistent workers add stale-state/lifecycle complexity without protecting Pi better; worker threads cannot contain native faults.

#### T4 — Implement bounded worker operations and stable artifact writing

- **Change:**
  - Implement worker operations for parse, search, and screenshot with strict protocol validation and absolute parent-supplied job staging paths.
  - For text output, write UTF-8 aggregate text in fixed chunks with backpressure and stop before the 256 MiB artifact budget.
  - For JSON output, emit compact UTF-8 with fixed field order and count every syntax/escape byte toward 256 MiB. Stream the stable `{ pages, text }` projection page-by-page; retain only approved fields, require finite required page/item numbers, omit absent/non-finite optional numbers, and match `JSON.stringify` escaping for control characters and lone surrogates without splitting surrogate pairs.
  - Each job writes only beneath its own staging directory. Write files as `.partial`, atomically rename files/directories after success, and remove only that job’s staging data on failure. A screenshot job cannot delete a completed parse artifact or its caller-owned output directory.
  - A parse response returns only page count/output bytes. Perform `searchItems` in the worker and return at most 200 hits under the 1 MiB response budget, reporting count/byte truncation.
  - Render at most four requested screenshots one page at a time so LiteParse does not retain a four-page result array. Reject a PNG over 25 MiB or a job over 64 MiB before publishing its staging directory; return only bounded path/size/dimension metadata—never buffers or base64 over the response pipe.
- **Starts at:** `extensions/docparser/native-worker.mjs`; `native-protocol.mjs`; add checked runtime `extensions/docparser/parse-output.mjs` for streaming/projection. The worker must import only `.mjs` project modules plus published JavaScript dependencies.
- **Depends on:** T3.
- **Verify:**
  - Run `bun run test -- tests/parse-output.test.ts tests/native-worker.integration.test.ts`; expect exact JSON projection/escaping, output-budget cleanup, bounded search, and parse/screenshot success on committed small fixtures.
  - Run `node --test tests/native-worker.integration.test.ts`; expect the real LiteParse worker to parse and screenshot the fixture without loading native code in the parent.
- **Tests:** Deep-compare parsed streamed JSON with a reference projector; protect fixed order, UTF-8/control/lone-surrogate escaping, surrogate-pair chunk boundaries, finite-number policy, omission of upstream-only fields/buffers, byte counting including syntax/escapes, job-owned atomic cleanup, parse preservation after screenshot failure, search count/byte limits, per-file/aggregate PNG limits, one-page-at-a-time rendering, and real LiteParse parse/screenshot behavior.
- **Risk/recovery:** LiteParse still materializes its native result inside the child. A worker can still OOM, but the executor must report its death without terminating Pi or publishing partial artifacts.

#### T5 — Route all tools through the executor and bound Pi-facing results

- **Change:**
  - Accept the one shared `NativeExecutor` explicitly in all three registration functions; tests may supply a fake executor. Leave Pi `executionMode` unset so unrelated sibling tools can still run in parallel while the executor serializes native document jobs.
  - Replace direct LiteParse calls in `document_parse` with a parse worker job; read only the existing 20-line/2 KiB preview from the saved artifact, not the complete output.
  - Run optional parse screenshots as a separate serialized worker job with its own staging directory so a screenshot crash/timeout removes only screenshot partials, remains a warning, and preserves completed parse output.
  - Replace direct parsing/searching in `document_search` with the worker’s bounded hits and carry explicit count/byte truncation into content/details.
  - Replace direct screenshot buffers in `document_screenshot` with worker metadata. Read/base64 only files at or below 3 MiB each and stop at 12 MiB raw total; keep omitted images available by path and return an explicit warning. Details contain at most four metadata entries.
  - Pass the Pi `AbortSignal` to every job and apply the shared internal timeout; preserve pre-start cancellation messages and distinguish cancellation, timeout, signaled/native crash, protocol error, and ordinary parse error.
- **Starts at:** `extensions/docparser/tool.ts:registerDocumentParseTool`, `renderScreenshots`; `search-tool.ts:registerDocumentSearchTool`; `screenshot-tool.ts:registerDocumentScreenshotTool`; `types.ts` detail types; `index.ts` registration.
- **Depends on:** T4.
- **Verify:**
  - Run `bun run test -- tests/tools.test.ts`; expect all definitions to share the injected fake executor, native jobs to serialize while unrelated fake tool work is unaffected, validated budgets/signals to reach the executor, and all Pi-facing result sizes/details to remain bounded.
  - Run `bun run check:runtime`; expect extension import/registration without loading LiteParse’s native module in Pi; worker availability is verified by the native integration and packed-install tests, not this import check.
- **Tests:** Cover concurrent calls across all tool kinds, parse success plus optional-screenshot failure, pre-start and active cancellation, timeout/crash messages, bounded previews/hits/details, per-image and aggregate inline-image omission, and cleanup of failed temp directories.
- **Risk/recovery:** Returning fewer inline images and rejecting all-page screenshots are intentional breaking changes; every omitted image remains discoverable by its saved path.

#### T6 — Remove obsolete ImageMagick dependency handling

- **Change:**
  - Narrow `DependencyName`, package-manager mappings, doctor diagnostics/install strategies, setup-error recognition, and relevant-dependency logic to LibreOffice only.
  - Keep image classification, but make image inputs require no external preflight dependency under LiteParse 2.8+.
  - Remove ImageMagick-specific friendly-error branches and install instructions while preserving generalized doctor behavior for Office-family documents.
- **Starts at:** `extensions/docparser/types.ts:DependencyName`; `deps.ts:DEPENDENCY_NAMES`, `PACKAGE_NAMES`, `DEPENDENCY_METADATA`, `getRelevantDependencyNames`; `doctor.ts`; friendly-error functions in all tool modules.
- **Depends on:** T1.
- **Verify:**
  - Run `bun run test -- tests/deps.test.ts`; expect Office/spreadsheet inputs to select LibreOffice and image/PDF inputs to select no host dependency.
  - Run `grep -Rni "imagemagick" extensions README.md skills/parse-document`; expect no matches; historical `CHANGELOG.md` entries may remain.
- **Tests:** Protect dependency relevance, missing-LibreOffice guidance, platform install strategies, and native image input reaching the worker without an ImageMagick preflight error.

#### T7 — Complete regression, packaging, and manual validation

- **Change:**
  - Add committed minimal PDF/image fixtures and flat `tests/*.test.ts` suites for policy, executor, worker, tool registration/results, dependencies, and package metadata.
  - Extend `check` so formatting check, lint, typecheck, unit/integration tests, runtime import, and worker/package assertions run in CI; keep the repository’s mandatory Bun validation commands.
  - Add `.github/workflows/ci.yml` with Node 22.19 Linux, macOS, and Windows jobs covering unit tests, real LiteParse fixtures, nested-process abort/timeout cleanup, direct-worker native-crash containment, and package smoke tests.
  - Ensure the tarball includes `native-worker.mjs` and runtime modules. Add an isolated `npm pack` → install beneath a temporary `node_modules` → real worker parse smoke test so Node’s dependency TypeScript restriction is exercised; exclude test suites/non-runtime fixtures from the published package.
  - Exercise a real concurrent batch through the shared executor and verify deterministic memory-boundary invariants: one active worker, bounded protocol/results, no native module in the parent, and worker/process-tree exit after each operation.
- **Starts at:** add `tests/*.test.ts`, `tests/fixtures/*`, `.github/workflows/ci.yml`; `package.json` scripts/files; `tsconfig.json` `allowJs`/`checkJs` and includes.
- **Depends on:** T1–T6.
- **Verify:**
  - Run `bun run format`; expect formatting to complete with no unintended file rewrites.
  - Run `bun run lint`; expect zero findings.
  - Run `bun run typecheck`; expect zero TypeScript errors.
  - Run `bun run test`; expect all unit and native integration tests to pass.
  - Run `bun run check:runtime`; expect successful parent extension import/registration only.
  - Run `bun run test:packed`; expect a packed package installed under temporary `node_modules` to execute a real worker parse without `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
  - Run `bun run pack:dry`; expect all worker runtime files, README, skill, notices, and licenses in the tarball and no test suite.
  - Run `npx --yes node@22.19.0 --import tsx --test tests/*.test.ts`; expect the focused minimum-runtime run to pass.
  - Run the GitHub Actions Node 22.19 Linux/macOS/Windows matrix; expect process-tree and packed-install checks to pass on every OS.
  - Run `git diff --check`; expect no whitespace errors, and compare final status/manifest/lockfile diffs with T1’s baseline to confirm the original `@types/node`/`oxlint` changes remain.
  - Manually load the extension with current Pi, parse/search/screenshot the committed fixture, issue parallel document calls, cancel one active call, and verify Pi remains alive, later calls still work, outputs are bounded, and no worker remains in the local process list afterward.
- **Risk/recovery:** Native tests must use small deterministic fixtures and fixed timeouts. No supported CI OS may skip root/grandchild teardown for controlled abort/timeout or packed-install execution. On Windows, a converter orphaned by an instantaneous native root crash remains a documented best-effort cleanup limitation; Pi crash containment does not depend on that descendant.

#### T8 — Document the breaking safety contract and release impact

- **Change:**
  - Update README requirements, examples, JSON contract, limits/defaults, timeout/cancellation behavior, child-process crash containment, screenshot page-1 default/four-page cap, output paths, and native image conversion.
  - Update the bundled `parse-document` skill to request small page ranges, avoid `all`, explain bounded inline images and saved-path follow-up, and qualify local OCR language-data downloads instead of claiming unconditional zero network access.
  - Add an Unreleased changelog section separating breaking changes, fixes, dependency/runtime upgrades, and tests; leave historical changelog entries unchanged and record the exact 2.10.1 upgrade without claiming 2.11 features.
  - Check third-party notices/license references for version-specific wording; retain the existing LiteParse license material unless upstream licensing changed.
- **Starts at:** `README.md`; `skills/parse-document/SKILL.md`; `CHANGELOG.md`; `THIRD_PARTY_NOTICES.md`; `licenses/`.
- **Depends on:** T1–T7.
- **Verify:**
  - Run `grep -RniE "Node.js 20|default.*1000|defaults to all|ImageMagick" README.md skills/parse-document`; expect no stale behavior claims.
  - Run `bun run check && bun run pack:dry`; expect all checks and package-content validation to pass.
- **Tests:** Package/docs assertions should verify documented constants match exported policy values where practical, avoiding duplicated magic-number tests.

## Final acceptance

- **Checks:** `bun run format`; `bun run lint`; `bun run typecheck`; `bun run test`; `bun run check:runtime`; `bun run test:packed`; `bun run pack:dry`; `npx --yes node@22.19.0 --import tsx --test tests/*.test.ts`; Linux/macOS/Windows CI matrix; `git diff --check`; manual Pi parse/search/screenshot/concurrency/cancellation smoke test.
- **End state:** Pi never imports LiteParse’s native module. Every native operation runs in a fresh child serialized within the extension activation, with bounded requests/results/artifacts, timeout/abort handling, atomic publication, and abnormal-exit reporting. Inputs and resource knobs have strict maxima; JSON and screenshots cannot create unbounded parent-process serialization; LiteParse 2.10.1 and the Pi 0.83 development baseline are validated; ImageMagick is no longer required; tests reproduce the previously unsafe concurrency/cancellation/crash boundaries.
- **Deferrals or blockers:** No implementation blocker. A worker may still exhaust its own memory because LiteParse materializes native results; process isolation contains that failure. LiteParse 2.11+, machine-wide coordination, successful-artifact garbage collection, OS-specific memory limits, and guaranteed Windows descendant cleanup after an instantaneous worker crash remain separate future work.
