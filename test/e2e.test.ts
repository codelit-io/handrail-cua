import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { createDemoBinding, createDemoPolicyStack } from "../src/demo/config.js";
import {
  type AppBinding,
  type CapabilityArtifact,
  type CapabilityArtifactDraft,
  RunResultSchema,
} from "../src/domain/schema.js";
import { allowLoopbackDemoOperatorAction, startOperatorConsole } from "../src/operator/index.js";
import { compileArtifact } from "../src/runtime/artifact.js";
import { ControlCoordinator, ControlError, type ControlGrant } from "../src/runtime/control.js";
import {
  ReplayEngine,
  type ReplayInterventionContext,
  type ReplayInterventionResolution,
  type ReplaySurfaceSentinel,
} from "../src/runtime/replay.js";
import { BrowserSurface } from "../src/surface/browser-surface.js";
import type { SurfaceObservation, SurfaceSession } from "../src/surface/types.js";
import { type LegacyTargetHandle, startLegacyTarget } from "../src/target/server.js";

const HARD_SENTINELS: readonly ReplaySurfaceSentinel[] = [
  {
    kind: "hard_failure",
    pattern: /Permission denied[\s\S]*Access denied/iu,
    code: "PERMISSION_DENIED",
    message: "The synthetic member record is outside the operator's permissions.",
  },
  {
    kind: "hard_failure",
    pattern: /Application error E-500/iu,
    code: "INTERNAL_ERROR",
    message: "The synthetic member service returned its declared application error.",
  },
];

const SESSION_SENTINEL: ReplaySurfaceSentinel = {
  kind: "intervention",
  pattern: /Your session has expired/iu,
  reason: "SESSION_EXPIRED",
  message: "The live synthetic session expired and requires operator recovery.",
};

const SLOW_SENTINEL: ReplaySurfaceSentinel = {
  kind: "recoverable",
  code: "SLOW_MEMBER_LOAD",
  pattern: /Loading member record\. Please wait/iu,
  summary: "The bounded slow-member recovery window elapsed.",
  maxChecks: 30,
  delayMs: 100,
};

let calibrationSequence = 0;

function nextDecisionId(label: string): string {
  calibrationSequence += 1;
  return `${label}-${calibrationSequence}`;
}

function findMemberInput(observation: SurfaceObservation) {
  return observation.elements.find(
    (element) => element.role === "textbox" && element.context.precedingLabel === "Member number",
  );
}

function findLookupButton(observation: SurfaceObservation) {
  return observation.elements.find(
    (element) => element.role === "button" && element.name === "Find Member",
  );
}

async function searchMember(
  surface: BrowserSurface,
  session: SurfaceSession,
  grant: ControlGrant,
  observation: SurfaceObservation,
  memberId: string,
): Promise<SurfaceObservation> {
  const input = findMemberInput(observation);
  assert.ok(input, "calibration member input must be visible");
  await surface.dispatch(
    session.id,
    {
      kind: "set_value",
      decisionId: nextDecisionId("calibration-fill"),
      observationId: observation.id,
      rationale: "Calibrate a deterministic target without a planner.",
      elementRef: input.ref,
      value: { kind: "input", name: "memberId" },
    },
    { observationId: observation.id, inputs: { memberId }, grant },
  );
  const filled = await surface.observe(session.id);
  const button = findLookupButton(filled);
  assert.ok(button, "calibration lookup button must be visible");
  await surface.dispatch(
    session.id,
    {
      kind: "activate",
      decisionId: nextDecisionId("calibration-search"),
      observationId: filled.id,
      rationale: "Calibrate a deterministic target without a planner.",
      elementRef: button.ref,
    },
    { observationId: filled.id, inputs: { memberId }, grant },
  );
  return surface.observe(session.id);
}

async function calibrateArtifact(
  surface: BrowserSurface,
  control: ControlCoordinator,
  binding: AppBinding,
  target: LegacyTargetHandle,
): Promise<CapabilityArtifact> {
  const session = await surface.createSession(binding);
  const grant = control.createAutomationLease(session.id, "e2e-calibration");
  try {
    await surface.navigate(session.id, target.entryUrl(), grant);
    const initial = await surface.observe(session.id);
    const input = findMemberInput(initial);
    const button = findLookupButton(initial);
    assert.ok(input);
    assert.ok(button);
    const memberTarget = surface.compileTarget(initial.id, input.ref, "Member number input");
    const buttonTarget = surface.compileTarget(initial.id, button.ref, "Find member command");

    const unknown = await searchMember(surface, session, grant, initial, "11111");
    const notFound = unknown.elements.find(
      (element) => element.role === "status" && element.name === "Member search result",
    );
    assert.ok(notFound, "known member-not-found outcome must be visible during calibration");
    const notFoundTarget = surface.compileTarget(
      unknown.id,
      notFound.ref,
      "Known member-not-found outcome",
    );

    const successful = await searchMember(surface, session, grant, unknown, "84721");
    const balance = successful.elements.find(
      (element) =>
        element.context.rowLabel === "Savings" && element.context.columnLabel === "Current balance",
    );
    assert.ok(balance, "savings current balance must be visible during calibration");
    const balanceTarget = surface.compileTarget(
      successful.id,
      balance.ref,
      "Savings current balance",
    );

    const draft: CapabilityArtifactDraft = {
      schemaVersion: "1.0.0",
      id: "member-savings-e2e",
      revision: 1,
      name: "Synthetic member savings lookup",
      description: "Looks up a synthetic member and returns the verified Savings current balance.",
      purpose: "Exercise deterministic replay, typed outcomes, and safe exceptional handling.",
      compatibility: {
        product: {
          vendor: binding.product.vendor,
          product: binding.product.product,
        },
        requiredSurfaceCapabilities: [
          "accessibility_tree",
          "dom",
          "frames",
          "screenshot",
          "visual_anchors",
        ],
        fingerprint: binding.expectedFingerprint,
      },
      entrypoint: { bindingKey: "memberSearch", route: "/legacy" },
      contract: {
        inputs: {
          memberId: {
            description: "Synthetic five-digit member identifier",
            classification: "pii",
            required: true,
            validator: {
              kind: "string",
              pattern: "^[0-9]{5}$",
              minLength: 5,
              maxLength: 5,
            },
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
        memberField: memberTarget,
        lookupButton: buttonTarget,
        savingsBalance: balanceTarget,
        notFoundNotice: notFoundTarget,
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
          description: "Bind the typed member ID input to the legacy member form.",
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
          description: "Activate the read-only synthetic member lookup.",
          command: "activate",
          target: "lookupButton",
          effect: "read",
          idempotency: "idempotent",
          timeoutMs: 5_000,
          retry: { maxAttempts: 1, delayMs: 0, retryOn: [] },
          postcondition: {
            kind: "target_visible",
            target: "savingsBalance",
            expected: true,
          },
        },
        {
          id: "extract-balance",
          description: "Extract and validate the Savings current balance.",
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
          { kind: "target_visible", target: "savingsBalance", expected: true },
        ],
      },
      provenance: {
        discoveryRunId: "e2e-calibration-run",
        provider: "deterministic-test-calibration",
        modelId: "none",
        promptHash: "c".repeat(64),
        liveModel: false,
        createdAt: "2026-08-27T18:00:00.000Z",
      },
    };
    return compileArtifact(draft);
  } finally {
    try {
      await control.complete(grant);
    } catch {
      // A failing calibration will still release its browser resources below.
    }
    await surface.closeSession(session.id);
  }
}

async function postOperatorAction(
  interventionUrl: string,
  action: string,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  const operatorUrl = new URL(interventionUrl);
  const sessionId = decodeURIComponent(
    operatorUrl.pathname.split("/").filter(Boolean).at(-1) ?? "",
  );
  const capability = new URLSearchParams(operatorUrl.hash.slice(1)).get("capability") ?? "";
  if (!sessionId || !capability) throw new Error("Intervention URL is missing capability context.");
  return fetch(`${operatorUrl.origin}/api/sessions/${encodeURIComponent(sessionId)}/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: operatorUrl.origin,
      "X-Handrail-Console": "1",
      "X-Handrail-Capability": capability,
    },
    body: JSON.stringify(body),
  });
}

async function jsonBody<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("real-browser end-to-end replay", { concurrency: 1 }, () => {
  let target: LegacyTargetHandle;
  let control: ControlCoordinator;
  let surface: BrowserSurface;
  let binding: AppBinding;
  let artifact: CapabilityArtifact;

  before(async () => {
    target = await startLegacyTarget();
    control = new ControlCoordinator();
    surface = await BrowserSurface.launch({ control, headless: true });
    binding = createDemoBinding(target.origin);
    artifact = await calibrateArtifact(surface, control, binding, target);
  });

  after(async () => {
    await surface.close();
    await target.close();
  });

  function replay(
    options: {
      readonly sentinels?: readonly ReplaySurfaceSentinel[];
      readonly onIntervention?: (
        context: ReplayInterventionContext,
      ) => Promise<ReplayInterventionResolution>;
      readonly platformPolicy?: ReturnType<typeof createDemoPolicyStack>["platform"];
    } = {},
  ) {
    return new ReplayEngine({
      surface,
      control,
      platformPolicy: options.platformPolicy ?? createDemoPolicyStack(binding).platform,
      ...(options.sentinels ? { surfaceSentinels: options.sentinels } : {}),
      ...(options.onIntervention ? { onIntervention: options.onIntervention } : {}),
    });
  }

  it("reuses the artifact with a different valid member input", async () => {
    const result = await replay({ sentinels: HARD_SENTINELS }).run({
      artifact,
      binding,
      inputs: { memberId: "26017" },
      targetUrl: target.entryUrl(),
      runId: "e2e-different-member",
    });

    assert.equal(result.status, "succeeded");
    if (result.status === "succeeded") {
      assert.equal(result.outputs.savingsBalance, 8_912.04);
    }
    assert.equal(result.meta.modelCalls, 0);
    assert.equal(RunResultSchema.safeParse(result).success, true);
  });

  it("classifies an unknown member as a declared business outcome", async () => {
    const result = await replay({ sentinels: HARD_SENTINELS }).run({
      artifact,
      binding,
      inputs: { memberId: "11111" },
      targetUrl: target.entryUrl(),
      runId: "e2e-member-not-found",
    });

    assert.equal(result.status, "business_outcome");
    if (result.status === "business_outcome") {
      assert.equal(result.outcome.code, "MEMBER_NOT_FOUND");
      assert.equal(result.outcome.details.stepId, "activate-lookup");
    }
    assert.equal(result.meta.modelCalls, 0);
    assert.equal(RunResultSchema.safeParse(result).success, true);
  });

  it("waits through the bounded slow-state sentinel and completes", async () => {
    const result = await replay({ sentinels: [SLOW_SENTINEL, ...HARD_SENTINELS] }).run({
      artifact,
      binding,
      inputs: { memberId: "26017" },
      targetUrl: target.entryUrl("slow"),
      runId: "e2e-slow-recovery",
    });

    assert.equal(result.status, "succeeded");
    if (result.status === "succeeded") {
      assert.equal(result.outputs.savingsBalance, 8_912.04);
    }
    assert.equal(result.meta.modelCalls, 0);
  });

  it("returns a typed intervention while retaining the expired live session", async () => {
    const result = await replay({ sentinels: [SESSION_SENTINEL, ...HARD_SENTINELS] }).run({
      artifact,
      binding,
      inputs: { memberId: "84721" },
      targetUrl: target.entryUrl("session-expired"),
      runId: "e2e-session-intervention",
    });

    assert.equal(result.status, "needs_intervention");
    if (result.status !== "needs_intervention") return;
    assert.equal(result.intervention.reason, "SESSION_EXPIRED");
    assert.equal(result.intervention.sessionId, result.meta.sessionId);
    assert.equal(result.intervention.currentStepId, "activate-lookup");
    assert.equal(control.snapshot(result.meta.sessionId).phase, "AWAITING_OPERATOR");
    const retained = await surface.observe(result.meta.sessionId);
    assert.equal(retained.sessionId, result.meta.sessionId);
    assert.match(retained.visibleText, /Your session has expired/iu);
    assert.equal(result.meta.modelCalls, 0);
    await surface.closeSession(result.meta.sessionId);
  });

  it("hands the exact expired session to an operator, resumes it, and finishes replay", async () => {
    const consoleServer = await startOperatorConsole({
      control,
      surface,
      authorizeOperatorAction: allowLoopbackDemoOperatorAction,
    });
    let handlerCalls = 0;
    let handoffSessionId = "";
    let auditActions: readonly string[] = [];
    try {
      const result = await replay({
        sentinels: [SESSION_SENTINEL, ...HARD_SENTINELS],
        onIntervention: async (context) => {
          handlerCalls += 1;
          handoffSessionId = context.session.id;
          assert.equal(context.reason, "SESSION_EXPIRED");
          assert.equal(context.currentStepId, "activate-lookup");
          assert.equal(context.observation.sessionId, context.session.id);
          const restore = context.observation.elements.find(
            (element) => element.role === "button" && element.name === "Restore demo session",
          );
          assert.ok(restore, "operator must receive the live restore control");

          const intervention = await consoleServer.openIntervention({
            runId: context.runId,
            capability: context.artifactId,
            currentStep: context.currentStepId,
            reason: context.reason,
            stoppedBecause: context.summary,
            session: context.session,
            automationGrant: context.automationGrant,
            evaluateCheckpoint: async ({ session, observation }) => {
              assert.equal(session.id, context.session.id);
              assert.equal(observation.sessionId, context.session.id);
              return {
                passed:
                  !/Your session has expired/iu.test(observation.visibleText) &&
                  Boolean(findLookupButton(observation)),
                observed: "Session restored and Find Member is visible in the same session.",
              };
            },
          });
          assert.throws(
            () => control.assertGrant(context.automationGrant),
            (error: unknown) => error instanceof ControlError && error.code === "CONTROL_LOST",
          );
          const waiting = intervention.state();
          const claimResponse = await postOperatorAction(intervention.url, "claim", {
            operatorId: "e2e-operator",
            expectedEpoch: waiting.control.epoch,
          });
          assert.equal(claimResponse.status, 200, await claimResponse.clone().text());
          const claim = await jsonBody<{ claimId: string; epoch: number }>(claimResponse);

          const clickResponse = await postOperatorAction(intervention.url, "click", {
            claimId: claim.claimId,
            epoch: claim.epoch,
            x: (restore.bounds.x + restore.bounds.width / 2) * context.session.viewport.width,
            y: (restore.bounds.y + restore.bounds.height / 2) * context.session.viewport.height,
          });
          assert.equal(clickResponse.status, 200, await clickResponse.clone().text());

          const captureResponse = await postOperatorAction(intervention.url, "capture", {
            claimId: claim.claimId,
            epoch: claim.epoch,
          });
          assert.equal(captureResponse.status, 200, await captureResponse.clone().text());

          const resumedFromHandle = intervention.waitForResume();
          const resumeResponse = await postOperatorAction(intervention.url, "resume", {
            claimId: claim.claimId,
            epoch: claim.epoch,
          });
          assert.equal(resumeResponse.status, 200, await resumeResponse.clone().text());
          const resumed = await resumedFromHandle;
          assert.equal(resumed.sessionId, context.session.id);
          assert.notEqual(resumed.observation.id, context.observation.id);
          control.assertGrant(resumed.automationGrant, "automation");
          auditActions = intervention.audit().map((event) => event.action);
          return resumed;
        },
      }).run({
        artifact,
        binding,
        inputs: { memberId: "84721" },
        targetUrl: target.entryUrl("session-expired"),
        runId: "e2e-same-session-handoff",
      });

      assert.equal(result.status, "succeeded");
      if (result.status === "succeeded") {
        assert.equal(result.outputs.savingsBalance, 1_284.37);
      }
      assert.equal(handlerCalls, 1);
      assert.equal(result.meta.sessionId, handoffSessionId);
      assert.equal(result.meta.modelCalls, 0);
      assert.deepEqual(auditActions, [
        "automation_paused",
        "control_claimed",
        "operator_clicked",
        "evidence_captured",
        "control_returned",
      ]);
      assert.equal(control.snapshot(handoffSessionId).phase, "COMPLETED");
    } finally {
      await consoleServer.close();
    }
  });

  it("fails hard on declared permission and application errors", async () => {
    const cases = [
      { memberId: "40300", code: "PERMISSION_DENIED" },
      { memberId: "50000", code: "INTERNAL_ERROR" },
    ] as const;
    for (const entry of cases) {
      const result = await replay({ sentinels: HARD_SENTINELS }).run({
        artifact,
        binding,
        inputs: { memberId: entry.memberId },
        targetUrl: target.entryUrl(),
        runId: `e2e-hard-${entry.memberId}`,
      });
      assert.equal(result.status, "failed");
      if (result.status === "failed") {
        assert.equal(result.error.code, entry.code);
        assert.equal(result.error.phase, "replay");
        assert.equal(result.error.retryable, false);
      }
      assert.equal(result.meta.modelCalls, 0);
      assert.equal(RunResultSchema.safeParse(result).success, true);
    }
  });

  it("fails closed when the live target becomes ambiguous", async () => {
    const result = await replay({ sentinels: HARD_SENTINELS }).run({
      artifact,
      binding,
      inputs: { memberId: "84721" },
      targetUrl: target.entryUrl("ambiguous"),
      runId: "e2e-ambiguous-target",
    });

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.code, "TARGET_AMBIGUOUS");
      assert.equal(result.error.retryable, false);
    }
    assert.equal(result.meta.modelCalls, 0);
  });

  it("keeps an off-origin link inside the exact-origin browser network boundary", async () => {
    const session = await surface.createSession(binding);
    const grant = control.createAutomationLease(session.id, "e2e-off-origin-gate");
    try {
      await surface.navigate(session.id, target.entryUrl("off-origin"), grant);
      const observation = await surface.observe(session.id);
      const externalLink = observation.elements.find(
        (element) => element.role === "link" && element.name === "External diagnostics",
      );
      assert.ok(externalLink);
      await surface
        .dispatch(
          session.id,
          {
            kind: "activate",
            decisionId: "e2e-off-origin-click",
            observationId: observation.id,
            rationale: "Verify the exact-origin surface network boundary.",
            elementRef: externalLink.ref,
          },
          { observationId: observation.id, inputs: {}, grant },
        )
        .catch(() => undefined);
      const after = await surface.observe(session.id);
      assert.equal(after.route, "/legacy");
      assert.notEqual(after.title, "Example Domain");
    } finally {
      try {
        await control.complete(grant);
      } catch {
        // The session is still closed below if a browser action invalidates control.
      }
      await surface.closeSession(session.id);
    }
  });

  it("denies entry navigation before creating a browser session when platform origin differs", async () => {
    const allowed = createDemoPolicyStack(binding).platform;
    const result = await replay({
      platformPolicy: { ...allowed, allowedOrigins: ["http://127.0.0.1:9"] },
    }).run({
      artifact,
      binding,
      inputs: { memberId: "84721" },
      targetUrl: target.entryUrl(),
      runId: "e2e-policy-denied",
    });

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.code, "POLICY_DENIED");
      assert.equal(result.error.observed, "ORIGIN_DENIED");
    }
    assert.equal(result.meta.sessionId, "session-pending");
    assert.equal(result.meta.modelCalls, 0);
  });

  it("has no import edge to a planner or model implementation", async () => {
    const source = await readFile(new URL("./e2e.test.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]);
    assert.equal(
      imports.some((specifier) => /(?:^|\/)(?:model|planner)(?:\/|$)/u.test(specifier ?? "")),
      false,
    );
  });
});
