import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
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
  serviceWorkerScriptRequestCount: () => number;
  webrtcDatagramCount: () => number;
  websocketUpgradeCount: () => number;
  outsideBindingRequestCount: () => number;
  close: () => Promise<void>;
}> {
  let websocketUpgradeCount = 0;
  let serviceWorkerScriptRequestCount = 0;
  let webrtcDatagramCount = 0;
  let outsideBindingRequestCount = 0;
  const udpServer = createSocket("udp4");
  udpServer.on("message", () => {
    webrtcDatagramCount += 1;
  });
  const udpPort = await new Promise<number>((resolve, reject) => {
    udpServer.once("error", reject);
    udpServer.bind(0, "127.0.0.1", () => {
      udpServer.off("error", reject);
      const address = udpServer.address();
      resolve(address.port);
    });
  });
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/outside-binding")) outsideBindingRequestCount += 1;
    if (request.url === "/legacy/sw.js") {
      serviceWorkerScriptRequestCount += 1;
      const worker = Buffer.from('self.addEventListener("fetch", () => undefined);', "utf8");
      response.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Content-Length": String(worker.byteLength),
      });
      response.end(worker);
      return;
    }
    const observationDriftControls = request.url?.includes("observe-drift=1")
      ? `${Array.from(
          { length: 120 },
          (_, index) => `<button type="button">Drift filler ${index + 1}</button>`,
        ).join(
          "",
        )}<button id="observation-drift-trigger" type="button">Observation drift trigger</button>`
      : "";
    const body = Buffer.from(
      `<!doctype html>
      <html lang="en">
        <head><title>Navigation policy harness</title></head>
        <body>
          <a href="#allowed-section">Same-page anchor</a>
          <a href="about:blank">About blank escape</a>
          <a href="data:text/html,%3Ctitle%3EData%20escape%3C%2Ftitle%3E">Data URL escape</a>
          <a href="https://example.com/diagnostics">Off-origin escape</a>
          <a href="/outside-binding">Same-origin route escape</a>
          <a href="#allowed-section" target="_blank">Declarative popup escape</a>
          <button id="delayed-route" type="button">Delayed route change</button>
          <button id="window-open-escape" type="button">Script popup escape</button>
          <output id="window-open-status">Script popup not attempted</output>
          <form id="async-popup-form" method="get" action="/outside-binding" target="_blank">
            <button id="async-popup-escape" type="button">Async popup escape</button>
          </form>
          <button id="websocket-escape" type="button">Open WebSocket</button>
          <output id="websocket-status">WebSocket not attempted</output>
          <button id="service-worker" type="button">Register service worker</button>
          <output id="service-worker-status">Service worker not attempted</output>
          <button id="webrtc-escape" type="button">Open WebRTC</button>
          <output id="webrtc-status">WebRTC not attempted</output>
          <button id="webtransport-escape" type="button">Open WebTransport</button>
          <output id="webtransport-status">WebTransport not attempted</output>
          <section id="allowed-section">Allowed anchor destination</section>
          ${observationDriftControls}
          <script>
            document.querySelector("#delayed-route").addEventListener("click", () => {
              window.setTimeout(() => history.pushState({}, "", "/outside-binding"), 100);
            });
            document.querySelector("#window-open-escape").addEventListener("click", () => {
              const status = document.querySelector("#window-open-status");
              try {
                const popup = window.open("/outside-binding", "_blank");
                status.textContent = popup ? "Script popup opened" : "Script popup blocked";
              } catch {
                status.textContent = "Script popup blocked";
              }
            });
            document.querySelector("#async-popup-escape").addEventListener("click", () => {
              window.setTimeout(() => document.querySelector("#async-popup-form").submit(), 80);
            });
            document.querySelector("#websocket-escape").addEventListener("click", () => {
              const status = document.querySelector("#websocket-status");
              let opened = false;
              const socket = new WebSocket(
                (location.protocol === "https:" ? "wss://" : "ws://") +
                  location.host +
                  "/socket-escape",
              );
              socket.addEventListener("open", () => {
                opened = true;
                status.textContent = "WebSocket connected";
              });
              socket.addEventListener("error", () => {
                status.textContent = "WebSocket blocked";
              });
              socket.addEventListener("close", () => {
                if (!opened) status.textContent = "WebSocket blocked";
              });
            });
            document.querySelector("#service-worker").addEventListener("click", async () => {
              const status = document.querySelector("#service-worker-status");
              try {
                await navigator.serviceWorker.register("/legacy/sw.js");
                status.textContent = "Service worker registered";
              } catch {
                status.textContent = "Service worker blocked";
              }
            });
            document.querySelector("#webrtc-escape").addEventListener("click", async () => {
              const status = document.querySelector("#webrtc-status");
              try {
                const peer = new RTCPeerConnection({
                  iceServers: [{ urls: "stun:127.0.0.1:${udpPort}" }],
                });
                peer.createDataChannel("policy-bypass");
                await peer.setLocalDescription(await peer.createOffer());
                status.textContent = "WebRTC opened";
              } catch {
                status.textContent = "WebRTC blocked";
              }
            });
            document.querySelector("#webtransport-escape").addEventListener("click", () => {
              const status = document.querySelector("#webtransport-status");
              try {
                new WebTransport("https://127.0.0.1:${udpPort}/transport-escape");
                status.textContent = "WebTransport opened";
              } catch {
                status.textContent = "WebTransport blocked";
              }
            });
            const driftTrigger = document.querySelector("#observation-drift-trigger");
            if (driftTrigger) {
              let drifted = false;
              const getAttribute = driftTrigger.getAttribute.bind(driftTrigger);
              driftTrigger.getAttribute = (name) => {
                if (!drifted) {
                  drifted = true;
                  history.pushState({}, "", "/outside-binding");
                }
                return getAttribute(name);
              };
            }
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
  server.on("upgrade", (_request, socket) => {
    websocketUpgradeCount += 1;
    socket.destroy();
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
    serviceWorkerScriptRequestCount: () => serviceWorkerScriptRequestCount,
    webrtcDatagramCount: () => webrtcDatagramCount,
    websocketUpgradeCount: () => websocketUpgradeCount,
    outsideBindingRequestCount: () => outsideBindingRequestCount,
    close: async () => {
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
        new Promise<void>((resolve) => udpServer.close(() => resolve())),
      ]);
    },
  };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("browser surface adapter", () => {
  it("prevents popup creation and closes a session after an asynchronous new-page attempt", async () => {
    const target = await startNavigationPolicyTarget();
    const control = new ControlCoordinator();
    const surface = await BrowserSurface.launch({ control, headless: true });
    cleanups.push(async () => surface.close(), target.close);

    const session = await surface.createSession(createDemoBinding(target.origin));
    const grant = control.createAutomationLease(session.id, "popup-policy-test");
    await surface.navigate(session.id, target.entryUrl, grant);

    let observation = await surface.observe(session.id);
    const declarativePopup = observation.elements.find(
      (candidate) => candidate.name === "Declarative popup escape",
    );
    assert.ok(declarativePopup);
    await assert.rejects(
      surface.dispatch(
        session.id,
        {
          decisionId: "declarative-popup-escape",
          observationId: observation.id,
          kind: "activate",
          elementRef: declarativePopup.ref,
          rationale: "Exercise a target-blank activation inside an otherwise allowed route.",
        },
        { observationId: observation.id, inputs: {}, grant, expectedUrl: observation.url },
      ),
      /single-page/u,
    );

    observation = await surface.observe(session.id);
    const scriptedPopup = observation.elements.find(
      (candidate) => candidate.name === "Script popup escape",
    );
    assert.ok(scriptedPopup);
    await surface.dispatch(
      session.id,
      {
        decisionId: "script-popup-escape",
        observationId: observation.id,
        kind: "activate",
        elementRef: scriptedPopup.ref,
        rationale: "Exercise a direct window.open attempt.",
      },
      { observationId: observation.id, inputs: {}, grant, expectedUrl: observation.url },
    );
    assert.match((await surface.observe(session.id)).visibleText, /Script popup blocked/u);

    observation = await surface.observe(session.id);
    const asyncPopup = observation.elements.find(
      (candidate) => candidate.name === "Async popup escape",
    );
    assert.ok(asyncPopup);
    const x = (asyncPopup.bounds.x + asyncPopup.bounds.width / 2) * observation.viewport.width;
    const y = (asyncPopup.bounds.y + asyncPopup.bounds.height / 2) * observation.viewport.height;
    await surface.clickAt(session.id, x, y, grant, observation.url);
    await new Promise((resolve) => setTimeout(resolve, 160));
    await assert.rejects(surface.observe(session.id), /popup or additional page/u);
    await assert.rejects(surface.observe(session.id), /Unknown browser surface session/u);
    assert.equal(target.outsideBindingRequestCount(), 0);
  });

  it("blocks browser transports outside the declared HTTP surface boundary", async () => {
    const target = await startNavigationPolicyTarget();
    const control = new ControlCoordinator();
    const surface = await BrowserSurface.launch({ control, headless: true });
    cleanups.push(async () => surface.close(), target.close);

    const session = await surface.createSession(createDemoBinding(target.origin));
    const grant = control.createAutomationLease(session.id, "browser-transport-policy-test");
    await surface.navigate(session.id, target.entryUrl, grant);

    const activate = async (name: string): Promise<void> => {
      const observation = await surface.observe(session.id);
      const element = observation.elements.find((candidate) => candidate.name === name);
      assert.ok(element);
      await surface.dispatch(
        session.id,
        {
          decisionId: `transport-${name.toLowerCase().replaceAll(/[^a-z]+/gu, "-")}`,
          observationId: observation.id,
          kind: "activate",
          elementRef: element.ref,
          rationale: "Exercise a browser transport the HTTP surface does not authorize.",
        },
        { observationId: observation.id, inputs: {}, grant, expectedUrl: observation.url },
      );
    };

    await activate("Open WebSocket");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match((await surface.observe(session.id)).visibleText, /WebSocket blocked/u);
    assert.equal(target.websocketUpgradeCount(), 0);

    await activate("Register service worker");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(target.serviceWorkerScriptRequestCount(), 0);
    assert.equal(target.websocketUpgradeCount(), 0);

    await activate("Open WebRTC");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.match((await surface.observe(session.id)).visibleText, /WebRTC blocked/u);
    assert.equal(target.webrtcDatagramCount(), 0);

    await activate("Open WebTransport");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.match((await surface.observe(session.id)).visibleText, /WebTransport blocked/u);
    assert.equal(target.webrtcDatagramCount(), 0);
  });

  it("rejects a same-document route change during observation", async () => {
    const target = await startNavigationPolicyTarget();
    const control = new ControlCoordinator();
    const surface = await BrowserSurface.launch({ control, headless: true });
    cleanups.push(async () => surface.close(), target.close);

    const session = await surface.createSession(createDemoBinding(target.origin));
    const grant = control.createAutomationLease(session.id, "observation-route-drift-test");
    await surface.navigate(session.id, `${target.entryUrl}?observe-drift=1`, grant);
    await assert.rejects(surface.observe(session.id), /Route \/outside-binding/u);
    await assert.rejects(surface.observe(session.id), /Unknown browser surface session/u);
  });

  it("enforces every effective origin and route layer at the browser boundary", async () => {
    const target = await startNavigationPolicyTarget();
    const control = new ControlCoordinator();
    const surface = await BrowserSurface.launch({ control, headless: true });
    cleanups.push(async () => surface.close(), target.close);

    const base = createDemoBinding(target.origin);
    const widenedBinding = {
      ...base,
      policy: {
        ...base.policy,
        allowedRoutes: ["/legacy", "/outside-binding"],
      },
    };
    const session = await surface.createSession(widenedBinding, [
      {
        name: "platform",
        allowedOrigins: [target.origin],
        allowedRoutes: ["/legacy"],
      },
    ]);
    const grant = control.createAutomationLease(session.id, "effective-surface-policy-test");
    await surface.navigate(session.id, target.entryUrl, grant);
    const observation = await surface.observe(session.id);
    const routeEscape = observation.elements.find(
      (candidate) => candidate.name === "Same-origin route escape",
    );
    assert.ok(routeEscape);

    await assert.rejects(
      surface.dispatch(
        session.id,
        {
          decisionId: "effective-policy-route-escape",
          observationId: observation.id,
          kind: "activate",
          elementRef: routeEscape.ref,
          rationale: "The broader app binding must not widen the effective platform policy.",
        },
        {
          observationId: observation.id,
          inputs: {},
          grant,
          expectedUrl: observation.url,
        },
      ),
      /outside effective policy layer platform/u,
    );
    await assert.rejects(
      surface.navigate(session.id, `${target.origin}/outside-binding`, grant),
      /outside effective policy layer platform/u,
    );
    assert.equal((await surface.observe(session.id)).url, observation.url);
  });

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
    const authorizedObservation = await surface.observe(session.id);
    const authorizedLink = authorizedObservation.elements.find(
      (candidate) => candidate.name === "Same-page anchor",
    );
    assert.ok(authorizedLink);
    const authorizedTarget = surface.compileTarget(
      authorizedObservation.id,
      authorizedLink.ref,
      "Same-page anchor",
    );
    const staleAuthorizedUrl = `${target.origin}/wrong-but-allowed`;
    await assert.rejects(
      surface.clickAt(session.id, 1, 1, grant, staleAuthorizedUrl),
      /changed after policy authorization/u,
    );
    await assert.rejects(
      surface.dispatch(
        session.id,
        {
          decisionId: "dispatch-with-stale-policy-url",
          observationId: authorizedObservation.id,
          kind: "activate",
          elementRef: authorizedLink.ref,
          rationale: "A dispatch must stay bound to the URL policy authorized.",
        },
        {
          observationId: authorizedObservation.id,
          inputs: {},
          grant,
          expectedUrl: staleAuthorizedUrl,
        },
      ),
      /changed after policy authorization/u,
    );
    await assert.rejects(
      surface.evaluate(
        session.id,
        { kind: "target_visible", target: "same-page", expected: true },
        {
          inputs: {},
          outputs: {},
          targets: { "same-page": authorizedTarget },
          grant,
          expectedUrl: staleAuthorizedUrl,
        },
      ),
      /changed after policy authorization/u,
    );
    await assert.rejects(
      surface.extract(
        session.id,
        authorizedTarget,
        { kind: "target_text", target: "same-page", transforms: ["trim"] },
        undefined,
        grant,
        staleAuthorizedUrl,
      ),
      /changed after policy authorization/u,
    );
    await assert.rejects(
      surface.captureEvidence(session.id, "stale-policy-url", undefined, staleAuthorizedUrl, grant),
      /changed after policy authorization/u,
    );

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
