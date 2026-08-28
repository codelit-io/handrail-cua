import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ControlCoordinator, ControlError } from "../src/runtime/control.js";

describe("control coordinator", () => {
  it("transfers exclusive ownership and invalidates stale epochs", async () => {
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease("surface-1", "runtime");
    assert.equal(control.snapshot("surface-1").phase, "AUTOMATION_ACTIVE");

    control.requestPause(automation, "Session expired");
    const waiting = await control.quiesceAutomation(automation);
    assert.equal(waiting.phase, "AWAITING_OPERATOR");
    assert.equal(waiting.owner, null);
    assert.throws(
      () => control.assertGrant(automation),
      (error) => error instanceof ControlError && error.code === "CONTROL_LOST",
    );

    const operator = control.claimOperator("surface-1", "operator-demo");
    assert.equal(control.snapshot("surface-1").owner?.kind, "operator");
    assert.throws(
      () => control.claimOperator("surface-1", "intruder"),
      /Expected AWAITING_OPERATOR/,
    );

    control.requestResume(operator);
    const resumed = control.returnToAutomation(operator, "runtime");
    assert.equal(control.snapshot("surface-1").phase, "AUTOMATION_ACTIVE");
    assert.throws(() => control.assertGrant(operator), /stale/);
    control.assertGrant(resumed, "automation");
  });

  it("serializes commands for the current owner", async () => {
    const control = new ControlCoordinator();
    const grant = control.createAutomationLease("surface-2");
    const order: string[] = [];

    await Promise.all([
      control.withControl(grant, async () => {
        order.push("first-start");
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("first-end");
      }),
      control.withControl(grant, async () => {
        order.push("second");
      }),
    ]);

    assert.deepEqual(order, ["first-start", "first-end", "second"]);
  });

  it("drains the in-flight action boundary before revoking automation", async () => {
    const control = new ControlCoordinator();
    const grant = control.createAutomationLease("surface-boundary");
    const order: string[] = [];
    let releaseAction: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });

    const inFlight = control.withControl(grant, async () => {
      order.push("in-flight-start");
      markStarted?.();
      await actionGate;
      order.push("in-flight-effect");
    });
    await started;

    control.requestPause(grant, "Operator handoff requested");
    assert.equal(control.snapshot(grant.sessionId).phase, "PAUSE_REQUESTED");
    const queued = control.withControl(grant, async () => {
      order.push("queued-effect");
    });
    const quiescing = control.quiesceAutomation(grant);

    releaseAction?.();
    await inFlight;
    await assert.rejects(
      queued,
      (error: unknown) => error instanceof ControlError && error.code === "CONTROL_LOST",
    );
    const waiting = await quiescing;

    assert.deepEqual(order, ["in-flight-start", "in-flight-effect"]);
    assert.equal(waiting.phase, "AWAITING_OPERATOR");
    assert.equal(waiting.owner, null);
    assert.throws(
      () => control.assertGrant(grant),
      (error: unknown) => error instanceof ControlError && error.code === "CONTROL_LOST",
    );
  });

  it("queues terminal failure behind the in-flight action boundary", async () => {
    const control = new ControlCoordinator();
    const grant = control.createAutomationLease("surface-terminal-boundary");
    const order: string[] = [];
    let releaseAction: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const actionGate = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });

    const inFlight = control.withControl(grant, async () => {
      order.push("action-started");
      markStarted?.();
      await actionGate;
      order.push("action-settled");
    });
    await started;

    const failing = control.fail(grant, "Timed-out replay action.");
    assert.equal(control.snapshot(grant.sessionId).phase, "AUTOMATION_ACTIVE");
    releaseAction?.();
    await inFlight;
    const failed = await failing;

    order.push("terminal-failed");
    assert.deepEqual(order, ["action-started", "action-settled", "terminal-failed"]);
    assert.equal(failed.phase, "FAILED");
    assert.equal(failed.owner, null);
    assert.throws(
      () => control.assertGrant(grant),
      (error: unknown) => error instanceof ControlError && error.code === "CONTROL_LOST",
    );
  });

  it("never silently returns an expired operator lease to automation", async () => {
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease("surface-3");
    control.requestPause(automation, "Human decision required");
    await control.quiesceAutomation(automation);
    const operator = control.claimOperator("surface-3", "operator-demo", 1);

    const originalNow = Date.now;
    Date.now = () => originalNow() + 5_000;
    try {
      assert.throws(
        () => control.assertGrant(operator),
        (error) => error instanceof ControlError && error.code === "LEASE_EXPIRED",
      );
      assert.equal(control.snapshot("surface-3").phase, "AWAITING_OPERATOR");
      assert.equal(control.snapshot("surface-3").owner, null);
    } finally {
      Date.now = originalNow;
    }
  });

  it("returns an admitted operator mutation before expiring control at its safe boundary", async () => {
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease("surface-mid-action-expiry");
    control.requestPause(automation, "Human decision required");
    await control.quiesceAutomation(automation);

    const originalNow = Date.now;
    let nowMs = originalNow();
    Date.now = () => nowMs;
    try {
      const operator = control.claimOperator("surface-mid-action-expiry", "operator-demo", 1_000);
      let mutations = 0;

      const receipt = await control.withControl(operator, async () => {
        mutations += 1;
        nowMs += 1_001;
        const inFlightSnapshot = control.snapshot(operator.sessionId);
        assert.equal(inFlightSnapshot.phase, "OPERATOR_ACTIVE");
        assert.equal(inFlightSnapshot.owner?.id, "operator-demo");
        assert.throws(
          () => control.claimOperator(operator.sessionId, "second-operator"),
          (error: unknown) => error instanceof ControlError && error.code === "LEASE_EXPIRED",
        );
        return { changedSurface: true, sequence: mutations };
      });

      assert.deepEqual(receipt, { changedSurface: true, sequence: 1 });
      assert.equal(mutations, 1);
      const waiting = control.snapshot(operator.sessionId);
      assert.equal(waiting.phase, "AWAITING_OPERATOR");
      assert.equal(waiting.owner, null);
      assert.equal(waiting.expiresAt, null);
      assert.equal(waiting.epoch, operator.epoch + 1);
      assert.throws(
        () => control.assertGrant(operator),
        (error: unknown) => error instanceof ControlError && error.code === "CONTROL_LOST",
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("fails an exact unowned handoff epoch when no actor grant remains", async () => {
    const control = new ControlCoordinator();
    const automation = control.createAutomationLease("surface-quiesced-failure");
    control.requestPause(automation, "Operator handoff requested");
    const waiting = await control.quiesceAutomation(automation);

    await assert.rejects(
      control.failQuiesced(waiting.sessionId, waiting.epoch + 1, "Wrong epoch"),
      (error: unknown) => error instanceof ControlError && error.code === "CONTROL_LOST",
    );
    const failed = await control.failQuiesced(
      waiting.sessionId,
      waiting.epoch,
      "Initial operator audit persistence failed.",
    );
    assert.equal(failed.phase, "FAILED");
    assert.equal(failed.owner, null);
    assert.equal(failed.reason, "Initial operator audit persistence failed.");
  });
});
