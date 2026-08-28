# Handrail engineering report

## Architecture

Handrail is a modular TypeScript monolith organized around one hard boundary: discovery may use an LLM, while capability replay may not. A local run coordinator owns the Playwright browser context, discovery loop, artifact compiler, deterministic replay engine, policy and redaction gates, evidence writer, epoch-based control lease, and small operator HTTP surface. One process is enough to make the vertical slice real while keeping state ownership and same-session handoff understandable.

The `SurfaceAdapter` separates core automation from Playwright. The browser implementation owns page creation, frame traversal, live observations, target resolution, input dispatch, predicate evaluation, extraction, and evidence capture. Core artifacts contain no Playwright `Page`, `Locator`, element handle, or executable script. This gives the design a credible path to a future desktop accessibility/OCR adapter without pretending that adapter exists today.

Discovery observes the current live surface and gives the planner only a bounded semantic snapshot, typed invocation inputs, already captured outputs, allowed action kinds, the current observation ID, and ephemeral element references. The native Ollama integration uses `/api/chat`, strict JSON Schema output, deterministic temperature, and a timeout. The default `qwen3:4b` configuration is semantic: screenshots are captured for runtime evidence and human review but are not model input. Screenshot input is opt-in only for a configured vision-capable model. Every decision is parsed, freshness-checked, policy-checked, executed once, and verified against a new observation before it can contribute to an artifact.

The included target is a deliberately awkward local legacy UI with an iframe boundary, table context, sparse labels, and deterministic exceptional states. It contains only synthetic data. This makes browser behavior, failure handling, and target robustness testable without introducing a real customer system or credential flow.

## Artifact schema

The compiled capability is declarative intermediate representation, not a recording and not generated code. Its contract includes schema version, revision, canonical digest, vendor/product compatibility, required surface capabilities, binding entrypoint, typed inputs and outputs, known business outcomes, a target dictionary, policy requirements, ordered steps, recovery limits, a compound success predicate, and discovery provenance.

Invocation data is represented by typed expression nodes such as `{ kind: "input", name: "memberId" }`; the compiler does not copy the member value into the artifact or interpolate opaque templates. Each output has a validator and an explicit extractor. Targets use an ordered locator lattice: exact accessible role/name, associated label, contextual table relationship, anchored relation, justified stable attribute, then a bounded visual region where permitted. Every target requires exactly one visible match plus a semantic fingerprint. Zero matches try the next reviewed candidate; multiple matches fail closed instead of selecting the first element.

Compilation retains only actions whose postconditions succeeded. Canonical serialization binds a SHA-256 digest to the reviewed content while preserving workflow array order. The linter rejects sensitive per-run literals, raw executable behavior, missing or weak checkpoints, unknown target references, broad routes, duplicate or weak locator candidates, policy-escaping actions, and automatic retries for non-idempotent or commit effects. Approval can therefore bind to immutable content rather than to a mutable file path.

## Determinism & error handling

Replay accepts an artifact, an app binding, and typed inputs. Before opening a surface it validates schema, digest, input contract, binding compatibility, and the effective policy intersection. It then opens a fresh session, re-resolves each logical target immediately before use, dispatches only declared commands, verifies each postcondition, validates extracted outputs, and evaluates the compound terminal checkpoint. The replay module has no import edge to a planner or model module, and its result metadata reports zero model calls.

The runtime exposes four non-overlapping results: `succeeded`, `business_outcome`, `needs_intervention`, and `failed`. A missing synthetic member is a declared business outcome rather than an exception. A known transient loading state may be checked within a small configured budget. Session expiry, unsafe ambiguity, or exhausted safe recovery retains the current session for intervention. Invalid input, digest drift, incompatible surfaces, policy denial, permission denial, hard application errors, and false terminal checkpoints produce structured faults with phase and code.

Retries are narrow rather than optimistic. Only configured recoverable classes are eligible, attempts and delays are bounded, and commit or non-idempotent steps are never automatically retried. Global sentinels are evaluated before collapsing a state into a generic postcondition failure. Tests cover invalid preflight without opening a browser, digest drift, a declared not-found outcome, transient recovery, retained-session intervention, a false terminal checkpoint, target ambiguity, policy escape, and replay through a fresh real Chromium session.

The scripted planner is an offline fixture for deterministic development and CI. It exercises the discovery/compiler plumbing but is not evidence of genuine LLM discovery. A qualifying live run must show native Ollama decisions over fresh surface observations, live provenance, successful artifact compilation, and a later replay with zero model calls.

## Heterogeneity & multi-tenant

Reuse is split between a product-family capability and a tenant-specific `AppBinding`. The capability owns workflow semantics and logical targets. The binding supplies an exact origin, named entrypoints, tenant label, secret references, expected product fingerprint, policy, and narrowly scoped target overrides. It cannot broaden the capability's effects or permissions.

Preflight scores stable product signals such as route shape, frame identity, headings, and markers. A score below the reviewed threshold returns `INCOMPATIBLE_SURFACE` before a write. A tenant override may replace one logical target within the same typed workflow; a semantic workflow difference requires a new artifact revision and review. This prevents a shared capability from accumulating tenant URLs, branding, credentials, or browser state.

Today the implemented adapter is Playwright/Chromium and the implemented catalog is local. The interface boundaries support future desktop adapters, tenant-isolated workers, immutable catalog storage, and replay-health drift signals, but none of those production components is claimed as complete.

## Escalation & handoff

Every command is serialized through a control coordinator with a monotonically increasing epoch. When automation requests intervention, the runtime quiesces at an action boundary, revokes its grant, records the current step and reason, and gives the operator a URL for the same `SurfaceSession`. The operator console receives an already-created session and cannot create, replace, close, or navigate a substitute session behind the runtime's back.

One operator may claim the current epoch using an opaque, short-lived claim. Click, focused typing, allowlisted keypress, and capture requests must carry that claim and epoch. A duplicate claimant, expired claim, prior automation grant, or stale request is rejected with `CONTROL_LOST`. Human actions pass through the same surface action mutex and are retained as redacted audit events; typed content and claim tokens are not written into the audit trail.

Resume atomically returns ownership, observes the same session again, and evaluates an orchestration-supplied checkpoint. Only then does it issue a new automation grant at a fresh epoch. The caller can advance when the human already satisfied the postcondition or safely retry the current idempotent step. Process death cannot preserve an in-memory browser and is reported honestly as session loss rather than silently opening a new page.

## Safety

Effective permission is the intersection of platform policy, tenant binding policy, and capability requirements. Every navigation and action must match the exact origin, a bounded route pattern, an allowed command, and an allowed effect class. Read, reversible write, and commit are distinct. Commit requires an approval or human authority bound to the exact request and session epoch, even if every policy layer allows the effect.

Page content is untrusted application data, never an instruction channel. The model can select only schema-defined actions against the current observation ID and enumerated references. Stale observations, invented references, out-of-range coordinates, unknown actions, ambiguous targets, off-origin redirects, and disallowed effects fail before dispatch. Arbitrary JavaScript, shell execution, downloads, clipboard access, file upload, cookies, raw storage state, and undeclared credential handling are outside the action vocabulary.

Inputs and outputs carry public, internal, PII, or secret classification. Structured evidence is recursively redacted by lineage and defensive patterns before serialization; persistent audit projections also discard page text, planner rationale, free-form intervention state, and receipt text. Evidence paths are bounded, immutable writes refuse replacement, and symlinks are rejected. Screenshot persistence requires the adapter to assert that pixel safety was verified. The assignment demo can make that assertion because every displayed record is a conspicuous synthetic fixture; a production adapter must mask declared sensitive regions first. Ollama defaults to loopback, and the unauthenticated operator console is restricted to loopback as well.

## Cuts

Handrail intentionally does not build a distributed queue, database, cloud browser fleet, remote operator identity system, durable cross-process lease, artifact marketplace, native desktop adapter, or real financial-system integration. Chromium is the supported automation surface; Firefox and WebKit are not qualified. The operator UI is functional and responsive, but it is a local demonstration surface rather than a production remote-assistance product.

The offline scripted planner is retained because it makes CI deterministic and failure injection cheap. It is clearly labeled and cannot satisfy the live-discovery acceptance gate. Likewise, unit tests and synthetic screenshots do not replace a sanitized native Ollama run, a clean-clone verification, or public CI evidence. Those are release gates, not architectural claims. The result is deliberately small: one meaningful workflow, strong contracts, honest failure modes, observable ownership transfer, and seams that can scale only when product demand justifies the operational cost.
