import { randomUUID } from "node:crypto";

import {
  AppBindingSchema,
  type AutomationFault,
  type CapabilityArtifact,
  type CapabilityArtifactDraft,
  type CapabilityPolicyRequirements,
  type EffectClass,
  EffectClassSchema,
  IdentifierSchema,
  type InputSpec,
  InputSpecSchema,
  type InterventionView,
  type KnownOutcome,
  type KnownOutcomeSpec,
  KnownOutcomeSpecSchema,
  type ModelDecision,
  ModelDecisionSchema,
  type OutputSpec,
  OutputSpecSchema,
  type Predicate,
  type Step,
  type SurfaceCapability,
  type TargetSpec,
  TargetSpecSchema,
} from "../domain/schema.js";
import {
  computePromptTraceHashFromRequestHashes,
  type DiscoveryPlanner,
  PlannerDecisionError,
  type PlannerResponse,
} from "../model/planner.js";
import type {
  ObservedElement,
  PredicateContext,
  PredicateResult,
  SurfaceAdapter,
  SurfaceObservation,
  SurfaceSession,
} from "../surface/types.js";
import {
  ArtifactBindingError,
  ArtifactCompilationError,
  compileArtifact,
  validateArtifactOutputs,
} from "./artifact.js";
import { constrainedPatternPasses } from "./constrained-pattern.js";
import { type ControlCoordinator, ControlError, type ControlGrant } from "./control.js";
import type { EvidenceRef, EvidenceWriter } from "./evidence.js";
import {
  checkPolicy,
  enforcePolicy,
  PolicyDeniedError,
  type PolicyLayer,
  type PolicyStack,
  type RuntimeCommand,
  surfaceAccessPolicy,
} from "./policy.js";

const DEFAULT_MAX_STEPS = 16;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RECOVERIES = 2;
const DEFAULT_RECOVERY_DELAY_MS = 300;
const MAX_RESULT_MESSAGE = 1_600;

type Policy = PolicyStack | readonly PolicyLayer[];
type DiscoveryModelDecision = Exclude<ModelDecision, { kind: "activate_coordinate" }>;
type DiscoveryModelAction = DiscoveryModelDecision["kind"];
export type InterventionReason = InterventionView["reason"];

export interface DiscoveryOutputBinding {
  readonly source?: "text" | "value";
  readonly transforms?: readonly ("trim" | "currency_to_number" | "number")[];
  /** Stable semantic identity required before this output may be extracted. */
  readonly target: {
    readonly role?: string;
    readonly name?: string;
    readonly precedingLabel?: string;
    readonly rowLabel?: string;
    readonly columnLabel?: string;
  };
}

export interface DiscoveryActivationPolicy {
  /** Exact user-visible identity from the fresh observation, never a CSS selector. */
  readonly role: string;
  readonly name: string;
  readonly effect: EffectClass;
  readonly idempotency: "idempotent" | "non_idempotent";
}

export interface DiscoveryArtifactSpec {
  readonly id: string;
  readonly revision?: number;
  readonly name: string;
  readonly description: string;
  readonly purpose: string;
  readonly entrypointKey: string;
  readonly inputs: Readonly<Record<string, InputSpec>>;
  readonly outputs: Readonly<Record<string, OutputSpec>>;
  readonly outcomes?: readonly KnownOutcomeSpec[];
  /** Durable, reviewed targets used by outcome predicates but not visited in the successful run. */
  readonly staticTargets?: Readonly<Record<string, TargetSpec>>;
  readonly outputBindings?: Readonly<Record<string, DiscoveryOutputBinding>>;
  /** Every activatable control must be explicitly classified before the model may choose it. */
  readonly activationPolicies?: readonly DiscoveryActivationPolicy[];
  readonly versionRange?: string;
  readonly requiredSurfaceCapabilities?: readonly SurfaceCapability[];
  readonly policyRequirements?: CapabilityPolicyRequirements;
  /** Additional independent terminal checkpoints, usually supplied by a binding override. */
  readonly successTargetNames?: readonly string[];
}

export type DiscoverySentinel =
  | {
      readonly kind: "recoverable";
      readonly code: string;
      readonly pattern: RegExp;
      readonly summary: string;
    }
  | {
      readonly kind: "business_outcome";
      readonly code: string;
      readonly pattern: RegExp;
      readonly message: string;
    }
  | {
      readonly kind: "intervention";
      readonly reason: InterventionReason;
      readonly pattern: RegExp;
      readonly summary: string;
    }
  | {
      readonly kind: "hard_failure";
      readonly code: AutomationFault["code"];
      readonly pattern: RegExp;
      readonly message: string;
      readonly retryable?: boolean;
    };

export interface DiscoveryRequest {
  readonly runId?: string;
  readonly goal: string;
  readonly targetUrl: string;
  readonly binding: unknown;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly artifact: DiscoveryArtifactSpec;
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
  readonly maxRecoveries?: number;
  readonly recoveryDelayMs?: number;
  readonly sentinels?: readonly DiscoverySentinel[];
  /** Keep successful/failed sessions open for a caller that owns their lifecycle. */
  readonly retainSession?: boolean;
  readonly persistObservationScreenshots?: boolean;
  /** Must be explicitly true; the adapter is responsible for pixel masking. */
  readonly screenshotsRedactionVerified?: true;
  readonly artifactEvidencePath?: string;
}

export interface DiscoveryEngineOptions {
  readonly surface: SurfaceAdapter;
  readonly planner: DiscoveryPlanner;
  readonly control: ControlCoordinator;
  readonly policy: Policy;
  readonly evidence?: EvidenceWriter;
  /** Optional same-session handoff bridge. One intervention may be resumed per discovery run. */
  readonly onIntervention?: (
    context: DiscoveryInterventionContext,
  ) => Promise<DiscoveryInterventionResolution>;
  readonly now?: () => Date;
  readonly sleep?: (durationMs: number) => Promise<void>;
}

export interface DiscoveryInterventionContext {
  readonly runId: string;
  readonly capabilityId: string;
  readonly session: SurfaceSession;
  readonly reason: InterventionReason;
  readonly summary: string;
  readonly automationGrant: ControlGrant;
  readonly observation: SurfaceObservation;
  readonly intervention: InterventionView;
}

export interface DiscoveryInterventionResolution {
  readonly sessionId: string;
  readonly automationGrant: ControlGrant;
  readonly observation: SurfaceObservation;
  readonly checkpoint: { readonly passed: boolean; readonly observed: string };
}

export interface DiscoveryResultBase {
  readonly runId: string;
  readonly sessionId: string | null;
  readonly modelCalls: number;
  readonly recoveries: number;
  readonly evidence: readonly EvidenceRef[];
}

export type DiscoveryResult =
  | (DiscoveryResultBase & {
      readonly status: "succeeded";
      readonly artifact: CapabilityArtifact;
      readonly outputs: Readonly<Record<string, unknown>>;
    })
  | (DiscoveryResultBase & {
      readonly status: "business_outcome";
      readonly outcome: KnownOutcome;
    })
  | (DiscoveryResultBase & {
      readonly status: "needs_intervention";
      readonly intervention: InterventionView;
    })
  | (DiscoveryResultBase & {
      readonly status: "failed";
      readonly error: AutomationFault;
    });

interface RecordedActivation {
  readonly stepIndex: number;
  readonly afterObservationId: string;
  readonly fallbackRoute: string;
}

interface MutableRun {
  readonly runId: string;
  readonly startedAtMs: number;
  readonly sessionId: string;
  readonly session: SurfaceSession;
  grant: ControlGrant;
  observation: SurfaceObservation;
  readonly inputs: Record<string, unknown>;
  readonly outputs: Record<string, unknown>;
  readonly targets: Record<string, TargetSpec>;
  readonly targetNamesBySignature: Map<string, string>;
  readonly outputTargets: Map<string, string>;
  readonly steps: Step[];
  readonly pendingActivations: RecordedActivation[];
  readonly evidence: EvidenceRef[];
  recoveries: number;
  handledInterventions: number;
  modelCalls: number;
  readonly promptRequestHashes: string[];
  sequence: number;
}

type Signal =
  | Exclude<DiscoverySentinel, { kind: "business_outcome" }>
  | { readonly kind: "business_outcome"; readonly outcome: KnownOutcome };

class DiscoveryFault extends Error {
  constructor(readonly fault: AutomationFault) {
    super(fault.message);
    this.name = "DiscoveryFault";
  }
}

function boundedText(value: string, fallback: string): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  return (normalized || fallback).slice(0, MAX_RESULT_MESSAGE);
}

function slug(value: string, fallback: string): string {
  const result = value
    .normalize("NFKD")
    .replaceAll(/[^A-Za-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 80);
  const safe = result && /^[A-Za-z]/u.test(result) ? result : `${fallback}-${result || "target"}`;
  return safe.length >= 2 ? safe : `${fallback}-target`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function boundInputNames(run: MutableRun): string[] {
  return unique(
    run.steps.flatMap((step) =>
      step.command === "set_value" && step.value.kind === "input" ? [step.value.name] : [],
    ),
  );
}

function decisionCommand(decision: DiscoveryModelDecision): RuntimeCommand | undefined {
  switch (decision.kind) {
    case "set_value":
      return "set_value";
    case "activate":
      return "activate";
    case "wait":
      return "wait_for";
    case "extract":
      return "extract";
    case "finish":
    case "request_help":
      return undefined;
  }
}

function activationPolicyFor(
  element: ObservedElement | undefined,
  artifact: DiscoveryArtifactSpec,
): DiscoveryActivationPolicy | undefined {
  if (!element?.role || !element.name) return undefined;
  return artifact.activationPolicies?.find(
    (policy) => policy.role === element.role && policy.name === element.name,
  );
}

function matchesOutputTarget(
  element: ObservedElement,
  target: DiscoveryOutputBinding["target"],
): boolean {
  return (
    (target.role === undefined || element.role === target.role) &&
    (target.name === undefined || element.name === target.name) &&
    (target.precedingLabel === undefined ||
      element.context.precedingLabel === target.precedingLabel) &&
    (target.rowLabel === undefined || element.context.rowLabel === target.rowLabel) &&
    (target.columnLabel === undefined || element.context.columnLabel === target.columnLabel)
  );
}

function decisionEffect(
  decision: DiscoveryModelDecision,
  element: ObservedElement | undefined,
  artifact: DiscoveryArtifactSpec,
): EffectClass {
  if (decision.kind === "set_value") return "reversible_write";
  if (decision.kind === "activate") {
    // Unclassified activation is treated as irreversible. Discovery has no implicit approval,
    // so the policy stack blocks it instead of guessing that a button is safe.
    return activationPolicyFor(element, artifact)?.effect ?? "commit";
  }
  return "read";
}

function targetSignature(element: ObservedElement): string {
  return JSON.stringify({
    framePath: element.framePath,
    role: element.role ?? "",
    name: element.name ?? "",
    precedingLabel: element.context.precedingLabel ?? "",
    rowLabel: element.context.rowLabel ?? "",
    columnLabel: element.context.columnLabel ?? "",
  });
}

function elementForDecision(
  observation: SurfaceObservation,
  decision: DiscoveryModelDecision,
): ObservedElement | undefined {
  if (!("elementRef" in decision)) return undefined;
  return observation.elements.find((element) => element.ref === decision.elementRef);
}

function defaultOutputBinding(
  spec: OutputSpec,
): Required<Pick<DiscoveryOutputBinding, "source" | "transforms">> {
  if (spec.validator.kind === "number") {
    return { source: "text", transforms: ["trim", "currency_to_number"] };
  }
  return { source: "text", transforms: ["trim"] };
}

function matcherNames(predicate: Predicate): string[] {
  if (predicate.kind === "all" || predicate.kind === "any") {
    return predicate.predicates.flatMap(matcherNames);
  }
  if (predicate.kind === "not") return matcherNames(predicate.predicate);
  if (
    predicate.kind === "target_visible" ||
    predicate.kind === "target_text_matches" ||
    predicate.kind === "target_value_equals"
  ) {
    return [predicate.target];
  }
  return [];
}

function inputValueValid(value: unknown, spec: InputSpec): boolean {
  if (value === undefined) return !spec.required;
  const validator = spec.validator;
  if (validator.kind === "string") {
    if (typeof value !== "string") return false;
    if (validator.minLength !== undefined && value.length < validator.minLength) return false;
    if (validator.maxLength !== undefined && value.length > validator.maxLength) return false;
    if (validator.enum && !validator.enum.includes(value)) return false;
    if (validator.pattern) {
      try {
        if (!constrainedPatternPasses(validator.pattern, value, validator.maxLength ?? 0)) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }
  if (validator.kind === "number") {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (validator.minimum === undefined || value >= validator.minimum) &&
      (validator.maximum === undefined || value <= validator.maximum) &&
      (validator.integer !== true || Number.isInteger(value))
    );
  }
  return typeof value === "boolean";
}

function assertBoundedInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a safe integer between ${minimum} and ${maximum}.`);
  }
}

function reasonFromModel(
  reason: Extract<ModelDecision, { kind: "request_help" }>["reason"],
): InterventionReason {
  switch (reason) {
    case "expired_session":
      return "SESSION_EXPIRED";
    case "risky":
      return "RISK_APPROVAL_REQUIRED";
    case "unsafe":
      return "UNSAFE_ACTION";
    case "stuck":
      return "STUCK";
    case "unknown_state":
      return "UNKNOWN_STATE";
  }
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
  return typeof value.code === "string" ? value.code : undefined;
}

function isModelDecisionError(error: unknown): boolean {
  return (
    error instanceof PlannerDecisionError ||
    error instanceof SyntaxError ||
    error?.constructor?.name === "ZodError"
  );
}

export class DiscoveryEngine {
  readonly #surface: SurfaceAdapter;
  readonly #planner: DiscoveryPlanner;
  readonly #control: ControlCoordinator;
  readonly #policy: Policy;
  readonly #evidence: EvidenceWriter | undefined;
  readonly #onIntervention: DiscoveryEngineOptions["onIntervention"];
  readonly #now: () => Date;
  readonly #sleep: (durationMs: number) => Promise<void>;

  constructor(options: DiscoveryEngineOptions) {
    this.#surface = options.surface;
    this.#planner = options.planner;
    this.#control = options.control;
    this.#policy = options.policy;
    this.#evidence = options.evidence;
    this.#onIntervention = options.onIntervention;
    this.#now = options.now ?? (() => new Date());
    this.#sleep =
      options.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  }

  async discover(request: DiscoveryRequest): Promise<DiscoveryResult> {
    const runId = request.runId ?? `discovery-${randomUUID()}`;
    let run: MutableRun | undefined;
    let terminal: DiscoveryResult | undefined;
    let orphanSessionId: string | undefined;
    let retainSession = request.retainSession === true;

    try {
      const preflight = this.#preflight(request, runId);
      const session = await this.#surface.createSession(
        preflight.binding,
        surfaceAccessPolicy(this.#policy),
      );
      orphanSessionId = session.id;
      const grant = this.#control.createAutomationLease(session.id, runId);
      run = {
        runId,
        startedAtMs: this.#now().getTime(),
        sessionId: session.id,
        session,
        grant,
        observation: undefined as unknown as SurfaceObservation,
        inputs: { ...request.inputs },
        outputs: {},
        targets: this.#staticTargets(request),
        targetNamesBySignature: new Map(),
        outputTargets: new Map(),
        steps: [],
        pendingActivations: [],
        evidence: [],
        recoveries: 0,
        handledInterventions: 0,
        modelCalls: 0,
        promptRequestHashes: [],
        sequence: 0,
      };
      orphanSessionId = undefined;

      await this.#emit(run, "run.started", { mode: "discovery" });
      enforcePolicy(this.#policy, {
        url: preflight.targetUrl,
        command: "navigate",
        effect: "read",
        actor: "discovery",
        runId,
        sessionId: session.id,
        ownerEpoch: grant.epoch,
      });
      await this.#surface.navigate(session.id, preflight.targetUrl, grant);
      run.observation = await this.#observe(run, request);

      terminal = await this.#runLoop(run, request, preflight.binding, preflight.route);
      if (terminal.status === "needs_intervention") retainSession = true;
      return terminal;
    } catch (error) {
      if (!run) {
        const fault = this.#faultFromError(error, []);
        terminal = {
          status: "failed",
          runId,
          sessionId: null,
          modelCalls: 0,
          recoveries: 0,
          evidence: [],
          error: fault,
        };
        return terminal;
      }
      const fault = this.#faultFromError(error, run.evidence);
      await this.#emit(run, "fault.raised", { code: fault.code, summary: fault.message }).catch(
        () => undefined,
      );
      try {
        await this.#control.fail(run.grant, fault.message);
      } catch {
        // A stale grant is itself represented by the terminal fault.
      }
      terminal = {
        status: "failed",
        runId,
        sessionId: run.sessionId,
        modelCalls: run.modelCalls,
        recoveries: run.recoveries,
        evidence: run.evidence,
        error: fault,
      };
      await this.#emit(run, "run.completed", {
        status: "failed",
        modelCalls: run.modelCalls,
      }).catch(() => undefined);
      return terminal;
    } finally {
      if (orphanSessionId) {
        await this.#surface.closeSession(orphanSessionId).catch(() => undefined);
      }
      if (run && terminal && terminal.status !== "needs_intervention" && !retainSession) {
        await this.#surface.closeSession(run.sessionId).catch(() => undefined);
      }
    }
  }

  #preflight(
    request: DiscoveryRequest,
    runId: string,
  ): { binding: ReturnType<typeof AppBindingSchema.parse>; targetUrl: string; route: string } {
    IdentifierSchema.parse(runId);
    const binding = AppBindingSchema.parse(request.binding);
    if (Object.keys(binding.targetOverrides).length > 0) {
      throw new TypeError(
        "Discovery forbids binding target overrides; compile against the current surface and review overrides only for replay.",
      );
    }
    if (!request.goal.trim()) throw new TypeError("Discovery goal cannot be empty.");
    IdentifierSchema.parse(request.artifact.id);
    IdentifierSchema.parse(request.artifact.entrypointKey);
    const entrypoint = binding.entrypoints[request.artifact.entrypointKey];
    if (!entrypoint) throw new TypeError("The requested binding entrypoint does not exist.");

    const parsed = new URL(request.targetUrl, binding.origin);
    if (parsed.origin !== binding.origin || parsed.username || parsed.password) {
      throw new TypeError(
        "Discovery target must use the binding's exact origin without credentials.",
      );
    }
    if (parsed.pathname !== entrypoint) {
      throw new TypeError("Discovery target path must match the selected binding entrypoint.");
    }
    parsed.hash = "";

    const inputNames = Object.keys(request.artifact.inputs);
    const outputNames = Object.keys(request.artifact.outputs);
    if (outputNames.length === 0)
      throw new TypeError("Discovery requires at least one declared output.");
    for (const [name, spec] of Object.entries(request.artifact.inputs)) {
      IdentifierSchema.parse(name);
      InputSpecSchema.parse(spec);
      if (!inputValueValid(request.inputs[name], spec)) {
        throw new ArtifactBindingError(
          "INPUT_INVALID",
          `$.inputs.${name}`,
          `Input ${name} does not satisfy its declared contract.`,
        );
      }
    }
    const unknownInputs = Object.keys(request.inputs).filter((name) => !inputNames.includes(name));
    if (unknownInputs.length > 0) {
      throw new ArtifactBindingError(
        "INPUT_INVALID",
        `$.inputs.${unknownInputs[0]}`,
        "Invocation contains an undeclared input.",
      );
    }
    for (const [name, spec] of Object.entries(request.artifact.outputs)) {
      IdentifierSchema.parse(name);
      OutputSpecSchema.parse(spec);
      const bindingSpec = request.artifact.outputBindings?.[name];
      if (!bindingSpec) {
        throw new TypeError(`Discovery output ${name} requires a semantic output binding.`);
      }
      if (
        bindingSpec.source !== undefined &&
        bindingSpec.source !== "text" &&
        bindingSpec.source !== "value"
      ) {
        throw new TypeError(`Discovery output ${name} has an invalid extraction source.`);
      }
      for (const transform of bindingSpec.transforms ?? []) {
        if (transform !== "trim" && transform !== "currency_to_number" && transform !== "number") {
          throw new TypeError(`Discovery output ${name} has an invalid transform.`);
        }
      }
      const targetEntries = Object.entries(bindingSpec.target);
      if (
        targetEntries.length === 0 ||
        targetEntries.some(([, value]) => typeof value !== "string" || !value.trim())
      ) {
        throw new TypeError(
          `Discovery output ${name} requires at least one non-empty semantic target field.`,
        );
      }
    }
    const unknownOutputBindings = Object.keys(request.artifact.outputBindings ?? {}).filter(
      (name) => !outputNames.includes(name),
    );
    if (unknownOutputBindings.length > 0) {
      throw new TypeError(`Discovery output binding ${unknownOutputBindings[0]} is undeclared.`);
    }
    for (const outcome of request.artifact.outcomes ?? []) KnownOutcomeSpecSchema.parse(outcome);
    for (const [name, target] of Object.entries(request.artifact.staticTargets ?? {})) {
      IdentifierSchema.parse(name);
      TargetSpecSchema.parse(target);
    }
    const activationKeys = new Set<string>();
    for (const policy of request.artifact.activationPolicies ?? []) {
      if (!policy.role.trim() || !policy.name.trim()) {
        throw new TypeError("Discovery activation policies require an exact role and name.");
      }
      EffectClassSchema.parse(policy.effect);
      if (policy.idempotency !== "idempotent" && policy.idempotency !== "non_idempotent") {
        throw new TypeError("Discovery activation policy idempotency is invalid.");
      }
      const key = `${policy.role}\u0000${policy.name}`;
      if (activationKeys.has(key)) {
        throw new TypeError("Discovery activation policies cannot duplicate a control identity.");
      }
      activationKeys.add(key);
    }
    for (const sentinel of request.sentinels ?? []) {
      if ("code" in sentinel) IdentifierSchema.parse(sentinel.code);
      if (!(sentinel.pattern instanceof RegExp)) {
        throw new TypeError("Discovery sentinel patterns must be regular expressions.");
      }
    }

    const maxSteps = request.maxSteps ?? DEFAULT_MAX_STEPS;
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRecoveries = request.maxRecoveries ?? DEFAULT_MAX_RECOVERIES;
    const recoveryDelayMs = request.recoveryDelayMs ?? DEFAULT_RECOVERY_DELAY_MS;
    assertBoundedInteger(maxSteps, "maxSteps", 1, 100);
    assertBoundedInteger(timeoutMs, "timeoutMs", 1_000, 10 * 60_000);
    assertBoundedInteger(maxRecoveries, "maxRecoveries", 0, 10);
    assertBoundedInteger(recoveryDelayMs, "recoveryDelayMs", 0, 10_000);

    return { binding, targetUrl: parsed.toString(), route: parsed.pathname };
  }

  #staticTargets(request: DiscoveryRequest): Record<string, TargetSpec> {
    const outcomes = request.artifact.outcomes ?? [];
    const required = new Set([
      ...outcomes.flatMap((outcome) => matcherNames(outcome.when)),
      ...(request.artifact.successTargetNames ?? []),
    ]);
    const available = { ...(request.artifact.staticTargets ?? {}) };
    const selected: Record<string, TargetSpec> = {};
    for (const name of required) {
      const target = available[name];
      if (target) selected[name] = target;
    }
    return selected;
  }

  async #runLoop(
    run: MutableRun,
    request: DiscoveryRequest,
    binding: ReturnType<typeof AppBindingSchema.parse>,
    entrypointRoute: string,
  ): Promise<DiscoveryResult> {
    const maxSteps = request.maxSteps ?? DEFAULT_MAX_STEPS;
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRecoveries = request.maxRecoveries ?? DEFAULT_MAX_RECOVERIES;
    const recoveryDelayMs = request.recoveryDelayMs ?? DEFAULT_RECOVERY_DELAY_MS;

    for (let stepCount = 0; stepCount < maxSteps; stepCount += 1) {
      if (this.#now().getTime() - run.startedAtMs > timeoutMs) {
        throw this.#fault(
          "RUN_TIMEOUT",
          "Discovery exceeded its configured wall-clock bound.",
          true,
          run.evidence,
        );
      }

      const signal = await this.#signal(run, request);
      if (signal?.kind === "business_outcome") {
        await this.#control.complete(run.grant);
        await this.#emit(run, "run.completed", {
          status: "business_outcome",
          modelCalls: run.modelCalls,
        });
        return {
          status: "business_outcome",
          runId: run.runId,
          sessionId: run.sessionId,
          modelCalls: run.modelCalls,
          recoveries: run.recoveries,
          evidence: run.evidence,
          outcome: signal.outcome,
        };
      }
      if (signal?.kind === "hard_failure") {
        throw this.#fault(signal.code, signal.message, signal.retryable ?? false, run.evidence);
      }
      if (signal?.kind === "intervention") {
        const intervention = await this.#intervene(run, request, signal.reason, signal.summary);
        if (intervention) return intervention;
        continue;
      }
      if (signal?.kind === "recoverable") {
        run.recoveries += 1;
        await this.#emit(run, "recovery.attempted", {
          code: signal.code,
          attempt: run.recoveries,
          summary: signal.summary,
        });
        if (run.recoveries > maxRecoveries) {
          throw this.#fault(
            "RECOVERY_EXHAUSTED",
            "A known transient state exceeded its bounded recovery budget.",
            false,
            run.evidence,
          );
        }
        await this.#sleep(recoveryDelayMs);
        run.observation = await this.#observe(run, request);
        stepCount -= 1;
        continue;
      }

      const allowedActions = this.#allowedActions(run, request);
      const allowedOutputRefs = this.#allowedOutputRefs(run, request);
      const allowedElementRefs = this.#allowedElementRefs(run, request, allowedOutputRefs);
      let response: PlannerResponse;
      run.modelCalls += 1;
      try {
        response = await this.#planner.decide({
          goal: request.goal,
          inputs: { ...run.inputs },
          inputSpecs: request.artifact.inputs,
          boundInputs: boundInputNames(run),
          outputs: { ...run.outputs },
          outputSpecs: request.artifact.outputs,
          observation: run.observation,
          allowedActions,
          allowedElementRefs,
          allowedOutputRefs,
        });
      } catch (error) {
        throw this.#fault(
          isModelDecisionError(error) ? "MODEL_INVALID_DECISION" : "MODEL_UNAVAILABLE",
          isModelDecisionError(error)
            ? "The planner returned a response outside the structured decision contract."
            : "The discovery planner was unavailable.",
          !isModelDecisionError(error),
          run.evidence,
        );
      }

      let decision: ModelDecision;
      try {
        if (
          response.provider !== this.#planner.provider ||
          response.model !== this.#planner.model ||
          !/^[a-f0-9]{64}$/u.test(response.promptRequestHash)
        ) {
          throw new PlannerDecisionError(
            "The planner response provenance does not match its configured identity or request hash contract.",
          );
        }
        decision = ModelDecisionSchema.parse(response.decision);
        this.#assertFreshDecision(run, decision, allowedActions, request);
      } catch (error) {
        throw this.#fault(
          "MODEL_INVALID_DECISION",
          boundedText(
            error instanceof Error ? error.message : "Invalid model decision.",
            "Invalid model decision.",
          ),
          false,
          run.evidence,
        );
      }
      run.promptRequestHashes.push(response.promptRequestHash);
      await this.#emit(run, "model.decision", {
        provider: response.provider,
        modelId: response.model,
        decision,
      });

      if (decision.kind === "request_help") {
        const intervention = await this.#intervene(
          run,
          request,
          reasonFromModel(decision.reason),
          decision.summary,
        );
        if (intervention) return intervention;
        continue;
      }
      if (decision.kind === "finish") {
        return this.#finish(run, request, binding, entrypointRoute);
      }

      await this.#executeDecision(run, request, binding, decision);
    }

    throw this.#fault(
      "MAX_STEPS",
      "Discovery exhausted its configured observe-decide-act step budget.",
      false,
      run.evidence,
    );
  }

  #assertFreshDecision(
    run: MutableRun,
    decision: ModelDecision,
    allowedActions: readonly DiscoveryModelAction[],
    request: DiscoveryRequest,
  ): asserts decision is DiscoveryModelDecision {
    if (decision.observationId !== run.observation.id) {
      throw new Error("The planner referenced a stale or invented observation ID.");
    }
    if (decision.kind === "activate_coordinate") {
      throw new Error(
        "Model coordinate activation is forbidden; discovery requires a current semantic element reference.",
      );
    }
    if (!allowedActions.includes(decision.kind)) {
      throw new Error(`The planner selected disallowed action ${decision.kind}.`);
    }
    if (decision.kind === "extract" && !(decision.output in request.artifact.outputs)) {
      throw new Error("The planner selected an undeclared output.");
    }
    if (decision.kind === "set_value") {
      if (decision.value.kind !== "input" || !(decision.value.name in request.artifact.inputs)) {
        throw new Error("Set-value discovery accepts declared input references only.");
      }
      if (boundInputNames(run).includes(decision.value.name)) {
        throw new Error("The planner attempted to repeat an input binding that already passed.");
      }
    }
    if (
      "elementRef" in decision &&
      !run.observation.elements.some((item) => item.ref === decision.elementRef)
    ) {
      throw new Error("The planner referenced an element absent from the current observation.");
    }
    if (
      "elementRef" in decision &&
      (decision.kind === "set_value" ||
        decision.kind === "activate" ||
        decision.kind === "extract") &&
      !this.#allowedElementRefs(run, request)[decision.kind].includes(decision.elementRef)
    ) {
      throw new Error(`The planner referenced an element not authorized for ${decision.kind}.`);
    }
    if (
      decision.kind === "extract" &&
      !this.#allowedOutputRefs(run, request)[decision.output]?.includes(decision.elementRef)
    ) {
      throw new Error("The planner referenced an element not authorized for the selected output.");
    }
  }

  #allowedOutputRefs(
    run: MutableRun,
    request: DiscoveryRequest,
  ): Readonly<Record<string, readonly string[]>> {
    return Object.fromEntries(
      Object.keys(request.artifact.outputs)
        .filter((outputName) => run.outputs[outputName] === undefined)
        .map((outputName) => {
          const bindingSpec = request.artifact.outputBindings?.[outputName];
          const refs = bindingSpec
            ? run.observation.elements
                .filter((element) => matchesOutputTarget(element, bindingSpec.target))
                .map((element) => element.ref)
            : [];
          return [outputName, refs] as const;
        }),
    );
  }

  #allowedElementRefs(
    run: MutableRun,
    request: DiscoveryRequest,
    outputRefs: Readonly<Record<string, readonly string[]>> = this.#allowedOutputRefs(run, request),
  ): Readonly<Record<"set_value" | "activate" | "extract", readonly string[]>> {
    const url = run.observation.url;
    return {
      set_value: run.observation.elements
        .filter(
          (element) =>
            element.enabled &&
            element.interactive &&
            (element.inputType !== undefined ||
              element.role === "textbox" ||
              element.role === "combobox" ||
              element.role === "searchbox" ||
              element.role === "spinbutton"),
        )
        .map((element) => element.ref),
      activate: run.observation.elements
        .filter((element) => {
          if (!element.enabled || !element.interactive) return false;
          const activation = activationPolicyFor(element, request.artifact);
          if (!activation) return false;
          return checkPolicy(this.#policy, {
            url,
            command: "activate",
            effect: activation.effect,
            actor: "discovery",
            runId: run.runId,
            sessionId: run.sessionId,
            ownerEpoch: run.grant.epoch,
          }).allowed;
        })
        .map((element) => element.ref),
      extract: unique(Object.values(outputRefs).flat()),
    };
  }

  #allowedActions(run: MutableRun, request: DiscoveryRequest): DiscoveryModelAction[] {
    const url = run.observation.url;
    const outputsComplete = Object.keys(request.artifact.outputs).every(
      (outputName) => run.outputs[outputName] !== undefined,
    );
    const activationEffects = run.observation.elements.flatMap((element) => {
      const policy = activationPolicyFor(element, request.artifact);
      return policy ? [policy.effect] : [];
    });
    const activationAllowed = activationEffects.some(
      (effect) =>
        checkPolicy(this.#policy, {
          url,
          command: "activate",
          effect,
          actor: "discovery",
          runId: run.runId,
          sessionId: run.sessionId,
          ownerEpoch: run.grant.epoch,
        }).allowed,
    );
    const alreadyBound = new Set(boundInputNames(run));
    const hasUnboundInput = Object.keys(request.artifact.inputs).some(
      (inputName) => !alreadyBound.has(inputName),
    );
    const hasEligibleOutput = Object.values(this.#allowedOutputRefs(run, request)).some(
      (refs) => refs.length > 0,
    );
    const candidates: Array<{
      kind: DiscoveryModelAction;
      command?: RuntimeCommand;
      effect: EffectClass;
      enabled: boolean;
    }> = [
      {
        kind: "set_value",
        command: "set_value",
        effect: "reversible_write",
        enabled: !outputsComplete && hasUnboundInput,
      },
      {
        kind: "activate",
        effect: "read",
        enabled: !outputsComplete && activationAllowed,
      },
      { kind: "wait", command: "wait_for", effect: "read", enabled: !outputsComplete },
      {
        kind: "extract",
        command: "extract",
        effect: "read",
        enabled: !outputsComplete && hasEligibleOutput,
      },
      {
        kind: "finish",
        effect: "read",
        enabled: outputsComplete,
      },
      { kind: "request_help", effect: "read", enabled: true },
    ];
    return candidates.flatMap((candidate) => {
      if (!candidate.enabled) return [];
      if (!candidate.command) return [candidate.kind];
      const decision = checkPolicy(this.#policy, {
        url,
        command: candidate.command,
        effect: candidate.effect,
        actor: "discovery",
        runId: run.runId,
        sessionId: run.sessionId,
        ownerEpoch: run.grant.epoch,
      });
      return decision.allowed ? [candidate.kind] : [];
    });
  }

  async #executeDecision(
    run: MutableRun,
    request: DiscoveryRequest,
    _binding: ReturnType<typeof AppBindingSchema.parse>,
    decision: Exclude<DiscoveryModelDecision, { kind: "finish" | "request_help" }>,
  ): Promise<void> {
    const command = decisionCommand(decision);
    if (!command) throw new Error("A surface decision must have a policy command.");
    const observedElement = elementForDecision(run.observation, decision);
    const activationPolicy =
      decision.kind === "activate"
        ? activationPolicyFor(observedElement, request.artifact)
        : undefined;
    if (decision.kind === "activate" && !activationPolicy) {
      throw this.#fault(
        "POLICY_DENIED",
        "Discovery refused an activation without an exact reviewed effect and idempotency policy.",
        false,
        run.evidence,
      );
    }
    const effect =
      activationPolicy?.effect ?? decisionEffect(decision, observedElement, request.artifact);
    const url = run.observation.url;
    enforcePolicy(this.#policy, {
      url,
      command,
      effect,
      actor: "discovery",
      runId: run.runId,
      sessionId: run.sessionId,
      ownerEpoch: run.grant.epoch,
    });

    const inputName =
      decision.kind === "set_value" && decision.value.kind === "input"
        ? decision.value.name
        : undefined;
    if (decision.kind === "set_value" && inputName === undefined) {
      throw new Error("Set-value discovery accepts input expressions only.");
    }
    let targetName: string | undefined;
    if (observedElement) {
      const purpose =
        decision.kind === "extract"
          ? `Output ${decision.output}`
          : decision.kind === "set_value"
            ? `Input ${inputName}`
            : `Action ${observedElement.name ?? observedElement.context.precedingLabel ?? observedElement.role ?? "control"}`;
      targetName = this.#compileObservedTarget(run, observedElement, purpose, decision);
      this.#resolvePendingActivation(run, targetName);
    }

    await this.#emit(run, "action.dispatched", {
      command,
      effect,
      ...(targetName ? { target: targetName } : {}),
    });
    const receipt = await this.#surface.dispatch(run.sessionId, decision, {
      observationId: run.observation.id,
      inputs: run.inputs,
      grant: run.grant,
      expectedUrl: run.observation.url,
    });

    if (decision.kind === "extract") {
      if (!targetName) throw new Error("Extraction target was not compiled.");
      const outputSpec = request.artifact.outputs[decision.output];
      if (!outputSpec) throw new Error("Extraction output is undeclared.");
      const configured = request.artifact.outputBindings?.[decision.output];
      const defaults = defaultOutputBinding(outputSpec);
      const bindingSpec = {
        source: configured?.source ?? defaults.source,
        transforms: [...(configured?.transforms ?? defaults.transforms)],
      };
      const extractor =
        bindingSpec.source === "value"
          ? ({
              kind: "target_value",
              target: targetName,
              transforms: bindingSpec.transforms,
            } as const)
          : ({
              kind: "target_text",
              target: targetName,
              transforms: bindingSpec.transforms,
            } as const);
      run.outputs[decision.output] = await this.#surface.extract(
        run.sessionId,
        run.targets[targetName] as TargetSpec,
        extractor,
        undefined,
        run.grant,
        run.observation.url,
      );
      run.outputTargets.set(decision.output, targetName);
      run.steps.push({
        id: `step-${String(run.steps.length + 1).padStart(2, "0")}-extract-${slug(decision.output, "output")}`,
        description: `Extract and validate ${decision.output}.`,
        command: "extract",
        output: decision.output,
        extractor,
        effect: "read",
        idempotency: "idempotent",
        timeoutMs: 5_000,
        retry: { maxAttempts: 2, delayMs: 150, retryOn: ["target_not_found"] },
        postcondition: { kind: "output_valid", output: decision.output },
      });
    } else if (decision.kind === "set_value") {
      if (!targetName) throw new Error("Set-value target was not compiled.");
      run.steps.push({
        id: `step-${String(run.steps.length + 1).padStart(2, "0")}-set-${slug(inputName ?? "input", "input")}`,
        description: `Bind the invocation ${inputName ?? "input"} to the observed control.`,
        command: "set_value",
        target: targetName,
        value: decision.value,
        effect: "reversible_write",
        idempotency: "idempotent",
        timeoutMs: 5_000,
        retry: { maxAttempts: 2, delayMs: 100, retryOn: ["target_not_found"] },
        postcondition: {
          kind: "target_value_equals",
          target: targetName,
          expected: decision.value,
        },
      });
    } else if (decision.kind === "activate") {
      if (!targetName) throw new Error("Activation target was not compiled.");
      if (!activationPolicy) throw new Error("Activation policy precondition was not retained.");
      const retryable =
        activationPolicy.effect !== "commit" && activationPolicy.idempotency === "idempotent";
      run.steps.push({
        id: `step-${String(run.steps.length + 1).padStart(2, "0")}-activate-${slug(targetName, "action")}`,
        description: `Activate the observed ${activationPolicy.effect} control.`,
        command: "activate",
        target: targetName,
        effect: activationPolicy.effect,
        idempotency: activationPolicy.idempotency,
        timeoutMs: 7_500,
        retry: {
          maxAttempts: retryable ? 2 : 1,
          delayMs: retryable ? 200 : 0,
          retryOn: retryable
            ? ["target_not_found", "postcondition_timeout", "known_transient"]
            : [],
        },
        postcondition: { kind: "route_matches", route: run.observation.route },
      });
    } else {
      run.steps.push({
        id: `step-${String(run.steps.length + 1).padStart(2, "0")}-wait`,
        description: "Wait for the observed surface to reach a stable known state.",
        command: "wait_for",
        condition: { kind: "surface_fingerprint", minimumScore: 0.6 },
        effect: "read",
        idempotency: "idempotent",
        timeoutMs: Math.max(500, decision.durationMs),
        retry: { maxAttempts: 1, delayMs: 0, retryOn: [] },
        postcondition: { kind: "surface_fingerprint", minimumScore: 0.6 },
      });
    }

    const beforeObservationId = run.observation.id;
    run.observation = await this.#observe(run, request);
    if (decision.kind === "activate") {
      run.pendingActivations.push({
        stepIndex: run.steps.length - 1,
        afterObservationId: run.observation.id,
        fallbackRoute: run.observation.route,
      });
    }
    if (decision.kind === "set_value" && targetName) {
      const result = await this.#surface.evaluate(
        run.sessionId,
        {
          kind: "target_value_equals",
          target: targetName,
          expected: decision.value,
        },
        this.#predicateContext(run),
      );
      if (!result.passed) {
        throw this.#fault(
          "POSTCONDITION_FAILED",
          "The set-value action did not satisfy its verified postcondition.",
          true,
          run.evidence,
        );
      }
    }
    await this.#emit(run, "action.completed", {
      command,
      durationMs: receipt.durationMs,
      changedSurface: receipt.changedSurface,
      previousObservationId: beforeObservationId,
      observationId: run.observation.id,
      summary: receipt.summary,
    });
  }

  #compileObservedTarget(
    run: MutableRun,
    element: ObservedElement,
    description: string,
    decision: Exclude<ModelDecision, { kind: "finish" | "request_help" }>,
  ): string {
    const signature = targetSignature(element);
    const existing = run.targetNamesBySignature.get(signature);
    if (existing) return existing;

    const inputName =
      decision.kind === "set_value" && decision.value.kind === "input"
        ? decision.value.name
        : undefined;
    const preferred =
      decision.kind === "extract"
        ? `output-${slug(decision.output, "output")}`
        : decision.kind === "set_value"
          ? `input-${slug(inputName ?? "input", "input")}`
          : `${slug(element.role ?? "action", "action")}-${slug(
              element.name ??
                element.context.precedingLabel ??
                element.context.rowLabel ??
                "control",
              "control",
            )}`;
    let name = preferred;
    let suffix = 2;
    while (name in run.targets) {
      name = `${preferred}-${suffix}`;
      suffix += 1;
    }
    const target = this.#surface.compileTarget(run.observation.id, element.ref, description);
    run.targets[name] = target;
    run.targetNamesBySignature.set(signature, name);
    return name;
  }

  #resolvePendingActivation(run: MutableRun, nextTarget: string): void {
    const pending = run.pendingActivations.find(
      (item) => item.afterObservationId === run.observation.id,
    );
    if (!pending) return;
    const step = run.steps[pending.stepIndex];
    if (step?.command === "activate") {
      step.postcondition = { kind: "target_visible", target: nextTarget, expected: true };
    }
    run.pendingActivations.splice(run.pendingActivations.indexOf(pending), 1);
  }

  async #finish(
    run: MutableRun,
    request: DiscoveryRequest,
    binding: ReturnType<typeof AppBindingSchema.parse>,
    entrypointRoute: string,
  ): Promise<DiscoveryResult> {
    for (const pending of run.pendingActivations) {
      const step = run.steps[pending.stepIndex];
      if (step?.command === "activate") {
        step.postcondition = { kind: "route_matches", route: pending.fallbackRoute };
      }
    }

    const successTargets = unique([
      ...run.outputTargets.values(),
      ...(request.artifact.successTargetNames ?? []),
    ]);
    if (successTargets.length === 0) {
      throw this.#fault(
        "POSTCONDITION_FAILED",
        "The planner finished without an independent surface checkpoint.",
        false,
        run.evidence,
      );
    }

    const effects = unique(run.steps.map((step) => step.effect));
    const commands = unique(run.steps.map((step) => step.command));
    const policyRequirements = request.artifact.policyRequirements ?? {
      allowedRoutes: [entrypointRoute],
      allowedCommands: commands,
      allowedEffects: effects,
      approvalRequiredFor: effects.includes("commit") ? ["commit"] : [],
    };
    const successPredicates = [
      ...Object.keys(request.artifact.outputs).map(
        (output) => ({ kind: "output_valid", output }) as const,
      ),
      ...successTargets.map(
        (target) => ({ kind: "target_visible", target, expected: true }) as const,
      ),
    ];

    const draft: CapabilityArtifactDraft = {
      schemaVersion: "1.0.0",
      id: request.artifact.id,
      revision: request.artifact.revision ?? 1,
      name: request.artifact.name,
      description: request.artifact.description,
      purpose: request.artifact.purpose,
      compatibility: {
        product: {
          vendor: binding.product.vendor,
          product: binding.product.product,
          ...(request.artifact.versionRange ? { versionRange: request.artifact.versionRange } : {}),
        },
        requiredSurfaceCapabilities: [
          ...(request.artifact.requiredSurfaceCapabilities ?? [
            "accessibility_tree",
            "dom",
            "frames",
            "screenshot",
            "visual_anchors",
          ]),
        ],
        fingerprint: binding.expectedFingerprint,
      },
      entrypoint: { bindingKey: request.artifact.entrypointKey, route: entrypointRoute },
      contract: {
        inputs: { ...request.artifact.inputs },
        outputs: { ...request.artifact.outputs },
        outcomes: [...(request.artifact.outcomes ?? [])],
      },
      targets: run.targets,
      effects,
      policyRequirements,
      steps: run.steps,
      success: { kind: "all", predicates: successPredicates },
      provenance: {
        discoveryRunId: run.runId,
        provider: this.#planner.provider,
        modelId: this.#planner.model,
        promptHash: computePromptTraceHashFromRequestHashes(
          this.#planner.transport,
          run.promptRequestHashes,
        ),
        liveModel: this.#planner.live,
        createdAt: this.#now().toISOString(),
      },
    };
    const artifact = compileArtifact(draft);
    const outputs = validateArtifactOutputs(artifact, run.outputs);
    const checkpoint = await this.#surface.evaluate(
      run.sessionId,
      artifact.success,
      this.#predicateContext(run),
    );
    if (!checkpoint.passed) {
      throw this.#fault(
        "POSTCONDITION_FAILED",
        "The model reported completion before the runtime terminal checkpoint passed.",
        false,
        run.evidence,
      );
    }

    if (this.#evidence) {
      const artifactRef = await this.#evidence.writeJson(
        request.artifactEvidencePath ?? "artifact.json",
        artifact,
        "artifact",
      );
      run.evidence.push(artifactRef);
    }
    await this.#control.complete(run.grant);
    await this.#emit(run, "run.completed", {
      status: "succeeded",
      artifactId: artifact.id,
      artifactDigest: artifact.digest,
      modelCalls: run.modelCalls,
    });
    return {
      status: "succeeded",
      runId: run.runId,
      sessionId: run.sessionId,
      modelCalls: run.modelCalls,
      recoveries: run.recoveries,
      evidence: run.evidence,
      artifact,
      outputs,
    };
  }

  async #signal(run: MutableRun, request: DiscoveryRequest): Promise<Signal | undefined> {
    for (const outcome of request.artifact.outcomes ?? []) {
      let evaluated: PredicateResult;
      try {
        evaluated = await this.#surface.evaluate(
          run.sessionId,
          outcome.when,
          this.#predicateContext(run),
        );
      } catch (error) {
        if (errorCode(error) === "TARGET_NOT_FOUND") continue;
        throw error;
      }
      if (evaluated.passed) {
        return {
          kind: "business_outcome",
          outcome: {
            code: outcome.code,
            message: outcome.description,
            details: {},
          },
        };
      }
    }
    for (const sentinel of request.sentinels ?? []) {
      sentinel.pattern.lastIndex = 0;
      if (!sentinel.pattern.test(run.observation.visibleText)) continue;
      if (sentinel.kind === "business_outcome") {
        return {
          kind: "business_outcome",
          outcome: { code: sentinel.code, message: sentinel.message, details: {} },
        };
      }
      return sentinel;
    }
    return undefined;
  }

  async #intervene(
    run: MutableRun,
    request: DiscoveryRequest,
    reason: InterventionReason,
    summary: string,
  ): Promise<DiscoveryResult | undefined> {
    const previousGrant = run.grant;
    const previousObservationId = run.observation.id;
    this.#control.requestPause(run.grant, summary);
    const paused = await this.#control.quiesceAutomation(run.grant);
    const intervention: InterventionView = {
      id: `intervention-${randomUUID()}`,
      runId: run.runId,
      sessionId: run.sessionId,
      reason,
      summary: boundedText(summary, "Human review is required."),
      observedState: boundedText(run.observation.visibleText, "Surface state unavailable."),
      allowedActions: [
        "claim",
        "activate",
        "type",
        "press_key",
        "capture_evidence",
        "resume",
        "abort",
      ],
      evidence: run.evidence,
      ownerEpoch: paused.epoch,
      createdAt: this.#now().toISOString(),
    };
    await this.#emit(run, "intervention.created", { intervention, ownerEpoch: paused.epoch });
    if (this.#onIntervention && run.handledInterventions < 1) {
      const resolution = await this.#onIntervention({
        runId: run.runId,
        capabilityId: request.artifact.id,
        session: run.session,
        reason,
        summary,
        automationGrant: previousGrant,
        observation: run.observation,
        intervention,
      });
      if (resolution.automationGrant.sessionId === run.sessionId) {
        try {
          this.#control.assertGrant(resolution.automationGrant, "automation");
          run.grant = resolution.automationGrant;
        } catch {
          // The structured validation below reports an invalid or stale return;
          // keep the prior grant when the candidate does not currently own control.
        }
      }
      if (
        resolution.sessionId !== run.sessionId ||
        resolution.automationGrant.sessionId !== run.sessionId ||
        resolution.observation.sessionId !== run.sessionId
      ) {
        throw this.#fault(
          "CONTROL_LOST",
          "Discovery handoff attempted to replace the live session.",
          false,
          run.evidence,
        );
      }
      let previousGrantInvalid = false;
      try {
        this.#control.assertGrant(previousGrant);
      } catch (error: unknown) {
        previousGrantInvalid = error instanceof ControlError && error.code === "CONTROL_LOST";
      }
      if (!previousGrantInvalid) {
        throw this.#fault(
          "CONTROL_LOST",
          "Discovery handoff returned without revoking the prior automation lease.",
          false,
          run.evidence,
        );
      }
      this.#control.assertGrant(resolution.automationGrant, "automation");
      // Retain the only valid lease before checking the returned observation and
      // checkpoint so outer failure cleanup can revoke it.
      run.grant = resolution.automationGrant;
      if (
        resolution.automationGrant.epoch <= previousGrant.epoch ||
        resolution.observation.id === previousObservationId ||
        !resolution.checkpoint.passed
      ) {
        throw this.#fault(
          "POSTCONDITION_FAILED",
          "Discovery handoff did not return a newer lease, fresh observation, and passing checkpoint.",
          false,
          run.evidence,
        );
      }
      run.observation = resolution.observation;
      run.handledInterventions += 1;
      await this.#emit(run, "discovery.intervention.resumed", {
        priorOwnerEpoch: previousGrant.epoch,
        newOwnerEpoch: resolution.automationGrant.epoch,
        observationId: resolution.observation.id,
        checkpointPassed: true,
      });
      return undefined;
    }
    await this.#emit(run, "run.completed", {
      status: "needs_intervention",
      modelCalls: run.modelCalls,
    });
    return {
      status: "needs_intervention",
      runId: run.runId,
      sessionId: run.sessionId,
      modelCalls: run.modelCalls,
      recoveries: run.recoveries,
      evidence: run.evidence,
      intervention,
    };
  }

  async #observe(run: MutableRun, request: DiscoveryRequest): Promise<SurfaceObservation> {
    const observation = await this.#surface.observe(run.sessionId);
    await this.#emit(run, "observation.captured", {
      observationId: observation.id,
      route: observation.route,
      surfaceFingerprint: observation.fingerprint,
      elementCount: observation.elements.length,
    });
    if (
      this.#evidence &&
      request.persistObservationScreenshots === true &&
      request.screenshotsRedactionVerified === true
    ) {
      const ref = await this.#evidence.writeScreenshot(
        `screenshots/${String(run.sequence).padStart(3, "0")}-${slug(observation.id, "observation")}.png`,
        observation.screenshotPng,
        { redactionVerified: true },
      );
      run.evidence.push(ref);
    }
    return observation;
  }

  #predicateContext(run: MutableRun): PredicateContext {
    return {
      outputs: run.outputs,
      inputs: run.inputs,
      targets: run.targets,
      grant: run.grant,
      expectedUrl: run.observation.url,
    };
  }

  async #emit(run: MutableRun, kind: string, fields: Record<string, unknown>): Promise<void> {
    run.sequence += 1;
    if (!this.#evidence) return;
    await this.#evidence.appendEvent({
      runId: run.runId,
      eventId: `event-${String(run.sequence).padStart(4, "0")}`,
      timestamp: this.#now().toISOString(),
      kind,
      sessionId: run.sessionId,
      ownerEpoch: run.grant.epoch,
      ...fields,
    });
  }

  #fault(
    code: AutomationFault["code"],
    message: string,
    retryable: boolean,
    evidence: readonly EvidenceRef[],
  ): DiscoveryFault {
    return new DiscoveryFault({
      code,
      message: boundedText(message, "Discovery failed."),
      phase: "discovery",
      retryable,
      evidence: [...evidence],
    });
  }

  #faultFromError(error: unknown, evidence: readonly EvidenceRef[]): AutomationFault {
    if (error instanceof DiscoveryFault) return error.fault;
    if (error instanceof PolicyDeniedError) {
      return {
        code: "POLICY_DENIED",
        message: "Runtime policy denied a discovery action.",
        phase: "discovery",
        retryable: false,
        evidence: [...evidence],
      };
    }
    if (error instanceof ArtifactBindingError) {
      return {
        code: "INPUT_INVALID",
        message: error.message,
        phase: "preflight",
        retryable: false,
        evidence: [...evidence],
      };
    }
    if (error instanceof ArtifactCompilationError) {
      return {
        code: "ARTIFACT_INVALID",
        message: "The discovered workflow did not pass capability artifact safety linting.",
        phase: "discovery",
        retryable: false,
        evidence: [...evidence],
      };
    }
    if (
      error instanceof TypeError ||
      error instanceof RangeError ||
      error?.constructor?.name === "ZodError"
    ) {
      return {
        code: "ARTIFACT_INVALID",
        message: "Discovery preflight rejected invalid request, binding, or contract metadata.",
        phase: "preflight",
        retryable: false,
        evidence: [...evidence],
      };
    }
    if (error instanceof ControlError) {
      return {
        code: "CONTROL_LOST",
        message: "Automation lost its exclusive session control lease.",
        phase: "discovery",
        retryable: false,
        evidence: [...evidence],
      };
    }
    const code = errorCode(error);
    if (code === "TARGET_AMBIGUOUS" || code === "TARGET_NOT_FOUND") {
      return {
        code,
        message: "The live surface could not resolve exactly one safe target.",
        phase: "discovery",
        retryable: code === "TARGET_NOT_FOUND",
        evidence: [...evidence],
      };
    }
    if (code === "STALE_OBSERVATION") {
      return {
        code: "MODEL_INVALID_DECISION",
        message: "The planner attempted to act on stale surface state.",
        phase: "discovery",
        retryable: false,
        evidence: [...evidence],
      };
    }
    return {
      code: "INTERNAL_ERROR",
      message: boundedText(
        error instanceof Error ? error.message : "Unexpected discovery failure.",
        "Unexpected discovery failure.",
      ),
      phase: "discovery",
      retryable: false,
      evidence: [...evidence],
    };
  }
}

export async function discoverCapability(
  options: DiscoveryEngineOptions,
  request: DiscoveryRequest,
): Promise<DiscoveryResult> {
  return new DiscoveryEngine(options).discover(request);
}
