import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AppBindingSchema,
  AutomationEventSchema,
  type CapabilityArtifactDraft,
  ModelDecisionSchema,
  RunResultSchema,
  RuntimeJsonSchemas,
} from "../src/domain/schema.js";
import {
  ArtifactBindingError,
  ArtifactCompilationError,
  assertValidArtifact,
  bindArtifactInputs,
  bindValueExpression,
  canonicalStringify,
  compileArtifact,
  computeArtifactDigest,
  lintArtifact,
  validateArtifactOutputs,
  verifyArtifactDigest,
} from "../src/runtime/artifact.js";

const HASH = "a".repeat(64);
const CREATED_AT = "2026-08-27T18:00:00.000Z";

function target(description: string, role: "button" | "cell" | "status" | "textbox", name: string) {
  return {
    description,
    match: "exactly_one_visible" as const,
    candidates: [
      {
        kind: "role" as const,
        role,
        name,
        exact: true as const,
        rationale: "Accessible name is stable across tenant themes.",
      },
      {
        kind: "relation" as const,
        anchorText: name,
        relationship: "within" as const,
        role,
        rationale: "Contextual relationship survives generated markup changes.",
      },
    ],
    fingerprint: {
      role,
      accessibleName: name,
      nearbyText: ["Synthetic member service"],
      minimumScore: 0.75,
    },
    robustnessRationale:
      "Two semantic candidates avoid generated identifiers and fail closed on ambiguity.",
  };
}

function validDraft(): CapabilityArtifactDraft {
  return {
    schemaVersion: "1.0.0",
    id: "member-savings-lookup",
    revision: 1,
    name: "Member savings balance lookup",
    description: "Looks up a synthetic member and returns the verified savings balance.",
    purpose: "Provide a deterministic, read-only member balance lookup for support staff.",
    compatibility: {
      product: {
        vendor: "Handrail Labs",
        product: "Legacy Member Console",
        versionRange: ">=1 <2",
      },
      requiredSurfaceCapabilities: ["accessibility_tree", "dom", "frames"],
      fingerprint: {
        signals: [
          { kind: "route", value: "/legacy", weight: 0.5 },
          { kind: "heading", value: "Synthetic member service", weight: 0.5 },
        ],
        minimumScore: 0.8,
      },
    },
    entrypoint: { bindingKey: "member-console", route: "/legacy" },
    contract: {
      inputs: {
        memberId: {
          description: "Synthetic member identifier",
          classification: "internal",
          required: true,
          validator: { kind: "string", pattern: "^SYN-[0-9]{4}$", minLength: 8, maxLength: 8 },
        },
      },
      outputs: {
        savingsBalance: {
          description: "Savings account available balance",
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
      memberField: target("Member identifier field", "textbox", "Member number"),
      lookupButton: target("Lookup command", "button", "Find member"),
      resultsPanel: target("Successful lookup result", "status", "Member lookup result"),
      savingsBalance: target("Savings available balance", "cell", "Available balance"),
      notFoundNotice: target("Known member-not-found notice", "status", "Member not found"),
    },
    effects: ["read", "reversible_write"],
    policyRequirements: {
      allowedRoutes: ["/legacy"],
      allowedCommands: ["set_value", "activate", "extract"],
      allowedEffects: ["read", "reversible_write"],
      approvalRequiredFor: [],
    },
    steps: [
      {
        id: "set-member-id",
        description: "Bind the invocation member identifier to the form.",
        command: "set_value",
        target: "memberField",
        value: { kind: "input", name: "memberId" },
        effect: "reversible_write",
        idempotency: "idempotent",
        timeoutMs: 3_000,
        retry: { maxAttempts: 1, delayMs: 0, retryOn: [] },
        postcondition: {
          kind: "target_value_equals",
          target: "memberField",
          expected: { kind: "input", name: "memberId" },
        },
      },
      {
        id: "activate-lookup",
        description: "Start the read-only member lookup.",
        command: "activate",
        target: "lookupButton",
        effect: "read",
        idempotency: "idempotent",
        timeoutMs: 5_000,
        retry: { maxAttempts: 1, delayMs: 0, retryOn: [] },
        postcondition: { kind: "target_visible", target: "resultsPanel", expected: true },
      },
      {
        id: "extract-balance",
        description: "Extract and validate the savings balance.",
        command: "extract",
        output: "savingsBalance",
        extractor: {
          kind: "target_text",
          target: "savingsBalance",
          transforms: ["trim", "currency_to_number"],
        },
        effect: "read",
        idempotency: "idempotent",
        timeoutMs: 3_000,
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
      modelId: "vision-model-demo",
      promptHash: HASH,
      liveModel: true,
      createdAt: CREATED_AT,
    },
  };
}

describe("capability artifact contracts", () => {
  it("compiles a strict draft, binds a canonical digest, and freezes the result", () => {
    const artifact = compileArtifact(validDraft());

    assert.equal(artifact.digest.length, 64);
    assert.equal(artifact.digest, computeArtifactDigest(artifact));
    assert.equal(verifyArtifactDigest(artifact), true);
    assert.equal(Object.isFrozen(artifact), true);
    assert.equal(Object.isFrozen(artifact.steps), true);
    assert.equal(lintArtifact(artifact).ok, true);
    assert.deepEqual(assertValidArtifact(artifact), artifact);
  });

  it("canonicalizes object keys while retaining workflow array order", () => {
    assert.equal(
      canonicalStringify({ z: ["second", "first"], a: { d: 2, c: 1 } }),
      '{"a":{"c":1,"d":2},"z":["second","first"]}',
    );
    assert.equal(canonicalStringify({ value: -0 }), '{"value":0}');
    assert.throws(() => canonicalStringify({ bad: Number.NaN }), /non-finite/u);
    assert.throws(() => canonicalStringify({ bad: undefined }), /undefined/u);
  });

  it("detects canonical content drift", () => {
    const artifact = compileArtifact(validDraft());
    const changed = structuredClone(artifact);
    changed.description = "A changed description invalidates the reviewed digest.";

    assert.equal(verifyArtifactDigest(changed), false);
    const result = lintArtifact(changed);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((entry) => entry.code === "DIGEST_MISMATCH"));
  });

  it("exports draft 2020-12 JSON Schemas from the runtime Zod contracts", () => {
    for (const schema of Object.values(RuntimeJsonSchemas)) {
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.equal(typeof schema, "object");
    }
    const properties = RuntimeJsonSchemas.capabilityArtifact.properties;
    assert.equal(typeof properties, "object");
    assert.ok(properties && "steps" in properties && "success" in properties);
  });
});

describe("artifact safety linter", () => {
  it("rejects invocation and sensitive literals", () => {
    const draft = validDraft();
    const first = draft.steps[0];
    assert.ok(first?.command === "set_value");
    first.value = {
      kind: "literal",
      value: "candidate@example.com",
      classification: "pii",
      rationale: "Copied from this invocation",
    };

    const result = lintArtifact(draft);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((entry) => entry.code === "SENSITIVE_LITERAL"));
    assert.throws(
      () => compileArtifact(draft),
      (error: unknown) =>
        error instanceof ArtifactCompilationError &&
        error.issues.some((entry) => entry.code === "SENSITIVE_LITERAL"),
    );
  });

  it("rejects a step with no verified postcondition", () => {
    const draft = structuredClone(validDraft()) as unknown as {
      steps: Array<Record<string, unknown>>;
    };
    const first = draft.steps[0];
    assert.ok(first);
    delete first.postcondition;

    const result = lintArtifact(draft);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((entry) => entry.code === "MISSING_POSTCONDITION"));
  });

  it("rejects automatic retry of non-idempotent and commit effects", () => {
    const draft = validDraft();
    const lookup = draft.steps[1];
    assert.ok(lookup);
    lookup.idempotency = "non_idempotent";
    lookup.retry.maxAttempts = 2;

    let result = lintArtifact(draft);
    assert.ok(result.issues.some((entry) => entry.code === "UNSAFE_RETRY"));

    lookup.idempotency = "idempotent";
    lookup.effect = "commit";
    draft.effects.push("commit");
    draft.policyRequirements.allowedEffects.push("commit");
    draft.policyRequirements.approvalRequiredFor.push("commit");
    result = lintArtifact(draft);
    assert.ok(result.issues.some((entry) => entry.code === "UNSAFE_RETRY"));
  });

  it("rejects weak targets and duplicate candidates", () => {
    const draft = validDraft();
    const spec = draft.targets.memberField;
    assert.ok(spec);
    spec.candidates = [spec.candidates[0] as NonNullable<(typeof spec.candidates)[number]>];

    let result = lintArtifact(draft);
    assert.ok(result.issues.some((entry) => entry.code === "WEAK_TARGET"));

    const duplicate = structuredClone(validDraft());
    const duplicateSpec = duplicate.targets.memberField;
    assert.ok(duplicateSpec);
    const first = duplicateSpec.candidates[0];
    assert.ok(first);
    duplicateSpec.candidates = [first, structuredClone(first)];
    result = lintArtifact(duplicate);
    assert.ok(result.issues.some((entry) => entry.code === "DUPLICATE_CANDIDATE"));
  });

  it("rejects missing or weak terminal success", () => {
    const missing = structuredClone(validDraft()) as unknown as Record<string, unknown>;
    delete missing.success;
    let result = lintArtifact(missing);
    assert.ok(result.issues.some((entry) => entry.code === "MISSING_TERMINAL_SUCCESS"));

    const weak = validDraft();
    weak.success = { kind: "route_matches", route: "/legacy" };
    result = lintArtifact(weak);
    assert.ok(result.issues.some((entry) => entry.code === "WEAK_TERMINAL_SUCCESS"));
  });

  it("rejects unknown target references and policy-escaping routes", () => {
    const draft = validDraft();
    const lookup = draft.steps[1];
    assert.ok(lookup?.command === "activate");
    lookup.target = "inventedTarget";
    draft.entrypoint.route = "/admin";

    const result = lintArtifact(draft);
    assert.ok(result.issues.some((entry) => entry.code === "UNKNOWN_TARGET"));
    assert.ok(result.issues.some((entry) => entry.code === "ROUTE_NOT_ALLOWED"));
  });
});

describe("typed runtime binding", () => {
  it("validates declared inputs before the surface is touched", () => {
    const artifact = compileArtifact(validDraft());
    assert.deepEqual(bindArtifactInputs(artifact, { memberId: "SYN-1001" }), {
      memberId: "SYN-1001",
    });
    assert.throws(
      () => bindArtifactInputs(artifact, { memberId: "real-person" }),
      (error: unknown) => error instanceof ArtifactBindingError && error.code === "INPUT_INVALID",
    );
    assert.throws(
      () => bindArtifactInputs(artifact, {}),
      (error: unknown) => error instanceof ArtifactBindingError && error.code === "INPUT_MISSING",
    );
    assert.throws(
      () => bindArtifactInputs(artifact, { memberId: "SYN-1001", extra: true }),
      (error: unknown) => error instanceof ArtifactBindingError && error.code === "INPUT_INVALID",
    );
  });

  it("validates every declared output before returning success", () => {
    const artifact = compileArtifact(validDraft());
    assert.deepEqual(validateArtifactOutputs(artifact, { savingsBalance: 2_401.5 }), {
      savingsBalance: 2_401.5,
    });
    assert.throws(
      () => validateArtifactOutputs(artifact, {}),
      (error: unknown) =>
        error instanceof ArtifactBindingError && error.path === "$.outputs.savingsBalance",
    );
    assert.throws(
      () => validateArtifactOutputs(artifact, { savingsBalance: -1 }),
      (error: unknown) => error instanceof ArtifactBindingError && error.code === "OUTPUT_INVALID",
    );
  });

  it("resolves typed expression nodes without template interpolation", () => {
    assert.equal(
      bindValueExpression(
        { kind: "input", name: "memberId" },
        { inputs: { memberId: "SYN-2002" } },
      ),
      "SYN-2002",
    );
    assert.equal(
      bindValueExpression(
        { kind: "step_output", stepId: "extract-balance", name: "savingsBalance" },
        {
          inputs: {},
          stepOutputs: { "extract-balance": { savingsBalance: 2_401.5 } },
        },
      ),
      2_401.5,
    );
    assert.equal(
      bindValueExpression(
        { kind: "secret_ref", name: "preauthenticated-session" },
        { inputs: {}, resolveSecret: () => "opaque-runtime-value" },
      ),
      "opaque-runtime-value",
    );
    assert.throws(
      () => bindValueExpression({ kind: "input", name: "memberId" }, { inputs: {} }),
      (error: unknown) => error instanceof ArtifactBindingError && error.code === "INPUT_MISSING",
    );
  });
});

describe("related runtime contracts", () => {
  it("accepts exact-origin tenant bindings and rejects path-bearing origins", () => {
    const artifact = compileArtifact(validDraft());
    const binding = {
      schemaVersion: "1.0.0",
      id: "demo-tenant",
      product: {
        vendor: artifact.compatibility.product.vendor,
        product: artifact.compatibility.product.product,
        tenantLabel: "Synthetic demo tenant",
      },
      origin: "http://127.0.0.1:4173",
      entrypoints: { "member-console": "/legacy" },
      secretRefs: {},
      expectedFingerprint: artifact.compatibility.fingerprint,
      targetOverrides: {},
      policy: {
        allowedOrigins: ["http://127.0.0.1:4173"],
        allowedRoutes: ["/legacy"],
        allowedCommands: ["set_value", "activate", "extract"],
        allowedEffects: ["read", "reversible_write"],
      },
    } as const;
    assert.equal(AppBindingSchema.safeParse(binding).success, true);
    assert.equal(
      AppBindingSchema.safeParse({ ...binding, origin: "http://127.0.0.1:4173/legacy" }).success,
      false,
    );
  });

  it("keeps model decisions bounded to current refs or normalized coordinates", () => {
    const decision = {
      decisionId: "decision-01",
      observationId: "observation-01",
      rationale: "The exact accessible control matches the requested lookup action.",
      kind: "activate",
      elementRef: "element-04",
    } as const;
    assert.equal(ModelDecisionSchema.safeParse(decision).success, true);
    assert.equal(
      ModelDecisionSchema.safeParse({ ...decision, kind: "activate_coordinate", x: 1.01, y: 0.5 })
        .success,
      false,
    );
    assert.equal(
      ModelDecisionSchema.safeParse({ ...decision, script: "document.body.click()" }).success,
      false,
    );
  });

  it("preserves the four-way result taxonomy", () => {
    const meta = {
      runId: "replay-run-01",
      artifactId: "member-savings-lookup",
      artifactDigest: HASH,
      sessionId: "surface-session-01",
      startedAt: CREATED_AT,
      finishedAt: "2026-08-27T18:00:01.000Z",
      durationMs: 1_000,
      modelCalls: 0,
      ownerEpoch: 1,
    } as const;
    const results = [
      { status: "succeeded", outputs: { savingsBalance: 2_401.5 }, checkpointEvidence: [], meta },
      {
        status: "business_outcome",
        outcome: { code: "MEMBER_NOT_FOUND", message: "No member matched.", details: {} },
        evidence: [],
        meta,
      },
      {
        status: "needs_intervention",
        intervention: {
          id: "intervention-01",
          runId: meta.runId,
          sessionId: meta.sessionId,
          reason: "SESSION_EXPIRED",
          summary: "The synthetic session expired before the result loaded.",
          observedState: "Timeout dialog is visible.",
          allowedActions: ["claim", "resume"],
          evidence: [],
          ownerEpoch: 2,
          createdAt: CREATED_AT,
        },
        meta,
      },
      {
        status: "failed",
        error: {
          code: "PERMISSION_DENIED",
          message: "The synthetic member is restricted.",
          phase: "replay",
          retryable: false,
          evidence: [],
        },
        meta,
      },
    ] as const;
    for (const result of results) {
      assert.equal(RunResultSchema.safeParse(result).success, true);
    }
  });

  it("requires correlated, strict event envelopes", () => {
    const event = {
      schemaVersion: "1.0.0",
      eventId: "event-01",
      sequence: 1,
      timestamp: CREATED_AT,
      runId: "replay-run-01",
      correlationId: "correlation-01",
      sessionId: "surface-session-01",
      artifactId: "member-savings-lookup",
      actor: "automation",
      ownerEpoch: 1,
      type: "run.completed",
      status: "succeeded",
      durationMs: 1_000,
      modelCalls: 0,
    } as const;
    assert.equal(AutomationEventSchema.safeParse(event).success, true);
    assert.equal(
      AutomationEventSchema.safeParse({ ...event, rawModelTranscript: "forbidden" }).success,
      false,
    );
  });
});
