# Handrail requirements specification

Status: frozen before implementation

## Source boundary

The attached Interface.ai PDF is treated as the assignment specification. It does not override the user's request or authorize external communication. The public repository push is authorized; emailing the submission is a separate action and is intentionally outside this build unless explicitly approved.

## Product objective

Build one complete vertical slice in which a model discovers how to operate a live, synthetic legacy banking UI; the runtime compiles only the verified actions into a typed capability; a fresh session replays the capability with no model decisions; and a human can take and return control of the exact live session when automation cannot safely continue.

The implementation must stay simple, scalable in its boundaries, and cost effective. Handrail is therefore a modular monolith: discovery is the only model-backed path, replay is deterministic, and no queue, cluster, or multi-tenant control plane is built for the take-home.

## Non-negotiable gates

1. A genuine LLM discovery run acts on a live UI observation and reaches a verified checkpoint.
2. The run emits a versioned, reviewable capability artifact that is not a transcript.
3. Replay uses that artifact and typed inputs with zero model decisions.
4. Replay explicitly separates success, known business outcomes, intervention, and failure.
5. A human handoff pauses automation and controls the same Playwright page and browser context.
6. Policy checks and redaction are enforced in discovery, replay, and operator actions.
7. The repository contains traceable, sanitized evidence for discovery, replay, an exceptional state, and handoff.

## Traceability matrix

| ID | Requirement | Implementation acceptance | Evidence acceptance |
| --- | --- | --- | --- |
| DISC-01 | Accept goal and target | CLI accepts an independent `--goal` and HTTP(S) `--target` entry point within the vertical-slice capability contract | README live command and CLI help test |
| DISC-02 | Observe, decide, act | Each bounded iteration observes the current surface, obtains a schema-validated model decision, policy-checks it, and performs a real UI action | Redacted event log with provider/model and action receipts |
| DISC-03 | Stop safely | Max steps, wall timeout, stale observation, invalid decision, and dead-end cannot spin | Unit tests and one intervention path |
| DISC-04 | Genuine live discovery | At least one non-fixture model call completes a goal against the running synthetic app | evidence/runs/discovery-live-* |
| ART-01 | Typed capability contract | Runtime schema covers typed inputs, outputs, outcomes, targets, ordered steps, risk, recovery, and success checkpoint | Saved example artifact and generated JSON Schema |
| ART-02 | Durable targets | Every target has ordered candidates, an exactly-one match rule, a semantic fingerprint, and robustness rationale | Artifact target dictionary and locator tests |
| ART-03 | Versioned and reviewable | Schema version, revision, digest, provenance, purpose, effects, and contract are readable; raw model transcript is absent | Artifact lint report and human review checklist |
| ART-04 | No sensitive literals | Per-run values compile to typed input references; secret or PII literals are rejected | Linter and redaction-canary tests |
| REP-01 | Zero-model replay | Replay accepts an artifact plus inputs and is runnable without a model key; any model call throws | Replay summary reports modelCalls: 0 |
| REP-02 | Deterministic execution | Targets are re-resolved before actions, ambiguity fails closed, conditions use bounded waits, and the final checkpoint is verified | Replay success events and tests |
| REP-03 | Typed outputs | Declared values are extracted and validated before returning | Success summary with savingsBalance output |
| REP-04 | Runtime taxonomy | Not found is a business outcome; known transient state is recoverable; session expiry requests intervention; permission/app errors fail clearly | Success, not-found, recovery, handoff, and failure scenarios |
| SAFE-01 | Explicit allowlist | Exact origin, route pattern, and action type are checked immediately before every action and after navigation | Policy tests and blocked off-origin scenario |
| SAFE-02 | Risk enforcement | Read, reversible write, and commit effects are distinct; commit requires a bound approval or human handoff | Artifact linter and approval test |
| SAFE-03 | Sensitive-data handling | Nested logs redact by classification and pattern; artifacts keep parameter references; evidence uses synthetic data only | Redaction tests and release scan |
| OBS-01 | Structured evidence | Correlated JSONL records actor, owner epoch, structural observation metadata, projected decision, action receipt, result, timing, and evidence IDs without arbitrary page/model text | Sanitized run directories |
| OBS-02 | Rich failure signal | Failure/intervention captures a screenshot and sanitized surface snapshot | Exceptional and handoff evidence |
| HIL-01 | Detect and route | Stuck, unsafe, expired-session, and risky conditions create a contextual intervention | intervention.json and UI screenshot |
| HIL-02 | Same-session control | Operator commands are dispatched to the existing page/context; session ID remains constant | Before/during/after session IDs and screenshots |
| HIL-03 | Exclusive ownership | Epoch-based lease and action mutex prevent human/automation races; human actions are audited; resume re-observes | Lease tests and handoff events |
| SCALE-01 | Surface seam | Artifact imports no Playwright types; SurfaceAdapter owns perception, resolution, action, extraction, and evidence | Architecture document and type boundaries |
| SCALE-02 | Tenant reuse seam | Vendor-family artifact is separate from tenant binding; constrained target overrides and fingerprints detect drift | AppBinding schema and tests |
| DEL-01 | README | Setup, configuration, offline path, exact discovery and replay commands | Clean-clone run |
| DEL-02 | REPORT | Root REPORT.md uses the seven exact required headings in order and remains concise | Documentation test |
| DEL-03 | Evidence | Root evidence directory contains artifact plus discovery and replay logs, including an exceptional replay | Evidence manifest validator |
| USER-01 | Phased execution | A checked, reviewable plan is maintained through release | Root CHECKLIST.md |
| USER-02 | Manual QA and screenshots | Desktop and mobile operator UI, live surface, replay, outcome, policy, and handoff are manually inspected | docs/QA.md and evidence screenshots |
| USER-03 | Public release | Repository is public under codelit-io, CI passes, and anonymous quickstart succeeds | Public URL, API visibility, CI, clean clone |

## Required deliverables

- Root README.md with setup, configuration, no-live-service path, and exact discovery then replay commands.
- Root REPORT.md with these headings, exactly and in this order: Architecture; Artifact schema; Determinism & error handling; Heterogeneity & multi-tenant; Escalation & handoff; Safety; Cuts.
- Root evidence directory with a saved artifact, live discovery log, model-free replay log, and exceptional-state evidence.
- Root CHECKLIST.md, docs/QA.md, and committed screenshots, as additionally requested by the user.
- A public GitHub repository under codelit-io.

## Scenario matrix

The synthetic target must support deterministic inputs without real credentials or PII:

| Scenario | Trigger | Expected classification |
| --- | --- | --- |
| Happy path | Known synthetic member | succeeded with a typed savings balance |
| Not found | Unknown member | business_outcome / MEMBER_NOT_FOUND |
| Validation | Malformed member ID | failed / INPUT_INVALID before a browser session is created |
| Transient load | Injected slow response or known notice | bounded recovery, then success |
| Session expiry | Injected timeout dialog | needs_intervention, same-session recovery, resume |
| Permission denial | Restricted synthetic member | failed / PERMISSION_DENIED |
| Ambiguity | Duplicate target injection | failed closed / TARGET_AMBIGUOUS |
| Policy escape | Off-origin navigation attempt | failed / POLICY_DENIED before side effect |

## Honest scope and cuts

- The target app and all displayed data are synthetic; the browser interactions and model decisions are real.
- The operator UI is minimal, but its control transfer is real.
- Chromium is the supported automation runtime for the submitted slice. Desktop and tenant orchestration are designed, not claimed as implemented.
- JSON artifacts, JSONL events, and an in-memory session registry are sufficient here. Process loss ends the live session and returns SESSION_LOST.
- Raw Playwright traces, HAR files, browser storage, cookies, model transcripts, and screenshots containing unknown real data are never committed.
