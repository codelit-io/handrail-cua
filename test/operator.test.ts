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

function fakeSurface(
  session: SurfaceSession,
  currentUrl = "http://127.0.0.1:4312/legacy",
  beforeObserve?: (observationNumber: number) => Promise<void>,
): {
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
      const observationNumber = calls.observe;
      calls.sessions.push(sessionId);
      await beforeObserve?.(observationNumber);
      return {
        id: `observation-${observationNumber}`,
        sessionId,
        url: currentUrl,
        route: "/legacy",
        title: "Synthetic legacy member services",
        capturedAt: `2026-08-27T18:00:0${observationNumber}.000Z`,
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
      x: 320.49,
      y: 180.51,
    });
    assert.equal(click.status, 200);
    assert.deepEqual(fake.calls.clicks, [
      { sessionId: session.id, x: 320, y: 181, epoch: claim.epoch },
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
        { action: "type", effect: "commit" },
        { action: "press_key", effect: "commit" },
        { action: "capture_evidence", effect: "read" },
      ],
    );
    for (const context of authorizationContexts) {
      assert.equal(context.runId, intervention.runId);
      assert.equal(context.sessionId, session.id);
      assert.equal(context.session.id, session.id);
      assert.equal(context.currentUrl, "http://127.0.0.1:4312/legacy");
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
        "control_claim_authorized",
        "control_claimed",
        "operator_action_authorized",
        "operator_clicked",
        "operator_action_authorized",
        "operator_typed",
        "operator_action_authorized",
        "operator_pressed_key",
        "operator_action_authorized",
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
      { route: "key", body: { key: "ArrowDown" } },
      { route: "key", body: { key: "Tab" } },
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
        { action: "type", effect: "commit" },
        { action: "press_key", effect: "commit" },
        { action: "press_key", effect: "commit" },
        { action: "press_key", effect: "commit" },
        { action: "capture_evidence", effect: "read" },
      ],
    );
    assert.equal(fake.calls.observe, actions.length);
    assert.deepEqual(new Set(fake.calls.sessions), new Set([session.id]));
    assert.deepEqual(fake.calls.clicks, []);
    assert.deepEqual(fake.calls.typedCharacterCounts, []);
    assert.deepEqual(fake.calls.keys, []);
    assert.equal(fake.calls.captures, 0);
    assert.equal(control.snapshot(session.id).owner?.id, "operator-denied");
  });

  it("authorizes against a fresh current URL and denies route drift before dispatch", async () => {
    const session: SurfaceSession = {
      id: "surface-route-drift",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "runtime");
    const fake = fakeSurface(session, "https://untrusted.example/phishing");
    const observedUrls: string[] = [];
    const consoleServer = await startOperatorConsole({
      control,
      surface: fake.surface,
      authorizeOperatorAction: (context) => {
        observedUrls.push(context.currentUrl);
        return new URL(context.currentUrl).origin === "http://127.0.0.1:4312"
          ? { allowed: true, authorization: "loopback_demo" }
          : { allowed: false, code: "ROUTE_DENIED", summary: "Current URL is outside policy." };
      },
    });
    consoles.push(consoleServer);
    const intervention = await consoleServer.openIntervention({
      runId: "run-route-drift-001",
      capability: "member.balance.lookup",
      currentStep: "search-member",
      reason: "Manual recovery required",
      stoppedBecause: "The retained surface may have drifted",
      session,
      automationGrant: automation,
      evaluateCheckpoint: async () => ({ passed: true, observed: "not reached" }),
    });
    const waiting = intervention.state();
    const claimResponse = await post(intervention.url, "claim", {
      operatorId: "operator-route-review",
      expectedEpoch: waiting.control.epoch,
    });
    const claim = await responseJson<{ claimId: string; epoch: number }>(claimResponse);
    const click = await post(intervention.url, "click", {
      claimId: claim.claimId,
      epoch: claim.epoch,
      x: 320,
      y: 180,
    });

    assert.equal(click.status, 403, await click.clone().text());
    assert.deepEqual(observedUrls, ["https://untrusted.example/phishing"]);
    assert.equal(fake.calls.observe, 1);
    assert.deepEqual(fake.calls.clicks, []);
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
    assert.equal(fake.calls.observe, 1);
    assert.deepEqual(new Set(fake.calls.sessions), new Set([session.id]));
    assert.deepEqual(fake.calls.clicks, []);
  });

  it("retains operator ownership when the resume checkpoint does not pass", async () => {
    const session: SurfaceSession = {
      id: "surface-checkpoint-blocked",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "runtime");
    const fake = fakeSurface(session);
    const consoleServer = await startOperatorConsole({
      control,
      surface: fake.surface,
      authorizeOperatorAction: allowLoopbackDemoOperatorAction,
    });
    consoles.push(consoleServer);
    const intervention = await consoleServer.openIntervention({
      runId: "run-checkpoint-blocked-001",
      capability: "member.balance.lookup",
      currentStep: "search-member",
      reason: "Manual recovery required",
      stoppedBecause: "The recovery checkpoint is intentionally false",
      session,
      automationGrant: automation,
      evaluateCheckpoint: async () => ({
        passed: false,
        observed: "The session-expiry dialog remains visible.",
      }),
    });
    const waiting = intervention.state();
    const claimResponse = await post(intervention.url, "claim", {
      operatorId: "operator-checkpoint",
      expectedEpoch: waiting.control.epoch,
    });
    const claim = await responseJson<{ claimId: string; epoch: number }>(claimResponse);
    const resume = await post(intervention.url, "resume", {
      claimId: claim.claimId,
      epoch: claim.epoch,
    });

    assert.equal(resume.status, 409, await resume.clone().text());
    assert.equal(
      (await responseJson<{ error: { code: string } }>(resume)).error.code,
      "SESSION_CONFLICT",
    );
    assert.equal(control.snapshot(session.id).phase, "OPERATOR_ACTIVE");
    assert.equal(control.snapshot(session.id).owner?.id, "operator-checkpoint");
    assert.equal(intervention.state().canResume, true);
    assert.equal(intervention.audit().at(-1)?.action, "resume_checkpoint_failed");

    const capture = await post(intervention.url, "capture", {
      claimId: claim.claimId,
      epoch: claim.epoch,
    });
    assert.equal(capture.status, 200, await capture.clone().text());
    assert.equal(fake.calls.captures, 1);
  });

  it("rejects capture requests beyond the durable per-intervention limit", async () => {
    const session: SurfaceSession = {
      id: "surface-capture-limit",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "runtime");
    const fake = fakeSurface(session);
    let durableCaptures = 0;
    const consoleServer = await startOperatorConsole({
      control,
      surface: fake.surface,
      authorizeOperatorAction: allowLoopbackDemoOperatorAction,
      captureSink: async (capture) => {
        durableCaptures += 1;
        return { evidenceId: capture.id, durable: true };
      },
    });
    consoles.push(consoleServer);
    const intervention = await consoleServer.openIntervention({
      runId: "run-capture-limit",
      capability: "member.balance.lookup",
      currentStep: "search-member",
      reason: "Manual recovery required",
      stoppedBecause: "Capture retention limit is under test",
      session,
      automationGrant: automation,
      evaluateCheckpoint: async () => ({ passed: true, observed: "not reached" }),
    });
    const claimResponse = await post(intervention.url, "claim", {
      operatorId: "operator-capture-limit",
      expectedEpoch: intervention.state().control.epoch,
    });
    const claim = await responseJson<{ claimId: string; epoch: number }>(claimResponse);

    for (let index = 0; index < 8; index += 1) {
      const response = await post(intervention.url, "capture", {
        claimId: claim.claimId,
        epoch: claim.epoch,
      });
      assert.equal(response.status, 200, await response.clone().text());
    }
    const observationsBeforeLimit = fake.calls.observe;
    const ninth = await post(intervention.url, "capture", {
      claimId: claim.claimId,
      epoch: claim.epoch,
    });

    assert.equal(ninth.status, 409, await ninth.clone().text());
    assert.equal(fake.calls.captures, 8);
    assert.equal(durableCaptures, 8);
    assert.equal(intervention.captures().length, 8);
    assert.equal(fake.calls.observe, observationsBeforeLimit);
  });

  it("accepts only the exact pre-quiesced discovery epoch", async () => {
    const session: SurfaceSession = {
      id: "surface-pre-quiesced",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "discovery");
    control.requestPause(automation, "Discovery requested operator help.");
    const waiting = await control.quiesceAutomation(automation);
    const fake = fakeSurface(session);
    const consoleServer = await startOperatorConsole({ control, surface: fake.surface });
    consoles.push(consoleServer);

    await assert.rejects(
      consoleServer.openIntervention({
        runId: "run-pre-quiesced-stale",
        capability: "member.balance.lookup",
        currentStep: "discovery-loop",
        reason: "Manual recovery required",
        stoppedBecause: "Discovery is already quiesced",
        session,
        automationGrant: automation,
        preQuiescedEpoch: waiting.epoch + 1,
        evaluateCheckpoint: async () => ({ passed: true, observed: "not reached" }),
      }),
      /does not match the current control epoch/u,
    );

    await assert.rejects(
      consoleServer.openIntervention({
        runId: "run-pre-quiesced-old-grant",
        capability: "member.balance.lookup",
        currentStep: "discovery-loop",
        reason: "Manual recovery required",
        stoppedBecause: "Discovery is already quiesced",
        session,
        automationGrant: { ...automation, epoch: automation.epoch - 1 },
        preQuiescedEpoch: waiting.epoch,
        evaluateCheckpoint: async () => ({ passed: true, observed: "not reached" }),
      }),
      /does not match the current control epoch/u,
    );

    const intervention = await consoleServer.openIntervention({
      runId: "run-pre-quiesced-valid",
      capability: "member.balance.lookup",
      currentStep: "discovery-loop",
      reason: "Manual recovery required",
      stoppedBecause: "Discovery is already quiesced",
      session,
      automationGrant: automation,
      preQuiescedEpoch: waiting.epoch,
      evaluateCheckpoint: async () => ({ passed: true, observed: "restored" }),
    });
    assert.equal(intervention.state().control.phase, "AWAITING_OPERATOR");
    assert.equal(intervention.state().control.epoch, waiting.epoch);
    assert.equal(intervention.audit()[0]?.action, "automation_paused");
  });

  it("fails closed before surface dispatch when durable audit persistence fails", async () => {
    const session: SurfaceSession = {
      id: "surface-audit-failure",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "runtime");
    const fake = fakeSurface(session);
    const consoleServer = await startOperatorConsole({
      control,
      surface: fake.surface,
      authorizeOperatorAction: allowLoopbackDemoOperatorAction,
      auditSink: async (event) => {
        if (event.action === "operator_action_authorized") {
          throw new Error("synthetic durable sink failure");
        }
        return { eventId: event.eventId, durable: true };
      },
    });
    consoles.push(consoleServer);
    const intervention = await consoleServer.openIntervention({
      runId: "run-audit-failure",
      capability: "member.balance.lookup",
      currentStep: "search-member",
      reason: "Manual recovery required",
      stoppedBecause: "Audit failure is under test",
      session,
      automationGrant: automation,
      evaluateCheckpoint: async () => ({ passed: true, observed: "not reached" }),
    });
    const waiting = intervention.state();
    const claimResponse = await post(intervention.url, "claim", {
      operatorId: "operator-audit-test",
      expectedEpoch: waiting.control.epoch,
    });
    const claim = await responseJson<{ claimId: string; epoch: number }>(claimResponse);

    const action = await post(intervention.url, "click", {
      claimId: claim.claimId,
      epoch: claim.epoch,
      x: 120,
      y: 120,
    });
    assert.equal(action.status, 503, await action.clone().text());
    assert.equal(
      (await responseJson<{ error: { code: string } }>(action)).error.code,
      "AUDIT_UNAVAILABLE",
    );
    assert.equal(fake.calls.clicks.length, 0);
    assert.equal(intervention.state().canAct, false);
    assert.equal(intervention.state().canResume, false);
    assert.equal(intervention.audit().at(-1)?.action, "audit_sink_failed");

    const secondAction = await post(intervention.url, "capture", {
      claimId: claim.claimId,
      epoch: claim.epoch,
    });
    assert.equal(secondAction.status, 503);
    assert.equal(fake.calls.captures, 0);
  });

  it("serializes authorization and dispatch for concurrent operator mutations", async () => {
    const session: SurfaceSession = {
      id: "surface-serialized-actions",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "runtime");
    const fake = fakeSurface(session);
    const authorized: OperatorAuthorizationContext["action"][] = [];
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalFirstEntered: () => void = () => undefined;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    const consoleServer = await startOperatorConsole({
      control,
      surface: fake.surface,
      authorizeOperatorAction: async (context) => {
        authorized.push(context.action);
        if (authorized.length === 1) {
          signalFirstEntered();
          await firstBlocked;
        }
        return allowLoopbackDemoOperatorAction(context);
      },
    });
    consoles.push(consoleServer);
    const intervention = await consoleServer.openIntervention({
      runId: "run-serialized-actions",
      capability: "member.balance.lookup",
      currentStep: "search-member",
      reason: "Manual recovery required",
      stoppedBecause: "Concurrent action serialization is under test",
      session,
      automationGrant: automation,
      evaluateCheckpoint: async () => ({ passed: true, observed: "not reached" }),
    });
    const waiting = intervention.state();
    const claimResponse = await post(intervention.url, "claim", {
      operatorId: "operator-serialized",
      expectedEpoch: waiting.control.epoch,
    });
    const claim = await responseJson<{ claimId: string; epoch: number }>(claimResponse);

    const click = post(intervention.url, "click", {
      claimId: claim.claimId,
      epoch: claim.epoch,
      x: 100,
      y: 100,
    });
    await firstEntered;
    const type = post(intervention.url, "type", {
      claimId: claim.claimId,
      epoch: claim.epoch,
      value: "synthetic",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(authorized, ["activate_coordinate"]);
    assert.equal(fake.calls.clicks.length, 0);
    assert.equal(fake.calls.typedCharacterCounts.length, 0);

    releaseFirst();
    assert.equal((await click).status, 200);
    assert.equal((await type).status, 200);
    assert.deepEqual(authorized, ["activate_coordinate", "type"]);
    assert.equal(fake.calls.clicks.length, 1);
    assert.equal(fake.calls.typedCharacterCounts.length, 1);
  });

  it("does not create an inaccessible claim when claim audit persistence fails", async () => {
    const session: SurfaceSession = {
      id: "surface-claim-audit-failure",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "runtime");
    const fake = fakeSurface(session);
    const consoleServer = await startOperatorConsole({
      control,
      surface: fake.surface,
      auditSink: async (event) => {
        if (event.action === "control_claimed") {
          const transitioned = control.snapshot(session.id);
          assert.equal(transitioned.phase, "OPERATOR_ACTIVE");
          assert.equal(transitioned.owner?.id, "operator-claim-audit");
          throw new Error("synthetic claim audit failure");
        }
        return { eventId: event.eventId, durable: true };
      },
    });
    consoles.push(consoleServer);
    const intervention = await consoleServer.openIntervention({
      runId: "run-claim-audit-failure",
      capability: "member.balance.lookup",
      currentStep: "search-member",
      reason: "Manual recovery required",
      stoppedBecause: "Claim audit failure is under test",
      session,
      automationGrant: automation,
      evaluateCheckpoint: async () => ({ passed: true, observed: "not reached" }),
    });
    const resumeRejected = assert.rejects(intervention.waitForResume(), /auditing failed closed/u);
    const claim = await post(intervention.url, "claim", {
      operatorId: "operator-claim-audit",
      expectedEpoch: intervention.state().control.epoch,
    });

    assert.equal(claim.status, 503, await claim.clone().text());
    assert.equal(control.snapshot(session.id).phase, "FAILED");
    assert.equal(control.snapshot(session.id).owner, null);
    assert.equal(intervention.state().canClaim, false);
    await resumeRejected;
  });

  it("keeps resume waiters and authority consistent when return audit persistence fails", async () => {
    const session: SurfaceSession = {
      id: "surface-return-audit-failure",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "runtime");
    const fake = fakeSurface(session);
    const consoleServer = await startOperatorConsole({
      control,
      surface: fake.surface,
      authorizeOperatorAction: allowLoopbackDemoOperatorAction,
      auditSink: async (event) => {
        if (event.action === "control_returned") {
          const transitioned = control.snapshot(session.id);
          assert.equal(transitioned.phase, "AUTOMATION_ACTIVE");
          assert.equal(transitioned.owner?.kind, "automation");
          throw new Error("synthetic return audit failure");
        }
        return { eventId: event.eventId, durable: true };
      },
    });
    consoles.push(consoleServer);
    const intervention = await consoleServer.openIntervention({
      runId: "run-return-audit-failure",
      capability: "member.balance.lookup",
      currentStep: "search-member",
      reason: "Manual recovery required",
      stoppedBecause: "Return audit failure is under test",
      session,
      automationGrant: automation,
      evaluateCheckpoint: async () => ({ passed: true, observed: "restored" }),
    });
    const claimResponse = await post(intervention.url, "claim", {
      operatorId: "operator-return-audit",
      expectedEpoch: intervention.state().control.epoch,
    });
    const claim = await responseJson<{ claimId: string; epoch: number }>(claimResponse);
    const resumeRejected = assert.rejects(intervention.waitForResume(), /auditing failed closed/u);
    const resume = await post(intervention.url, "resume", {
      claimId: claim.claimId,
      epoch: claim.epoch,
    });

    assert.equal(resume.status, 503, await resume.clone().text());
    assert.equal(control.snapshot(session.id).phase, "FAILED");
    assert.equal(control.snapshot(session.id).owner, null);
    await resumeRejected;
  });

  it("never returns a claim that expires while durable completion is pending", async () => {
    const session: SurfaceSession = {
      id: "surface-short-claim-lease",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "runtime");
    const fake = fakeSurface(session);
    const consoleServer = await startOperatorConsole({
      control,
      surface: fake.surface,
      auditSink: async (event) => {
        if (event.action === "control_claimed") {
          assert.equal(control.snapshot(session.id).phase, "OPERATOR_ACTIVE");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return { eventId: event.eventId, durable: true };
      },
    });
    consoles.push(consoleServer);
    const intervention = await consoleServer.openIntervention({
      runId: "run-short-claim-lease",
      capability: "member.balance.lookup",
      currentStep: "search-member",
      reason: "Manual recovery required",
      stoppedBecause: "Short claim lease race is under test",
      session,
      automationGrant: automation,
      operatorLeaseTtlMs: 5,
      evaluateCheckpoint: async () => ({ passed: true, observed: "not reached" }),
    });
    const claim = await post(intervention.url, "claim", {
      operatorId: "operator-short-lease",
      expectedEpoch: intervention.state().control.epoch,
    });

    assert.equal(claim.status, 409, await claim.clone().text());
    assert.equal(control.snapshot(session.id).phase, "AWAITING_OPERATOR");
    assert.equal(control.snapshot(session.id).owner, null);
    assert.equal(intervention.state().canClaim, true);
  });

  it("serializes a live screenshot refresh before the fresh resume observation", async () => {
    const session: SurfaceSession = {
      id: "surface-screenshot-resume-race",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "runtime");
    let markFirstObservationStarted: (() => void) | undefined;
    let releaseFirstObservation: (() => void) | undefined;
    const firstObservationStarted = new Promise<void>((resolve) => {
      markFirstObservationStarted = resolve;
    });
    const firstObservationGate = new Promise<void>((resolve) => {
      releaseFirstObservation = resolve;
    });
    const fake = fakeSurface(session, undefined, async (observationNumber) => {
      if (observationNumber !== 1) return;
      markFirstObservationStarted?.();
      await firstObservationGate;
    });
    const consoleServer = await startOperatorConsole({
      control,
      surface: fake.surface,
      authorizeOperatorAction: allowLoopbackDemoOperatorAction,
    });
    consoles.push(consoleServer);
    const intervention = await consoleServer.openIntervention({
      runId: "run-screenshot-resume-race",
      capability: "member.balance.lookup",
      currentStep: "search-member",
      reason: "Manual recovery required",
      stoppedBecause: "Screenshot and return overlap is under test",
      session,
      automationGrant: automation,
      evaluateCheckpoint: async () => ({ passed: true, observed: "Session restored" }),
    });
    const claimResponse = await post(intervention.url, "claim", {
      operatorId: "operator-race-test",
      expectedEpoch: intervention.state().control.epoch,
    });
    assert.equal(claimResponse.status, 200);
    const claim = await responseJson<{ claimId: string; epoch: number }>(claimResponse);

    const screenshot = operatorGet(intervention.url, "screenshot");
    await firstObservationStarted;
    const resume = post(intervention.url, "resume", {
      claimId: claim.claimId,
      epoch: claim.epoch,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.calls.observe, 1);

    releaseFirstObservation?.();
    assert.equal((await screenshot).status, 200);
    const resumeResponse = await resume;
    assert.equal(resumeResponse.status, 200, await resumeResponse.clone().text());
    const resumed = await intervention.waitForResume();
    assert.equal(resumed.observation.id, "observation-2");
    const cached = await operatorGet(intervention.url, "screenshot");
    assert.equal(cached.headers.get("x-handrail-observation-id"), resumed.observation.id);
    assert.equal(fake.calls.observe, 2);
  });

  it("recovers a handoff after one transient observation failure", async () => {
    const session: SurfaceSession = {
      id: "surface-transient-observation-recovery",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "runtime");
    const fake = fakeSurface(session, undefined, async (observationNumber) => {
      if (observationNumber === 1) throw new Error("synthetic transient observation failure");
    });
    const consoleServer = await startOperatorConsole({
      control,
      surface: fake.surface,
      authorizeOperatorAction: allowLoopbackDemoOperatorAction,
    });
    consoles.push(consoleServer);
    const intervention = await consoleServer.openIntervention({
      runId: "run-transient-observation-recovery",
      capability: "member.balance.lookup",
      currentStep: "search-member",
      reason: "Manual recovery required",
      stoppedBecause: "A transient observation failure is under test",
      session,
      automationGrant: automation,
      evaluateCheckpoint: async () => ({ passed: true, observed: "Session restored" }),
    });

    const failedScreenshot = await operatorGet(intervention.url, "screenshot");
    assert.equal(failedScreenshot.status, 500);
    assert.equal(intervention.state().connected, false);
    assert.equal(intervention.state().canClaim, false);

    const recoveredStateResponse = await operatorGet(intervention.url, "state");
    assert.equal(recoveredStateResponse.status, 200);
    const recoveredState = await responseJson<{
      connected: boolean;
      canClaim: boolean;
      latestObservation?: { id: string };
      control: { epoch: number };
    }>(recoveredStateResponse);
    assert.equal(recoveredState.connected, true);
    assert.equal(recoveredState.canClaim, true);
    assert.equal(recoveredState.latestObservation?.id, "observation-2");
    assert.equal(fake.calls.observe, 2);

    const claim = await post(intervention.url, "claim", {
      operatorId: "operator-reconnect-test",
      expectedEpoch: recoveredState.control.epoch,
    });
    assert.equal(claim.status, 200, await claim.clone().text());
    assert.equal(intervention.state().connected, true);
  });

  it("fails and closes a quiesced session when the initial pause audit is unavailable", async () => {
    const session: SurfaceSession = {
      id: "surface-initial-audit-failure",
      adapter: "playwright-web",
      createdAt: "2026-08-27T18:00:00.000Z",
      viewport: { width: 1280, height: 800 },
    };
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease(session.id, "runtime");
    const fake = fakeSurface(session);
    const consoleServer = await startOperatorConsole({
      control,
      surface: fake.surface,
      auditSink: async () => {
        throw new Error("durable audit unavailable");
      },
    });
    consoles.push(consoleServer);

    await assert.rejects(
      consoleServer.openIntervention({
        runId: "run-initial-audit-failure",
        capability: "member.balance.lookup",
        currentStep: "search-member",
        reason: "Manual recovery required",
        stoppedBecause: "Initial audit durability is under test",
        session,
        automationGrant: automation,
        evaluateCheckpoint: async () => ({ passed: true, observed: "not reached" }),
      }),
      /auditing failed closed/u,
    );
    assert.equal(control.snapshot(session.id).phase, "FAILED");
    assert.equal(control.snapshot(session.id).owner, null);
    assert.equal(fake.calls.closeSession, 1);
    assert.throws(() => consoleServer.state(session.id), /Unknown operator session/u);
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
