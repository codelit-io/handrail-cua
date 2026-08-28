import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createDemoBinding, createDemoPolicyStack } from "../src/demo/config.js";
import {
  type AppBinding,
  type ArtifactApproval,
  type CapabilityArtifact,
  type CapabilityArtifactDraft,
  type ModelDecision,
  RunResultSchema,
} from "../src/domain/schema.js";
import {
  compileArtifact,
  computeArtifactApprovalDigest,
  computeTargetDigest,
} from "../src/runtime/artifact.js";
import { ControlCoordinator, ControlError, type ControlGrant } from "../src/runtime/control.js";
import type { BoundApproval } from "../src/runtime/policy.js";
import { ReplayEngine, replayCapability } from "../src/runtime/replay.js";
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
    artifactApprovalMode: "non_strict",
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

class ControlCheckingEvidenceSurface extends FakeReplaySurface {
  constructor(
    readonly control: ControlCoordinator,
    terminalCheckpointFails = false,
  ) {
    super("none", terminalCheckpointFails);
  }

  override async captureEvidence(
    _sessionId: string,
    _label: string,
    _signal?: AbortSignal,
    _expectedUrl?: string,
    grant?: ControlGrant,
  ): Promise<Buffer> {
    assert.ok(grant);
    this.control.assertGrant(grant, "automation");
    return super.captureEvidence(_sessionId, _label, _signal, _expectedUrl, grant);
  }
}

function artifactWithFirstStepTimeout(timeoutMs: number) {
  const { digest: _digest, ...draft } = structuredClone(replayArtifact());
  return compileArtifact({
    ...draft,
    steps: draft.steps.map((step, index) => (index === 0 ? { ...step, timeoutMs } : step)),
  });
}

function strictEngine(surface: FakeReplaySurface): ReplayEngine {
  return new ReplayEngine({
    surface,
    control: new ControlCoordinator(),
    platformPolicy,
    artifactApprovalMode: "strict",
    now: () => new Date("2026-08-27T18:00:00.000Z"),
    sleep: async () => undefined,
  });
}

function artifactApproval(artifact: CapabilityArtifact): ArtifactApproval {
  return {
    artifactId: artifact.id,
    revision: artifact.revision,
    digest: artifact.digest,
    approvedBy: "reviewer-01",
    approvedAt: "2026-08-27T18:00:00.000Z",
    expiresAt: "2026-08-27T19:00:00.000Z",
  };
}

function commitArtifact(failingPostcondition = false): CapabilityArtifact {
  const { digest: _digest, ...draft } = structuredClone(replayArtifact());
  const commitStep = draft.steps[1];
  assert.ok(commitStep?.command === "activate");
  commitStep.effect = "commit";
  commitStep.idempotency = "non_idempotent";
  commitStep.retry = {
    maxAttempts: 1,
    delayMs: 0,
    retryOn: failingPostcondition ? ["postcondition_timeout"] : [],
  };
  if (failingPostcondition) {
    commitStep.postcondition = {
      kind: "target_visible",
      target: "resultsPanel",
      expected: false,
    };
  }
  draft.effects.push("commit");
  draft.policyRequirements.allowedEffects.push("commit");
  draft.policyRequirements.approvalRequiredFor.push("commit");
  return compileArtifact(draft);
}

function commitBinding(): AppBinding {
  const binding = structuredClone(replayBinding());
  binding.policy.allowedEffects.push("commit");
  return binding;
}

function commitApproval(artifact: CapabilityArtifact, runId: string): BoundApproval {
  return {
    id: "commit-approval-01",
    runId,
    operationId: "activate-lookup",
    command: "activate",
    effect: "commit",
    origin: "http://127.0.0.1:4312",
    route: "/legacy",
    expiresAt: "2026-08-27T19:00:00.000Z",
    capabilityDigest: artifact.digest,
  };
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

  it("captures business-outcome evidence before completing its automation lease", async () => {
    const control = new ControlCoordinator();
    const surface = new ControlCheckingEvidenceSurface(control);
    const screenshotRef = {
      id: "ev_aaaaaaaaaaaaaaaaaaaaaaaa",
      kind: "screenshot" as const,
      relativePath: "screenshots/outcome.png",
      sha256: "a".repeat(64),
      byteLength: 8,
      mimeType: "image/png" as const,
      createdAt: "2026-08-27T18:00:00.000Z",
    };
    const result = await new ReplayEngine({
      surface,
      control,
      platformPolicy,
      artifactApprovalMode: "non_strict",
      now: () => new Date("2026-08-27T18:00:00.000Z"),
      sleep: async () => undefined,
      screenshotRedactionVerified: true,
      evidence: {
        appendEvent: async (_event) => ({
          eventId: "event-outcome",
          relativePath: "events.jsonl",
          byteOffset: 0,
          byteLength: 1,
          lineSha256: "b".repeat(64),
        }),
        eventLogRef: async () => ({
          ...screenshotRef,
          kind: "event_log" as const,
          relativePath: "events.jsonl",
          mimeType: "application/x-ndjson" as const,
        }),
        writeScreenshot: async () => screenshotRef,
      },
    }).run({
      artifact: replayArtifact(),
      binding: replayBinding(),
      inputs: { memberId: "00000" },
      runId: "replay-outcome-evidence-order",
    });

    assert.equal(result.status, "business_outcome");
    if (result.status === "business_outcome") {
      assert.deepEqual(result.evidence, [screenshotRef]);
      assert.equal(control.snapshot(result.meta.sessionId).phase, "COMPLETED");
    }
  });

  it("captures failure evidence before failing its automation lease", async () => {
    const control = new ControlCoordinator();
    const surface = new ControlCheckingEvidenceSurface(control, true);
    const events: Array<Readonly<Record<string, unknown>>> = [];
    const screenshotRef = {
      id: "ev_cccccccccccccccccccccccc",
      kind: "screenshot" as const,
      relativePath: "screenshots/failure.png",
      sha256: "c".repeat(64),
      byteLength: 8,
      mimeType: "image/png" as const,
      createdAt: "2026-08-27T18:00:00.000Z",
    };
    const result = await new ReplayEngine({
      surface,
      control,
      platformPolicy,
      artifactApprovalMode: "non_strict",
      now: () => new Date("2026-08-27T18:00:00.000Z"),
      sleep: async () => undefined,
      screenshotRedactionVerified: true,
      evidence: {
        appendEvent: async (event) => {
          if (event.type === "replay.completed") {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          events.push({ ...event });
          return {
            eventId: `event-failure-${events.length}`,
            relativePath: "events.jsonl",
            byteOffset: events.length - 1,
            byteLength: 1,
            lineSha256: "d".repeat(64),
          };
        },
        eventLogRef: async () => ({
          ...screenshotRef,
          kind: "event_log" as const,
          relativePath: "events.jsonl",
          mimeType: "application/x-ndjson" as const,
        }),
        writeScreenshot: async () => screenshotRef,
      },
    }).run({
      artifact: replayArtifact(),
      binding: replayBinding(),
      inputs: { memberId: "84721" },
      runId: "replay-failure-evidence-order",
    });

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.deepEqual(result.error.evidence, [screenshotRef]);
      assert.equal(control.snapshot(result.meta.sessionId).phase, "FAILED");
      assert.equal(events.at(-2)?.type, "replay.failed");
      assert.equal(events.at(-1)?.type, "replay.completed");
      assert.equal(events.at(-1)?.timestamp, result.meta.finishedAt);
    }
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

  it("defaults an omitted artifact approval mode to strict before surface creation", async () => {
    const surface = new FakeReplaySurface();
    const result = await new ReplayEngine({
      surface,
      control: new ControlCoordinator(),
      platformPolicy,
      now: () => new Date("2026-08-27T18:00:00.000Z"),
      sleep: async () => undefined,
    }).run({
      artifact: replayArtifact(),
      binding: replayBinding(),
      inputs: { memberId: "84721" },
      runId: "replay-default-strict-approval-denied",
    });

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.phase, "preflight");
      assert.equal(result.error.code, "ARTIFACT_INVALID");
      assert.match(result.error.message, /requires a current approval/u);
    }
    assert.equal(surface.createCalls, 0);
    assert.equal(surface.navigateCalls, 0);
    assert.equal(surface.observeCalls, 0);
  });

  it("keeps the replayCapability convenience entrypoint strict when mode is omitted", async () => {
    const surface = new FakeReplaySurface();
    const result = await replayCapability(
      {
        surface,
        control: new ControlCoordinator(),
        platformPolicy,
        now: () => new Date("2026-08-27T18:00:00.000Z"),
        sleep: async () => undefined,
      },
      {
        artifact: replayArtifact(),
        binding: replayBinding(),
        inputs: { memberId: "84721" },
        runId: "replay-capability-default-strict-denied",
      },
    );

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.phase, "preflight");
      assert.equal(result.error.code, "ARTIFACT_INVALID");
    }
    assert.equal(surface.createCalls, 0);
  });

  it("strict mode requires an exact, current artifact approval before surface creation", async () => {
    const artifact = replayArtifact();
    const invalidApprovals: readonly (ArtifactApproval | undefined)[] = [
      undefined,
      { ...artifactApproval(artifact), artifactId: "another-artifact" },
      { ...artifactApproval(artifact), revision: artifact.revision + 1 },
      { ...artifactApproval(artifact), digest: "b".repeat(64) },
      {
        ...artifactApproval(artifact),
        approvedAt: "2026-08-27T20:00:00.000Z",
        expiresAt: "2026-08-27T21:00:00.000Z",
      },
      { ...artifactApproval(artifact), expiresAt: "2026-08-27T17:30:00.000Z" },
    ];

    for (const approval of invalidApprovals) {
      const surface = new FakeReplaySurface();
      const result = await strictEngine(surface).run({
        artifact,
        ...(approval ? { artifactApproval: approval } : {}),
        binding: replayBinding(),
        inputs: { memberId: "84721" },
        runId: "replay-strict-approval-denied",
      });
      assert.equal(result.status, "failed");
      if (result.status === "failed") {
        assert.equal(result.error.phase, "preflight");
        assert.equal(result.error.code, "ARTIFACT_INVALID");
      }
      assert.equal(surface.createCalls, 0);
      assert.equal(surface.navigateCalls, 0);
    }
  });

  it("accepts a valid strict approval and preserves explicit non-strict replay", async () => {
    const artifact = replayArtifact();
    const strictSurface = new FakeReplaySurface();
    const strictResult = await strictEngine(strictSurface).run({
      artifact,
      artifactApproval: artifactApproval(artifact),
      binding: replayBinding(),
      inputs: { memberId: "84721" },
      runId: "replay-strict-approval-accepted",
    });
    assert.equal(strictResult.status, "succeeded");
    assert.equal(strictSurface.createCalls, 1);

    const nonStrictSurface = new FakeReplaySurface();
    const nonStrictResult = await new ReplayEngine({
      surface: nonStrictSurface,
      control: new ControlCoordinator(),
      platformPolicy,
      artifactApprovalMode: "non_strict",
      now: () => new Date("2026-08-27T18:00:00.000Z"),
      sleep: async () => undefined,
    }).run({
      artifact,
      binding: replayBinding(),
      inputs: { memberId: "84721" },
      runId: "replay-non-strict-explicit",
    });
    assert.equal(nonStrictResult.status, "succeeded");
    assert.equal(nonStrictSurface.createCalls, 1);
  });

  it("binds strict replay evidence to the exact artifact approval digest", async () => {
    const artifact = replayArtifact();
    const approval = artifactApproval(artifact);
    const events: Array<Readonly<Record<string, unknown>>> = [];
    const evidenceRef = {
      id: "ev_aaaaaaaaaaaaaaaaaaaaaaaa",
      kind: "event_log" as const,
      relativePath: "events.jsonl",
      sha256: "a".repeat(64),
      byteLength: 1,
      mimeType: "application/x-ndjson",
      createdAt: "2026-08-27T18:00:00.000Z",
    };
    const result = await new ReplayEngine({
      surface: new FakeReplaySurface(),
      control: new ControlCoordinator(),
      platformPolicy,
      artifactApprovalMode: "strict",
      now: () => new Date("2026-08-27T18:00:00.000Z"),
      sleep: async () => undefined,
      evidence: {
        appendEvent: async (event) => {
          events.push({ ...event });
          return {
            eventId: `event-${events.length}`,
            relativePath: "events.jsonl",
            byteOffset: events.length - 1,
            byteLength: 1,
            lineSha256: "b".repeat(64),
          };
        },
        eventLogRef: async () => evidenceRef,
        writeScreenshot: async () => ({ ...evidenceRef, kind: "screenshot" as const }),
      },
    }).run({
      artifact,
      artifactApproval: approval,
      binding: replayBinding(),
      inputs: { memberId: "84721" },
      runId: "replay-strict-evidence-binding",
    });

    assert.equal(result.status, "succeeded");
    const started = events.find((event) => event.type === "replay.started");
    assert.ok(started);
    assert.equal(started.artifactApprovalMode, "strict");
    assert.equal(started.artifactApprovalDigest, computeArtifactApprovalDigest(approval));
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

  it("rejects unreviewed or digest-drifted target overrides before creating a surface", async () => {
    const artifact = replayArtifact();
    const baseTarget = artifact.targets.lookupButton;
    assert.ok(baseTarget);
    const overrideTarget = structuredClone(baseTarget);
    overrideTarget.robustnessRationale =
      "Tenant review confirmed equivalent semantic locators for this exact legacy surface.";
    const unreviewedBinding = {
      ...replayBinding(),
      targetOverrides: { lookupButton: overrideTarget },
    };
    const unreviewedSurface = new FakeReplaySurface();
    const unreviewedResult = await engine(unreviewedSurface).run({
      artifact,
      binding: unreviewedBinding,
      inputs: { memberId: "84721" },
      runId: "replay-unreviewed-target-override",
    });
    assert.equal(unreviewedResult.status, "failed");
    if (unreviewedResult.status === "failed") {
      assert.equal(unreviewedResult.error.phase, "preflight");
      assert.equal(unreviewedResult.error.code, "ARTIFACT_INVALID");
    }
    assert.equal(unreviewedSurface.createCalls, 0);

    const reviewedBinding = {
      ...unreviewedBinding,
      targetOverrideReviews: {
        lookupButton: {
          baseTargetDigest: computeTargetDigest(baseTarget),
          overrideTargetDigest: computeTargetDigest(overrideTarget),
          reviewedBy: "reviewer-01",
          reviewedAt: "2026-08-27T17:00:00.000Z",
          expiresAt: "2026-08-27T19:00:00.000Z",
        },
      },
    };
    const tamperedBinding = structuredClone(reviewedBinding);
    tamperedBinding.targetOverrides.lookupButton.description =
      "A semantic target changed after its review";
    const tamperedSurface = new FakeReplaySurface();
    const tamperedResult = await engine(tamperedSurface).run({
      artifact,
      binding: tamperedBinding,
      inputs: { memberId: "84721" },
      runId: "replay-tampered-target-override",
    });
    assert.equal(tamperedResult.status, "failed");
    if (tamperedResult.status === "failed") {
      assert.equal(tamperedResult.error.phase, "preflight");
      assert.equal(tamperedResult.error.code, "ARTIFACT_INVALID");
    }
    assert.equal(tamperedSurface.createCalls, 0);
  });

  it("accepts an exact digest-reviewed semantic target override", async () => {
    const artifact = replayArtifact();
    const baseTarget = artifact.targets.lookupButton;
    assert.ok(baseTarget);
    const overrideTarget = structuredClone(baseTarget);
    overrideTarget.robustnessRationale =
      "Tenant review confirmed equivalent semantic locators for this exact legacy surface.";
    const surface = new FakeReplaySurface();
    const result = await engine(surface).run({
      artifact,
      binding: {
        ...replayBinding(),
        targetOverrides: { lookupButton: overrideTarget },
        targetOverrideReviews: {
          lookupButton: {
            baseTargetDigest: computeTargetDigest(baseTarget),
            overrideTargetDigest: computeTargetDigest(overrideTarget),
            reviewedBy: "reviewer-01",
            reviewedAt: "2026-08-27T17:00:00.000Z",
            expiresAt: "2026-08-27T19:00:00.000Z",
          },
        },
      },
      inputs: { memberId: "84721" },
      runId: "replay-reviewed-target-override",
    });
    assert.equal(result.status, "succeeded");
    assert.equal(surface.createCalls, 1);
  });

  it("executes one commit with an approval bound to its exact replay step", async () => {
    const surface = new FakeReplaySurface();
    const artifact = commitArtifact();
    const runId = "replay-step-bound-commit-approval";
    const result = await new ReplayEngine({
      surface,
      control: new ControlCoordinator(),
      artifactApprovalMode: "non_strict",
      platformPolicy: {
        ...platformPolicy,
        allowedEffects: ["read", "reversible_write", "commit"],
      },
      now: () => new Date("2026-08-27T18:00:00.000Z"),
      sleep: async () => undefined,
    }).run({
      artifact,
      binding: commitBinding(),
      inputs: { memberId: "84721" },
      approval: commitApproval(artifact, runId),
      runId,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(surface.activationCalls, 1);
  });

  it("denies a replay action after drift to a secondary binding-allowed origin", async () => {
    const secondaryOrigin = "http://127.0.0.1:4314";
    const surface = new FakeReplaySurface();
    surface.observationOrigin = secondaryOrigin;
    const bindingWithSecondaryOrigin: AppBinding = {
      ...replayBinding(),
      policy: {
        ...replayBinding().policy,
        allowedOrigins: ["http://127.0.0.1:4312", secondaryOrigin],
      },
    };
    const result = await new ReplayEngine({
      surface,
      control: new ControlCoordinator(),
      platformPolicy,
      artifactApprovalMode: "non_strict",
      now: () => new Date("2026-08-27T18:00:00.000Z"),
      sleep: async () => undefined,
    }).run({
      artifact: replayArtifact(),
      binding: bindingWithSecondaryOrigin,
      inputs: { memberId: "84721" },
      runId: "replay-secondary-origin-denied",
    });

    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.code, "POLICY_DENIED");
    assert.deepEqual(surface.dispatchCommands, []);
  });

  it("consumes a step-bound approval before a commit can be attempted again", async () => {
    const surface = new FakeReplaySurface();
    const control = new ControlCoordinator();
    const artifact = commitArtifact(true);
    const runId = "replay-single-use-commit-approval";
    const result = await new ReplayEngine({
      surface,
      control,
      artifactApprovalMode: "non_strict",
      platformPolicy: {
        ...platformPolicy,
        allowedEffects: ["read", "reversible_write", "commit"],
      },
      now: () => new Date("2026-08-27T18:00:00.000Z"),
      sleep: async () => undefined,
      onIntervention: async (context) => {
        control.requestPause(context.automationGrant, "Review failed commit checkpoint");
        await control.quiesceAutomation(context.automationGrant);
        const operatorGrant = control.claimOperator(context.session.id, "operator-approval-review");
        control.requestResume(operatorGrant);
        const automationGrant = control.returnToAutomation(operatorGrant, context.runId);
        return {
          sessionId: context.session.id,
          automationGrant,
          observation: await surface.observe(context.session.id),
          checkpoint: {
            passed: true,
            observed: "Operator confirmed the same session is ready for guarded recovery.",
          },
        };
      },
    }).run({
      artifact,
      binding: commitBinding(),
      inputs: { memberId: "84721" },
      approval: commitApproval(artifact, runId),
      runId,
    });

    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.code, "POLICY_DENIED");
      assert.equal(result.error.observed, "APPROVAL_INVALID");
    }
    assert.equal(surface.activationCalls, 1);
    assert.deepEqual(surface.dispatchCommands, ["set_value", "activate"]);
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
      artifactApprovalMode: "non_strict",
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

  it("revokes a valid returned lease when intervention metadata names a replacement session", async () => {
    const surface = new FakeReplaySurface("always");
    const control = new ControlCoordinator();
    const result = await new ReplayEngine({
      surface,
      control,
      platformPolicy,
      artifactApprovalMode: "non_strict",
      now: () => new Date("2026-08-27T18:00:00.000Z"),
      sleep: async () => undefined,
      onIntervention: async (context) => {
        control.requestPause(context.automationGrant, "Operator recovery requested");
        await control.quiesceAutomation(context.automationGrant);
        const operatorGrant = control.claimOperator(context.session.id, "operator-replay-test");
        control.requestResume(operatorGrant);
        const automationGrant = control.returnToAutomation(operatorGrant, context.runId);
        return {
          sessionId: "replacement-session",
          automationGrant,
          observation: await surface.observe(context.session.id),
          checkpoint: { passed: true, observed: "Synthetic recovery passed." },
        };
      },
    }).run({
      artifact: replayArtifact(),
      binding: replayBinding(),
      inputs: { memberId: "84721" },
      runId: "replay-wrong-session-return",
    });

    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.error.code, "CONTROL_LOST");
    assert.equal(control.snapshot(result.meta.sessionId).phase, "FAILED");
    assert.equal(control.snapshot(result.meta.sessionId).owner, null);
  });

  it("cancels and settles a timed-out action before terminal control, close, or return", async () => {
    const control = new ControlCoordinator();
    const surface = new AbortAwareDelayedSurface(control);
    const artifact = artifactWithFirstStepTimeout(100);

    const result = await new ReplayEngine({
      surface,
      control,
      platformPolicy,
      artifactApprovalMode: "non_strict",
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
      artifactApprovalMode: "non_strict",
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
          allowedRoutes: ["/legacy", "/legacy/**"],
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
        artifactApprovalMode: "non_strict",
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
