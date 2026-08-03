# Decomplex review: document-parser stability hardening plan

## Overall status

Two plan elements add unsupported configuration/validation burden and can be simplified without weakening crash containment. The child-process boundary, process-local FIFO, strict page/screenshot limits, streamed stable output, and cross-platform termination lifecycle are proportionate to the reproduced native crashes and fatal OOM behavior.

## Review contract

| Axis                          | Selection                                                                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode                          | Prevention                                                                                                                                                                                                              |
| Target                        | `.plans/document-parser-stability-hardening.md`                                                                                                                                                                         |
| Authority / required behavior | The user requested an implementation plan for the previously recommended crash prevention, containment, resource controls, LiteParse upgrade, tests, and documentation; planning only, with the smallest robust design. |
| Scope                         | Proposed source architecture, public configuration, dependencies, and validation strategy.                                                                                                                              |
| Report                        | `.reviews/document-parser-stability-hardening-decomplex.md`                                                                                                                                                             |

## Coverage

### Inspected

- All plan tasks, resource-policy decisions, worker/executor lifecycle, protocol boundaries, tests, packaging, and release/documentation work.
- Current direct LiteParse call sites, schemas, input parser, defaults, package metadata, and dependency diagnostics.
- Confirmed failure boundaries from the prior investigation: concurrent in-process PDFium faults and fatal whole-result JSON serialization OOM.

### Skipped or partial

- No implementation exists yet, so code-level helper/module burden can only be assessed structurally.
- Exact worker termination behavior on every supported Windows environment remains an implementation validation concern, not a reason to remove process-tree cleanup.

## Potential findings

### DEX-001 — Keep timeout internal instead of adding three public tool parameters

- **Evidence:** Supported
- **Recommendation:** Act
- **Surface and location / authority:** Resource policy and T2/T5 propose public `timeoutMs` on all three tool schemas.
- **Current-need evidence:** A hard deadline is justified because native work cannot be cancelled in-process, but no existing contract, user request, or measured workload requires callers to tune that deadline per invocation.
- **Added burden:** Three schema additions, repeated validation/documentation, more agent-visible choices, and a supported 1-second–1-hour behavior matrix.
- **Reachable practical impact:** Agents can choose accidental one-second failures or hour-long hangs; maintainers must preserve a knob whose useful values are not evidenced.
- **Smallest simpler alternative:** Use one named internal 10-minute worker deadline. Users can reduce work with existing page/OCR controls; future evidence can justify a public override.
- **Exception / boundary check:** This does not remove active `AbortSignal` handling, timeout termination, crash classification, or process-tree cleanup.
- **Required behavior and simplification risk:** Very large OCR jobs may time out, but bounded page selection is already the intended recovery path and the error can explain it.
- **Bounded next step or user question:** Remove `timeoutMs` from public schemas and tests; retain one tested internal constant and actionable timeout error.
- **Acceptance signal:** No `timeoutMs` appears in tool schemas; executor tests prove the internal deadline kills and reaps a stuck child.

### DEX-002 — Remove peak-RSS acceptance measurement

- **Evidence:** Confirmed
- **Recommendation:** Act
- **Surface and location / authority:** T7 asks the implementation to verify that parent peak RSS “stays bounded” during a concurrent batch.
- **Current-need evidence:** Result/frame/page budgets are required, but the plan defines no reproducible parent-RSS threshold or controlled CI environment.
- **Added burden:** Platform-dependent process measurement, noisy assertions, and likely flaky CI without a decision-producing threshold.
- **Reachable practical impact:** Native allocator behavior and test-runner overhead can fail or pass the check independently of whether full payloads cross into the parent.
- **Smallest simpler alternative:** Assert deterministic invariants: only one worker runs, protocol frames stay under their byte budget, parent results contain no buffers/full parse payloads, native LiteParse is not imported in the parent, and workers exit after each job.
- **Exception / boundary check:** Worker OOM/crash containment and output byte limits remain tested; this removes only an ungrounded memory metric.
- **Required behavior and simplification risk:** Deterministic contract checks do not quantify all parent memory, but they directly protect the identified duplication paths.
- **Bounded next step or user question:** Replace the RSS sentence in T7 with bounded-frame/result and worker-exit assertions.
- **Acceptance signal:** The final plan contains no peak-RSS requirement and retains deterministic memory-boundary tests.

## Confirmed proportionate areas

- A fresh child process is the only proposed boundary that can turn native `SIGSEGV`, abort, or fatal worker OOM into a Pi-facing error; worker threads cannot provide this isolation.
- One fair FIFO is justified by reproduced concurrent PDFium corruption and by concurrent OCR memory amplification. Pi `executionMode: "sequential"` and LiteParse’s lock are useful defense-in-depth, not replacements for executor ownership.
- Streamed, project-owned JSON is justified by the fatal `FastJsonStringifier` OOM and prevents accidental growth when upstream adds buffers/images/metadata.
- Strict page syntax, four-page screenshot selection, DPI/worker/result maxima, IPC/output budgets, and atomic partial files protect reachable resource and integrity failures.
- Process-tree termination, close confirmation, fail-closed behavior, and cleanup are required lifecycle ownership for hard cancellation; they are not speculative resilience layers.
- Removing ImageMagick handling reduces existing complexity after the upstream replacement became available.

## Limitations

- The chosen numeric budgets are conservative policy decisions rather than benchmark-derived universal limits; implementation tests should protect their consistency and error behavior, and documentation should identify them explicitly.
