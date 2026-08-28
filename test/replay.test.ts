import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createDemoBinding, createDemoPolicyStack } from "../src/demo/config.js";
import {
  type CapabilityArtifactDraft,
  type ModelDecision,
  RunResultSchema,
} from "../src/domain/schema.js";
import { compileArtifact } from "../src/runtime/artifact.js";
import { ControlCoordinator, ControlError, type ControlGrant } from "../src/runtime/control.js";
import { ReplayEngine } from "../src/runtime/replay.js";
import { BrowserSurface } from "../src/surface/browser-surface.js";
import type { ActionReceipt, DispatchContext } from "../src/surface/types.js";
import { startLegacyTarget } from "../src/target/server.js";
import { FakeReplaySurface, replayArtifact, replayBinding } from "./fixtures/replay/scenario.js";

const platformPolicy = {
  name: "platform",
  allowedOrigins: ["http://127.0.0.1:4312"],
  allowedRoutes: ["/**"],
  allowedCommands: ["navigate", "set_value", "activate", "extract"],
  allowedEffects: ["read", "reversible_write"],
} as const;

function engine(surface: FakeReplaySurface): ReplayEngine {
  return new ReplayEngine({
    surface,
    control: new ControlCoordinator(),
    platformPolicy,
    now: () => new Date("2026-08-27T18:00:00.000Z"),
    sleep: async () => undefined,
  });
}

class AbortAwareDelayedSurface extends FakeReplaySurface {
  actionSettled = false;
  actionSettledAtClose = false;
  controlPhaseAtClose = "";

  constructor(readonly control: ControlCoordinator) {
    super();
  }

  override async dispatch(
    sessionId: string,
    decision: ModelDecision,
    context: DispatchContext,
  ): Promise<ActionReceipt> {
    if (decision.kind !== "set_value") return super.dispatch(sessionId, decision, context);
    this.dispatchCommands.push(decision.kind);
    return this.control.withControl(context.grant, async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 250);
          const onAbort = () => {
            clearTimeout(timer);
            reject(context.signal?.reason ?? new Error("Replay action aborted."));
          };
          context.signal?.addEventListener("abort", onAbort, { once: true });
        });
        context.signal?.throwIfAborted();
        this.memberValue = String(
          decision.value.kind === "input"
            ? context.inputs[decision.value.name]
            : decision.value.kind === "literal"
              ? decision.value.value
              : "",
        );
        return {
          command: "set_value",
          startedAt: "2026-08-27T18:00:00.000Z",
          finishedAt: "2026-08-27T18:00:00.000Z",
          durationMs: 250,
          changedSurface: true,
          summary: "Completed a delayed mutation.",
        };
      } finally {
        this.actionSettled = true;
      }
    });
  }

  override async closeSession(sessionId = "surface-replay-01"): Promise<void> {
    this.actionSettledAtClose = this.actionSettled;
    this.controlPhaseAtClose = this.control.snapshot(sessionId).phase;
    await super.closeSession();
  }
}

class UncooperativeDelayedSurface extends FakeReplaySurface {
  actionSettled = false;
  actionSettledAtClose = false;
  readonly actionStarted: Promise<void>;
  readonly #actionGate: Promise<void>;
  #markActionStarted: (() => void) | undefined;
  #releaseAction: (() => void) | undefined;

  constructor(readonly control: ControlCoordinator) {
    super();
    this.actionStarted = new Promise((resolve) => {
      this.#markActionStarted = resolve;
    });
    this.#actionGate = new Promise((resolve) => {
      this.#releaseAction = resolve;
    });
  }

  releaseAction(): void {
    this.#releaseAction?.();
  }

  override async dispatch(
    sessionId: string,
    decision: ModelDecision,
    context: DispatchContext,
  ): Promise<ActionReceipt> {
    if (decision.kind !== "set_value") return super.dispatch(sessionId, decision, context);
    this.dispatchCommands.push(decision.kind);
    return this.control.withControl(context.grant, async () => {
      this.#markActionStarted?.();
      await this.#actionGate;
      this.memberValue = String(
        decision.value.kind === "input" ? context.inputs[decision.value.name] : "mutated",
      );
      this.actionSettled = true;
      return {
        command: "set_value",
        startedAt: "2026-08-27T18:00:00.000Z",
        finishedAt: "2026-08-27T18:00:00.000Z",
        durationMs: 0,
        changedSurface: true,
        summary: "Completed an adapter action that ignored cancellation.",
      };
    });
  }

  override async closeSession(): Promise<void> {
    this.actionSettledAtClose = this.actionSettled;
    await super.closeSession();
  }
}

function artifactWithFirstStepTimeout(timeoutMs: number) {
  const { digest: _digest, ...draft } = structuredClone(replayArtifact());
  return compileArtifact({
    ...draft,
    steps: draft.steps.map((step, index) => (index === 0 ? { ...step, timeoutMs } : step)),
  });
}

describe("deterministic capability replay", () => {
  it("replays ordered typed steps, extracts a validated output, and proves zero model calls", async () => {
    const surface = new FakeReplaySurface();
    const result = await engine(surface).run({
      artifact: replayArtifact(),
      binding: replayBinding(),
      inputs: { memberId: "84721" },
      runId: "replay-happy-01",
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.meta.modelCalls, 0);
    if (result.status === "succeeded") {
      assert.equal(result.outputs.savingsBalance, 1_284.37);
      assert.deepEqual(result.checkpointEvidence, []);
    }
    assert.deepEqual(surface.dispatchCommands, ["set_value", "activate"]);
    assert.equal(surface.activationCalls, 1);
    assert.equal(surface.navigateCalls, 1);
    assert.equal(surface.closeCalls, 1);
    assert.equal(RunResultSchema.safeParse(result).success, true);
  });

  it("returns a declared business outcome before treating its failed success checkpoint as an error", async () => {
    const surface = new FakeReplaySurface();
    const result = await engine(surface).run({
      artifact: replayArtifact(),
      binding: replayBinding(),
      inputs: { memberId: "00000" },
      runId: "replay-outcome-01",
    });

    assert.equal(result.status, "business_outcome");
    assert.equal(result.meta.modelCalls, 0);
    if (result.status === "business_outcome") {
      assert.equal(result.outcome.code, "MEMBER_NOT_FOUND");
      assert.equal(result.outcome.details.stepId, "activate-lookup");
    }
    assert.deepEqual(surface.dispatchCommands, ["set_value", "activate"]);
    assert.equal(RunResultSchema.safeParse(result).success, true);
  });

  it("rejects invalid typed input before creating or navigating any surface", async () => {
    const surface = new FakeReplaySurface();
    const result = await engine(surface).run({
      artifact: replayArtifact(),
      binding: replayBinding(),
      inputs: { memberId: "not-five-digits" },
      runId: "replay-preflight-01",
    });

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.phase, "preflight");
      assert.equal(result.error.code, "INPUT_INVALID");
    }
    assert.equal(result.meta.modelCalls, 0);
    assert.equal(surface.createCalls, 0);
    assert.equal(surface.navigateCalls, 0);
    assert.equal(surface.observeCalls, 0);
    assert.equal(RunResultSchema.safeParse(result).success, true);
  });

  it("rejects reviewed-content drift before creating a surface", async () => {
    const surface = new FakeReplaySurface();
    const artifact = structuredClone(replayArtifact());
    artifact.description = "Drifted content must invalidate the compiled digest before replay.";
    const result = await engine(surface).run({
      artifact,
      binding: replayBinding(),
      inputs: { memberId: "84721" },
      runId: "replay-digest-01",
    });

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.phase, "preflight");
      assert.equal(result.error.code, "ARTIFACT_DIGEST_MISMATCH");
    }
    assert.equal(surface.createCalls, 0);
    assert.equal(surface.navigateCalls, 0);
    assert.equal(result.meta.modelCalls, 0);
  });

  it("rejects an off-origin target URL override before creating a surface", async () => {
    const surface = new FakeReplaySurface();
    const result = await engine(surface).run({
      artifact: replayArtifact(),
      binding: replayBinding(),
      inputs: { memberId: "84721" },
      targetUrl: "https://example.com/legacy?scenario=off-origin",
      runId: "replay-target-url-denied",
    });

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.phase, "preflight");
      assert.equal(result.error.code, "ARTIFACT_INVALID");
    }
    assert.equal(surface.createCalls, 0);
    assert.equal(surface.navigateCalls, 0);
    assert.equal(result.meta.modelCalls, 0);
  });

  it("retries only a configured recoverable class and stays within maxAttempts", async () => {
    const surface = new FakeReplaySurface("once");
    const result = await engine(surface).run({
      artifact: replayArtifact(),
      binding: replayBinding(),
      inputs: { memberId: "84721" },
      runId: "replay-retry-01",
    });

    assert.equal(result.status, "succeeded");
    assert.equal(surface.activationCalls, 1);
    assert.deepEqual(surface.dispatchCommands, ["set_value", "activate"]);
    assert.equal(result.meta.modelCalls, 0);
  });

  it("escalates exhausted configured recovery without closing the same surface session", async () => {
    const surface = new FakeReplaySurface("always");
    const result = await engine(surface).run({
      artifact: replayArtifact(),
      binding: replayBinding(),
      inputs: { memberId: "84721" },
      runId: "replay-intervention-01",
    });

    assert.equal(result.status, "needs_intervention");
    if (result.status === "needs_intervention") {
      assert.equal(result.intervention.reason, "STUCK");
      assert.equal(result.intervention.sessionId, "surface-replay-01");
      assert.equal(result.intervention.currentStepId, "activate-lookup");
    }
    assert.equal(surface.closeCalls, 0);
    assert.deepEqual(surface.dispatchCommands, ["set_value"]);
    assert.equal(result.meta.modelCalls, 0);
    assert.equal(RunResultSchema.safeParse(result).success, true);
  });

  it("fails and revokes the current automation grant when resume validation fails", async () => {
    const surface = new FakeReplaySurface("always");
    const control = new ControlCoordinator();
    let resumedGrant: ControlGrant | undefined;
    const result = await new ReplayEngine({
      surface,
      control,
      platformPolicy,
      now: () => new Date("2026-08-27T18:00:00.000Z"),
      sleep: async () => undefined,
      onIntervention: async (context) => {
        control.requestPause(context.automationGrant, "Operator recovery requested");
        await control.quiesceAutomation(context.automationGrant);
        const operatorGrant = control.claimOperator(context.session.id, "operator-replay-test");
        control.requestResume(operatorGrant);
        resumedGrant = control.returnToAutomation(operatorGrant, context.runId);
        return {
          sessionId: context.session.id,
          automationGrant: resumedGrant,
          observation: await surface.observe(context.session.id),
          checkpoint: {
            passed: false,
            observed: "The operator recovery checkpoint is still blocked.",
          },
        };
      },
    }).run({
      artifact: replayArtifact(),
      binding: replayBinding(),
      inputs: { memberId: "84721" },
      runId: "replay-resume-failure-01",
    });

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.code, "POSTCONDITION_FAILED");
    }
    const returnedGrant = resumedGrant;
    assert.ok(returnedGrant);
    const snapshot = control.snapshot(result.meta.sessionId);
    assert.equal(snapshot.phase, "FAILED");
    assert.equal(snapshot.owner, null);
    assert.equal(snapshot.epoch, result.meta.ownerEpoch);
    assert.ok(snapshot.epoch > returnedGrant.epoch);
    assert.throws(
      () => control.assertGrant(returnedGrant),
      (error: unknown) => error instanceof ControlError && error.code === "CONTROL_LOST",
    );
    assert.equal(surface.closeCalls, 1);
    assert.equal(result.meta.modelCalls, 0);
  });

  it("cancels and settles a timed-out action before terminal control, close, or return", async () => {
    const control = new ControlCoordinator();
    const surface = new AbortAwareDelayedSurface(control);
    const artifact = artifactWithFirstStepTimeout(100);

    const result = await new ReplayEngine({
      surface,
      control,
      platformPolicy,
      now: () => new Date("2026-08-27T18:00:00.000Z"),
    }).run({
      artifact,
      binding: replayBinding(),
      inputs: { memberId: "84721" },
      runId: "replay-timeout-settlement-01",
    });

    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.code, "POSTCONDITION_FAILED");
    assert.equal(surface.memberValue, "");
    assert.equal(surface.actionSettled, true);
    assert.equal(surface.actionSettledAtClose, true);
    assert.equal(surface.controlPhaseAtClose, "FAILED");
    assert.equal(control.snapshot(result.meta.sessionId).phase, "FAILED");
    assert.equal(surface.closeCalls, 1);

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(surface.memberValue, "", "no delayed mutation may occur after replay returns");
    assert.equal(surface.closeCalls, 1);
  });

  it("joins an adapter that ignores cancellation before closing or returning", async () => {
    const control = new ControlCoordinator();
    const surface = new UncooperativeDelayedSurface(control);
    let returned = false;
    const resultPromise = new ReplayEngine({
      surface,
      control,
      platformPolicy,
      now: () => new Date("2026-08-27T18:00:00.000Z"),
    })
      .run({
        artifact: artifactWithFirstStepTimeout(100),
        binding: replayBinding(),
        inputs: { memberId: "84721" },
        runId: "replay-timeout-uncooperative-01",
      })
      .then((result) => {
        returned = true;
        return result;
      });

    await surface.actionStarted;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(returned, false, "replay must still be joining the timed-out action");
    assert.equal(surface.closeCalls, 0);
    assert.equal(surface.actionSettled, false);

    surface.releaseAction();
    const result = await resultPromise;
    assert.equal(result.status, "failed");
    assert.equal(surface.memberValue, "84721");
    assert.equal(surface.actionSettledAtClose, true);
    assert.equal(surface.closeCalls, 1);
    const settledValue = surface.memberValue;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(surface.memberValue, settledValue, "no mutation may occur after replay returns");
  });

  it("returns a hard failure when the compound terminal checkpoint is false", async () => {
    const surface = new FakeReplaySurface("none", true);
    const result = await engine(surface).run({
      artifact: replayArtifact(),
      binding: replayBinding(),
      inputs: { memberId: "84721" },
      runId: "replay-checkpoint-01",
    });

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.code, "POSTCONDITION_FAILED");
      assert.equal(result.error.phase, "replay");
    }
    assert.equal(surface.closeCalls, 1);
    assert.equal(result.meta.modelCalls, 0);
    assert.equal(RunResultSchema.safeParse(result).success, true);
  });

  it("replays a compiled artifact through a fresh real browser session", async () => {
    const target = await startLegacyTarget();
    const control = new ControlCoordinator();
    const surface = await BrowserSurface.launch({ control, headless: true });
    try {
      const binding = createDemoBinding(target.origin);
      const discoverySession = await surface.createSession(binding);
      const discoveryGrant = control.createAutomationLease(
        discoverySession.id,
        "replay-fixture-discovery",
      );
      await surface.navigate(discoverySession.id, target.entryUrl(), discoveryGrant);
      const initial = await surface.observe(discoverySession.id);
      const memberInput = initial.elements.find(
        (element) =>
          element.role === "textbox" && element.context.precedingLabel === "Member number",
      );
      const lookupButton = initial.elements.find(
        (element) => element.role === "button" && element.name === "Find Member",
      );
      assert.ok(memberInput);
      assert.ok(lookupButton);
      const memberTarget = surface.compileTarget(
        initial.id,
        memberInput.ref,
        "Member number input",
      );
      const buttonTarget = surface.compileTarget(
        initial.id,
        lookupButton.ref,
        "Find member command",
      );

      await surface.dispatch(
        discoverySession.id,
        {
          kind: "set_value",
          decisionId: "fixture-fill-member",
          observationId: initial.id,
          rationale: "Create the reviewed browser replay fixture.",
          elementRef: memberInput.ref,
          value: { kind: "input", name: "memberId" },
        },
        { observationId: initial.id, inputs: { memberId: "84721" }, grant: discoveryGrant },
      );
      const filled = await surface.observe(discoverySession.id);
      const freshButton = filled.elements.find(
        (element) => element.role === "button" && element.name === "Find Member",
      );
      assert.ok(freshButton);
      await surface.dispatch(
        discoverySession.id,
        {
          kind: "activate",
          decisionId: "fixture-activate-lookup",
          observationId: filled.id,
          rationale: "Create the reviewed browser replay fixture.",
          elementRef: freshButton.ref,
        },
        { observationId: filled.id, inputs: { memberId: "84721" }, grant: discoveryGrant },
      );
      const resultObservation = await surface.observe(discoverySession.id);
      const balance = resultObservation.elements.find(
        (element) =>
          element.context.rowLabel === "Savings" &&
          element.context.columnLabel === "Current balance",
      );
      assert.ok(balance);
      const balanceTarget = surface.compileTarget(
        resultObservation.id,
        balance.ref,
        "Savings current balance",
      );
      await control.complete(discoveryGrant);
      await surface.closeSession(discoverySession.id);

      const draft: CapabilityArtifactDraft = {
        schemaVersion: "1.0.0",
        id: "browser-member-savings",
        revision: 1,
        name: "Browser member savings lookup",
        description: "Replays the reviewed synthetic member lookup in a fresh browser session.",
        purpose: "Prove deterministic browser replay without a planner or model dependency.",
        compatibility: {
          product: {
            vendor: binding.product.vendor,
            product: binding.product.product,
          },
          requiredSurfaceCapabilities: ["accessibility_tree", "dom", "frames", "visual_anchors"],
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
          outcomes: [],
        },
        targets: {
          memberField: memberTarget,
          lookupButton: buttonTarget,
          savingsBalance: balanceTarget,
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
            description: "Set the member number from the typed invocation input.",
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
            description: "Activate the read-only member lookup.",
            command: "activate",
            target: "lookupButton",
            effect: "read",
            idempotency: "idempotent",
            timeoutMs: 3_000,
            retry: { maxAttempts: 1, delayMs: 0, retryOn: [] },
            postcondition: {
              kind: "target_visible",
              target: "savingsBalance",
              expected: true,
            },
          },
          {
            id: "extract-balance",
            description: "Extract and validate the savings current balance.",
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
          discoveryRunId: "browser-fixture-discovery",
          provider: "test-fixture",
          modelId: "none-fixture-only",
          promptHash: "b".repeat(64),
          liveModel: false,
          createdAt: "2026-08-27T18:00:00.000Z",
        },
      };
      const artifact = compileArtifact(draft);
      const result = await new ReplayEngine({
        surface,
        control,
        platformPolicy: createDemoPolicyStack(binding).platform,
      }).run({
        artifact,
        binding,
        inputs: { memberId: "84721" },
        runId: "real-browser-replay-01",
      });

      assert.equal(result.status, "succeeded");
      if (result.status === "succeeded") {
        assert.equal(result.outputs.savingsBalance, 1_284.37);
      }
      assert.equal(result.meta.modelCalls, 0);
    } finally {
      await surface.close();
      await target.close();
    }
  });

  it("contains no import edge to a model or planner module", async () => {
    const source = await readFile(new URL("../src/runtime/replay.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]);
    assert.equal(
      imports.some((specifier) => /(?:^|\/)(?:model|planner)(?:\/|$)/u.test(specifier ?? "")),
      false,
    );
    assert.equal(source.includes("planner."), false);
  });
});
