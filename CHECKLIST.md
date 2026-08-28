# Handrail execution checklist

This is the release ledger. A checked item means the stated phase produced traceable implementation or evidence. Historical v0.1 publication checks are labeled separately; they do not attest v0.2. The v0.2 stop-ship gates below were closed against the public repository, public CI, and a credential-free clone.

## Phase 0 - requirements and design

- [x] Read and visually inspect all 10 assignment pages.
- [x] Separate assignment content from the user's authorization boundary.
- [x] Freeze the traceable requirements matrix in docs/REQUIREMENTS.md.
- [x] Define the modular-monolith architecture and SurfaceAdapter seam.
- [x] Define the capability artifact, typed value references, result union, target lattice, and linter.
- [x] Define the allowlist, risk, redaction, evidence, and prompt-injection boundaries.
- [x] Define the epoch lease and same-session pause/claim/resume state machine.
- [x] Define the vendor-family artifact, tenant binding, override, and drift model.
- [x] Generate and accept the complete operator-console design concept.
- [x] Freeze the UI inventory, tokens, exact copy, components, and responsive behavior.
- [x] Choose the core demo: synthetic member savings-balance lookup.
- [x] Limit stretch work to a capability catalog and/or replay stability only after the core is green.

## Phase 1 - typed foundation and target surface

- [x] Scaffold Node/TypeScript project with frozen dependencies and clean scripts.
- [x] Implement the hostile iframe/table-based synthetic legacy banking surface.
- [x] Label every displayed record as synthetic and seed deterministic scenarios.
- [x] Implement Zod schemas and generated JSON Schema for artifacts, decisions, policies, bindings, events, interventions, and results.
- [x] Implement canonical serialization, SHA-256 digest, draft/approved registry, and artifact linter.
- [x] Implement AppBinding, product fingerprint preflight, and digest-reviewed replay-only target overrides; reject overrides during discovery.
- [x] Implement explicit origin, route, action, and effect policy enforcement.
- [x] Implement classification-aware recursive redaction and canary scanning.
- [x] Implement correlated JSONL events and evidence file references.
- [x] Unit-test schemas, linter, parameter binding, digest, policy, redaction, and result taxonomy.
- [x] Phase 1 review: typecheck, lint, tests, and no hardcoded discovery value in artifact code.

## Phase 2 - genuine discovery

- [x] Implement BrowserSurface session creation, compact observation, frame traversal, screenshots, and fresh element refs.
- [x] Implement native Ollama and OpenAI-compatible planners with strict structured decisions, bounded retries, and optional screenshot input for configured vision models.
- [x] Reject stale observation IDs, invented refs, unsafe coordinates, unsupported actions, and page prompt injection.
- [x] Execute the bounded observe -> decide -> policy -> act -> verify loop.
- [x] Compile executed input values to typed parameter references.
- [x] Compile ephemeral elements to durable target candidates and semantic fingerprints.
- [x] Verify declared output and checkpoint before saving a capability.
- [x] Run a genuine local LLM discovery against the live synthetic app.
- [x] Commit sanitized live discovery events, screenshots, summary, and generated capability.
- [x] Phase 2 review: `liveModel: true`, `modelCalls > 0`, and no raw transcript, key, base64 image, or sensitive literal committed.

## Phase 3 - deterministic replay and outcomes

- [x] Validate artifact, digest, approval, binding fingerprint, policy, and typed inputs before acting.
- [x] Resolve targets in fixed priority order with exactly-one and fingerprint checks.
- [x] Implement bounded condition waits, retry budgets, known interstitial dismissal, and global sentinels.
- [x] Prohibit automatic retry for non-idempotent and commit effects.
- [x] Extract and validate typed outputs and compound final checkpoint.
- [x] Return succeeded, business_outcome, needs_intervention, or failed without ambiguity.
- [x] Demonstrate fresh-session success replay with a different synthetic input.
- [x] Demonstrate MEMBER_NOT_FOUND as a business outcome.
- [x] Demonstrate transient recovery, permission failure, ambiguity failure, and policy denial.
- [x] Prove the replay module has no planner/model import edge and every replay result/event records `modelCalls: 0`.
- [x] Phase 3 review: artifact is parameterized, replay needs no key, exceptional states never blindly proceed.

## Phase 4 - human handoff

- [x] Implement bearer-capability intervention access, control lease epochs, short-lived operator claims, action serialization, and guarded transitions.
- [x] Create contextual interventions with sanitized reason, step, state, screenshot, and allowed actions.
- [x] Implement the concept-faithful operator console on the live session.
- [x] Map live screenshot clicks to the same Playwright page while operator owns control.
- [x] Support focused typing, key press, evidence capture, and return-to-automation.
- [x] Redact every human action and persist authorization intent plus completion through evaluator audit/capture sinks; fail the lease when a configured sink fails.
- [x] Resume with a fresh observation and current-step postcondition check.
- [x] Reject stale claim, duplicate claim, automation-during-human-control, and stale resume.
- [x] Demonstrate session-expiry pause -> human recovery -> resumed completion with one stable session ID.
- [x] Phase 4 review: the operator surface is intentionally small, while ownership transfer and same-session actions are real.

## Phase 5 - automated and manual QA

- [x] Run format/lint, typecheck, unit, integration, end-to-end, and evidence validation suites.
- [x] Run at least 10 deterministic replays and report success rate and latency.
- [x] Verify page identity, nonblank content, no framework overlay, and clean console.
- [x] Manually exercise discovery, success replay, not found, recovery, hard failure, policy block, and handoff.
- [x] Verify operator UI at 1440 x 900 and a mobile viewport.
- [x] Compare final operator screenshot to docs/design/operator-console-concept.png with `view_image`.
- [x] Complete a five-point fidelity ledger and above-the-fold copy diff.
- [x] Run accessibility smoke checks, keyboard navigation, focus visibility, and reduced motion.
- [x] Capture labeled screenshots with synthetic data only.
- [x] Scan text and image evidence for secrets, tokens, real PII, raw storage, local paths, and redaction canaries.
- [x] Phase 5 review: no fixable functional, visual, accessibility, or evidence defect remains.

## Phase 6 - evaluator documentation and evidence

- [x] Finish README setup, configuration, offline mode, and exact copy-paste demo commands.
- [x] Finish REPORT with the seven exact headings in the required order and roughly 1-3 pages.
- [x] Document all real, synthetic, injected, mocked, designed-only, and cut surfaces honestly.
- [x] Build evidence/README.md as the evaluator index.
- [x] Implement manifest v1.2 generation and validation for source/target/runtime provenance, strict artifact approval, discovery/replay relationships, model-call counts, and same-session handoff audit/capture binding.
- [x] Validate every Markdown link, JSON file, hash, image, and requirement mapping.
- [x] Add least-privilege CI for quality, contracts, offline integration, zero-model replay, evidence, security, and clean install.
- [x] Run the documented evaluator path from a clean local clone.
- [x] Phase 6 review: required names/paths/headings are exact and the repository explains itself without oral context.

## Phase 7 - historical v0.1 public release

- [x] Confirm no repository-name collision and authenticated write access to codelit-io.
- [x] Inspect the exact staged diff and commit only intended project files.
- [x] Scan the complete Git history for secrets and unsafe evidence.
- [x] Create codelit-io/handrail-cua as a public repository and push main.
- [x] Verify GitHub reports PUBLIC visibility while unauthenticated.
- [x] Wait for all CI checks and fix any failure.
- [x] Clone anonymously to a temporary directory and rerun install, tests, evidence validation, and offline demo.
- [x] Record the public URL, release verification sources, and anonymous-clone result in this ledger; record the immutable final commit and CI URL in the GitHub release.
- [x] Prepare the assignment email body with the repository URL on its own line; do not send without separate authorization.
- [x] Keep the active goal open until the public repository, final CI, anonymous clone, and GitHub release record pass.

## Phase 8 - v0.2 submission-readiness audit

- [x] Re-read all 10 assignment pages and reconcile the canonical SDD and requirement trace with the hardened implementation.
- [x] Correct model-data, operator-capability, audit durability, override, malformed-input, and evidence-boundary claims across evaluator documentation.
- [x] Complete the immutable repository security review and close all five validated source findings with focused regressions and independent bypass review.
- [x] Preserve exactly seven required H2 headings in `REPORT.md` and validate all relative Markdown links.
- [x] Commit the final hardened runtime source revision before generating revision-bound evidence (`2ae4515747c49b11ae49dfd6fbd44b730113ab49`).
- [x] Generate and validate a fresh live manifest v1.2 bundle from that exact revision: 51 files, 13 runs, four-decision native Ollama discovery with zero recoveries, and artifact digest `7d630ecefe5e11341b59cba004a66c9e21b531e488c4c382dab6d8ed156a1d58`.
- [x] Complete and attach a same-session handoff run with three manifest-bound operator captures, including byte-distinct states around the recovery click, epochs 1 -> 3 -> 4, 13 operator audit events, a fresh passing checkpoint, and zero model calls.
- [x] Re-run desktop handoff against the exact source; re-inspect the source-unchanged 1440 x 900 and 390 x 844 references, keyboard/accessibility behavior, console listeners, and all 8 unique release images.
- [x] Run lint, typecheck, 228/228 tests, strict evidence validation, both zero-vulnerability dependency audits, targeted tracked-file hygiene checks, and a fresh 10/10 offline evaluator path.
- [x] Publish the evidence refresh through a reviewed PR, wait for green main CI, replace the not-yet-released v0.2.0 candidate tag, and create the immutable GitHub release record.
- [x] Clone public `main` without GitHub credentials and repeat locked installation, Chromium setup, 228/228 tests, strict validation of 51 files/13 runs, and the 10/10 offline demo.
- [x] Exercise a full-history clone of the exact public tag, retain the deliberate shallow-clone failure for unavailable evidence history, and record the post-publication result in GitHub release metadata.

## Public release verification

- Repository: <https://github.com/codelit-io/handrail-cua>
- Historical v0.1 baseline: commit `e740dc06ecdad3be02f3a34c86373c1a7e47b8fe`, [GitHub Actions run 33141788185](https://github.com/codelit-io/handrail-cua/actions/runs/33141788185), and [v0.1.0](https://github.com/codelit-io/handrail-cua/releases/tag/v0.1.0) attest the prior public tree only.
- Superseded v0.2 candidate: `131567b61f86c5ffd83ef839c31764e441bb1073`, merged without squashing through [PR #1](https://github.com/codelit-io/handrail-cua/pull/1) as `175dc614d3d89def523f3ffbc1755748540df127`; [GitHub Actions run 33200810272](https://github.com/codelit-io/handrail-cua/actions/runs/33200810272) passed. An exact-tag smoke later exposed the typed-hash/Luhn false positive, so that unreleased candidate was not submitted.
- Final runtime source basis: `2ae4515747c49b11ae49dfd6fbd44b730113ab49`. The manifest binds this commit's `src/` tree; the release commit adds the validated evidence, validator regression, and documentation without changing that runtime tree.
- Anonymous verification: a credential-free, full-history HTTPS clone of the final public tree passed `npm ci`, Chromium setup, 228/228 tests, real-Chromium E2E, strict validation of 51 files/13 runs, and a newly generated 10/10 zero-model replay smoke with the expected zero-model `MEMBER_NOT_FOUND` outcome.
- Exact-tag verification: a credential-free full-history clone of `v0.2.0` passed the same 228-test, evidence, and offline-smoke gates. The validator deliberately rejects a depth-1 clone until its bound source revision is fetched.
- Release record: [v0.2.0](https://github.com/codelit-io/handrail-cua/releases/tag/v0.2.0) is the immutable public submission record; its metadata names the final tagged revision and verification sources without creating a self-referential commit hash in this file.
- Submission boundary: the email body is prepared in the final handoff with the repository URL on its own line. No email is sent by this workflow.
