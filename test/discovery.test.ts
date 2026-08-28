import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type {
  AppBinding,
  ModelDecision,
  Predicate,
  TargetSpec,
  ValueExpression,
} from "../src/domain/schema.js";
import {
  computePromptRequestHash,
  computePromptTraceHashFromRequestHashes,
  type DiscoveryPlanner,
  PlannerDecisionError,
  type PlannerRequest,
  type PlannerResponse,
} from "../src/model/planner.js";
import { ControlCoordinator } from "../src/runtime/control.js";
import { DiscoveryEngine, type DiscoveryRequest } from "../src/runtime/discovery.js";
import { EvidenceWriter } from "../src/runtime/evidence.js";
import type { PolicyStack } from "../src/runtime/policy.js";
import type {
  ActionReceipt,
  DispatchContext,
  ObservedElement,
  PredicateContext,
  PredicateResult,
  SurfaceAdapter,
  SurfaceObservation,
  SurfaceSession,
} from "../src/surface/types.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FINGERPRINT = "a".repeat(64);

function observed(
  ref: string,
  role: string,
  name: string,
  options: Partial<ObservedElement> = {},
): ObservedElement {
  return {
    ref,
    framePath: ["name:workspace"],
    tagName: role === "textbox" ? "input" : role === "button" ? "input" : "td",
    role,
    name,
    text: name,
    interactive: role !== "cell",
    enabled: true,
    bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.08 },
    context: {},
    ...options,
  };
}

function durableTarget(element: ObservedElement, description: string): TargetSpec {
  if (element.context.rowLabel && element.context.columnLabel) {
    return {
      description,
      match: "exactly_one_visible",
      candidates: [
        {
          kind: "table",
          rowLabel: element.context.rowLabel,
          columnLabel: element.context.columnLabel,
          framePath: element.framePath,
          rationale: "Stable row and column meaning identifies the value.",
        },
        {
          kind: "visual",
          anchorText: element.context.columnLabel,
          region: element.bounds,
          minimumConfidence: 0.85,
          framePath: element.framePath,
          rationale: "A bounded visual anchor is the final sparse-UI fallback.",
        },
      ],
      fingerprint: {
        role: element.role,
        nearbyText: [element.context.rowLabel, element.context.columnLabel],
        minimumScore: 0.6,
      },
      robustnessRationale:
        "Semantic table context is primary and the visual region is a bounded final fallback.",
    };
  }
  return {
    description,
    match: "exactly_one_visible",
    candidates: [
      {
        kind: "role",
        role: element.role as "button" | "status" | "textbox",
        name: element.name ?? "Synthetic control",
        exact: true,
        framePath: element.framePath,
        rationale: "Exact accessible role and name survive generated markup.",
      },
      {
        kind: "visual",
        anchorText: element.name ?? "Synthetic control",
        region: element.bounds,
        minimumConfidence: 0.85,
        framePath: element.framePath,
        rationale: "A bounded visual anchor is the final sparse-UI fallback.",
      },
    ],
    fingerprint: {
      role: element.role,
      accessibleName: element.name,
      minimumScore: 0.6,
    },
    robustnessRationale:
      "Accessible semantics are primary and the normalized visual region is a bounded fallback.",
  };
}

class FakeSurface implements SurfaceAdapter {
  readonly session: SurfaceSession = {
    id: "surface-discovery-test",
    adapter: "playwright-web",
    createdAt: "2026-08-27T18:00:00.000Z",
    viewport: { width: 1280, height: 800 },
  };
  stage = 0;
  observeCount = 0;
  dispatchCount = 0;
  closed = false;
  currentObservation: SurfaceObservation | undefined;

  constructor(
    readonly options: {
      businessOutcome?: boolean;
      transientFirstObservation?: boolean;
      unclassifiedButton?: boolean;
      observationOrigin?: string;
    } = {},
  ) {}

  async createSession(): Promise<SurfaceSession> {
    return this.session;
  }

  async navigate(): Promise<ActionReceipt> {
    return this.receipt("navigate", true, "Opened the synthetic member console.");
  }

  async observe(): Promise<SurfaceObservation> {
    this.observeCount += 1;
    const elements: ObservedElement[] = [
      observed("field", "textbox", "Member number", {
        value: this.stage >= 1 ? "84721" : "",
        context: { precedingLabel: "Member number" },
      }),
      observed("find", "button", "Find Member"),
    ];
    if (this.options.unclassifiedButton) {
      elements.push(observed("delete", "button", "Delete Account"));
    }
    if (this.stage >= 2) {
      elements.push(
        observed("balance", "cell", "$1,284.37", {
          interactive: false,
          context: {
            rowText: ["Savings", "0042", "$1,284.37"],
            rowLabel: "Savings",
            columnLabel: "Current balance",
            tableCaption: "Member accounts",
          },
        }),
      );
    }
    if (this.options.businessOutcome) {
      elements.push(observed("not-found", "status", "Member not found"));
    }
    const visibleText = this.options.businessOutcome
      ? "No member found."
      : this.options.transientFirstObservation && this.observeCount === 1
        ? "Loading temporary member service state."
        : this.stage >= 2
          ? "Member profile Alex Rivera Savings Current balance $1,284.37"
          : "Member lookup Member number Find Member";
    this.currentObservation = {
      id: `observation-${this.observeCount}`,
      sessionId: this.session.id,
      url: `${this.options.observationOrigin ?? binding.origin}/legacy`,
      route: "/legacy",
      title: "Synthetic Member Services",
      capturedAt: "2026-08-27T18:00:00.000Z",
      screenshotPng: PNG,
      viewport: this.session.viewport,
      visibleText,
      elements,
      fingerprint: FINGERPRINT,
    };
    return this.currentObservation;
  }

  async dispatch(
    _sessionId: string,
    decision: ModelDecision,
    context: DispatchContext,
  ): Promise<ActionReceipt> {
    assert.equal(decision.observationId, this.currentObservation?.id);
    assert.equal(context.observationId, this.currentObservation?.id);
    this.dispatchCount += 1;
    if (decision.kind === "set_value") this.stage = 1;
    if (decision.kind === "activate") this.stage = 2;
    return this.receipt(decision.kind, decision.kind !== "extract", `Executed ${decision.kind}.`);
  }

  compileTarget(observationId: string, elementRef: string, description: string): TargetSpec {
    assert.equal(observationId, this.currentObservation?.id);
    const element = this.currentObservation?.elements.find((item) => item.ref === elementRef);
    assert.ok(element, `Missing fake element ${elementRef}`);
    return durableTarget(element, description);
  }

  async evaluate(
    _sessionId: string,
    predicate: Predicate,
    context: PredicateContext,
  ): Promise<PredicateResult> {
    if (predicate.kind === "all" || predicate.kind === "any") {
      const results = await Promise.all(
        predicate.predicates.map((item) => this.evaluate(this.session.id, item, context)),
      );
      return {
        passed:
          predicate.kind === "all"
            ? results.every((item) => item.passed)
            : results.some((item) => item.passed),
        observed: "compound fake predicate",
      };
    }
    if (predicate.kind === "not") {
      const result = await this.evaluate(this.session.id, predicate.predicate, context);
      return { passed: !result.passed, observed: "negated fake predicate" };
    }
    if (predicate.kind === "route_matches") {
      return { passed: predicate.route === "/legacy", observed: "route=/legacy" };
    }
    if (predicate.kind === "surface_fingerprint") {
      return { passed: true, observed: "surface fingerprint present" };
    }
    if (predicate.kind === "output_valid") {
      return {
        passed: context.outputs[predicate.output] !== undefined,
        observed: `output ${predicate.output}`,
      };
    }
    if (predicate.kind === "target_value_equals") {
      const value = this.stage >= 1 ? "84721" : "";
      return {
        passed: value === String(this.resolveValue(predicate.expected, context.inputs)),
        observed: `value=${value}`,
      };
    }
    if (predicate.kind === "target_visible") {
      const target = context.targets[predicate.target];
      const isOutcome = target?.description.toLowerCase().includes("not found") ?? false;
      const visible = isOutcome ? this.options.businessOutcome === true : this.stage >= 2;
      return { passed: visible === predicate.expected, observed: `visible=${visible}` };
    }
    return { passed: false, observed: "text predicate did not match" };
  }

  async extract(): Promise<unknown> {
    return 1284.37;
  }

  resolveValue(expression: ValueExpression, inputs: Record<string, unknown>): unknown {
    if (expression.kind === "input") return inputs[expression.name];
    if (expression.kind === "literal") return expression.value;
    return undefined;
  }

  async captureEvidence(): Promise<Buffer> {
    return PNG;
  }

  async pressKey(): Promise<ActionReceipt> {
    return this.receipt("press_key", true, "Pressed a key.");
  }

  async clickAt(): Promise<ActionReceipt> {
    return this.receipt("activate", true, "Clicked a coordinate.");
  }

  async typeFocused(): Promise<ActionReceipt> {
    return this.receipt("set_value", true, "Typed a value.");
  }

  async closeSession(): Promise<void> {
    this.closed = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private receipt(
    command: ActionReceipt["command"],
    changedSurface: boolean,
    summary: string,
  ): ActionReceipt {
    return {
      command,
      startedAt: "2026-08-27T18:00:00.000Z",
      finishedAt: "2026-08-27T18:00:00.010Z",
      durationMs: 10,
      changedSurface,
      summary,
    };
  }
}

class ObservationPlanner implements DiscoveryPlanner {
  readonly provider = "test-observation-provider";
  readonly model = "test-observation-model";
  readonly transport = "scripted" as const;
  readonly live = false;
  #callCount = 0;
  readonly #promptRequestHashes: string[] = [];
  readonly observationIds: string[] = [];
  readonly allowedActionSets: ModelDecision["kind"][][] = [];
  readonly boundInputSets: string[][] = [];
  readonly allowedElementRefSets: PlannerRequest["allowedElementRefs"][] = [];
  readonly allowedOutputRefSets: PlannerRequest["allowedOutputRefs"][] = [];

  get callCount(): number {
    return this.#callCount;
  }

  get promptHash(): string {
    return computePromptTraceHashFromRequestHashes(this.transport, this.#promptRequestHashes);
  }

  promptHashSince(callCount: number): string {
    return computePromptTraceHashFromRequestHashes(
      this.transport,
      this.#promptRequestHashes.slice(callCount),
    );
  }

  async decide(request: PlannerRequest): Promise<PlannerResponse> {
    const promptRequestHash = computePromptRequestHash(
      this.transport,
      JSON.stringify({ model: this.model, request }),
    );
    this.#promptRequestHashes.push(promptRequestHash);
    this.#callCount += 1;
    this.observationIds.push(request.observation.id);
    this.allowedActionSets.push([...request.allowedActions]);
    this.boundInputSets.push([...(request.boundInputs ?? [])]);
    this.allowedElementRefSets.push(request.allowedElementRefs);
    this.allowedOutputRefSets.push(request.allowedOutputRefs);
    const common = {
      decisionId: `decision-${this.#callCount}`,
      observationId: request.observation.id,
      rationale: "Choose one current observed element to make bounded progress.",
    };
    const field = request.observation.elements.find((item) => item.role === "textbox");
    const button = request.observation.elements.find((item) => item.role === "button");
    const balance = request.observation.elements.find(
      (item) =>
        item.context.rowLabel === "Savings" && item.context.columnLabel === "Current balance",
    );
    let decision: ModelDecision;
    if (balance && request.outputs.savingsBalance === undefined) {
      decision = {
        ...common,
        kind: "extract",
        elementRef: balance.ref,
        output: "savingsBalance",
      };
    } else if (request.outputs.savingsBalance !== undefined) {
      decision = { ...common, kind: "finish", summary: "Verified output is present." };
    } else if (field?.value !== String(request.inputs.memberId)) {
      assert.ok(field);
      decision = {
        ...common,
        kind: "set_value",
        elementRef: field.ref,
        value: { kind: "input", name: "memberId" },
      };
    } else {
      assert.ok(button);
      decision = { ...common, kind: "activate", elementRef: button.ref };
    }
    assert.ok(request.allowedActions.includes(decision.kind));
    return { decision, provider: this.provider, model: this.model, promptRequestHash };
  }
}

class RepeatedDecisionIdPlanner extends ObservationPlanner {
  override async decide(request: PlannerRequest): Promise<PlannerResponse> {
    const response = await super.decide(request);
    return {
      ...response,
      decision: { ...response.decision, decisionId: "d1" } as ModelDecision,
    };
  }
}

class FixedPlanner implements DiscoveryPlanner {
  readonly provider = "fixed-test-provider";
  readonly model = "fixed-test-model";
  readonly transport = "scripted" as const;
  readonly live = false;
  #callCount = 0;
  readonly #promptRequestHashes: string[] = [];

  constructor(readonly choose: (request: PlannerRequest, callCount: number) => ModelDecision) {}

  get callCount(): number {
    return this.#callCount;
  }

  get promptHash(): string {
    return computePromptTraceHashFromRequestHashes(this.transport, this.#promptRequestHashes);
  }

  promptHashSince(callCount: number): string {
    return computePromptTraceHashFromRequestHashes(
      this.transport,
      this.#promptRequestHashes.slice(callCount),
    );
  }

  async decide(request: PlannerRequest): Promise<PlannerResponse> {
    const promptRequestHash = computePromptRequestHash(
      this.transport,
      JSON.stringify({ model: this.model, request }),
    );
    this.#promptRequestHashes.push(promptRequestHash);
    this.#callCount += 1;
    return {
      decision: this.choose(request, this.#callCount),
      provider: this.provider,
      model: this.model,
      promptRequestHash,
    };
  }
}

const binding: AppBinding = {
  schemaVersion: "1.0.0",
  id: "northstar-member-console",
  product: {
    vendor: "Handrail Labs",
    product: "Legacy Member Console",
    tenantLabel: "Northstar synthetic tenant",
  },
  origin: "http://127.0.0.1:4312",
  entrypoints: { "member-console": "/legacy" },
  secretRefs: {},
  expectedFingerprint: {
    signals: [
      { kind: "route", value: "/legacy", weight: 0.5 },
      { kind: "heading", value: "Synthetic Member Services", weight: 0.5 },
    ],
    minimumScore: 0.8,
  },
  targetOverrides: {},
  policy: {
    allowedOrigins: ["http://127.0.0.1:4312"],
    allowedRoutes: ["/legacy"],
    allowedCommands: ["navigate", "set_value", "activate", "wait_for", "extract"],
    allowedEffects: ["read", "reversible_write"],
  },
};

const policy: PolicyStack = {
  platform: {
    name: "platform",
    allowedOrigins: [binding.origin],
    allowedRoutes: ["/**"],
    allowedCommands: ["navigate", "set_value", "activate", "wait_for", "extract"],
    allowedEffects: ["read", "reversible_write"],
  },
  binding: {
    name: "binding",
    allowedOrigins: binding.policy.allowedOrigins,
    allowedRoutes: binding.policy.allowedRoutes,
    allowedCommands: binding.policy.allowedCommands,
    allowedEffects: binding.policy.allowedEffects,
  },
  capability: {
    name: "discovery-capability-envelope",
    allowedRoutes: ["/legacy"],
    allowedCommands: ["navigate", "set_value", "activate", "wait_for", "extract"],
    allowedEffects: ["read", "reversible_write"],
  },
};

function request(overrides: Partial<DiscoveryRequest> = {}): DiscoveryRequest {
  return {
    runId: "discovery-test-01",
    goal: "Find the synthetic member and return the current Savings balance.",
    targetUrl: `${binding.origin}/legacy`,
    binding,
    inputs: { memberId: "84721" },
    artifact: {
      id: "member-savings-lookup",
      name: "Member savings balance lookup",
      description: "Looks up a synthetic member and returns the verified current savings balance.",
      purpose: "Provide a deterministic read-only savings lookup for synthetic support training.",
      entrypointKey: "member-console",
      inputs: {
        memberId: {
          description: "Synthetic five-digit member identifier",
          classification: "pii",
          required: true,
          validator: { kind: "string", pattern: "^[0-9]{5}$", minLength: 5, maxLength: 5 },
        },
      },
      outputs: {
        savingsBalance: {
          description: "Current balance of the Savings account",
          classification: "internal",
          validator: { kind: "number", minimum: 0 },
        },
      },
      outputBindings: {
        savingsBalance: {
          source: "text",
          transforms: ["trim", "currency_to_number"],
          target: { role: "cell", rowLabel: "Savings", columnLabel: "Current balance" },
        },
      },
      activationPolicies: [
        {
          role: "button",
          name: "Find Member",
          effect: "read",
          idempotency: "idempotent",
        },
      ],
      outcomes: [],
    },
    ...overrides,
  };
}

describe("bounded model-driven discovery", () => {
  it("returns a typed hard preflight failure before opening a surface for invalid input", async () => {
    const surface = new FakeSurface();
    const planner = new ObservationPlanner();
    const result = await new DiscoveryEngine({
      surface,
      planner,
      control: new ControlCoordinator(),
      policy,
    }).discover(request({ inputs: { memberId: "not-five-digits" } }));

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.sessionId, null);
    assert.equal(result.error.code, "INPUT_INVALID");
    assert.equal(result.error.phase, "preflight");
    assert.equal(surface.observeCount, 0);
    assert.equal(planner.callCount, 0);
  });

  it("rejects a contract pattern outside the bounded fixed-width language before opening a surface", async () => {
    const surface = new FakeSurface();
    const planner = new ObservationPlanner();
    const unsafe = request({ inputs: { memberId: `${"a".repeat(24)}!` } });
    const memberId = unsafe.artifact.inputs.memberId;
    assert.ok(memberId?.validator.kind === "string");
    memberId.validator.pattern = "^(a+)+$";
    memberId.validator.maxLength = 25;

    const result = await new DiscoveryEngine({
      surface,
      planner,
      control: new ControlCoordinator(),
      policy,
    }).discover(unsafe);

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.sessionId, null);
    assert.equal(result.error.code, "INPUT_INVALID");
    assert.equal(result.error.phase, "preflight");
    assert.equal(surface.observeCount, 0);
    assert.equal(planner.callCount, 0);
  });

  it("requires every output to declare a semantic extraction target before opening a surface", async () => {
    const surface = new FakeSurface();
    const planner = new ObservationPlanner();
    const baseline = request();
    const result = await new DiscoveryEngine({
      surface,
      planner,
      control: new ControlCoordinator(),
      policy,
    }).discover(
      request({
        artifact: { ...baseline.artifact, outputBindings: {} },
      }),
    );

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.sessionId, null);
      assert.equal(result.error.phase, "preflight");
    }
    assert.equal(surface.observeCount, 0);
    assert.equal(planner.callCount, 0);
  });

  it("forbids replay target overrides during discovery before opening a surface", async () => {
    const surface = new FakeSurface();
    const planner = new ObservationPlanner();
    const overrideTarget = durableTarget(
      observed("override", "button", "Find Member"),
      "Synthetic replay-only override",
    );
    const result = await new DiscoveryEngine({
      surface,
      planner,
      control: new ControlCoordinator(),
      policy,
    }).discover(
      request({
        binding: {
          ...binding,
          targetOverrides: { lookupButton: overrideTarget },
          targetOverrideReviews: {
            lookupButton: {
              baseTargetDigest: "a".repeat(64),
              overrideTargetDigest: "b".repeat(64),
              reviewedBy: "reviewer-01",
              reviewedAt: "2026-08-27T17:00:00.000Z",
            },
          },
        },
      }),
    );

    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.phase, "preflight");
    assert.equal(surface.observeCount, 0);
    assert.equal(planner.callCount, 0);
  });

  it("acts only on fresh observed refs and compiles the verified live path into an artifact", async () => {
    const surface = new FakeSurface();
    const planner = new ObservationPlanner();
    const control = new ControlCoordinator();
    const engine = new DiscoveryEngine({ surface, planner, control, policy });

    const result = await engine.discover(request());

    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.deepEqual(result.outputs, { savingsBalance: 1284.37 });
    assert.equal(result.modelCalls, 4);
    assert.deepEqual(planner.observationIds, [
      "observation-1",
      "observation-2",
      "observation-3",
      "observation-4",
    ]);
    assert.deepEqual(planner.allowedActionSets, [
      ["set_value"],
      ["activate"],
      ["extract"],
      ["finish"],
    ]);
    assert.deepEqual(planner.boundInputSets, [[], ["memberId"], ["memberId"], ["memberId"]]);
    assert.equal(planner.allowedActionSets[1]?.includes("set_value"), false);
    assert.deepEqual(planner.allowedElementRefSets[1]?.activate, ["find"]);
    assert.equal(planner.allowedElementRefSets[1]?.activate?.includes("member-input"), false);
    assert.deepEqual(
      planner.allowedOutputRefSets.map((items) => items?.savingsBalance ?? []),
      [[], [], ["balance"], []],
    );
    assert.equal(
      planner.allowedActionSets.some((actions) => actions.includes("activate_coordinate")),
      false,
    );
    assert.equal(surface.dispatchCount, 3);
    assert.equal(surface.closed, true);
    assert.equal(result.artifact.schemaVersion, "1.0.0");
    assert.equal(result.artifact.digest.length, 64);
    assert.equal(result.artifact.provenance.liveModel, false);
    assert.equal(result.artifact.provenance.provider, planner.provider);
    assert.deepEqual(
      result.artifact.steps.map((step) => step.command),
      ["set_value", "activate", "extract"],
    );
    const activation = result.artifact.steps[1];
    assert.equal(activation?.command, "activate");
    assert.deepEqual(activation?.postcondition, {
      kind: "target_visible",
      target: "output-savingsBalance",
      expected: true,
    });
    const outputTarget = result.artifact.targets["output-savingsBalance"];
    assert.equal(outputTarget?.candidates[0]?.kind, "table");
    assert.ok(
      !JSON.stringify(result.artifact).includes("$1,284.37"),
      "The changing output value must never become a persisted locator.",
    );
  });

  it("assigns trusted run-local IDs when a planner repeats untrusted decision labels", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "handrail-discovery-decisions-"));
    try {
      const result = await new DiscoveryEngine({
        surface: new FakeSurface(),
        planner: new RepeatedDecisionIdPlanner(),
        control: new ControlCoordinator(),
        policy,
        evidence: new EvidenceWriter({ rootDirectory: root }),
      }).discover(request({ runId: "discovery-repeated-decision-labels" }));

      assert.equal(result.status, "succeeded");
      const events = (await readFile(path.join(root, "events.redacted.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const decisionIds = events
        .filter((event) => event.type === "model.decision")
        .map((event) => (event.decision as Record<string, unknown>).decisionId);
      assert.deepEqual(decisionIds, [
        "decision-0001",
        "decision-0002",
        "decision-0003",
        "decision-0004",
      ]);
      assert.equal(new Set(decisionIds).size, decisionIds.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports model calls for each run when a planner instance is reused", async () => {
    const planner = new ObservationPlanner();
    const [first, second] = await Promise.all([
      new DiscoveryEngine({
        surface: new FakeSurface(),
        planner,
        control: new ControlCoordinator(),
        policy,
      }).discover(request({ runId: "discovery-planner-reuse-1" })),
      new DiscoveryEngine({
        surface: new FakeSurface(),
        planner,
        control: new ControlCoordinator(),
        policy,
      }).discover(request({ runId: "discovery-planner-reuse-2" })),
    ]);

    assert.equal(first.status, "succeeded");
    assert.equal(first.modelCalls, 4);
    assert.equal(second.status, "succeeded");
    assert.equal(second.modelCalls, 4);
    assert.equal(planner.callCount, 8);
    if (first.status === "succeeded" && second.status === "succeeded") {
      assert.equal(
        first.artifact.provenance.promptHash,
        second.artifact.provenance.promptHash,
        "identical per-run request sequences should have the same prompt trace despite interleaving",
      );
      assert.notEqual(
        first.artifact.provenance.promptHash,
        planner.promptHash,
        "an artifact must not inherit the shared planner's interleaved lifetime trace",
      );
    }
  });

  it("rejects a stale model observation before dispatch", async () => {
    const surface = new FakeSurface();
    const planner = new FixedPlanner((plannerRequest) => ({
      kind: "activate",
      decisionId: "decision-stale",
      observationId: "observation-stale",
      elementRef: plannerRequest.observation.elements[1]?.ref ?? "missing",
      rationale: "Attempt to use an older observation.",
    }));
    const result = await new DiscoveryEngine({
      surface,
      planner,
      control: new ControlCoordinator(),
      policy,
    }).discover(request());

    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.code, "MODEL_INVALID_DECISION");
    assert.equal(surface.dispatchCount, 0);
  });

  it("never offers or accepts coordinate activation from a model", async () => {
    const surface = new FakeSurface();
    let offeredActions: readonly ModelDecision["kind"][] = [];
    const planner = new FixedPlanner((plannerRequest) => {
      offeredActions = [...plannerRequest.allowedActions];
      return {
        kind: "activate_coordinate",
        decisionId: "decision-coordinate",
        observationId: plannerRequest.observation.id,
        x: 0.2,
        y: 0.2,
        rationale: "Attempt a raw coordinate activation.",
      };
    });
    const result = await new DiscoveryEngine({
      surface,
      planner,
      control: new ControlCoordinator(),
      policy,
    }).discover(request());

    assert.equal(offeredActions.includes("activate_coordinate"), false);
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.code, "MODEL_INVALID_DECISION");
      assert.match(result.error.message, /coordinate activation is forbidden/u);
    }
    assert.equal(surface.dispatchCount, 0);
  });

  it("classifies typed planner contract failures as invalid decisions, not outages", async () => {
    const surface = new FakeSurface();
    const planner: DiscoveryPlanner = {
      provider: "typed-error-provider",
      model: "typed-error-model",
      transport: "openai-compatible",
      live: true,
      callCount: 1,
      promptHash: computePromptTraceHashFromRequestHashes("openai-compatible", []),
      promptHashSince: () => computePromptTraceHashFromRequestHashes("openai-compatible", []),
      decide: async () => {
        throw new PlannerDecisionError("The provider returned a stale observation.");
      },
    };
    const result = await new DiscoveryEngine({
      surface,
      planner,
      control: new ControlCoordinator(),
      policy,
    }).discover(request());

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.code, "MODEL_INVALID_DECISION");
      assert.equal(result.error.retryable, false);
    }
    assert.equal(surface.dispatchCount, 0);
  });

  it("evaluates policy against the fresh observed origin instead of reconstructing it", async () => {
    const secondaryOrigin = "http://127.0.0.1:4314";
    const surface = new FakeSurface({ observationOrigin: secondaryOrigin });
    let offeredActions: readonly ModelDecision["kind"][] = [];
    const planner = new FixedPlanner((plannerRequest) => {
      offeredActions = [...plannerRequest.allowedActions];
      return {
        kind: "set_value",
        decisionId: "decision-secondary-origin",
        observationId: plannerRequest.observation.id,
        elementRef: "field",
        value: { kind: "input", name: "memberId" },
        rationale: "Attempt an action after cross-origin drift.",
      };
    });
    const bindingWithSecondaryOrigin: AppBinding = {
      ...binding,
      policy: {
        ...binding.policy,
        allowedOrigins: [binding.origin, secondaryOrigin],
      },
    };
    const result = await new DiscoveryEngine({
      surface,
      planner,
      control: new ControlCoordinator(),
      policy: {
        ...policy,
        binding: {
          ...policy.binding,
          allowedOrigins: [binding.origin, secondaryOrigin],
        },
      },
    }).discover(request({ binding: bindingWithSecondaryOrigin }));

    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.code, "MODEL_INVALID_DECISION");
    assert.equal(offeredActions.includes("set_value"), false);
    assert.equal(surface.dispatchCount, 0);
  });

  it("turns request-help into an audited same-session intervention without closing the surface", async () => {
    const surface = new FakeSurface();
    const control = new ControlCoordinator();
    const planner = new FixedPlanner((plannerRequest) => ({
      kind: "request_help",
      decisionId: "decision-help",
      observationId: plannerRequest.observation.id,
      reason: "expired_session",
      summary: "The synthetic session must be restored by an operator.",
      rationale: "A session boundary cannot be bypassed safely.",
    }));
    const result = await new DiscoveryEngine({ surface, planner, control, policy }).discover(
      request({ allowProactiveModelIntervention: true }),
    );

    assert.equal(result.status, "needs_intervention");
    if (result.status !== "needs_intervention") return;
    assert.equal(result.intervention.reason, "SESSION_EXPIRED");
    assert.equal(result.intervention.sessionId, surface.session.id);
    assert.equal(control.snapshot(surface.session.id).phase, "AWAITING_OPERATOR");
    assert.equal(surface.closed, false);
  });

  it("cedes and resumes discovery on the same session with a newer automation lease", async () => {
    const surface = new FakeSurface();
    const control = new ControlCoordinator();
    const planner = new FixedPlanner((plannerRequest, callCount) => {
      const common = {
        decisionId: `decision-resume-${callCount}`,
        observationId: plannerRequest.observation.id,
        rationale: "Exercise the bounded same-session discovery handoff.",
      };
      if (callCount === 1) {
        return {
          ...common,
          kind: "request_help",
          reason: "expired_session",
          summary: "Restore the synthetic session.",
        };
      }
      const balance = plannerRequest.observation.elements.find((item) => item.role === "cell");
      const field = plannerRequest.observation.elements.find((item) => item.role === "textbox");
      const button = plannerRequest.observation.elements.find((item) => item.role === "button");
      if (balance && plannerRequest.outputs.savingsBalance === undefined) {
        return { ...common, kind: "extract", elementRef: balance.ref, output: "savingsBalance" };
      }
      if (plannerRequest.outputs.savingsBalance !== undefined) {
        return { ...common, kind: "finish", summary: "Verified output is present." };
      }
      if (field?.value !== String(plannerRequest.inputs.memberId)) {
        return {
          ...common,
          kind: "set_value",
          elementRef: field?.ref ?? "missing",
          value: { kind: "input", name: "memberId" },
        };
      }
      return { ...common, kind: "activate", elementRef: button?.ref ?? "missing" };
    });
    let previousEpoch = 0;
    const result = await new DiscoveryEngine({
      surface,
      planner,
      control,
      policy,
      onIntervention: async (context) => {
        previousEpoch = context.automationGrant.epoch;
        const operatorGrant = control.claimOperator(context.session.id, "operator-test");
        control.requestResume(operatorGrant);
        const automationGrant = control.returnToAutomation(operatorGrant, context.runId);
        const observation = await surface.observe();
        return {
          sessionId: context.session.id,
          automationGrant,
          observation,
          checkpoint: { passed: true, observed: "Synthetic session restored." },
        };
      },
    }).discover(request({ allowProactiveModelIntervention: true }));

    assert.equal(result.status, "succeeded");
    assert.equal(result.sessionId, surface.session.id);
    assert.ok(control.snapshot(surface.session.id).epoch > previousEpoch);
  });

  it("revokes the returned automation lease when the handoff checkpoint fails", async () => {
    const surface = new FakeSurface();
    const control = new ControlCoordinator();
    const planner = new FixedPlanner((plannerRequest) => ({
      kind: "request_help",
      decisionId: "decision-failed-handoff",
      observationId: plannerRequest.observation.id,
      reason: "expired_session",
      summary: "Restore the synthetic session.",
      rationale: "Exercise failed same-session handoff cleanup.",
    }));
    const result = await new DiscoveryEngine({
      surface,
      planner,
      control,
      policy,
      onIntervention: async (context) => {
        const operatorGrant = control.claimOperator(context.session.id, "operator-test");
        control.requestResume(operatorGrant);
        const automationGrant = control.returnToAutomation(operatorGrant, context.runId);
        return {
          sessionId: context.session.id,
          automationGrant,
          observation: await surface.observe(),
          checkpoint: { passed: false, observed: "Synthetic recovery did not pass." },
        };
      },
    }).discover(request({ allowProactiveModelIntervention: true }));

    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.code, "POSTCONDITION_FAILED");
    assert.equal(control.snapshot(surface.session.id).phase, "FAILED");
    assert.equal(control.snapshot(surface.session.id).owner, null);
  });

  it("revokes a valid returned lease when handoff metadata names a replacement session", async () => {
    const surface = new FakeSurface();
    const control = new ControlCoordinator();
    const planner = new FixedPlanner((plannerRequest) => ({
      kind: "request_help",
      decisionId: "decision-wrong-session-handoff",
      observationId: plannerRequest.observation.id,
      reason: "expired_session",
      summary: "Restore the synthetic session.",
      rationale: "Exercise invalid handoff metadata cleanup.",
    }));
    const result = await new DiscoveryEngine({
      surface,
      planner,
      control,
      policy,
      onIntervention: async (context) => {
        const operatorGrant = control.claimOperator(context.session.id, "operator-test");
        control.requestResume(operatorGrant);
        const automationGrant = control.returnToAutomation(operatorGrant, context.runId);
        return {
          sessionId: "replacement-session",
          automationGrant,
          observation: await surface.observe(),
          checkpoint: { passed: true, observed: "Synthetic session restored." },
        };
      },
    }).discover(request({ allowProactiveModelIntervention: true }));

    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.code, "CONTROL_LOST");
    assert.equal(control.snapshot(surface.session.id).phase, "FAILED");
    assert.equal(control.snapshot(surface.session.id).owner, null);
  });

  it("blocks an activation that has no explicit effect and idempotency classification", async () => {
    const surface = new FakeSurface();
    const planner = new FixedPlanner((plannerRequest) => ({
      kind: "activate",
      decisionId: "decision-unclassified-activation",
      observationId: plannerRequest.observation.id,
      elementRef: plannerRequest.observation.elements[1]?.ref ?? "missing",
      rationale: "Attempt an activation omitted from the reviewed policy.",
    }));
    const base = request();
    const result = await new DiscoveryEngine({
      surface,
      planner,
      control: new ControlCoordinator(),
      policy,
    }).discover({
      ...base,
      artifact: { ...base.artifact, activationPolicies: [] },
    });

    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.code, "MODEL_INVALID_DECISION");
    assert.equal(surface.dispatchCount, 0);
  });

  it("does not let a classified sibling expose an unclassified activation", async () => {
    const surface = new FakeSurface({ unclassifiedButton: true });
    const planner = new FixedPlanner((plannerRequest) => ({
      kind: "activate",
      decisionId: "decision-unclassified-sibling",
      observationId: plannerRequest.observation.id,
      elementRef: "delete",
      rationale: "Attempt the unreviewed sibling control.",
    }));
    const result = await new DiscoveryEngine({
      surface,
      planner,
      control: new ControlCoordinator(),
      policy,
    }).discover(request());

    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.code, "MODEL_INVALID_DECISION");
    assert.equal(surface.dispatchCount, 0);
  });

  it("classifies a declared business outcome before making another model call", async () => {
    const surface = new FakeSurface({ businessOutcome: true });
    const planner = new ObservationPlanner();
    const outcomeTarget = durableTarget(
      observed("not-found", "status", "Member not found"),
      "Known member not found status",
    );
    const base = request();
    const result = await new DiscoveryEngine({
      surface,
      planner,
      control: new ControlCoordinator(),
      policy,
    }).discover({
      ...base,
      artifact: {
        ...base.artifact,
        staticTargets: { memberNotFound: outcomeTarget },
        outcomes: [
          {
            code: "MEMBER_NOT_FOUND",
            description: "No synthetic member matched the supplied identifier.",
            when: { kind: "target_visible", target: "memberNotFound", expected: true },
          },
        ],
      },
    });

    assert.equal(result.status, "business_outcome");
    if (result.status === "business_outcome") {
      assert.equal(result.outcome.code, "MEMBER_NOT_FOUND");
    }
    assert.equal(planner.callCount, 0);
  });

  it("bounds known transient recovery and the total model action budget", async () => {
    const surface = new FakeSurface({ transientFirstObservation: true });
    const planner = new FixedPlanner((plannerRequest, callCount) => {
      const common = {
        decisionId: `decision-progress-${callCount}`,
        observationId: plannerRequest.observation.id,
        rationale: "Make only policy-qualified progress within the configured bounded loop.",
      };
      if (callCount === 1) {
        return {
          ...common,
          kind: "set_value",
          elementRef: plannerRequest.allowedElementRefs?.set_value?.[0] ?? "missing",
          value: { kind: "input", name: "memberId" },
        };
      }
      return {
        ...common,
        kind: "activate",
        elementRef: plannerRequest.allowedElementRefs?.activate?.[0] ?? "missing",
      };
    });
    const result = await new DiscoveryEngine({
      surface,
      planner,
      control: new ControlCoordinator(),
      policy,
      sleep: async () => undefined,
    }).discover(
      request({
        maxSteps: 2,
        sentinels: [
          {
            kind: "recoverable",
            code: "KNOWN_LOADING_STATE",
            pattern: /Loading temporary/iu,
            summary: "Known temporary loading state.",
          },
        ],
      }),
    );

    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.code, "MAX_STEPS");
    assert.equal(result.recoveries, 1);
    assert.equal(planner.callCount, 2);
  });
});
