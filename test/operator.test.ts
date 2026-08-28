import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AppBinding, ModelDecision } from "../src/domain/schema.js";
import {
  allowLoopbackDemoOperatorAction,
  type OperatorAuthorizationContext,
  type OperatorConsoleHandle,
  startOperatorConsole,
} from "../src/operator/index.js";
import { ControlCoordinator, ControlError, type ControlGrant } from "../src/runtime/control.js";
import type {
  ActionReceipt,
  DispatchContext,
  PredicateContext,
  SurfaceAdapter,
  SurfaceObservation,
  SurfaceSession,
} from "../src/surface/types.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

interface FakeSurfaceCalls {
  createSession: number;
  closeSession: number;
  close: number;
  observe: number;
  sessions: string[];
  clicks: Array<{ sessionId: string; x: number; y: number; epoch: number }>;
  typedCharacterCounts: number[];
  keys: string[];
  captures: number;
}

function actionReceipt(command: ActionReceipt["command"], summary: string): ActionReceipt {
  return {
    command,
    startedAt: "2026-08-27T18:00:00.000Z",
    finishedAt: "2026-08-27T18:00:00.001Z",
    durationMs: 1,
    changedSurface: true,
    summary,
  };
}

function fakeSurface(session: SurfaceSession): {
  readonly surface: SurfaceAdapter;
  readonly calls: FakeSurfaceCalls;
} {
  const calls: FakeSurfaceCalls = {
    createSession: 0,
    closeSession: 0,
    close: 0,
    observe: 0,
    sessions: [],
    clicks: [],
    typedCharacterCounts: [],
    keys: [],
    captures: 0,
  };

  const surface: SurfaceAdapter = {
    async createSession(_binding: AppBinding): Promise<SurfaceSession> {
      calls.createSession += 1;
      throw new Error("The operator console must never create a surface session.");
    },
    async navigate(sessionId: string, _url: string, _grant: ControlGrant): Promise<ActionReceipt> {
      calls.sessions.push(sessionId);
      return actionReceipt("navigate", "navigated");
    },
    async observe(sessionId: string): Promise<SurfaceObservation> {
      calls.observe += 1;
      calls.sessions.push(sessionId);
      return {
        id: `observation-${calls.observe}`,
        sessionId,
        route: "/legacy",
        title: "Synthetic legacy member services",
        capturedAt: `2026-08-27T18:00:0${calls.observe}.000Z`,
        screenshotPng: Buffer.from(PNG_1X1),
        viewport: { ...session.viewport },
        visibleText: "Synthetic banking surface",
        elements: [],
        fingerprint: "a".repeat(64),
      };
    },
    async dispatch(
      sessionId: string,
      decision: ModelDecision,
      _context: DispatchContext,
    ): Promise<ActionReceipt> {
      calls.sessions.push(sessionId);
      return actionReceipt(decision.kind, "dispatched");
    },
    compileTarget(): never {
      throw new Error("not used by operator test");
    },
    async evaluate(
      sessionId: string,
      _predicate,
      _context: PredicateContext,
    ): Promise<{ passed: boolean; observed: string }> {
      calls.sessions.push(sessionId);
      return { passed: true, observed: "checkpoint passed" };
    },
    async extract(sessionId: string): Promise<unknown> {
      calls.sessions.push(sessionId);
      return null;
    },
    resolveValue(): unknown {
      return null;
    },
    async captureEvidence(sessionId: string): Promise<Buffer> {
      calls.captures += 1;
      calls.sessions.push(sessionId);
      return Buffer.from(PNG_1X1);
    },
    async pressKey(sessionId: string, key: string, grant: ControlGrant): Promise<ActionReceipt> {
      calls.sessions.push(sessionId);
      calls.keys.push(key);
      return actionReceipt("press_key", `pressed ${key} at epoch ${grant.epoch}`);
    },
    async clickAt(
      sessionId: string,
      x: number,
      y: number,
      grant: ControlGrant,
    ): Promise<ActionReceipt> {
      calls.sessions.push(sessionId);
      calls.clicks.push({ sessionId, x, y, epoch: grant.epoch });
      return actionReceipt("activate_coordinate", "clicked existing surface");
    },
    async typeFocused(
      sessionId: string,
      value: string,
      _grant: ControlGrant,
    ): Promise<ActionReceipt> {
      calls.sessions.push(sessionId);
      calls.typedCharacterCounts.push(Array.from(value).length);
      return actionReceipt("set_value", "typed a redacted value");
    },
    async closeSession(_sessionId: string): Promise<void> {
      calls.closeSession += 1;
    },
    async close(): Promise<void> {
      calls.close += 1;
    },
  };
  return { surface, calls };
}

function interventionAccess(interventionUrl: string): {
  readonly origin: string;
  readonly sessionId: string;
  readonly capability: string;
} {
  const parsed = new URL(interventionUrl);
  const sessionId = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "");
  const capability = new URLSearchParams(parsed.hash.slice(1)).get("capability") ?? "";
  if (!sessionId || !capability) throw new Error("Intervention URL is missing capability context.");
  return { origin: parsed.origin, sessionId, capability };
}

async function operatorGet(
  interventionUrl: string,
  action: string,
  authorized = true,
): Promise<Response> {
  const access = interventionAccess(interventionUrl);
  return fetch(`${access.origin}/api/sessions/${encodeURIComponent(access.sessionId)}/${action}`, {
    headers: authorized ? { "X-Handrail-Capability": access.capability } : {},
  });
}

async function post(
  interventionUrl: string,
  action: string,
  body: Readonly<Record<string, unknown>>,
  authorized = true,
): Promise<Response> {
  const access = interventionAccess(interventionUrl);
  return fetch(`${access.origin}/api/sessions/${encodeURIComponent(access.sessionId)}/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: access.origin,
      "X-Handrail-Console": "1",
      ...(authorized ? { "X-Handrail-Capability": access.capability } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("operator console", () => {
  const consoles: OperatorConsoleHandle[] = [];

  afterEach(async () => {
    await Promise.all(consoles.splice(0).map((consoleServer) => consoleServer.close()));
  });

  it("hands the existing surface to one operator and returns a fresh automation grant", async () => {
    const session: SurfaceSession = {
      id: "surface-existing",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "runtime");
    const fake = fakeSurface(session);
    let checkpointObservationId = "";
    const authorizationContexts: OperatorAuthorizationContext[] = [];
    const durableAuditReceipts: string[] = [];
    const durableCaptureReceipts: string[] = [];
    const consoleServer = await startOperatorConsole({
      control,
      surface: fake.surface,
      now: () => new Date("2026-08-27T18:00:10.000Z"),
      authorizeOperatorAction: async (context) => {
        authorizationContexts.push(context);
        return allowLoopbackDemoOperatorAction(context);
      },
      auditSink: async (event) => {
        durableAuditReceipts.push(event.eventId);
        return { eventId: event.eventId, durable: true };
      },
      captureSink: async (capture) => {
        durableCaptureReceipts.push(capture.id);
        return { evidenceId: capture.id, durable: true };
      },
    });
    consoles.push(consoleServer);

    const intervention = await consoleServer.openIntervention({
      runId: "run-handoff-001",
      capability: "member.balance.lookup",
      currentStep: "search-member",
      reason: "Session expired - manual recovery required",
      stoppedBecause: "Known session-timeout dialog detected",
      session,
      automationGrant: automation,
      evaluateCheckpoint: async ({ session: checkpointSession, observation }) => {
        assert.equal(checkpointSession, session);
        assert.equal(observation.sessionId, session.id);
        checkpointObservationId = observation.id;
        return { passed: true, observed: "Session restored and member search is visible" };
      },
    });

    assert.equal(fake.calls.createSession, 0);
    assert.equal(intervention.sessionId, session.id);
    assert.equal(control.snapshot(session.id).phase, "AWAITING_OPERATOR");
    assert.throws(
      () => control.assertGrant(automation),
      (error: unknown) => error instanceof ControlError && error.code === "CONTROL_LOST",
    );

    const access = interventionAccess(intervention.url);
    assert.equal(access.sessionId, session.id);
    assert.match(access.capability, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(new URL(intervention.url).search, "");

    const page = await fetch(intervention.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    for (const copy of [
      "Handrail",
      "Human control",
      "Return to automation",
      "Live session",
      "Same browser session",
      "Intervention required",
      "Capture evidence",
      "Type into the focused control",
    ]) {
      assert.match(html, new RegExp(copy));
    }
    assert.doesNotMatch(html, /member\.balance\.lookup/u);
    assert.doesNotMatch(html, /Session expired - manual recovery required/u);
    assert.doesNotMatch(html, /\/screenshot/u);
    assert.doesNotMatch(html, new RegExp(access.capability));

    const bootstrapScript = await (await fetch(`${consoleServer.origin}/operator.js`)).text();
    assert.match(bootstrapScript, /window\.location\.hash/u);
    assert.match(bootstrapScript, /X-Handrail-Capability/u);
    assert.doesNotMatch(bootstrapScript, new RegExp(access.capability));

    const unauthorizedState = await operatorGet(intervention.url, "state", false);
    assert.equal(unauthorizedState.status, 403);
    const wrongCapabilityState = await fetch(
      `${consoleServer.origin}/api/sessions/${encodeURIComponent(session.id)}/state`,
      {
        headers: {
          "X-Handrail-Capability": `${access.capability.slice(0, -1)}${access.capability.endsWith("A") ? "B" : "A"}`,
        },
      },
    );
    assert.equal(wrongCapabilityState.status, 403);
    const unauthorizedScreenshot = await operatorGet(intervention.url, "screenshot", false);
    assert.equal(unauthorizedScreenshot.status, 403);
    assert.equal(fake.calls.observe, 0);
    const unauthorizedBootstrap = await post(intervention.url, "bootstrap", {}, false);
    assert.equal(unauthorizedBootstrap.status, 403);

    const bootstrap = await post(intervention.url, "bootstrap", {});
    assert.equal(bootstrap.status, 204, await bootstrap.clone().text());
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    assert.match(bootstrap.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/u);
    const stateFromCookie = await fetch(
      `${consoleServer.origin}/api/sessions/${encodeURIComponent(session.id)}/state`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(stateFromCookie.status, 200);
    const reloadBootstrap = await fetch(
      `${consoleServer.origin}/api/sessions/${encodeURIComponent(session.id)}/bootstrap`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: consoleServer.origin,
          "X-Handrail-Console": "1",
        },
      },
    );
    assert.equal(reloadBootstrap.status, 204);

    const unauthorizedClaim = await post(
      intervention.url,
      "claim",
      { operatorId: "operator-unauthorized", expectedEpoch: intervention.state().control.epoch },
      false,
    );
    assert.equal(unauthorizedClaim.status, 403);
    assert.equal(control.snapshot(session.id).owner, null);

    const screenshot = await operatorGet(intervention.url, "screenshot");
    assert.equal(screenshot.status, 200);
    assert.equal(screenshot.headers.get("content-type"), "image/png");
    assert.equal(screenshot.headers.get("x-handrail-session-id"), session.id);
    assert.deepEqual(Buffer.from(await screenshot.arrayBuffer()), PNG_1X1);

    const waitingState = intervention.state();
    assert.equal(waitingState.sessionId, session.id);
    assert.equal(waitingState.canClaim, true);
    const claimResponse = await post(intervention.url, "claim", {
      operatorId: "operator-demo",
      expectedEpoch: waitingState.control.epoch,
    });
    assert.equal(claimResponse.status, 200, await claimResponse.clone().text());
    const claim = await responseJson<{
      claimId: string;
      sessionId: string;
      epoch: number;
      expiresAt: string;
    }>(claimResponse);
    assert.equal(claim.sessionId, session.id);
    assert.equal(control.snapshot(session.id).owner?.kind, "operator");
    assert.doesNotMatch(JSON.stringify(claim), /leaseToken/u);

    const unauthorizedClick = await post(
      intervention.url,
      "click",
      { claimId: claim.claimId, epoch: claim.epoch, x: 320, y: 180 },
      false,
    );
    assert.equal(unauthorizedClick.status, 403);
    assert.deepEqual(fake.calls.clicks, []);

    const staleClaim = await post(intervention.url, "claim", {
      operatorId: "operator-intruder",
      expectedEpoch: waitingState.control.epoch,
    });
    assert.equal(staleClaim.status, 409);
    assert.equal(
      (await responseJson<{ error: { code: string } }>(staleClaim)).error.code,
      "CONTROL_LOST",
    );

    const click = await post(intervention.url, "click", {
      claimId: claim.claimId,
      epoch: claim.epoch,
      x: 320,
      y: 180,
    });
    assert.equal(click.status, 200);
    assert.deepEqual(fake.calls.clicks, [
      { sessionId: session.id, x: 320, y: 180, epoch: claim.epoch },
    ]);

    // Assemble the provider-shaped canary at runtime so the repository itself
    // never contains a token-like literal that can trip push protection.
    const sensitiveValue = `sk-${"operator-canary-".repeat(2)}84721`;
    const typed = await post(intervention.url, "type", {
      claimId: claim.claimId,
      epoch: claim.epoch,
      value: sensitiveValue,
    });
    assert.equal(typed.status, 200);
    assert.deepEqual(fake.calls.typedCharacterCounts, [Array.from(sensitiveValue).length]);

    const key = await post(intervention.url, "key", {
      claimId: claim.claimId,
      epoch: claim.epoch,
      key: "Enter",
    });
    assert.equal(key.status, 200);
    assert.deepEqual(fake.calls.keys, ["Enter"]);

    const capture = await post(intervention.url, "capture", {
      claimId: claim.claimId,
      epoch: claim.epoch,
    });
    assert.equal(capture.status, 200);
    assert.equal(fake.calls.captures, 1);
    assert.equal(intervention.captures().length, 1);
    assert.equal(intervention.captures()[0]?.mimeType, "image/png");
    assert.equal(durableCaptureReceipts.length, 1);

    assert.deepEqual(
      authorizationContexts.map(({ action, effect }) => ({ action, effect })),
      [
        { action: "activate_coordinate", effect: "commit" },
        { action: "type", effect: "reversible_write" },
        { action: "press_key", effect: "commit" },
        { action: "capture_evidence", effect: "read" },
      ],
    );
    for (const context of authorizationContexts) {
      assert.equal(context.runId, intervention.runId);
      assert.equal(context.sessionId, session.id);
      assert.equal(context.session.id, session.id);
      assert.equal(context.ownerEpoch, claim.epoch);
      assert.equal(context.operatorId, "operator-demo");
      assert.ok(Number.isFinite(Date.parse(context.operatorLeaseExpiresAt)));
    }
    assert.doesNotMatch(JSON.stringify(authorizationContexts), new RegExp(sensitiveValue));

    const serializedAudit = JSON.stringify(intervention.audit());
    assert.doesNotMatch(serializedAudit, new RegExp(sensitiveValue));
    assert.doesNotMatch(serializedAudit, new RegExp(claim.claimId));
    assert.doesNotMatch(serializedAudit, new RegExp(access.capability));
    assert.match(serializedAudit, /Operator typed a redacted value/u);
    assert.match(serializedAudit, /loopback_demo/u);
    assert.ok(intervention.audit().every((event) => event.type === "operator.audit"));
    assert.equal(durableAuditReceipts.length, intervention.audit().length);
    assert.deepEqual(
      intervention.audit().map((event) => event.action),
      [
        "automation_paused",
        "control_claimed",
        "operator_clicked",
        "operator_typed",
        "operator_pressed_key",
        "evidence_captured",
      ],
    );

    const resumedFromHandle = intervention.waitForResume();
    const resumeResponse = await post(intervention.url, "resume", {
      claimId: claim.claimId,
      epoch: claim.epoch,
    });
    assert.equal(resumeResponse.status, 200);
    const resumeBody = await responseJson<{
      sessionId: string;
      epoch: number;
      phase: string;
      freshObservation: { id: string; sessionId: string };
      checkpoint: { passed: boolean; observed: string };
    }>(resumeResponse);
    assert.equal(resumeBody.sessionId, session.id);
    assert.equal(resumeBody.phase, "AUTOMATION_ACTIVE");
    assert.equal(resumeBody.freshObservation.id, checkpointObservationId);
    assert.equal(resumeBody.freshObservation.sessionId, session.id);
    assert.equal(resumeBody.checkpoint.passed, true);
    assert.match(resumeBody.checkpoint.observed, /Session restored/u);

    const resumed = await resumedFromHandle;
    assert.equal(resumed.sessionId, session.id);
    assert.equal(resumed.observation.id, checkpointObservationId);
    assert.equal(resumed.checkpoint.passed, true);
    control.assertGrant(resumed.automationGrant, "automation");
    assert.equal(control.snapshot(session.id).phase, "AUTOMATION_ACTIVE");
    assert.ok(resumed.automationGrant.epoch > claim.epoch);

    const observationsAtResume = fake.calls.observe;
    const cachedScreenshot = await operatorGet(intervention.url, "screenshot");
    assert.equal(cachedScreenshot.status, 200);
    assert.equal(cachedScreenshot.headers.get("x-handrail-observation-id"), resumed.observation.id);
    assert.equal(fake.calls.observe, observationsAtResume);

    const staleAction = await post(intervention.url, "click", {
      claimId: claim.claimId,
      epoch: claim.epoch,
      x: 10,
      y: 10,
    });
    assert.equal(staleAction.status, 409);
    assert.equal(
      (await responseJson<{ error: { code: string } }>(staleAction)).error.code,
      "CONTROL_LOST",
    );

    assert.ok(fake.calls.sessions.length > 0);
    assert.deepEqual(new Set(fake.calls.sessions), new Set([session.id]));
    assert.equal(intervention.audit().at(-1)?.action, "control_returned");

    await consoleServer.close();
    consoles.splice(consoles.indexOf(consoleServer), 1);
    assert.equal(fake.calls.closeSession, 0);
    assert.equal(fake.calls.close, 0);
  });

  it("denies every configured operator action before it reaches the surface adapter", async () => {
    const session: SurfaceSession = {
      id: "surface-policy-denied",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "runtime");
    const fake = fakeSurface(session);
    const authorizationContexts: OperatorAuthorizationContext[] = [];
    const consoleServer = await startOperatorConsole({
      control,
      surface: fake.surface,
      authorizeOperatorAction: async (context) => {
        authorizationContexts.push(context);
        return {
          allowed: false,
          code: "ACTION_DENIED",
          summary: "The operator action is outside the configured policy.",
        };
      },
    });
    consoles.push(consoleServer);

    const intervention = await consoleServer.openIntervention({
      runId: "run-policy-denied-001",
      capability: "member.balance.lookup",
      currentStep: "search-member",
      reason: "Manual recovery required",
      stoppedBecause: "A synthetic policy denial is under test",
      session,
      automationGrant: automation,
      evaluateCheckpoint: async () => ({ passed: true, observed: "not reached" }),
    });
    const waiting = intervention.state();
    const claimResponse = await post(intervention.url, "claim", {
      operatorId: "operator-denied",
      expectedEpoch: waiting.control.epoch,
    });
    assert.equal(claimResponse.status, 200, await claimResponse.clone().text());
    const claim = await responseJson<{ claimId: string; epoch: number }>(claimResponse);

    const actions = [
      { route: "click", body: { x: 320, y: 180 } },
      { route: "type", body: { value: "must-not-reach-the-surface" } },
      { route: "key", body: { key: "Enter" } },
      { route: "capture", body: {} },
    ] as const;
    for (const action of actions) {
      const response = await post(intervention.url, action.route, {
        claimId: claim.claimId,
        epoch: claim.epoch,
        ...action.body,
      });
      assert.equal(response.status, 403, await response.clone().text());
      assert.equal(
        (await responseJson<{ error: { code: string } }>(response)).error.code,
        "POLICY_DENIED",
      );
    }

    assert.deepEqual(
      authorizationContexts.map(({ action, effect }) => ({ action, effect })),
      [
        { action: "activate_coordinate", effect: "commit" },
        { action: "type", effect: "reversible_write" },
        { action: "press_key", effect: "commit" },
        { action: "capture_evidence", effect: "read" },
      ],
    );
    assert.deepEqual(fake.calls.sessions, []);
    assert.deepEqual(fake.calls.clicks, []);
    assert.deepEqual(fake.calls.typedCharacterCounts, []);
    assert.deepEqual(fake.calls.keys, []);
    assert.equal(fake.calls.captures, 0);
    assert.equal(control.snapshot(session.id).owner?.id, "operator-denied");
  });

  it("fails closed when no operator action authorizer is configured", async () => {
    const session: SurfaceSession = {
      id: "surface-policy-unconfigured",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "runtime");
    const fake = fakeSurface(session);
    const consoleServer = await startOperatorConsole({ control, surface: fake.surface });
    consoles.push(consoleServer);

    const intervention = await consoleServer.openIntervention({
      runId: "run-policy-unconfigured-001",
      capability: "member.balance.lookup",
      currentStep: "search-member",
      reason: "Manual recovery required",
      stoppedBecause: "An unconfigured policy is under test",
      session,
      automationGrant: automation,
      evaluateCheckpoint: async () => ({ passed: true, observed: "not reached" }),
    });
    const waiting = intervention.state();
    const claimResponse = await post(intervention.url, "claim", {
      operatorId: "operator-unconfigured",
      expectedEpoch: waiting.control.epoch,
    });
    assert.equal(claimResponse.status, 200, await claimResponse.clone().text());
    const claim = await responseJson<{ claimId: string; epoch: number }>(claimResponse);
    const response = await post(intervention.url, "click", {
      claimId: claim.claimId,
      epoch: claim.epoch,
      x: 100,
      y: 100,
    });

    assert.equal(response.status, 403, await response.clone().text());
    assert.equal(
      (await responseJson<{ error: { code: string } }>(response)).error.code,
      "POLICY_DENIED",
    );
    assert.deepEqual(fake.calls.sessions, []);
    assert.deepEqual(fake.calls.clicks, []);
  });

  it("validates intervention metadata before revoking automation", async () => {
    const session: SurfaceSession = {
      id: "surface-validation",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "runtime");
    const fake = fakeSurface(session);
    const consoleServer = await startOperatorConsole({ control, surface: fake.surface });
    consoles.push(consoleServer);

    await assert.rejects(
      consoleServer.openIntervention({
        runId: "run-invalid-001",
        capability: "",
        currentStep: "search-member",
        reason: "Session expired - manual recovery required",
        stoppedBecause: "Known session-timeout dialog detected",
        session,
        automationGrant: automation,
        evaluateCheckpoint: async () => ({ passed: true, observed: "not reached" }),
      }),
      /capability must be between/u,
    );

    control.assertGrant(automation, "automation");
    assert.equal(control.snapshot(session.id).phase, "AUTOMATION_ACTIVE");
    assert.equal(fake.calls.createSession, 0);
  });
});
