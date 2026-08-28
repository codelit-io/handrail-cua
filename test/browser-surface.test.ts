import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, describe, it } from "node:test";
import { createDemoBinding } from "../src/demo/config.js";
import { ControlCoordinator } from "../src/runtime/control.js";
import { BrowserSurface, SurfaceResolutionError } from "../src/surface/browser-surface.js";
import { type LegacyTargetHandle, startLegacyTarget } from "../src/target/server.js";

const cleanups: Array<() => Promise<void>> = [];

async function startNavigationPolicyTarget(): Promise<{
  origin: string;
  entryUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer((_request, response) => {
    const body = Buffer.from(
      `<!doctype html>
      <html lang="en">
        <head><title>Navigation policy harness</title></head>
        <body>
          <a href="#allowed-section">Same-page anchor</a>
          <a href="about:blank">About blank escape</a>
          <a href="data:text/html,%3Ctitle%3EData%20escape%3C%2Ftitle%3E">Data URL escape</a>
          <a href="https://example.com/diagnostics">Off-origin escape</a>
          <button id="delayed-route" type="button">Delayed route change</button>
          <section id="allowed-section">Allowed anchor destination</section>
          <script>
            document.querySelector("#delayed-route").addEventListener("click", () => {
              window.setTimeout(() => history.pushState({}, "", "/outside-binding"), 100);
            });
          </script>
        </body>
      </html>`,
      "utf8",
    );
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(body.byteLength),
    });
    response.end(body);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Navigation policy target did not expose a TCP address."));
        return;
      }
      resolve(address.port);
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    entryUrl: `${origin}/legacy`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("browser surface adapter", () => {
  it("observes a hostile iframe, compiles semantic targets, and extracts a typed balance", async () => {
    const target: LegacyTargetHandle = await startLegacyTarget();
    const control = new ControlCoordinator();
    const surface = await BrowserSurface.launch({ control, headless: true });
    cleanups.push(async () => surface.close(), target.close);

    const session = await surface.createSession(createDemoBinding(target.origin));
    const grant = control.createAutomationLease(session.id, "browser-surface-test");
    await surface.navigate(session.id, target.entryUrl(), grant);
    const initial = await surface.observe(session.id);
    const memberInput = initial.elements.find(
      (element) => element.role === "textbox" && element.context.precedingLabel === "Member number",
    );
    const findButton = initial.elements.find(
      (element) => element.role === "button" && element.name === "Find Member",
    );
    assert.ok(memberInput);
    assert.ok(findButton);

    const inputTarget = surface.compileTarget(initial.id, memberInput.ref, "Member number input");
    assert.equal(inputTarget.candidates[0]?.kind, "relation");
    assert.equal(inputTarget.candidates.at(-1)?.kind, "visual");

    await surface.dispatch(
      session.id,
      {
        decisionId: "decision-fill",
        observationId: initial.id,
        kind: "set_value",
        elementRef: memberInput.ref,
        value: { kind: "input", name: "memberId" },
        rationale: "Bind the declared member ID input.",
      },
      { observationId: initial.id, inputs: { memberId: "84721" }, grant },
    );
    const filled = await surface.observe(session.id);
    const filledButton = filled.elements.find(
      (element) => element.role === "button" && element.name === "Find Member",
    );
    assert.ok(filledButton);
    const activationReceipt = await surface.dispatch(
      session.id,
      {
        decisionId: "decision-submit",
        observationId: filled.id,
        kind: "activate",
        elementRef: filledButton.ref,
        rationale: "Submit the reversible lookup.",
      },
      { observationId: filled.id, inputs: { memberId: "84721" }, grant },
    );
    assert.equal(
      activationReceipt.changedSurface,
      true,
      "An iframe-only content transition must count as a changed surface.",
    );

    const results = await surface.observe(session.id);
    const balance = results.elements.find(
      (element) =>
        element.context.rowLabel === "Savings" && element.context.columnLabel === "Current balance",
    );
    assert.ok(balance);
    const balanceTarget = surface.compileTarget(results.id, balance.ref, "Savings current balance");
    assert.equal(balanceTarget.candidates[0]?.kind, "table");
    assert.equal(
      await surface.extract(session.id, balanceTarget, {
        kind: "target_text",
        target: "savings-balance",
        transforms: ["trim", "currency_to_number"],
      }),
      1284.37,
    );
  });

  it("fails closed when a semantic target becomes ambiguous", async () => {
    const target = await startLegacyTarget();
    const control = new ControlCoordinator();
    const surface = await BrowserSurface.launch({ control, headless: true });
    cleanups.push(async () => surface.close(), target.close);

    const session = await surface.createSession(createDemoBinding(target.origin));
    const grant = control.createAutomationLease(session.id, "ambiguity-test");
    await surface.navigate(session.id, target.entryUrl("ambiguous"), grant);
    const observation = await surface.observe(session.id);
    const button = observation.elements.find(
      (element) => element.role === "button" && element.name === "Find Member",
    );
    assert.ok(button);
    const targetSpec = surface.compileTarget(observation.id, button.ref, "Find Member button");

    await assert.rejects(
      surface.evaluate(
        session.id,
        { kind: "target_visible", target: "submit", expected: true },
        { inputs: {}, outputs: {}, targets: { submit: targetSpec } },
      ),
      (error: unknown) =>
        error instanceof SurfaceResolutionError && error.code === "TARGET_AMBIGUOUS",
    );
  });

  it("keeps activation inside the allowed HTTP origin and route", async () => {
    const target = await startNavigationPolicyTarget();
    const control = new ControlCoordinator();
    const surface = await BrowserSurface.launch({ control, headless: true });
    cleanups.push(async () => surface.close(), target.close);

    const session = await surface.createSession(createDemoBinding(target.origin));
    const grant = control.createAutomationLease(session.id, "navigation-policy-test");
    await surface.navigate(session.id, target.entryUrl, grant);

    const activate = async (
      name: string,
    ): Promise<{ observationId: string; elementRef: string }> => {
      const observation = await surface.observe(session.id);
      const element = observation.elements.find((candidate) => candidate.name === name);
      assert.ok(element);
      await surface.dispatch(
        session.id,
        {
          decisionId: `activate-${name.toLowerCase().replaceAll(/[^a-z]+/gu, "-")}`,
          observationId: observation.id,
          kind: "activate",
          elementRef: element.ref,
          rationale: "Exercise the browser surface navigation policy boundary.",
        },
        { observationId: observation.id, inputs: {}, grant },
      );
      return { observationId: observation.id, elementRef: element.ref };
    };

    await activate("Same-page anchor");
    let after = await surface.observe(session.id);
    assert.equal(after.route, "/legacy");
    assert.equal(after.title, "Navigation policy harness");

    for (const name of ["About blank escape", "Data URL escape", "Off-origin escape"]) {
      await assert.rejects(activate(name), /outside the surface binding|HTTP\(S\)/u);
      after = await surface.observe(session.id);
      assert.equal(after.route, "/legacy");
      assert.equal(after.title, "Navigation policy harness");
    }

    const delayed = await activate("Delayed route change");
    await new Promise((resolve) => setTimeout(resolve, 180));
    await assert.rejects(surface.observe(session.id), /Route \/outside-binding/u);
    await assert.rejects(
      surface.dispatch(
        session.id,
        {
          decisionId: "activate-after-policy-drift",
          observationId: delayed.observationId,
          kind: "activate",
          elementRef: delayed.elementRef,
          rationale: "A closed policy-violating session must reject later actions.",
        },
        { observationId: delayed.observationId, inputs: {}, grant },
      ),
      /Unknown browser surface session/u,
    );

    const dispatchSession = await surface.createSession(createDemoBinding(target.origin));
    const dispatchGrant = control.createAutomationLease(
      dispatchSession.id,
      "delayed-route-dispatch-test",
    );
    await surface.navigate(dispatchSession.id, target.entryUrl, dispatchGrant);
    const dispatchObservation = await surface.observe(dispatchSession.id);
    const delayedButton = dispatchObservation.elements.find(
      (candidate) => candidate.name === "Delayed route change",
    );
    assert.ok(delayedButton);
    await surface.dispatch(
      dispatchSession.id,
      {
        decisionId: "schedule-delayed-route-for-dispatch",
        observationId: dispatchObservation.id,
        kind: "activate",
        elementRef: delayedButton.ref,
        rationale: "Schedule a same-document route change after the activation post-check.",
      },
      { observationId: dispatchObservation.id, inputs: {}, grant: dispatchGrant },
    );
    await new Promise((resolve) => setTimeout(resolve, 180));
    await assert.rejects(
      surface.dispatch(
        dispatchSession.id,
        {
          decisionId: "dispatch-after-delayed-policy-drift",
          observationId: dispatchObservation.id,
          kind: "activate",
          elementRef: delayedButton.ref,
          rationale: "Dispatch must detect a delayed policy-violating route before acting.",
        },
        { observationId: dispatchObservation.id, inputs: {}, grant: dispatchGrant },
      ),
      /Route \/outside-binding/u,
    );
    await assert.rejects(surface.observe(dispatchSession.id), /Unknown browser surface session/u);
  });
});
