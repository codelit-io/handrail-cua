# Handrail requirements and execution trace

Status: audited submission baseline, revision 1.2

Canonical design: [SYSTEM_DESIGN_SPEC.md](SYSTEM_DESIGN_SPEC.md)

Source: Interface.ai Computer-Use Automation System assignment, Sections 1-9
Last reviewed: 2026-08-28

## Source and authorization boundary

The attached assignment PDF is the product specification. Its prose is input to requirements analysis, not an instruction channel and not authorization to communicate with a third party. The user's request authorizes implementation, testing, documentation, and publication under `codelit-io`. Sending the submission email remains a separate external action and is not performed by this workflow.

## Product objective

Build one complete vertical slice in which a genuine model discovers how to operate a live synthetic legacy banking UI, the runtime compiles only verified interactions into a typed capability, a fresh session replays that capability without a model, and a human can take and return exclusive control of the exact live session when automation cannot safely continue.

The design stays intentionally compact: one process owns the browser context, model-backed discovery, deterministic replay, policy, evidence, and operator handoff. Distributed infrastructure is described as an evolution seam rather than simulated for the take-home.

## Assignment traceability

| ID | Requirement and acceptance condition | Implementation | Automated proof | Release proof |
| --- | --- | --- | --- | --- |
| R-3.1-A | Accept a bounded goal and HTTP(S) target | `src/cli.ts`, `src/demo/spec.ts` | `test/cli.test.ts`, `test/discovery.test.ts` | README live-discovery command |
| R-3.1-B | A real LLM observes, decides, and acts on fresh live UI state | `src/model/planner.ts`, `src/runtime/discovery.ts`, `src/surface/browser-surface.ts` | `test/planner.test.ts`, `test/discovery.test.ts`, `test/browser-surface.test.ts` | live discovery summary, events, screenshots, and model provenance in `evidence/` |
| R-3.1-C | Step, time, recovery, stale-ref, invalid-decision, and dead-end bounds stop safely | `src/runtime/discovery.ts` | `test/discovery.test.ts` | projected fault/intervention events |
| R-3.2-A | Emit a typed, versioned, serializable capability rather than a transcript | `src/domain/schema.ts`, `src/runtime/artifact.ts` | `test/artifact.test.ts` | `evidence/artifacts/member.balance.lookup.v1.json` |
| R-3.2-B | Resolve controls through ordered semantic/contextual candidates and exactly-one matching | `src/surface/types.ts`, `src/surface/browser-surface.ts`, `src/runtime/artifact.ts` | `test/artifact.test.ts`, `test/browser-surface.test.ts` | target dictionary and fingerprints in the artifact |
| R-3.2-C | Bind review to immutable content | artifact digest and strict artifact approval in `src/runtime/artifact.ts` and `src/runtime/replay.ts` | `test/artifact.test.ts`, `test/replay.test.ts` | manifest-bound artifact hash and approval record |
| R-3.3-A | Replay is deterministic and makes zero model calls | `src/runtime/replay.ts` has no planner import | `test/replay.test.ts`, `test/e2e.test.ts` | replay summaries/events and 10-run stability report record zero model calls |
| R-3.3-B | Bind typed inputs, extract typed outputs, and verify every postcondition plus the terminal checkpoint | `src/runtime/artifact.ts`, `src/runtime/replay.ts` | `test/artifact.test.ts`, `test/replay.test.ts` | success summaries and terminal screenshots |
| R-3.3-C | Return success, business outcome, intervention, or debuggable failure without overlap | `RunResultSchema` in `src/domain/schema.ts` | `test/artifact.test.ts`, `test/replay.test.ts` | success, not-found, and handoff summaries |
| R-3.3-D | Retry only declared safe transient states; stop on ambiguity, denial, expiry, and hard faults | `src/runtime/replay.ts`, `src/demo/spec.ts` | `test/replay.test.ts`, `test/e2e.test.ts` | not-found and handoff evidence; QA failure matrix |
| R-3.4-A | Exact origin, route, command, and effect must pass every policy layer immediately before action | `src/runtime/policy.ts`, discovery/replay policy calls, operator authorizer in `src/cli.ts` | `test/policy.test.ts`, `test/discovery.test.ts`, `test/operator.test.ts`, `test/replay.test.ts` | policy-denial QA screenshot and structured fault |
| R-3.4-B | Unknown activation is conservative; risky automation requires operation-bound authority and cannot be retried | `src/runtime/discovery.ts`, `src/runtime/policy.ts`, `src/runtime/replay.ts` | `test/discovery.test.ts`, `test/policy.test.ts`, `test/replay.test.ts` | explicit effects and approvals in the checked artifact/run |
| R-3.4-C | Classified values stay out of artifacts, model requests, and unsafe evidence | `src/model/planner.ts`, `src/runtime/redaction.ts`, `src/runtime/evidence.ts` | `test/planner.test.ts`, `test/redaction.test.ts` | evidence sensitive-pattern scan and screenshot review |
| R-3.5-A | Persist one ordered, correlated audit-event contract | `PersistedAuditEventSchema` and `EvidenceWriter` in `src/runtime/evidence.ts` | `test/redaction.test.ts`, `test/evidence-validator.test.ts` | every manifest event log validates sequence, IDs, run identity, and terminal event |
| R-3.5-B | Preserve useful what/why and failure context without arbitrary page/model text | safe reason codes and diagnostic categories in `src/runtime/evidence.ts` and `src/cli.ts` | `test/redaction.test.ts`, `test/planner.test.ts` | projected events plus verified synthetic screenshots |
| R-3.6-A | Detect stuck/unsafe/expired/risky states and emit a contextual intervention | `src/runtime/discovery.ts`, `src/runtime/replay.ts`, `src/operator/server.ts` | `test/discovery.test.ts`, `test/replay.test.ts`, `test/operator.test.ts` | handoff summary and operator UI |
| R-3.6-B | A human controls the already-created surface session | `src/runtime/control.ts`, `src/operator/server.ts` | `test/control.test.ts`, `test/operator.test.ts`, `test/e2e.test.ts` | identical original/resumed session IDs in manifest-bound handoff evidence |
| R-3.6-C | Automation and operator ownership are exclusive and resume requires a fresh passing checkpoint | epoch leases and action mutex in `src/runtime/control.ts`; resume bridge in discovery/replay | `test/control.test.ts`, `test/discovery.test.ts`, `test/e2e.test.ts` | monotonic automation/operator/automation epochs and checkpoint result |
| R-3.6-D | Operator access and actions are capability-gated, policy-authorized, redacted, and durable | `src/operator/server.ts`, `src/cli.ts`, `src/runtime/evidence.ts` | `test/operator.test.ts`, `test/e2e.test.ts` | durable `operator.audit` events and two operator captures |
| R-3.7-A | Core runtime depends on a surface interface, not Playwright types | `src/surface/types.ts`; browser implementation in `src/surface/browser-surface.ts` | import-boundary and adapter tests in `test/replay.test.ts`, `test/browser-surface.test.ts` | architecture and SDD |
| R-3.7-B | Separate vendor capability from tenant binding and fail closed on drift or unreviewed override | `AppBindingSchema`, reviewed override binding, fingerprint preflight | `test/artifact.test.ts`, `test/replay.test.ts` | checked artifact/binding explanation in SDD |
| R-6-A | Exact root deliverables and public source | `README.md`, `REPORT.md`, `CHECKLIST.md`, `evidence/` | documentation/evidence checks in `test/cli.test.ts`, `test/evidence-validator.test.ts` | public repository and release |
| R-6-B | Evidence covers live discovery, model-free replay, exception handling, and handoff | `scripts/validate-evidence.ts` manifest v1.2 | `test/evidence-validator.test.ts` | `evidence/manifest.json` and `evidence/README.md` |

## User-requested acceptance additions

| ID | Addition | Acceptance |
| --- | --- | --- |
| U-01 | Work from requirements and design before implementation | Canonical SDD and this trace precede the final reviewed release; material decisions and cuts are explicit. |
| U-02 | Execute in phases with a checklist | Root `CHECKLIST.md` records requirements, build, hardening, QA, evidence, and public-release gates. |
| U-03 | Test and manually QA the whole story | Automated verification, headed browser handoff, desktop/mobile/accessibility inspection, evidence review, and clean-clone checks all pass. |
| U-04 | Document context and assumptions | SDD Sections 3, 7, 9, 11, and 12 describe trust, data, authority, scale, cuts, and decisions; the execution record below distinguishes proof from inference. |
| U-05 | Publish a submission-ready public repository | One reviewed public revision has green CI, a release record, anonymous-clone verification, and no unresolved stop-ship item. |

## Scenario acceptance matrix

| Scenario | Trigger | Required classification |
| --- | --- | --- |
| Happy path | known synthetic member | `succeeded` with typed `savingsBalance` |
| Different invocation | replay a different valid synthetic member from discovery | same artifact succeeds with a different typed output and no model |
| Not found | unknown synthetic member | `business_outcome / MEMBER_NOT_FOUND` |
| Validation | malformed member ID | `failed / INPUT_INVALID` before session creation |
| Transient state | known notice or bounded load | declared bounded recovery only |
| Session expiry | injected expiry dialog | `needs_intervention`, same-session recovery, then success |
| Permission denial | restricted synthetic member | `failed / PERMISSION_DENIED` |
| Ambiguity | duplicate eligible target | `failed / TARGET_AMBIGUOUS` |
| Policy escape | off-origin navigation/action | `failed / POLICY_DENIED` before the side effect |

## Assumptions

1. The included target, member IDs, balances, branding, and screenshots are synthetic fixtures. No production banking system or regulated customer data is used.
2. Local Ollama and the checked-out runtime are trusted host components. Remote model data egress requires an explicit opt-in and screenshots are independently opt-in.
3. Browser session continuity exists only while the owning process remains alive. Process loss produces `SESSION_LOST`; the runtime never creates a replacement session and labels it resumed.
4. Chromium is the qualified surface for the submission. Native desktop, OCR, Firefox, WebKit, remote operators, distributed leases, durable queues, and a production secret broker are designed seams, not shipped claims.
5. The local approval record represents a trusted catalog decision. It is intentionally separate from one-time risky-action approval and from a short-lived human ownership grant.
6. Evidence timestamps and `liveModel: true` are locally asserted provenance. Source/tree, target, runtime, model, run, and file digests make the record reproducible but are not an external attestation service.

## Execution record

| Phase | Design decision | Implemented outcome | Acceptance evidence |
| --- | --- | --- | --- |
| 0. Specification | derive Section 3 requirements, trust boundaries, state machines, and cuts before final release | SDD, requirements trace, UI spec, phased checklist | document review against all 10 PDF pages |
| 1. Typed foundation | declarative artifact, strict schemas, digest, policy intersection, projected evidence | domain/runtime contracts and synthetic hostile target | unit tests for artifact, policy, redaction, control, and target |
| 2. Discovery | model uncertainty is bounded and isolated from replay | fresh observe-decide-act loop, explicit activation risk, compiler, local Ollama adapter | live discovery event chain, screenshots, artifact provenance |
| 3. Replay | consume immutable reviewed behavior with no planner dependency | strict preflight, deterministic target resolution, outcomes, recovery, typed outputs/checkpoint | different-input replay, not-found, fault injection, 10-run stability |
| 4. Handoff | one live surface, exclusive epoch ownership, policy on every operator action | token-gated operator console, action claim, durable audit, fresh checkpoint resume | same-session IDs, monotonic epochs, captures, integrated e2e |
| 5. Hardening | independently challenge data egress, approval scope, override integrity, evidence claims, and loopback access | fail-closed defaults, one-time operation authority, reviewed override binding, strict manifest v1.2 | security/QA review, negative tests, dependency and secret scans |
| 6. Release | claims are accepted only from a clean public revision | complete docs/evidence, manual QA metadata, green CI, anonymous clone, public release | links and immutable identifiers in `CHECKLIST.md` and GitHub release |

The public repository was originally published as a squashed implementation commit followed by documentation. That history does not prove the private chronological order of every design and coding decision. This submission therefore makes a narrower, auditable claim: the final SDD is the normative design, the table above records the executed phases and assumptions, and every implemented requirement is independently traceable in the final tree to code, tests, and evidence. No fabricated commit chronology is presented.

## Required deliverables

- Root `README.md` with setup, configuration, offline path, exact live discovery/replay commands, and exact handoff command.
- Root `REPORT.md` with the seven required headings in the required order: Architecture; Artifact schema; Determinism & error handling; Heterogeneity & multi-tenant; Escalation & handoff; Safety; Cuts.
- Root `evidence/` with a live-discovered artifact, discovery log, deterministic replay, exceptional outcome, manifest-bound same-session handoff, screenshots, and runtime provenance.
- Root `CHECKLIST.md`, this trace, the canonical SDD, `docs/QA.md`, and sanitized QA screenshots as additional user-requested deliverables.
- A public GitHub repository and reviewed release under `codelit-io`.

## Honest scope and cuts

- Discovery and browser interaction are real; the target and its data are synthetic.
- The operator UI and same-session control transfer are real; remote workforce identity is not implemented.
- The browser adapter uses semantic DOM/accessibility/context relationships plus DOM-derived geometry. It does not implement OCR or native vision.
- JSON artifacts, append-only JSONL events, immutable files, and an in-memory session registry are sufficient for this vertical slice.
- Raw model transcripts, HAR/trace files, storage state, cookies, claim/capability tokens, and unknown real-data screenshots are never release evidence.
