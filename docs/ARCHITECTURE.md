# Handrail architecture specification

Status: frozen before implementation

## Decision summary

Handrail is a modular TypeScript monolith. One process owns the Playwright browser context, discovery loop, deterministic replay engine, policy and redaction gates, evidence writer, control lease, and a tiny operator HTTP surface. This is the smallest architecture that makes same-session handoff real. It also avoids fabricating distributed durability the assignment does not require.

Discovery is the only model-backed path. It uses a compact screenshot plus a fresh element map and allows the model to choose only from schema-validated actions and current observation references. Replay consumes an immutable declarative capability and contains no model dependency.

```mermaid
flowchart LR
  CLI[CLI / agent caller] --> Runtime[Run coordinator]
  Runtime --> Policy[Policy and redaction]
  Runtime --> Discovery[Discovery loop]
  Runtime --> Replay[Replay engine]
  Discovery --> Model[Vision planner]
  Discovery --> Surface[Surface adapter]
  Replay --> Surface
  Surface --> Browser[Playwright session]
  Discovery --> Compiler[Artifact compiler and linter]
  Compiler --> Artifact[Immutable capability JSON]
  Runtime --> Lease[Control lease]
  Lease --> Operator[Operator console]
  Operator --> Surface
  Runtime --> Evidence[Redacted evidence store]
```

## Runtime boundaries

```ts
interface SurfaceAdapter {
  createSession(binding: AppBinding): Promise<SurfaceSession>;
  observe(session: SurfaceSession, options: ObserveOptions): Promise<Observation>;
  resolve(session: SurfaceSession, target: TargetSpec): Promise<ResolvedTarget>;
  dispatch(
    session: SurfaceSession,
    command: SurfaceCommand,
    grant: ControlGrant,
    signal: AbortSignal,
  ): Promise<ActionReceipt>;
  evaluate(session: SurfaceSession, predicate: Predicate): Promise<PredicateResult>;
  extract(session: SurfaceSession, extractor: ExtractorSpec): Promise<unknown>;
  captureEvidence(session: SurfaceSession, policy: EvidencePolicy): Promise<EvidenceRef>;
}

interface DiscoveryModel {
  decide(input: {
    goal: string;
    observation: Observation;
    allowedCommands: CommandKind[];
  }): Promise<ModelDecision>;
}
```

Core modules never import Playwright Page or Locator. BrowserSurface owns frames, screenshots, live element references, hit testing, and locator resolution. A future desktop adapter can implement the same observe, resolve, dispatch, evaluate, and extract vocabulary with OS accessibility and OCR.

## Discovery protocol

1. Validate the request, input definitions, target binding, and hard policy.
2. Create a browser session and acquire the automation control lease.
3. Observe the live surface. The observation contains a resized screenshot, route-only URL, surface fingerprint, and ephemeral element references with roles, visible text, contextual table labels, frame paths, and normalized bounds.
4. Send the goal plus the redacted observation to the vision planner. The planner returns one structured action: set a value, activate a current element reference, wait, extract, finish, or request help.
5. Reject stale observation IDs, invented references, out-of-bounds coordinates, disallowed actions, and unsafe effects before dispatch.
6. Execute one bounded action, record its receipt, and verify its post-state from a fresh observation.
7. Compile only successful, postcondition-verified actions. A coordinate may locate an element during discovery, but the compiler must derive durable semantic, contextual, frame, or visual anchors before the artifact can be approved.
8. Finish only after the declared output and global checkpoint validate. Lint, digest, and save the artifact as draft.

Persistent audit events retain decision kinds, current observation and element references, structural observation metadata, and action receipts. They deliberately omit page text, planner rationales, free-form intervention state, hidden chain-of-thought, and raw provider transcripts.

## Capability artifact

The artifact is declarative intermediate representation rather than executable code:

```ts
interface CapabilityArtifact {
  schemaVersion: "1.0.0";
  id: string;
  revision: number;
  name: string;
  description: string;
  digest: string;
  compatibility: {
    product: { vendor: string; product: string; versionRange?: string };
    requiredSurfaceCapabilities: SurfaceCapability[];
    fingerprint: FingerprintRule;
  };
  entrypoint: { bindingKey: string; route?: PathTemplate };
  contract: {
    inputs: Record<string, InputSpec>;
    outputs: Record<string, OutputSpec>;
    outcomes: KnownOutcomeSpec[];
  };
  targets: Record<string, TargetSpec>;
  policyRequirements: CapabilityPolicyRequirements;
  steps: Step[];
  success: Predicate;
  provenance: {
    discoveryRunId: string;
    modelId: string;
    promptHash: string;
    createdAt: string;
  };
}
```

Per-invocation values are expression nodes such as source input and name memberId, never handlebars strings or copied literals. Targets live in a dictionary so a tenant binding may specialize a logical control without rewriting the workflow. Approval metadata is stored separately by canonical artifact digest; approving a capability never mutates the reviewed content.

The linter rejects sensitive literals, raw scripts, policy-escaping routes, targets without durable candidates, broad or ambiguous selectors, steps without postconditions, automatic retry on non-idempotent actions, outputs without validators, and artifacts without a terminal checkpoint.

## Locator lattice

Each TargetSpec contains a deterministic priority order and an exactly-one-visible match contract:

1. Accessible role plus exact normalized name.
2. Associated label text.
3. Contextual table relationship, such as control in the row labeled Member number.
4. Anchored relationship, such as the Available balance cell in the row whose Account type is Savings.
5. Stable non-sensitive attribute with recorded justification.
6. Visual anchor constrained to a normalized region, only when policy permits.

Every candidate is checked against a semantic fingerprint and a stable interval. Zero matches tries the next candidate. Multiple matches never use first; they fail closed as TARGET_AMBIGUOUS. Frame paths are explicit and re-resolved after navigation. Element handles and absolute coordinates are not persisted in an approved artifact.

## Replay and outcomes

Replay validates artifact, digest, approval state, binding fingerprint, input schema, and policy before opening or mutating the target. It re-resolves targets immediately before each action, uses bounded condition waits instead of blind sleeps, runs only artifact-declared recovery, validates typed outputs, and verifies a compound terminal checkpoint.

```ts
type RunResult<Output> =
  | { status: "succeeded"; outputs: Output; checkpointEvidence: EvidenceRef[]; meta: RunMeta }
  | { status: "business_outcome"; outcome: KnownOutcome; evidence: EvidenceRef[]; meta: RunMeta }
  | { status: "needs_intervention"; intervention: InterventionView; meta: RunMeta }
  | { status: "failed"; error: AutomationFault; meta: RunMeta };
```

Known business outcomes such as MEMBER_NOT_FOUND are returned to the caller and are not crashes. A known notice or transient load may be dismissed or retried within a small artifact-declared budget. Session expiry, unknown dialogs, unsafe ambiguity, and risky commits request intervention. Permission denial, policy denial, invalid artifacts, incompatible surfaces, and exhausted recovery return debuggable terminal faults.

No non-idempotent or commit action is retried automatically. Global sentinels for app errors, permission denial, session expiry, and unexpected dialogs are evaluated before a generic postcondition failure.

## Safety model

Three layers are intersected, never merged permissively: platform hard policy, tenant/app binding policy, and capability requirements. Exact origins, route patterns, allowed command kinds, and effect classes are enforced before every discovery, replay, and operator action and after redirects or popups.

Page content is untrusted input. A model can reference only a current observation ID and enumerated element refs. Arbitrary JavaScript, shell commands, downloads, clipboard access, file upload, credentials, cookies, headers, storage state, and unknown action types are denied.

Values carry public, internal, PII, or secret classification. Secrets come from a runtime broker or preauthenticated session and are never exposed to the model. Structured logging redacts by data lineage and defensive patterns, and persistent events minimize arbitrary surface/model text. Screenshot writes require an explicit assertion that pixel redaction has already been verified; this demo may assert it because every displayed record is a conspicuous synthetic fixture. A production adapter must mask declared sensitive regions before making that assertion. The local model endpoint is loopback by default.

## Same-session control transfer

Every command passes through one action mutex and an epoch-based lease:

```mermaid
stateDiagram-v2
  [*] --> AUTOMATION_ACTIVE
  AUTOMATION_ACTIVE --> PAUSE_REQUESTED
  PAUSE_REQUESTED --> AWAITING_OPERATOR
  AWAITING_OPERATOR --> OPERATOR_ACTIVE
  OPERATOR_ACTIVE --> RESUME_REQUESTED
  RESUME_REQUESTED --> AUTOMATION_ACTIVE
  AUTOMATION_ACTIVE --> COMPLETED
  AUTOMATION_ACTIVE --> FAILED
  OPERATOR_ACTIVE --> FAILED
```

Automation quiesces at an action boundary, records its last receipt, and atomically increments the lease epoch. The operator claims a short-lived grant and uses the console to click coordinates, type into the focused control, press keys, or capture evidence on the same Playwright Page. Every human command is redacted and audited. Resume atomically releases human ownership; automation reacquires only after a fresh observation and either advances when the human satisfied the current postcondition or safely retries the current idempotent step.

A stale epoch, token, or duplicate claimant is rejected as CONTROL_LOST. Lease expiry returns to awaiting operator; it never silently gives automation control. Local process death loses the live session and is reported honestly as SESSION_LOST.

## Heterogeneity and tenant reuse

A canonical artifact is scoped to a vendor, product, and compatible version family. It contains no tenant base URL, branding, credentials, or browser state. AppBinding supplies the tenant instance, exact origin, entrypoints, secret references, expected fingerprint, policy, and narrowly scoped target overrides.

A preflight fingerprint scores stable product signals such as frame names, route shapes, normalized headings, and version markers. Below threshold, replay returns INCOMPATIBLE_SURFACE before any write. An override may replace a logical target but not step semantics or policy. Semantic workflow differences require a new artifact revision and approval. Replay health by digest plus fingerprint provides the future drift signal.

The production evolution is straightforward but intentionally unbuilt here: tenant-isolated browser workers, durable compare-and-swap lease storage, immutable artifact catalog, encrypted short-TTL evidence storage, and a scheduler around deterministic replay.

## Cost and scale posture

- One model call per bounded discovery step; screenshot resized and element map compacted.
- Prompt hash and concise decisions retained; raw transcript and base64 image data discarded.
- Zero model calls during normal capability invocation.
- Single process, JSON artifacts, JSONL events, and local static assets for the take-home.
- No premature queue, cluster, database, or multi-tenant administration surface.
- Optional stretch work is limited to a typed capability catalog and a repeated-replay stability score after the core passes.
