# Handrail execution checklist

This is the release ledger. A checked item means the final tree contains evidence that it passed. Stop-ship gates stay unchecked until verified against the public commit.

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
- [x] Implement AppBinding and product fingerprint preflight.
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
- [x] Install a throwing model stub during replay and prove modelCalls equals zero.
- [x] Phase 3 review: artifact is parameterized, replay needs no key, exceptional states never blindly proceed.

## Phase 4 - human handoff

- [x] Implement control lease epochs, short-lived grants, action mutex, and guarded transitions.
- [x] Create contextual interventions with sanitized reason, step, state, screenshot, and allowed actions.
- [x] Implement the concept-faithful operator console on the live session.
- [x] Map live screenshot clicks to the same Playwright page while operator owns control.
- [x] Support focused typing, key press, evidence capture, and return-to-automation.
- [x] Redact and audit every human action.
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
- [x] Build evidence/manifest.json with run relationships, hashes, provenance flags, and model-call counts.
- [x] Validate every Markdown link, JSON file, hash, image, and requirement mapping.
- [x] Add least-privilege CI for quality, contracts, offline integration, zero-model replay, evidence, security, and clean install.
- [x] Run the documented evaluator path from a clean local clone.
- [x] Phase 6 review: required names/paths/headings are exact and the repository explains itself without oral context.

## Phase 7 - public release

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

## Public release verification

- Repository: <https://github.com/codelit-io/handrail-cua>
- Visibility: the authenticated GitHub view and an unauthenticated GitHub API request both reported `PUBLIC` / `public` with `main` as the default branch.
- Release candidate: commit `e740dc06ecdad3be02f3a34c86373c1a7e47b8fe` passed [GitHub Actions run 33141788185](https://github.com/codelit-io/handrail-cua/actions/runs/33141788185).
- Anonymous verification: a credential-free HTTPS clone of that commit completed `npm ci`, installed Chromium, passed `npm run verify` with 111/111 tests and the 44-file/12-run evidence validator, and completed `demo:offline` with successful discovery, zero-model replay, and `MEMBER_NOT_FOUND` handling.
- Final release: [v0.1.0](https://github.com/codelit-io/handrail-cua/releases/tag/v0.1.0) is the authoritative record for the immutable final commit and final CI URL. It is created only after this ledger commit passes the same public CI and anonymous-clone gates.
- Submission boundary: the email body is prepared in the final handoff with the repository URL on its own line. No email is sent by this workflow.
