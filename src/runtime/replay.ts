import { randomUUID } from "node:crypto";

import {
  AppBindingSchema,
  type AutomationFault,
  type CapabilityArtifact,
  type FingerprintRule,
  type InterventionView,
  type ModelDecision,
  type Predicate,
  type RunMeta,
  type RunResult,
  type ScalarValue,
  type Step,
  type TargetCandidate,
  type TargetSpec,
  type ValueExpression,
} from "../domain/schema.js";
import type {
  ObservedElement,
  PredicateContext,
  SurfaceAdapter,
  SurfaceObservation,
  SurfaceSession,
} from "../surface/types.js";
import {
  ArtifactApprovalError,
  ArtifactBindingError,
  ArtifactCompilationError,
  assertArtifactApproval,
  assertValidArtifact,
  bindArtifactInputs,
  bindReviewedTargetOverrides,
  bindValueExpression,
  computeArtifactApprovalDigest,
  TargetOverrideReviewError,
  validateArtifactOutputs,
} from "./artifact.js";
import { type ControlCoordinator, ControlError, type ControlGrant } from "./control.js";
import type { EvidenceWriter } from "./evidence.js";
import {
  type BoundApproval,
  bindingPolicyLayer,
  capabilityPolicyLayer,
  enforcePolicy,
  PolicyDeniedError,
  type PolicyLayer,
  type PolicyStack,
  routeMatches,
  surfaceAccessPolicy,
} from "./policy.js";

const ZERO_MODEL_CALLS = 0 as const;
const DEFAULT_RUN_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const ENTRYPOINT_OPERATION_ID = "replay-entrypoint";

export type ReplayRecoverableKind =
  | "target_not_found"
  | "postcondition_timeout"
  | "known_transient";

/** Typed adapter signal for transient conditions that artifact policy may retry. */
export class RecoverableReplayError extends Error {
  constructor(
    readonly retryKind: ReplayRecoverableKind,
    message: string,
  ) {
    super(message);
    this.name = "RecoverableReplayError";
  }
}

export interface ReplayInvocation {
  readonly artifact: unknown;
  /** Trusted catalog record. Strict engines require and validate it before surface creation. */
  readonly artifactApproval?: unknown;
  readonly binding: unknown;
  readonly inputs: Readonly<Record<string, unknown>>;
  /** Optional exact-origin URL for tenant/scenario query parameters; its route must match entrypoint. */
  readonly targetUrl?: string;
  readonly approval?: BoundApproval;
  readonly runId?: string;
}

export interface ReplayInterventionContext {
  readonly runId: string;
  readonly artifactId: string;
  readonly session: SurfaceSession;
  readonly currentStepId: string;
  readonly reason: InterventionView["reason"];
  readonly summary: string;
  readonly observedState: string;
  readonly automationGrant: ControlGrant;
  readonly observation: SurfaceObservation;
}

export interface ReplayInterventionResolution {
  readonly sessionId: string;
  readonly automationGrant: ControlGrant;
  readonly observation: SurfaceObservation;
  readonly checkpoint: {
    readonly passed: boolean;
    readonly observed: string;
  };
}

export type ReplaySurfaceSentinel =
  | {
      readonly kind: "recoverable";
      readonly code: string;
      readonly pattern: RegExp;
      readonly summary: string;
      readonly maxChecks?: number;
      readonly delayMs?: number;
    }
  | {
      readonly kind: "intervention";
      readonly pattern: RegExp;
      readonly reason: InterventionView["reason"];
      readonly message: string;
    }
  | {
      readonly kind: "hard_failure";
      readonly pattern: RegExp;
      readonly code: AutomationFault["code"];
      readonly message: string;
    };

export interface ReplayEngineOptions {
  readonly surface: SurfaceAdapter;
  readonly control: ControlCoordinator;
  /** The platform layer is supplied independently; binding and capability layers are derived. */
  readonly platformPolicy: PolicyLayer;
  readonly evidence?: Pick<EvidenceWriter, "appendEvent" | "eventLogRef" | "writeScreenshot">;
  /** Screenshot persistence stays off unless the adapter masks sensitive regions first. */
  readonly screenshotRedactionVerified?: boolean;
  readonly resolveSecret?: (name: string) => ScalarValue;
  readonly now?: () => Date;
  readonly sleep?: (durationMs: number) => Promise<void>;
  readonly runTimeoutMs?: number;
  readonly closeSessionOnFinish?: boolean;
  readonly surfaceSentinels?: readonly ReplaySurfaceSentinel[];
  /** `strict` requires a valid artifact approval and is the fail-closed default. */
  readonly artifactApprovalMode?: "strict" | "non_strict";
  /**
   * Optional same-session handoff bridge. It may pause/claim/return control once per run.
   * Without this callback replay preserves the default typed needs_intervention result.
   */
  readonly onIntervention?: (
    context: ReplayInterventionContext,
  ) => Promise<ReplayInterventionResolution>;
}

interface PreflightSuccess {
  readonly ok: true;
  readonly artifact: CapabilityArtifact;
  readonly binding: ReturnType<typeof AppBindingSchema.parse>;
  readonly inputs: Readonly<Record<string, ScalarValue>>;
  readonly targets: Record<string, TargetSpec>;
  readonly policy: PolicyStack;
  readonly entryUrl: string;
}

interface PreflightFailure {
  readonly ok: false;
  readonly fault: AutomationFault;
  readonly artifactId: string;
  readonly artifactDigest: string;
}

type PreflightResult = PreflightSuccess | PreflightFailure;

interface ExecutionState {
  readonly runId: string;
  readonly artifact: CapabilityArtifact;
  readonly inputs: Readonly<Record<string, ScalarValue>>;
  readonly targets: Record<string, TargetSpec>;
  readonly outputs: Record<string, unknown>;
  readonly stepOutputs: Record<string, Record<string, unknown>>;
  readonly policy: PolicyStack;
  readonly bindingOrigin: string;
  readonly session: SurfaceSession;
  readonly approval?: BoundApproval;
  readonly consumedBoundApprovalIds: Set<string>;
  readonly resolveSecret?: (name: string) => ScalarValue;
  sessionId: string;
  grant: ControlGrant;
  currentUrl: string;
  latestObservation: SurfaceObservation;
  actionSequence: number;
  handledInterventions: number;
  currentStepId?: string;
}

interface NormalizedStepError {
  readonly code: AutomationFault["code"];
  readonly message: string;
  readonly retryable: boolean;
  readonly retryKind?: ReplayRecoverableKind;
  readonly observed?: string;
  readonly expected?: string;
  readonly interventionReason?: InterventionView["reason"];
}

class ReplayStepError extends Error {
  constructor(
    readonly normalized: NormalizedStepError,
    options?: ErrorOptions,
  ) {
    super(normalized.message, options);
    this.name = "ReplayStepError";
  }
}

class ReplayTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayTimeoutError";
  }
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (Number.isNaN(value.getTime())) {
    throw new TypeError("Replay clock returned an invalid Date.");
  }
  return value;
}

function safeIdentifier(value: string | undefined, fallback: string): string {
  return value && /^[A-Za-z][A-Za-z0-9._-]{1,127}$/u.test(value) ? value : fallback;
}

function snapshotBoundApproval(approval: BoundApproval): BoundApproval {
  return Object.freeze({
    id: approval.id,
    runId: approval.runId,
    operationId: approval.operationId,
    ...(approval.command !== undefined ? { command: approval.command } : {}),
    ...(approval.action !== undefined ? { action: approval.action } : {}),
    effect: approval.effect,
    origin: approval.origin,
    route: approval.route,
    expiresAt:
      approval.expiresAt instanceof Date ? approval.expiresAt.getTime() : approval.expiresAt,
    ...(approval.capabilityDigest !== undefined
      ? { capabilityDigest: approval.capabilityDigest }
      : {}),
  });
}

function consumeBoundApproval(
  authorization: "policy" | "bound_approval" | "human_control",
  approval: BoundApproval | undefined,
  consumedApprovalIds: Set<string>,
): void {
  if (authorization !== "bound_approval") return;
  if (!approval || consumedApprovalIds.has(approval.id)) {
    throw new PolicyDeniedError({
      allowed: false,
      code: "APPROVAL_INVALID",
      summary: "The bound approval has already authorized one operation in this replay.",
    });
  }
  consumedApprovalIds.add(approval.id);
}

function elapsedMs(startedAt: Date, finishedAt: Date): number {
  return Math.max(0, Math.round(finishedAt.getTime() - startedAt.getTime()));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown replay failure occurred.";
}

function pathUrl(origin: string, route: string): string {
  return new URL(route, `${origin}/`).href;
}

function invocationEntryUrl(
  targetUrl: string | undefined,
  bindingOrigin: string,
  entryRoute: string,
): string {
  const configured = pathUrl(bindingOrigin, entryRoute);
  if (targetUrl === undefined) return configured;
  let requested: URL;
  try {
    requested = new URL(targetUrl);
  } catch {
    throw new TypeError("Replay targetUrl must be an absolute HTTP(S) URL.");
  }
  if (
    requested.origin !== bindingOrigin ||
    requested.username ||
    requested.password ||
    requested.hash ||
    !routeMatches(entryRoute, requested.pathname)
  ) {
    throw new TypeError(
      "Replay targetUrl must retain the binding origin and artifact entrypoint route.",
    );
  }
  return requested.href;
}

function frameMatches(element: ObservedElement, candidate: TargetCandidate): boolean {
  const expected = candidate.framePath ?? [];
  return (
    expected.length === element.framePath.length &&
    expected.every((segment, index) => element.framePath[index] === segment)
  );
}

function normalized(value: string | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

function textSignals(element: ObservedElement): readonly string[] {
  return [
    element.name,
    element.text,
    element.context.precedingLabel,
    element.context.rowLabel,
    element.context.columnLabel,
    element.context.tableCaption,
    ...(element.context.rowText ?? []),
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalized);
}

function candidateMatches(element: ObservedElement, candidate: TargetCandidate): boolean {
  if (!frameMatches(element, candidate)) return false;
  switch (candidate.kind) {
    case "role":
      return element.role === candidate.role && element.name === candidate.name;
    case "label":
      return element.name === candidate.label || element.context.precedingLabel === candidate.label;
    case "table":
      return (
        element.context.rowLabel === candidate.rowLabel &&
        element.context.columnLabel === candidate.columnLabel
      );
    case "relation": {
      if (candidate.role !== undefined && element.role !== candidate.role) return false;
      const anchor = normalized(candidate.anchorText);
      if (candidate.relationship === "labelled_control") {
        return normalized(element.context.precedingLabel) === anchor;
      }
      if (candidate.relationship === "row_value") {
        return (
          normalized(element.context.rowLabel) === anchor ||
          (element.context.rowText ?? []).some((value) => normalized(value) === anchor)
        );
      }
      return textSignals(element).includes(anchor);
    }
    case "attribute":
      // Stable attributes are intentionally absent from observations. A surface can still use
      // this candidate internally for extraction; replay continues to the next reviewable signal.
      return false;
    case "visual": {
      const centerX = candidate.region.x + candidate.region.width / 2;
      const centerY = candidate.region.y + candidate.region.height / 2;
      const bounds = element.bounds;
      const containsCenter =
        centerX >= bounds.x &&
        centerX <= bounds.x + bounds.width &&
        centerY >= bounds.y &&
        centerY <= bounds.y + bounds.height;
      return containsCenter && textSignals(element).includes(normalized(candidate.anchorText));
    }
  }
}

function fingerprintMatches(element: ObservedElement, target: TargetSpec): boolean {
  let possible = 0;
  let matched = 0;
  if (target.fingerprint.role !== undefined) {
    possible += 1;
    if (element.role === target.fingerprint.role) matched += 1;
  }
  if (target.fingerprint.accessibleName !== undefined) {
    possible += 1;
    if (element.name === target.fingerprint.accessibleName) matched += 1;
  }
  const signals = textSignals(element);
  for (const nearby of target.fingerprint.nearbyText ?? []) {
    possible += 1;
    if (signals.includes(normalized(nearby))) matched += 1;
  }
  for (const [attribute, value] of Object.entries(target.fingerprint.stableAttributes ?? {})) {
    possible += 1;
    if (attribute === "role" && element.role === value) matched += 1;
  }
  return possible > 0 && matched / possible >= target.fingerprint.minimumScore;
}

/** Resolve a compiled target only from fresh, deterministic observation signals. */
export function resolveReplayElement(
  target: TargetSpec,
  observation: SurfaceObservation,
): ObservedElement {
  for (const candidate of target.candidates) {
    const matches = observation.elements.filter(
      (element) => candidateMatches(element, candidate) && fingerprintMatches(element, target),
    );
    if (matches.length === 1) return matches[0] as ObservedElement;
    if (matches.length > 1) {
      throw new ReplayStepError({
        code: "TARGET_AMBIGUOUS",
        message: `Target ${target.description} resolved to multiple visible elements.`,
        retryable: false,
        observed: `${matches.length} matches for ${candidate.kind} candidate`,
        expected: "exactly one visible match",
      });
    }
  }
  throw new ReplayStepError({
    code: "TARGET_NOT_FOUND",
    message: `Target ${target.description} was not present in the fresh observation.`,
    retryable: true,
    retryKind: "target_not_found",
    observed: "zero matching visible elements",
    expected: "exactly one visible match",
  });
}

function fingerprintScore(rule: FingerprintRule, observation: SurfaceObservation): number {
  const route = normalized(observation.route);
  const haystack = normalized(`${observation.title}\n${observation.visibleText}`);
  let possible = 0;
  let matched = 0;
  for (const signal of rule.signals) {
    possible += signal.weight;
    const expected = normalized(signal.value);
    const passes =
      signal.kind === "route"
        ? routeMatches(signal.value, observation.route) || route === expected
        : haystack.includes(expected);
    if (passes) matched += signal.weight;
  }
  return possible > 0 ? matched / possible : 0;
}

function materializeExpression(
  expression: ValueExpression,
  state: ExecutionState,
): ValueExpression {
  if (expression.kind === "input" || expression.kind === "literal") return expression;
  const value = bindValueExpression(expression, {
    inputs: state.inputs,
    stepOutputs: state.stepOutputs,
    ...(state.resolveSecret ? { resolveSecret: state.resolveSecret } : {}),
  });
  return {
    kind: "literal",
    value,
    classification: expression.kind === "secret_ref" ? "secret" : "internal",
    rationale:
      "Materialized in memory for deterministic dispatch; never persisted in the artifact.",
  };
}

function materializePredicate(predicate: Predicate, state: ExecutionState): Predicate {
  if (predicate.kind === "all" || predicate.kind === "any") {
    return {
      kind: predicate.kind,
      predicates: predicate.predicates.map((item) => {
        if (item.kind !== "target_value_equals") return item;
        return { ...item, expected: materializeExpression(item.expected, state) };
      }),
    };
  }
  if (predicate.kind === "not") {
    return {
      kind: "not",
      predicate:
        predicate.predicate.kind === "target_value_equals"
          ? {
              ...predicate.predicate,
              expected: materializeExpression(predicate.predicate.expected, state),
            }
          : predicate.predicate,
    };
  }
  return predicate.kind === "target_value_equals"
    ? { ...predicate, expected: materializeExpression(predicate.expected, state) }
    : predicate;
}

function predicateContext(state: ExecutionState): PredicateContext {
  return {
    outputs: state.outputs,
    inputs: { ...state.inputs },
    targets: state.targets,
    grant: state.grant,
    expectedUrl: state.currentUrl,
  };
}

function normalizeStepError(error: unknown): NormalizedStepError {
  if (error instanceof ReplayStepError) return error.normalized;
  if (error instanceof RecoverableReplayError) {
    const code: AutomationFault["code"] =
      error.retryKind === "target_not_found"
        ? "TARGET_NOT_FOUND"
        : error.retryKind === "known_transient"
          ? "SESSION_LOST"
          : "POSTCONDITION_FAILED";
    return {
      code,
      message: error.message,
      retryable: true,
      retryKind: error.retryKind,
      ...(error.retryKind === "known_transient"
        ? { interventionReason: "SESSION_EXPIRED" as const }
        : {}),
    };
  }
  if (error instanceof ReplayTimeoutError) {
    return {
      code: "POSTCONDITION_FAILED",
      message: error.message,
      retryable: true,
      retryKind: "postcondition_timeout",
      observed: "step deadline elapsed",
      expected: "action and checkpoint within the declared timeout",
    };
  }
  if (error instanceof PolicyDeniedError) {
    return {
      code: "POLICY_DENIED",
      message: error.message,
      retryable: false,
      observed: error.decision.code,
      expected: "all policy layers authorize the exact request",
      ...(error.decision.code === "APPROVAL_REQUIRED"
        ? { interventionReason: "RISK_APPROVAL_REQUIRED" as const }
        : {}),
    };
  }
  if (error instanceof ControlError) {
    return {
      code: error.code === "LEASE_EXPIRED" ? "SESSION_LOST" : "CONTROL_LOST",
      message: error.message,
      retryable: false,
      observed: error.code,
      expected: "a current automation control lease",
    };
  }
  if (error instanceof ArtifactBindingError) {
    return {
      code: "INPUT_INVALID",
      message: error.message,
      retryable: false,
      observed: error.code,
      expected: error.path,
    };
  }
  const record =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; retryKind?: unknown })
      : undefined;
  if (record?.code === "TARGET_NOT_FOUND") {
    return {
      code: "TARGET_NOT_FOUND",
      message: messageOf(error),
      retryable: true,
      retryKind: "target_not_found",
    };
  }
  if (record?.code === "TARGET_AMBIGUOUS") {
    return { code: "TARGET_AMBIGUOUS", message: messageOf(error), retryable: false };
  }
  if (record?.retryKind === "known_transient") {
    return {
      code: "SESSION_LOST",
      message: messageOf(error),
      retryable: true,
      retryKind: "known_transient",
      interventionReason: "SESSION_EXPIRED",
    };
  }
  return { code: "INTERNAL_ERROR", message: messageOf(error), retryable: false };
}

function faultFrom(
  error: NormalizedStepError,
  phase: AutomationFault["phase"],
  stepId?: string,
): AutomationFault {
  return {
    code: error.code,
    message: error.message,
    phase,
    retryable: error.retryable,
    ...(stepId ? { stepId } : {}),
    ...(error.expected ? { expected: error.expected } : {}),
    ...(error.observed ? { observed: error.observed } : {}),
    evidence: [],
  };
}

export class ReplayEngine {
  readonly #surface: SurfaceAdapter;
  readonly #control: ControlCoordinator;
  readonly #platformPolicy: PolicyLayer;
  readonly #evidence?: ReplayEngineOptions["evidence"];
  readonly #screenshotRedactionVerified: boolean;
  readonly #resolveSecret?: ReplayEngineOptions["resolveSecret"];
  readonly #now: () => Date;
  readonly #sleep: (durationMs: number) => Promise<void>;
  readonly #runTimeoutMs: number;
  readonly #closeSessionOnFinish: boolean;
  readonly #surfaceSentinels: readonly ReplaySurfaceSentinel[];
  readonly #artifactApprovalMode: "strict" | "non_strict";
  readonly #onIntervention?: ReplayEngineOptions["onIntervention"];

  constructor(options: ReplayEngineOptions) {
    if (!Number.isSafeInteger(options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)) {
      throw new TypeError("runTimeoutMs must be a safe integer.");
    }
    this.#surface = options.surface;
    this.#control = options.control;
    this.#platformPolicy = options.platformPolicy;
    this.#evidence = options.evidence;
    this.#screenshotRedactionVerified = options.screenshotRedactionVerified ?? false;
    this.#resolveSecret = options.resolveSecret;
    this.#now = options.now ?? (() => new Date());
    this.#sleep =
      options.sleep ??
      ((durationMs) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
    this.#runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.#closeSessionOnFinish = options.closeSessionOnFinish ?? true;
    this.#surfaceSentinels = options.surfaceSentinels ?? [];
    if (
      options.artifactApprovalMode !== undefined &&
      options.artifactApprovalMode !== "strict" &&
      options.artifactApprovalMode !== "non_strict"
    ) {
      throw new TypeError("artifactApprovalMode must be strict or non_strict.");
    }
    this.#artifactApprovalMode = options.artifactApprovalMode ?? "strict";
    this.#onIntervention = options.onIntervention;
    if (this.#runTimeoutMs < 100 || this.#runTimeoutMs > 30 * 60_000) {
      throw new RangeError("runTimeoutMs must be between 100ms and 30 minutes.");
    }
  }

  async run(invocation: ReplayInvocation): Promise<RunResult> {
    const startedAt = validDate(this.#now);
    const runId = safeIdentifier(invocation.runId, `replay-${randomUUID()}`);
    const boundApproval = invocation.approval
      ? snapshotBoundApproval(invocation.approval)
      : undefined;
    const preflight = this.#preflight(invocation, startedAt);
    if (!preflight.ok) {
      return {
        status: "failed",
        error: preflight.fault,
        meta: this.#meta(
          runId,
          preflight.artifactId,
          preflight.artifactDigest,
          "preflight-none",
          startedAt,
          0,
        ),
      };
    }

    const { artifact, binding, inputs, targets, policy, entryUrl } = preflight;
    const artifactApprovalDigest =
      invocation.artifactApproval === undefined
        ? undefined
        : computeArtifactApprovalDigest(invocation.artifactApproval);
    const consumedBoundApprovalIds = new Set<string>();
    let sessionId = "session-pending";
    let grant: ControlGrant | undefined;
    let state: ExecutionState | undefined;
    try {
      // Policy is checked before session creation, so a denied entrypoint never touches a surface.
      const entryAuthorization = enforcePolicy(policy, {
        url: entryUrl,
        command: "navigate",
        effect: "read",
        actor: "replay",
        runId,
        operationId: ENTRYPOINT_OPERATION_ID,
        capabilityDigest: artifact.digest,
        ...(boundApproval ? { approval: boundApproval } : {}),
        now: validDate(this.#now),
      });
      consumeBoundApproval(
        entryAuthorization.authorization,
        boundApproval,
        consumedBoundApprovalIds,
      );

      const session = await this.#surface.createSession(binding, surfaceAccessPolicy(policy));
      sessionId = session.id;
      grant = this.#control.createAutomationLease(sessionId, runId);
      await this.#event({
        runId,
        type: "replay.started",
        artifactId: artifact.id,
        artifactDigest: artifact.digest,
        artifactApprovalMode: this.#artifactApprovalMode,
        ...(artifactApprovalDigest ? { artifactApprovalDigest } : {}),
        sessionId,
        modelCalls: ZERO_MODEL_CALLS,
      });
      await this.#surface.navigate(sessionId, entryUrl, grant);
      const observation = await this.#surface.observe(sessionId);
      state = {
        runId,
        artifact,
        inputs,
        targets,
        outputs: {},
        stepOutputs: {},
        policy,
        bindingOrigin: binding.origin,
        session,
        ...(boundApproval ? { approval: boundApproval } : {}),
        consumedBoundApprovalIds,
        ...(this.#resolveSecret ? { resolveSecret: this.#resolveSecret } : {}),
        sessionId,
        grant,
        currentUrl: observation.url,
        latestObservation: observation,
        actionSequence: 0,
        handledInterventions: 0,
      };

      this.#assertSurfaceCompatible(artifact, binding.expectedFingerprint, observation);

      const deadline = Date.now() + this.#runTimeoutMs;
      for (const step of artifact.steps) {
        if (Date.now() > deadline) {
          throw new ReplayStepError({
            code: "RUN_TIMEOUT",
            message: "Replay exceeded its configured run deadline.",
            retryable: false,
          });
        }
        state.currentStepId = step.id;
        const outcome = await this.#executeStepWithHandoff(step, state);
        if (outcome) {
          const evidence = await this.#checkpointEvidence(state, `outcome-${outcome.code}`);
          const snapshot = await this.#control.complete(state.grant);
          const result: RunResult = {
            status: "business_outcome",
            outcome: {
              code: outcome.code,
              message: outcome.description,
              details: { stepId: step.id, predicateMatched: true },
            },
            evidence,
            meta: this.#meta(
              runId,
              artifact.id,
              artifact.digest,
              sessionId,
              startedAt,
              snapshot.epoch,
            ),
          };
          await this.#completeEvent(result);
          await this.#closeFinishedSession(sessionId);
          return result;
        }
      }

      const knownOutcome = await this.#knownOutcome(state);
      if (knownOutcome) {
        const evidence = await this.#checkpointEvidence(state, `outcome-${knownOutcome.code}`);
        const snapshot = await this.#control.complete(state.grant);
        const result: RunResult = {
          status: "business_outcome",
          outcome: {
            code: knownOutcome.code,
            message: knownOutcome.description,
            details: { checkpoint: "terminal", predicateMatched: true },
          },
          evidence,
          meta: this.#meta(
            runId,
            artifact.id,
            artifact.digest,
            sessionId,
            startedAt,
            snapshot.epoch,
          ),
        };
        await this.#completeEvent(result);
        await this.#closeFinishedSession(sessionId);
        return result;
      }

      const outputs = validateArtifactOutputs(artifact, state.outputs);
      const terminal = await this.#surface.evaluate(
        sessionId,
        materializePredicate(artifact.success, state),
        predicateContext(state),
      );
      if (!terminal.passed) {
        throw new ReplayStepError({
          code: "POSTCONDITION_FAILED",
          message: "The compound terminal checkpoint did not pass.",
          retryable: false,
          expected: "all artifact success predicates",
          observed: terminal.observed,
        });
      }

      const checkpointEvidence = await this.#checkpointEvidence(state, "terminal-checkpoint");
      const snapshot = await this.#control.complete(state.grant);
      const result: RunResult = {
        status: "succeeded",
        outputs: { ...outputs },
        checkpointEvidence,
        meta: this.#meta(runId, artifact.id, artifact.digest, sessionId, startedAt, snapshot.epoch),
      };
      await this.#completeEvent(result);
      await this.#closeFinishedSession(sessionId);
      return result;
    } catch (error: unknown) {
      const normalizedError = normalizeStepError(error);
      if (state && this.#shouldIntervene(error, normalizedError)) {
        const failureEvidence = await this.#checkpointEvidence(
          state,
          `intervention-${normalizedError.code}`,
        ).catch(() => []);
        const intervention = await this.#toIntervention(state, normalizedError, failureEvidence);
        await this.#event({
          runId,
          type: "replay.intervention",
          code: normalizedError.code,
          sessionId,
          modelCalls: ZERO_MODEL_CALLS,
        });
        const result: RunResult = {
          status: "needs_intervention",
          intervention,
          meta: this.#meta(
            runId,
            artifact.id,
            artifact.digest,
            sessionId,
            startedAt,
            intervention.ownerEpoch,
          ),
        };
        await this.#completeEvent(result);
        return result;
      }

      const failureEvidence = state
        ? await this.#checkpointEvidence(state, `failure-${normalizedError.code}`).catch(() => [])
        : [];
      const currentGrant = state?.grant ?? grant;
      const ownerEpoch = currentGrant
        ? await this.#failControl(currentGrant, normalizedError.message)
        : 0;
      const fault = {
        ...faultFrom(normalizedError, "replay", state?.currentStepId),
        evidence: failureEvidence,
      };
      await this.#event({
        runId,
        type: "replay.failed",
        code: fault.code,
        sessionId,
        modelCalls: ZERO_MODEL_CALLS,
      }).catch(() => undefined);
      const result: RunResult = {
        status: "failed",
        error: fault,
        meta: this.#meta(runId, artifact.id, artifact.digest, sessionId, startedAt, ownerEpoch),
      };
      await this.#completeEvent(result).catch(() => undefined);
      if (sessionId !== "session-pending") await this.#closeFinishedSession(sessionId);
      return result;
    }
  }

  #preflight(invocation: ReplayInvocation, now: Date): PreflightResult {
    let artifact: CapabilityArtifact;
    try {
      artifact = assertValidArtifact(invocation.artifact);
    } catch (error: unknown) {
      const digestMismatch =
        error instanceof ArtifactCompilationError &&
        error.issues.some((issue) => issue.code === "DIGEST_MISMATCH");
      return {
        ok: false,
        artifactId: "invalid-artifact",
        artifactDigest: "0".repeat(64),
        fault: faultFrom(
          {
            code: digestMismatch ? "ARTIFACT_DIGEST_MISMATCH" : "ARTIFACT_INVALID",
            message: digestMismatch
              ? "The compiled capability digest does not match its reviewed content."
              : "The capability artifact failed strict schema or safety validation.",
            retryable: false,
            observed: messageOf(error),
          },
          "preflight",
        ),
      };
    }

    try {
      if (this.#artifactApprovalMode === "strict" && invocation.artifactApproval === undefined) {
        throw new ArtifactApprovalError(
          "Strict replay requires a trusted artifact approval record.",
        );
      }
      if (invocation.artifactApproval !== undefined) {
        assertArtifactApproval(artifact, invocation.artifactApproval, now);
      }
      const binding = AppBindingSchema.parse(invocation.binding);
      const inputs = bindArtifactInputs(artifact, invocation.inputs);
      const targets = bindReviewedTargetOverrides(artifact, binding, now);
      if (
        artifact.compatibility.product.vendor !== binding.product.vendor ||
        artifact.compatibility.product.product !== binding.product.product
      ) {
        throw new TypeError("Artifact and tenant binding identify different products.");
      }
      const bindingRoute = binding.entrypoints[artifact.entrypoint.bindingKey];
      if (!bindingRoute) {
        throw new TypeError("The selected binding has no artifact entrypoint key.");
      }
      const route = artifact.entrypoint.route ?? bindingRoute;
      const policy: PolicyStack = {
        platform: this.#platformPolicy,
        binding: bindingPolicyLayer(binding),
        capability: capabilityPolicyLayer(artifact.policyRequirements),
      };
      return {
        ok: true,
        artifact,
        binding,
        inputs,
        targets,
        policy,
        entryUrl: invocationEntryUrl(invocation.targetUrl, binding.origin, route),
      };
    } catch (error: unknown) {
      const inputError = error instanceof ArtifactBindingError;
      const approvalError = error instanceof ArtifactApprovalError;
      const targetOverrideError = error instanceof TargetOverrideReviewError;
      return {
        ok: false,
        artifactId: artifact.id,
        artifactDigest: artifact.digest,
        fault: faultFrom(
          {
            code: inputError ? "INPUT_INVALID" : "ARTIFACT_INVALID",
            message: inputError
              ? "Replay inputs failed the artifact contract."
              : approvalError
                ? "Replay requires a current approval for this exact artifact."
                : targetOverrideError
                  ? "A target override is missing its exact trusted review."
                  : "The app binding is invalid or incompatible with the artifact.",
            retryable: false,
            observed: messageOf(error),
          },
          "preflight",
        ),
      };
    }
  }

  #assertSurfaceCompatible(
    artifact: CapabilityArtifact,
    bindingFingerprint: FingerprintRule,
    observation: SurfaceObservation,
  ): void {
    const artifactScore = fingerprintScore(artifact.compatibility.fingerprint, observation);
    const bindingScore = fingerprintScore(bindingFingerprint, observation);
    if (
      artifactScore < artifact.compatibility.fingerprint.minimumScore ||
      bindingScore < bindingFingerprint.minimumScore
    ) {
      throw new ReplayStepError({
        code: "INCOMPATIBLE_SURFACE",
        message: "The live surface did not meet the artifact and tenant fingerprint thresholds.",
        retryable: false,
        expected: `artifact>=${artifact.compatibility.fingerprint.minimumScore}, binding>=${bindingFingerprint.minimumScore}`,
        observed: `artifact=${artifactScore.toFixed(2)}, binding=${bindingScore.toFixed(2)}`,
      });
    }
  }

  async #executeStepWithHandoff(
    step: Step,
    state: ExecutionState,
  ): Promise<CapabilityArtifact["contract"]["outcomes"][number] | undefined> {
    try {
      return await this.#executeStep(step, state);
    } catch (error: unknown) {
      const normalizedError = normalizeStepError(error);
      if (
        !this.#onIntervention ||
        state.handledInterventions >= 1 ||
        !this.#shouldIntervene(error, normalizedError)
      ) {
        throw error;
      }
      await this.#handleIntervention(state, normalizedError);
      return this.#executeStep(step, state);
    }
  }

  async #handleIntervention(state: ExecutionState, error: NormalizedStepError): Promise<void> {
    if (!this.#onIntervention || !state.currentStepId) {
      throw new ReplayStepError(error);
    }
    const previousGrant = state.grant;
    const previousObservationId = state.latestObservation.id;
    const resolution = await this.#onIntervention({
      runId: state.runId,
      artifactId: state.artifact.id,
      session: state.session,
      currentStepId: state.currentStepId,
      reason: error.interventionReason ?? "STUCK",
      summary: error.message,
      observedState: error.observed ?? "Replay reached a typed intervention boundary.",
      automationGrant: previousGrant,
      observation: state.latestObservation,
    });

    if (resolution.automationGrant.sessionId === state.sessionId) {
      try {
        this.#control.assertGrant(resolution.automationGrant, "automation");
        state.grant = resolution.automationGrant;
      } catch {
        // The validation below reports a stale/invalid return. Keeping the
        // prior grant lets outer cleanup revoke whichever candidate is valid.
      }
    }

    if (
      resolution.sessionId !== state.sessionId ||
      resolution.automationGrant.sessionId !== state.sessionId ||
      resolution.observation.sessionId !== state.sessionId
    ) {
      throw new ReplayStepError({
        code: "CONTROL_LOST",
        message: "Intervention attempted to replace the live replay session.",
        retryable: false,
        expected: state.sessionId,
        observed: resolution.sessionId,
      });
    }

    let previousGrantInvalid = false;
    try {
      this.#control.assertGrant(previousGrant);
    } catch (grantError: unknown) {
      previousGrantInvalid =
        grantError instanceof ControlError && grantError.code === "CONTROL_LOST";
    }
    if (!previousGrantInvalid) {
      throw new ReplayStepError({
        code: "CONTROL_LOST",
        message: "Intervention returned without revoking the prior automation grant.",
        retryable: false,
        expected: "a stale prior lease epoch",
        observed: `epoch=${previousGrant.epoch}`,
      });
    }

    this.#control.assertGrant(resolution.automationGrant, "automation");
    if (resolution.automationGrant.epoch <= previousGrant.epoch) {
      throw new ReplayStepError({
        code: "CONTROL_LOST",
        message: "Intervention did not return a newer automation lease epoch.",
        retryable: false,
        expected: `epoch>${previousGrant.epoch}`,
        observed: `epoch=${resolution.automationGrant.epoch}`,
      });
    }

    state.grant = resolution.automationGrant;
    state.latestObservation = resolution.observation;
    state.currentUrl = resolution.observation.url;
    if (resolution.observation.id === previousObservationId) {
      throw new ReplayStepError({
        code: "POSTCONDITION_FAILED",
        message: "Intervention resume did not provide a fresh surface observation.",
        retryable: false,
        expected: "a new observation ID after operator control",
        observed: resolution.observation.id,
      });
    }
    if (!resolution.checkpoint.passed) {
      throw new ReplayStepError({
        code: "POSTCONDITION_FAILED",
        message: "Intervention resume checkpoint did not pass.",
        retryable: false,
        expected: "a passing same-session recovery checkpoint",
        observed: resolution.checkpoint.observed,
      });
    }

    state.handledInterventions += 1;
    await this.#event({
      runId: state.runId,
      type: "replay.intervention.resumed",
      sessionId: state.sessionId,
      stepId: state.currentStepId,
      priorOwnerEpoch: previousGrant.epoch,
      newOwnerEpoch: resolution.automationGrant.epoch,
      observationId: resolution.observation.id,
      checkpointPassed: resolution.checkpoint.passed,
      modelCalls: ZERO_MODEL_CALLS,
    });
  }

  async #executeStep(
    step: Step,
    state: ExecutionState,
  ): Promise<CapabilityArtifact["contract"]["outcomes"][number] | undefined> {
    let lastError: NormalizedStepError | undefined;
    for (let attempt = 1; attempt <= step.retry.maxAttempts; attempt += 1) {
      await this.#event({
        runId: state.runId,
        type: "replay.step.attempt",
        stepId: step.id,
        command: step.command,
        attempt,
        maxAttempts: step.retry.maxAttempts,
        modelCalls: ZERO_MODEL_CALLS,
      });
      try {
        const outcome = await this.#withTimeout(
          async (signal) => {
            await this.#performStep(step, state, signal);
            this.#throwIfAborted(signal);
            const knownOutcome = await this.#knownOutcome(state, signal);
            if (knownOutcome) return knownOutcome;
            await this.#checkSurfaceSentinels(state, signal);
            this.#throwIfAborted(signal);
            const checkpoint = await this.#surface.evaluate(
              state.sessionId,
              materializePredicate(step.postcondition, state),
              predicateContext(state),
              signal,
            );
            this.#throwIfAborted(signal);
            if (!checkpoint.passed) {
              throw new ReplayStepError({
                code: "POSTCONDITION_FAILED",
                message: `Postcondition failed for step ${step.id}.`,
                retryable: true,
                retryKind: "postcondition_timeout",
                expected: "declared step postcondition",
                observed: checkpoint.observed,
              });
            }
            return undefined;
          },
          step.timeoutMs,
          step.id,
        );
        if (outcome) return outcome;
        await this.#event({
          runId: state.runId,
          type: "replay.step.completed",
          stepId: step.id,
          command: step.command,
          attempt,
          modelCalls: ZERO_MODEL_CALLS,
        });
        return undefined;
      } catch (error: unknown) {
        const outcome = await this.#knownOutcome(state).catch(() => undefined);
        if (outcome) return outcome;
        lastError = normalizeStepError(error);
        const configuredRetry =
          lastError.retryKind !== undefined && step.retry.retryOn.includes(lastError.retryKind);
        if (configuredRetry && attempt < step.retry.maxAttempts) {
          await this.#event({
            runId: state.runId,
            type: "replay.step.retry",
            stepId: step.id,
            attempt,
            retryKind: lastError.retryKind,
            modelCalls: ZERO_MODEL_CALLS,
          });
          if (step.retry.delayMs > 0) await this.#sleep(step.retry.delayMs);
          state.latestObservation = await this.#surface.observe(state.sessionId);
          state.currentUrl = state.latestObservation.url;
          continue;
        }
        if (configuredRetry && attempt === step.retry.maxAttempts) {
          throw new ReplayStepError({
            code: "RECOVERY_EXHAUSTED",
            message: `Step ${step.id} exhausted ${attempt} bounded attempt${attempt === 1 ? "" : "s"}.`,
            retryable: false,
            ...(lastError.expected ? { expected: lastError.expected } : {}),
            observed: lastError.observed ?? lastError.message,
            ...(lastError.interventionReason
              ? { interventionReason: lastError.interventionReason }
              : {}),
          });
        }
        throw new ReplayStepError(lastError, { cause: error });
      }
    }
    throw new ReplayStepError(
      lastError ?? {
        code: "INTERNAL_ERROR",
        message: `Step ${step.id} exited without a result.`,
        retryable: false,
      },
    );
  }

  async #performStep(step: Step, state: ExecutionState, signal: AbortSignal): Promise<void> {
    this.#throwIfAborted(signal);
    this.#authorize(step, state);
    switch (step.command) {
      case "set_value": {
        const target = this.#target(state, step.target);
        const observed = resolveReplayElement(target, state.latestObservation);
        const decision: ModelDecision = {
          kind: "set_value",
          decisionId: `replay-action-${++state.actionSequence}`,
          observationId: state.latestObservation.id,
          rationale: "Deterministic artifact replay action.",
          elementRef: observed.ref,
          value: materializeExpression(step.value, state),
        };
        await this.#surface.dispatch(state.sessionId, decision, {
          observationId: state.latestObservation.id,
          inputs: { ...state.inputs },
          grant: state.grant,
          signal,
          expectedUrl: state.currentUrl,
        });
        this.#throwIfAborted(signal);
        break;
      }
      case "activate": {
        const target = this.#target(state, step.target);
        const observed = resolveReplayElement(target, state.latestObservation);
        const decision: ModelDecision = {
          kind: "activate",
          decisionId: `replay-action-${++state.actionSequence}`,
          observationId: state.latestObservation.id,
          rationale: "Deterministic artifact replay action.",
          elementRef: observed.ref,
        };
        await this.#surface.dispatch(state.sessionId, decision, {
          observationId: state.latestObservation.id,
          inputs: { ...state.inputs },
          grant: state.grant,
          signal,
          expectedUrl: state.currentUrl,
        });
        this.#throwIfAborted(signal);
        break;
      }
      case "press_key":
        resolveReplayElement(this.#target(state, step.target), state.latestObservation);
        await this.#surface.pressKey(
          state.sessionId,
          step.key,
          state.grant,
          signal,
          state.currentUrl,
        );
        this.#throwIfAborted(signal);
        break;
      case "wait_for": {
        const maxPolls = Math.max(1, Math.ceil(step.timeoutMs / DEFAULT_POLL_INTERVAL_MS));
        let passed = false;
        for (let poll = 1; poll <= maxPolls; poll += 1) {
          const result = await this.#surface.evaluate(
            state.sessionId,
            materializePredicate(step.condition, state),
            predicateContext(state),
            signal,
          );
          this.#throwIfAborted(signal);
          if (result.passed) {
            passed = true;
            break;
          }
          if (poll < maxPolls) {
            await this.#abortableSleep(Math.min(DEFAULT_POLL_INTERVAL_MS, step.timeoutMs), signal);
          }
        }
        if (!passed) {
          throw new ReplayTimeoutError(`Wait condition timed out for step ${step.id}.`);
        }
        break;
      }
      case "extract": {
        const target = this.#target(state, step.extractor.target);
        const value = await this.#surface.extract(
          state.sessionId,
          target,
          step.extractor,
          signal,
          state.grant,
          state.currentUrl,
        );
        this.#throwIfAborted(signal);
        state.outputs[step.output] = value;
        state.stepOutputs[step.id] = { [step.output]: value };
        break;
      }
      case "navigate":
        {
          const targetUrl = pathUrl(state.bindingOrigin, step.route);
          await this.#surface.navigate(state.sessionId, targetUrl, state.grant, signal);
          this.#throwIfAborted(signal);
          state.currentUrl = targetUrl;
        }
        break;
      case "capture_evidence":
        await this.#checkpointEvidence(state, step.label, signal);
        this.#throwIfAborted(signal);
        break;
    }
    const observation = await this.#surface.observe(state.sessionId, signal);
    this.#throwIfAborted(signal);
    state.latestObservation = observation;
    state.currentUrl = observation.url;
  }

  #authorize(step: Step, state: ExecutionState): void {
    const url =
      step.command === "navigate" ? pathUrl(state.bindingOrigin, step.route) : state.currentUrl;
    const decision = enforcePolicy(state.policy, {
      url,
      command: step.command,
      effect: step.effect,
      actor: "replay",
      runId: state.runId,
      operationId: step.id,
      capabilityDigest: state.artifact.digest,
      sessionId: state.sessionId,
      ownerEpoch: state.grant.epoch,
      ...(state.approval ? { approval: state.approval } : {}),
      now: validDate(this.#now),
    });
    consumeBoundApproval(decision.authorization, state.approval, state.consumedBoundApprovalIds);
  }

  #target(state: ExecutionState, targetId: string): TargetSpec {
    const target = state.targets[targetId];
    if (target) return target;
    throw new ReplayStepError({
      code: "ARTIFACT_INVALID",
      message: `Artifact target ${targetId} is unavailable at replay time.`,
      retryable: false,
    });
  }

  async #knownOutcome(
    state: ExecutionState,
    signal?: AbortSignal,
  ): Promise<CapabilityArtifact["contract"]["outcomes"][number] | undefined> {
    for (const outcome of state.artifact.contract.outcomes) {
      try {
        if (signal) this.#throwIfAborted(signal);
        const result = await this.#surface.evaluate(
          state.sessionId,
          materializePredicate(outcome.when, state),
          predicateContext(state),
          signal,
        );
        if (signal) this.#throwIfAborted(signal);
        if (result.passed) return outcome;
      } catch (error: unknown) {
        const normalizedError = normalizeStepError(error);
        if (
          normalizedError.code !== "TARGET_NOT_FOUND" &&
          normalizedError.code !== "TARGET_AMBIGUOUS"
        ) {
          throw error;
        }
      }
    }
    return undefined;
  }

  async #checkSurfaceSentinels(state: ExecutionState, signal: AbortSignal): Promise<void> {
    for (const sentinel of this.#surfaceSentinels) {
      this.#throwIfAborted(signal);
      sentinel.pattern.lastIndex = 0;
      if (!sentinel.pattern.test(state.latestObservation.visibleText)) continue;
      if (sentinel.kind === "hard_failure") {
        throw new ReplayStepError({
          code: sentinel.code,
          message: sentinel.message,
          retryable: false,
          observed: sentinel.code,
          expected: "no hard-failure sentinel",
        });
      }
      if (sentinel.kind === "intervention") {
        throw new ReplayStepError({
          code: sentinel.reason === "SESSION_EXPIRED" ? "SESSION_LOST" : "DEAD_END",
          message: sentinel.message,
          retryable: false,
          interventionReason: sentinel.reason,
          observed: sentinel.reason,
          expected: "an automation-owned recoverable surface",
        });
      }

      const maxChecks = sentinel.maxChecks ?? 20;
      const delayMs = sentinel.delayMs ?? 100;
      if (!Number.isSafeInteger(maxChecks) || maxChecks < 1 || maxChecks > 100) {
        throw new TypeError("Recoverable sentinel maxChecks must be between 1 and 100.");
      }
      if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 10_000) {
        throw new TypeError("Recoverable sentinel delayMs must be between 0 and 10000.");
      }
      for (let check = 1; check <= maxChecks; check += 1) {
        if (delayMs > 0) await this.#abortableSleep(delayMs, signal);
        const observation = await this.#surface.observe(state.sessionId, signal);
        this.#throwIfAborted(signal);
        state.latestObservation = observation;
        state.currentUrl = observation.url;
        sentinel.pattern.lastIndex = 0;
        if (!sentinel.pattern.test(observation.visibleText)) {
          await this.#event({
            runId: state.runId,
            type: "replay.surface.recovered",
            code: sentinel.code,
            checks: check,
            modelCalls: ZERO_MODEL_CALLS,
          });
          return;
        }
      }
      throw new RecoverableReplayError("known_transient", sentinel.summary);
    }
  }

  #shouldIntervene(error: unknown, normalizedError: NormalizedStepError): boolean {
    return (
      (!(error instanceof ControlError) && normalizedError.code === "RECOVERY_EXHAUSTED") ||
      normalizedError.interventionReason !== undefined
    );
  }

  async #toIntervention(
    state: ExecutionState,
    error: NormalizedStepError,
    evidence: InterventionView["evidence"],
  ): Promise<InterventionView> {
    const reason: InterventionView["reason"] = error.interventionReason ?? "STUCK";
    this.#control.requestPause(state.grant, error.message);
    const snapshot = await this.#control.quiesceAutomation(state.grant);
    return {
      id: `intervention-${randomUUID()}`,
      runId: state.runId,
      sessionId: state.sessionId,
      reason,
      summary: error.message,
      ...(state.currentStepId ? { currentStepId: state.currentStepId } : {}),
      observedState: error.observed ?? "Replay stopped at a typed exceptional state.",
      allowedActions: [
        "claim",
        "activate",
        "type",
        "press_key",
        "capture_evidence",
        "resume",
        "abort",
      ],
      evidence,
      ownerEpoch: snapshot.epoch,
      createdAt: validDate(this.#now).toISOString(),
    };
  }

  async #withTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    stepId: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutError = new ReplayTimeoutError(`Step ${stepId} exceeded ${timeoutMs}ms.`);
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    const inFlight = Promise.resolve().then(() => operation(controller.signal));
    try {
      return await Promise.race([
        inFlight,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            controller.abort(timeoutError);
            reject(timeoutError);
          }, timeoutMs);
        }),
      ]);
    } catch (error: unknown) {
      if (!timedOut) throw error;
      // Never retry, revoke ownership, close the session, or return while the losing
      // operation can still mutate the surface. Abort-aware adapters stop promptly;
      // every adapter must at least settle this promise before replay advances.
      await inFlight.catch(() => undefined);
      throw timeoutError;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  #throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new ReplayTimeoutError("Replay step was aborted at its declared deadline.");
  }

  async #abortableSleep(durationMs: number, signal: AbortSignal): Promise<void> {
    this.#throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      this.#sleep(durationMs)
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener("abort", onAbort);
        });
    });
    this.#throwIfAborted(signal);
  }

  async #checkpointEvidence(state: ExecutionState, label: string, signal?: AbortSignal) {
    if (!this.#evidence || !this.#screenshotRedactionVerified) return [];
    if (signal) this.#throwIfAborted(signal);
    const screenshot = await this.#surface.captureEvidence(
      state.sessionId,
      label,
      signal,
      state.currentUrl,
      state.grant,
    );
    if (signal) this.#throwIfAborted(signal);
    const safeLabel = label.replaceAll(/[^A-Za-z0-9._-]/gu, "-").slice(0, 100);
    const ref = await this.#evidence.writeScreenshot(
      `screenshots/${state.runId}-${safeLabel}.png`,
      screenshot,
      {
        redactionVerified: true,
        mimeType: "image/png",
      },
    );
    return [ref];
  }

  async #event(event: {
    readonly runId: string;
    readonly type: string;
    readonly [key: string]: unknown;
  }) {
    await this.#evidence?.appendEvent(event);
  }

  async #completeEvent(result: RunResult): Promise<void> {
    await this.#event({
      runId: result.meta.runId,
      type: "replay.completed",
      timestamp: result.meta.finishedAt,
      status: result.status,
      durationMs: result.meta.durationMs,
      modelCalls: ZERO_MODEL_CALLS,
    });
  }

  async #failControl(grant: ControlGrant, reason: string): Promise<number> {
    try {
      return (await this.#control.fail(grant, reason)).epoch;
    } catch {
      return grant.epoch;
    }
  }

  async #closeFinishedSession(sessionId: string): Promise<void> {
    if (this.#closeSessionOnFinish) await this.#surface.closeSession(sessionId);
  }

  #meta(
    runId: string,
    artifactId: string,
    artifactDigest: string,
    sessionId: string,
    startedAt: Date,
    ownerEpoch: number,
  ): RunMeta {
    const finishedAt = validDate(this.#now);
    return {
      runId,
      artifactId,
      artifactDigest,
      sessionId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: elapsedMs(startedAt, finishedAt),
      modelCalls: ZERO_MODEL_CALLS,
      ownerEpoch,
    };
  }
}

/** Convenience entrypoint for callers that do not need to retain an engine instance. */
export async function replayCapability(
  options: ReplayEngineOptions,
  invocation: ReplayInvocation,
): Promise<RunResult> {
  return new ReplayEngine(options).run(invocation);
}
