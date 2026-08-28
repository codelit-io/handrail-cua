import type {
  AppBinding,
  CapabilityArtifact,
  CapabilityArtifactDraft,
  ModelDecision,
  Predicate,
  TargetSpec,
  ValueExpression,
} from "../../../src/domain/schema.js";
import { compileArtifact } from "../../../src/runtime/artifact.js";
import type { ControlGrant } from "../../../src/runtime/control.js";
import { routeMatches } from "../../../src/runtime/policy.js";
import type {
  ActionReceipt,
  DispatchContext,
  ObservedElement,
  PredicateContext,
  PredicateResult,
  SurfaceAdapter,
  SurfaceObservation,
  SurfaceSession,
} from "../../../src/surface/types.js";

const CREATED_AT = "2026-08-27T18:00:00.000Z";

function target(
  description: string,
  role: "button" | "cell" | "status" | "textbox",
  name: string,
  relation: string,
): TargetSpec {
  return {
    description,
    match: "exactly_one_visible",
    candidates: [
      {
        kind: "role",
        role,
        name,
        exact: true,
        rationale: "The exact accessible role and name are stable product semantics.",
      },
      {
        kind: "relation",
        anchorText: relation,
        relationship: role === "textbox" ? "labelled_control" : "within",
        role,
        rationale: "A visible semantic relationship survives legacy markup changes.",
      },
    ],
    fingerprint: { role, accessibleName: name, minimumScore: 1 },
    robustnessRationale:
      "Two independent user-visible signals avoid generated selectors and fail closed on ambiguity.",
  };
}

export function replayArtifact(): CapabilityArtifact {
  const draft: CapabilityArtifactDraft = {
    schemaVersion: "1.0.0",
    id: "member-savings-lookup",
    revision: 1,
    name: "Member savings balance lookup",
    description: "Looks up a synthetic member and returns a verified savings balance.",
    purpose: "Provide deterministic read-only lookup for a synthetic support workflow.",
    compatibility: {
      product: { vendor: "Handrail Labs", product: "Legacy Member Console" },
      requiredSurfaceCapabilities: ["accessibility_tree", "dom", "frames"],
      fingerprint: {
        signals: [{ kind: "route", value: "/legacy", weight: 1 }],
        minimumScore: 1,
      },
    },
    entrypoint: { bindingKey: "memberSearch", route: "/legacy" },
    contract: {
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
          description: "Savings current balance",
          classification: "internal",
          validator: { kind: "number", minimum: 0 },
        },
      },
      outcomes: [
        {
          code: "MEMBER_NOT_FOUND",
          description: "No synthetic member matched the supplied identifier.",
          when: { kind: "target_visible", target: "notFoundNotice", expected: true },
        },
      ],
    },
    targets: {
      memberField: target("Member number input", "textbox", "Member number", "Member number"),
      lookupButton: target("Find member command", "button", "Find Member", "Find Member"),
      resultsPanel: target(
        "Successful lookup result",
        "status",
        "Member lookup result",
        "Member lookup result",
      ),
      savingsBalance: target("Savings current balance", "cell", "$1,284.37", "Savings"),
      notFoundNotice: target(
        "Known not-found notice",
        "status",
        "No member found.",
        "No member found.",
      ),
    },
    effects: ["read", "reversible_write"],
    policyRequirements: {
      allowedRoutes: ["/legacy"],
      allowedCommands: ["navigate", "set_value", "activate", "extract"],
      allowedEffects: ["read", "reversible_write"],
      approvalRequiredFor: [],
    },
    steps: [
      {
        id: "set-member-id",
        description: "Set the invocation member identifier in the search form.",
        command: "set_value",
        target: "memberField",
        value: { kind: "input", name: "memberId" },
        effect: "reversible_write",
        idempotency: "idempotent",
        timeoutMs: 1_000,
        retry: { maxAttempts: 1, delayMs: 0, retryOn: [] },
        postcondition: {
          kind: "target_value_equals",
          target: "memberField",
          expected: { kind: "input", name: "memberId" },
        },
      },
      {
        id: "activate-lookup",
        description: "Activate the read-only member lookup command.",
        command: "activate",
        target: "lookupButton",
        effect: "read",
        idempotency: "idempotent",
        timeoutMs: 1_000,
        retry: { maxAttempts: 2, delayMs: 0, retryOn: ["target_not_found"] },
        postcondition: { kind: "target_visible", target: "resultsPanel", expected: true },
      },
      {
        id: "extract-balance",
        description: "Extract and type-check the savings balance.",
        command: "extract",
        output: "savingsBalance",
        extractor: {
          kind: "target_text",
          target: "savingsBalance",
          transforms: ["trim", "currency_to_number"],
        },
        effect: "read",
        idempotency: "idempotent",
        timeoutMs: 1_000,
        retry: { maxAttempts: 1, delayMs: 0, retryOn: [] },
        postcondition: { kind: "output_valid", output: "savingsBalance" },
      },
    ],
    success: {
      kind: "all",
      predicates: [
        { kind: "output_valid", output: "savingsBalance" },
        { kind: "target_visible", target: "resultsPanel", expected: true },
      ],
    },
    provenance: {
      discoveryRunId: "discovery-run-01",
      provider: "local-openai-compatible",
      modelId: "qwen-vision-live",
      promptHash: "a".repeat(64),
      liveModel: true,
      createdAt: CREATED_AT,
    },
  };
  return compileArtifact(draft);
}

export function replayBinding(): AppBinding {
  return {
    schemaVersion: "1.0.0",
    id: "member-console",
    product: {
      vendor: "Handrail Labs",
      product: "Legacy Member Console",
      tenantLabel: "Synthetic QA tenant",
    },
    origin: "http://127.0.0.1:4312",
    entrypoints: { memberSearch: "/legacy" },
    secretRefs: {},
    expectedFingerprint: {
      signals: [{ kind: "route", value: "/legacy", weight: 1 }],
      minimumScore: 1,
    },
    targetOverrides: {},
    policy: {
      allowedOrigins: ["http://127.0.0.1:4312"],
      allowedRoutes: ["/legacy"],
      allowedCommands: ["navigate", "set_value", "activate", "extract"],
      allowedEffects: ["read", "reversible_write"],
    },
  };
}

function observedElement(
  ref: string,
  role: string,
  name: string,
  extras: Partial<ObservedElement> = {},
): ObservedElement {
  return {
    ref,
    framePath: [],
    tagName: role === "textbox" ? "input" : role === "button" ? "button" : "div",
    role,
    name,
    text: name,
    interactive: role === "textbox" || role === "button",
    enabled: true,
    bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
    context: {},
    ...extras,
  };
}

function resolveExpression(
  expression: ValueExpression,
  inputs: Readonly<Record<string, unknown>>,
): unknown {
  if (expression.kind === "input") return inputs[expression.name];
  if (expression.kind === "literal") return expression.value;
  throw new Error(`Unsupported fake expression ${expression.kind}.`);
}

export class FakeReplaySurface implements SurfaceAdapter {
  createCalls = 0;
  navigateCalls = 0;
  closeCalls = 0;
  observeCalls = 0;
  dispatchCommands: string[] = [];
  activationCalls = 0;
  currentRoute = "/";
  bindingOrigin = "http://127.0.0.1:4312";
  observationOrigin: string | undefined;
  memberValue = "";
  state: "form" | "result" | "not_found" = "form";

  constructor(
    readonly buttonFault: "none" | "once" | "always" = "none",
    readonly terminalCheckpointFails = false,
  ) {}

  async createSession(binding: AppBinding): Promise<SurfaceSession> {
    this.createCalls += 1;
    this.bindingOrigin = binding.origin;
    return {
      id: "surface-replay-01",
      adapter: "playwright-web",
      createdAt: CREATED_AT,
      viewport: { width: 1280, height: 800 },
    };
  }

  async navigate(_sessionId: string, url: string, _grant: ControlGrant): Promise<ActionReceipt> {
    this.navigateCalls += 1;
    this.currentRoute = new URL(url).pathname;
    return this.receipt("navigate", "Navigated to the synthetic legacy console.");
  }

  async observe(sessionId: string): Promise<SurfaceObservation> {
    this.observeCalls += 1;
    const omitButton =
      this.buttonFault === "always" || (this.buttonFault === "once" && this.observeCalls === 2);
    const elements: ObservedElement[] = [
      observedElement("member-field", "textbox", "Member number", {
        value: this.memberValue,
        context: { precedingLabel: "Member number" },
      }),
      ...(omitButton ? [] : [observedElement("lookup-button", "button", "Find Member")]),
    ];
    if (this.state === "result") {
      elements.push(
        observedElement("result-panel", "status", "Member lookup result"),
        observedElement("balance-cell", "cell", "$1,284.37", {
          text: "$1,284.37",
          context: {
            rowLabel: "Savings",
            columnLabel: "Current balance",
            rowText: ["Savings", "Current balance", "$1,284.37"],
          },
        }),
      );
    }
    if (this.state === "not_found") {
      elements.push(observedElement("not-found", "status", "No member found."));
    }
    return {
      id: `observation-${this.observeCalls}`,
      sessionId,
      url: `${this.observationOrigin ?? this.bindingOrigin}${this.currentRoute}`,
      route: this.currentRoute,
      title: "Legacy Member Console",
      capturedAt: CREATED_AT,
      screenshotPng: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      viewport: { width: 1280, height: 800 },
      visibleText: "Synthetic member service",
      elements,
      fingerprint: "b".repeat(64),
    };
  }

  async dispatch(
    _sessionId: string,
    decision: ModelDecision,
    context: DispatchContext,
  ): Promise<ActionReceipt> {
    if (decision.observationId !== context.observationId) throw new Error("stale observation");
    this.dispatchCommands.push(decision.kind);
    if (decision.kind === "set_value") {
      this.memberValue = String(resolveExpression(decision.value, context.inputs));
    } else if (decision.kind === "activate") {
      this.activationCalls += 1;
      this.state = this.memberValue === "00000" ? "not_found" : "result";
    }
    return this.receipt(decision.kind, `Completed deterministic ${decision.kind}.`);
  }

  compileTarget(): TargetSpec {
    throw new Error("Replay never compiles targets.");
  }

  async evaluate(
    _sessionId: string,
    predicate: Predicate,
    context: PredicateContext,
  ): Promise<PredicateResult> {
    if (predicate.kind === "all" || predicate.kind === "any") {
      if (predicate.kind === "all" && this.terminalCheckpointFails) {
        return { passed: false, observed: "forced compound checkpoint mismatch" };
      }
      const values = await Promise.all(
        predicate.predicates.map((item) => this.evaluate("surface-replay-01", item, context)),
      );
      return {
        passed:
          predicate.kind === "all"
            ? values.every((value) => value.passed)
            : values.some((value) => value.passed),
        observed: values.map((value) => value.observed).join("; "),
      };
    }
    if (predicate.kind === "not") {
      const result = await this.evaluate("surface-replay-01", predicate.predicate, context);
      return { passed: !result.passed, observed: `not ${result.observed}` };
    }
    if (predicate.kind === "route_matches") {
      return {
        passed: routeMatches(predicate.route, this.currentRoute),
        observed: this.currentRoute,
      };
    }
    if (predicate.kind === "surface_fingerprint") {
      return { passed: true, observed: "fingerprint present" };
    }
    if (predicate.kind === "output_valid") {
      return {
        passed: context.outputs[predicate.output] !== undefined,
        observed: `output ${predicate.output}`,
      };
    }
    if (predicate.kind === "target_value_equals") {
      const expected = resolveExpression(predicate.expected, context.inputs);
      return {
        passed: predicate.target === "memberField" && this.memberValue === String(expected),
        observed: "member field value checked",
      };
    }
    const visible =
      (predicate.target === "resultsPanel" && this.state === "result") ||
      (predicate.target === "notFoundNotice" && this.state === "not_found");
    if (predicate.kind === "target_visible") {
      return { passed: visible === predicate.expected, observed: `visible=${visible}` };
    }
    return { passed: visible, observed: visible ? predicate.matcher.value : "target absent" };
  }

  async extract(): Promise<unknown> {
    if (this.state !== "result") throw new Error("result is unavailable");
    return 1_284.37;
  }

  resolveValue(expression: ValueExpression, inputs: Record<string, unknown>): unknown {
    return resolveExpression(expression, inputs);
  }

  async captureEvidence(
    _sessionId: string,
    _label: string,
    _signal?: AbortSignal,
    _expectedUrl?: string,
    _grant?: ControlGrant,
  ): Promise<Buffer> {
    return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }

  async pressKey(_sessionId: string, _key: string, _grant: ControlGrant): Promise<ActionReceipt> {
    return this.receipt("press_key", "Pressed key.");
  }

  async clickAt(
    _sessionId: string,
    _x: number,
    _y: number,
    _grant: ControlGrant,
  ): Promise<ActionReceipt> {
    return this.receipt("activate_coordinate", "Clicked coordinate.");
  }

  async typeFocused(
    _sessionId: string,
    _value: string,
    _grant: ControlGrant,
  ): Promise<ActionReceipt> {
    return this.receipt("set_value", "Typed value.");
  }

  async closeSession(): Promise<void> {
    this.closeCalls += 1;
  }

  async close(): Promise<void> {}

  private receipt(command: ActionReceipt["command"], summary: string): ActionReceipt {
    return {
      command,
      startedAt: CREATED_AT,
      finishedAt: CREATED_AT,
      durationMs: 0,
      changedSurface: true,
      summary,
    };
  }
}
