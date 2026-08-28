import type { OperatorAuditAction, OperatorConsoleState } from "./types.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function icon(kind: OperatorAuditAction | "human" | "monitor" | "warning" | "camera"): string {
  switch (kind) {
    case "human":
    case "control_claimed":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="3.4"/><path d="M5.8 20c.5-4 2.6-6.1 6.2-6.1s5.7 2.1 6.2 6.1"/></svg>';
    case "monitor":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/></svg>';
    case "warning":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v5M12 17.5h.01"/></svg>';
    case "camera":
    case "evidence_captured":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l1.4-2h7.2L17 8h3v11H4V8Z"/><circle cx="12" cy="13.5" r="3.2"/></svg>';
    case "automation_paused":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7v10M15 7v10"/></svg>';
    case "operator_clicked":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 3 10 9-5 1.5L10 19 7 3Z"/></svg>';
    case "operator_typed":
    case "operator_pressed_key":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/></svg>';
    case "control_returned":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h14M13 7l5 5-5 5"/></svg>';
    case "audit_sink_failed":
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/></svg>';
  }
}

function activityMarkup(state: OperatorConsoleState): string {
  return state.activities
    .map(
      (event) => `
        <li class="timeline-event" data-action="${escapeHtml(event.action)}">
          <span class="timeline-icon">${icon(event.action)}</span>
          <span>
            <time datetime="${escapeHtml(event.timestamp)}">${escapeHtml(
              new Date(event.timestamp).toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              }),
            )}</time>
            <span class="timeline-summary">${escapeHtml(event.summary)}</span>
          </span>
        </li>`,
    )
    .join("");
}

export function renderOperatorConsole(state: OperatorConsoleState): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>Handrail operator console</title>
    <link rel="stylesheet" href="/operator.css">
  </head>
  <body data-session-id="${escapeHtml(state.sessionId)}">
    <header class="command-bar">
      <strong class="wordmark">Handrail</strong>
      <span class="run-label" id="run-label">Run ${escapeHtml(state.runId)}</span>
      <span class="ownership-label">
        <span class="shell-icon">${icon("human")}</span>
        <span id="owner-label">Human control</span>
      </span>
      <button class="button button-return" id="resume-button" type="button" disabled>
        Return to automation
      </button>
    </header>

    <main class="workspace">
      <section class="live-column" aria-labelledby="live-title">
        <div class="live-panel">
          <header class="panel-heading">
            <h1 id="live-title">Live session</h1>
            <span class="same-session">
              <span class="inline-icon">${icon("monitor")}</span>
              Same browser session
            </span>
          </header>
          <div class="session-viewport" id="session-viewport">
            <img
              id="session-image"
              src="/api/sessions/${encodeURIComponent(state.sessionId)}/screenshot"
              alt="Live screenshot of the existing automation session"
              draggable="false"
              tabindex="0"
            >
          </div>
        </div>

        <form class="focused-control" id="type-form">
          <label class="sr-only" for="focused-value">Type into the focused control</label>
          <input
            id="focused-value"
            maxlength="4096"
            placeholder="Type into the focused control"
            autocomplete="off"
            disabled
          >
          <button class="button button-send" id="send-button" type="submit" disabled>Send</button>
        </form>
      </section>

      <aside class="intervention-rail" aria-labelledby="intervention-title">
        <header class="intervention-header">
          <span class="warning-icon">${icon("warning")}</span>
          <h2 id="intervention-title">Intervention required</h2>
        </header>

        <div class="intervention-body">
          <h3 id="intervention-reason">${escapeHtml(state.interventionReason)}</h3>
          <dl class="details-list">
            <div><dt>Capability</dt><dd id="capability">${escapeHtml(state.capability)}</dd></div>
            <div><dt>Current step</dt><dd id="current-step">${escapeHtml(state.currentStep)}</dd></div>
            <div><dt>Stopped because</dt><dd id="stopped-because">${escapeHtml(
              state.stoppedBecause,
            )}</dd></div>
          </dl>

          <section class="activity" aria-labelledby="activity-title">
            <h3 id="activity-title">Activity <span>(chronological)</span></h3>
            <ol id="activity-list">${activityMarkup(state)}</ol>
          </section>

          <button class="button button-capture" id="capture-button" type="button" disabled>
            <span class="button-icon">${icon("camera")}</span>
            Capture evidence
          </button>
          <p class="console-status" id="console-status" role="status" aria-live="polite"></p>
        </div>
      </aside>
    </main>
    <script src="/operator.js" defer></script>
  </body>
</html>`;
}

export const OPERATOR_CSS = `
:root {
  --ink-950: #04182f;
  --navy-800: #0a376a;
  --teal-600: #0795a5;
  --amber-600: #b56a00;
  --amber-100: #fff3d2;
  --canvas: #ffffff;
  --surface: #f7f9fb;
  --border: #d8dde5;
  --muted: #5d6878;
  --focus: #1769aa;
  color: var(--ink-950);
  background: var(--canvas);
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}

* { box-sizing: border-box; }
html, body { min-height: 100%; margin: 0; }
body { background: var(--canvas); font-size: 15px; }
button, input { font: inherit; }
button { -webkit-tap-highlight-color: transparent; }

.command-bar {
  min-height: 64px;
  padding: 0 16px 0 24px;
  display: grid;
  grid-template-columns: minmax(160px, 1fr) auto minmax(190px, 1fr) auto;
  align-items: center;
  gap: 28px;
  color: #fff;
  background: linear-gradient(100deg, #03172e 0%, #05264a 65%, #04284b 100%);
}

.wordmark { font-size: 25px; font-weight: 700; letter-spacing: -.02em; }
.run-label { font-size: 16px; font-weight: 700; }
.ownership-label {
  justify-self: end;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 16px;
  font-weight: 700;
}

.shell-icon, .inline-icon, .warning-icon, .button-icon, .timeline-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}
.shell-icon svg, .inline-icon svg, .warning-icon svg, .button-icon svg, .timeline-icon svg {
  width: 24px;
  height: 24px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.workspace {
  min-height: calc(100vh - 64px);
  padding: 16px;
  display: grid;
  grid-template-columns: minmax(0, 7fr) minmax(330px, 3fr);
  gap: 20px;
}

.live-column { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.live-panel, .focused-control, .intervention-rail {
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--canvas);
}
.live-panel { min-height: 0; overflow: hidden; }
.panel-heading {
  min-height: 58px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.panel-heading h1 { margin: 0; font-size: 18px; line-height: 1.2; }
.same-session { display: inline-flex; align-items: center; gap: 9px; white-space: nowrap; }
.inline-icon svg { width: 21px; height: 21px; }

.session-viewport {
  margin: 0 16px 14px;
  overflow: auto;
  border: 1px solid #97a1ae;
  background: var(--surface);
  min-height: 300px;
  max-height: calc(100vh - 224px);
}
.session-viewport[data-owned="true"] { cursor: crosshair; }
.session-viewport[data-owned="false"] { cursor: not-allowed; }
.session-viewport img {
  width: 100%;
  height: auto;
  min-width: 720px;
  display: block;
  user-select: none;
}

.focused-control { min-height: 86px; padding: 16px; display: flex; gap: 12px; }
.focused-control input {
  min-width: 0;
  flex: 1;
  padding: 0 14px;
  border: 1px solid #aeb7c3;
  border-radius: 6px;
  color: var(--ink-950);
  background: #fff;
}
.focused-control input::placeholder { color: #737b86; }

.button {
  min-height: 44px;
  border-radius: 6px;
  border: 1px solid transparent;
  padding: 0 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-weight: 700;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
}
.button:hover:not(:disabled) { filter: brightness(.96); }
.button:active:not(:disabled) { transform: translateY(1px); }
.button:focus-visible, input:focus-visible, .session-viewport img:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--focus) 35%, transparent);
  outline-offset: 2px;
}
.button:disabled, input:disabled { cursor: not-allowed; opacity: .48; }
.button-return { min-width: 220px; color: #fff; background: var(--teal-600); }
.button-send { min-width: 106px; color: #fff; background: var(--navy-800); }

.intervention-rail { min-width: 0; overflow: hidden; }
.intervention-header {
  min-height: 62px;
  padding: 0 20px;
  display: flex;
  align-items: center;
  gap: 14px;
  color: var(--ink-950);
  background: linear-gradient(90deg, var(--amber-100), #fffaf0);
  border-bottom: 1px solid #e2a934;
}
.intervention-header h2 { margin: 0; font-size: 20px; line-height: 1.2; }
.warning-icon { color: var(--amber-600); }
.warning-icon svg { width: 29px; height: 29px; stroke-width: 2; }
.intervention-body { padding: 20px; }
.intervention-body > h3 { margin: 0 0 26px; font-size: 18px; line-height: 1.35; }

.details-list { margin: 0; }
.details-list > div {
  display: grid;
  grid-template-columns: minmax(100px, 38%) 1fr;
  gap: 14px;
  padding: 13px 0;
}
.details-list dt, .details-list dd { margin: 0; line-height: 1.45; overflow-wrap: anywhere; }
.details-list dt { color: #1d2735; }

.activity { margin-top: 24px; padding-top: 22px; border-top: 1px solid var(--border); }
.activity h3 { margin: 0 0 18px; font-size: 15px; }
.activity h3 span { font-weight: 400; }
.activity ol { margin: 0; padding: 0; list-style: none; }
.timeline-event {
  position: relative;
  min-height: 64px;
  display: grid;
  grid-template-columns: 44px 1fr;
  gap: 12px;
}
.timeline-event:not(:last-child)::after {
  content: "";
  position: absolute;
  left: 21px;
  top: 40px;
  bottom: -5px;
  width: 1px;
  background: #b8bec7;
}
.timeline-icon {
  width: 42px;
  height: 42px;
  border: 2px solid currentColor;
  border-radius: 50%;
  color: var(--amber-600);
  background: #fff;
  z-index: 1;
}
.timeline-icon svg { width: 22px; height: 22px; }
.timeline-event[data-action="evidence_captured"] .timeline-icon,
.timeline-event[data-action="control_returned"] .timeline-icon { color: var(--navy-800); }
.timeline-event time { display: block; margin: 3px 0 5px; font-size: 12px; color: var(--muted); }
.timeline-summary { display: block; line-height: 1.35; overflow-wrap: anywhere; }

.button-capture {
  width: min(100%, 300px);
  margin: 22px auto 0;
  color: var(--navy-800);
  background: #fff;
  border-color: var(--navy-800);
}
.button-icon svg { width: 21px; height: 21px; }
.console-status { min-height: 20px; margin: 12px 0 0; text-align: center; color: var(--muted); font-size: 12px; }
.console-status[data-error="true"] { color: #9e2f2f; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@media (max-width: 1040px) {
  .command-bar { grid-template-columns: auto 1fr auto; gap: 18px; }
  .run-label { display: none; }
  .ownership-label { justify-self: end; }
  .workspace { grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr); }
}

@media (max-width: 760px) {
  .command-bar {
    min-height: 108px;
    padding: 12px 14px;
    grid-template-columns: 1fr auto;
    grid-template-rows: auto auto;
  }
  .ownership-label { font-size: 14px; }
  .button-return { min-width: 0; grid-column: 1 / -1; }
  .workspace { min-height: auto; padding: 10px; grid-template-columns: 1fr; gap: 12px; }
  .intervention-rail { order: -1; }
  .session-viewport { max-height: 65vh; }
  .focused-control { min-height: 76px; padding: 10px; }
  .button-send { min-width: 82px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
}
`;

export const OPERATOR_SCRIPT = `
(() => {
  "use strict";

  const sessionId = document.body.dataset.sessionId || "";
  const base = "/api/sessions/" + encodeURIComponent(sessionId) + "/";
  const image = document.getElementById("session-image");
  const viewport = document.getElementById("session-viewport");
  const status = document.getElementById("console-status");
  const resumeButton = document.getElementById("resume-button");
  const captureButton = document.getElementById("capture-button");
  const sendButton = document.getElementById("send-button");
  const typeInput = document.getElementById("focused-value");
  const typeForm = document.getElementById("type-form");
  const ownerLabel = document.getElementById("owner-label");
  const activityList = document.getElementById("activity-list");
  let state;
  let claim;
  let claiming = false;

  const actionIcons = {
    automation_paused: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7v10M15 7v10"/></svg>',
    control_claimed: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="3.4"/><path d="M5.8 20c.5-4 2.6-6.1 6.2-6.1s5.7 2.1 6.2 6.1"/></svg>',
    operator_clicked: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 3 10 9-5 1.5L10 19 7 3Z"/></svg>',
    operator_typed: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/></svg>',
    operator_pressed_key: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/></svg>',
    evidence_captured: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l1.4-2h7.2L17 8h3v11H4V8Z"/><circle cx="12" cy="13.5" r="3.2"/></svg>',
    control_returned: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h14M13 7l5 5-5 5"/></svg>',
    audit_sink_failed: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/></svg>'
  };

  function announce(message, isError) {
    status.textContent = message || "";
    status.dataset.error = isError ? "true" : "false";
  }

  async function request(path, method, body) {
    const response = await fetch(base + path, {
      method: method || "GET",
      headers: body ? { "Content-Type": "application/json", "X-Handrail-Console": "1" } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error && payload.error.message ? payload.error.message : "Operator request failed.");
      error.code = payload.error && payload.error.code;
      throw error;
    }
    return payload;
  }

  function ownsCurrentEpoch() {
    return Boolean(
      state && state.connected && claim &&
      state.control.phase === "OPERATOR_ACTIVE" &&
      state.control.owner && state.control.owner.kind === "operator" &&
      claim.epoch === state.control.epoch
    );
  }

  function setControlState() {
    const owns = ownsCurrentEpoch();
    viewport.dataset.owned = owns ? "true" : "false";
    resumeButton.disabled = !owns;
    captureButton.disabled = !owns;
    sendButton.disabled = !owns;
    typeInput.disabled = !owns;
    ownerLabel.textContent = state && state.control.owner && state.control.owner.kind === "automation"
      ? "Automation control"
      : "Human control";
  }

  function renderActivity() {
    activityList.replaceChildren();
    for (const event of state.activities) {
      const item = document.createElement("li");
      item.className = "timeline-event";
      item.dataset.action = event.action;
      const marker = document.createElement("span");
      marker.className = "timeline-icon";
      marker.innerHTML = actionIcons[event.action] || actionIcons.audit_sink_failed;
      const content = document.createElement("span");
      const time = document.createElement("time");
      time.dateTime = event.timestamp;
      time.textContent = new Date(event.timestamp).toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
      const summary = document.createElement("span");
      summary.className = "timeline-summary";
      summary.textContent = event.summary;
      content.append(time, summary);
      item.append(marker, content);
      activityList.append(item);
    }
  }

  function refreshImage() {
    image.src = base + "screenshot?fresh=" + Date.now();
  }

  async function refreshState(refreshScreenshot) {
    state = await request("state");
    if (claim && (
      !state.control.owner || state.control.owner.kind !== "operator" ||
      claim.epoch !== state.control.epoch
    )) claim = undefined;
    document.getElementById("run-label").textContent = "Run " + state.runId;
    document.getElementById("capability").textContent = state.capability;
    document.getElementById("current-step").textContent = state.currentStep;
    document.getElementById("intervention-reason").textContent = state.interventionReason;
    document.getElementById("stopped-because").textContent = state.stoppedBecause;
    renderActivity();
    setControlState();
    if (!state.connected) announce("Live session disconnected.", true);
    if (refreshScreenshot) refreshImage();

    if (state.canClaim && !claim && !claiming) {
      claiming = true;
      try {
        claim = await request("claim", "POST", {
          operatorId: "operator-demo",
          expectedEpoch: state.control.epoch
        });
        announce("", false);
        await refreshState(true);
      } catch (error) {
        announce(error.message, true);
      } finally {
        claiming = false;
      }
    } else if (state.control.phase === "OPERATOR_ACTIVE" && !claim) {
      announce("Control belongs to another operator lease.", true);
    }
  }

  async function act(path, payload, successMessage) {
    if (!ownsCurrentEpoch()) return;
    try {
      await request(path, "POST", { claimId: claim.claimId, epoch: claim.epoch, ...payload });
      announce(successMessage, false);
      await refreshState(true);
    } catch (error) {
      if (error.code === "CONTROL_LOST" || error.code === "LEASE_EXPIRED") claim = undefined;
      announce(error.message, true);
      await refreshState(false).catch(() => undefined);
    }
  }

  image.addEventListener("click", async (event) => {
    if (!ownsCurrentEpoch()) return;
    const rect = image.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * state.viewport.width;
    const y = ((event.clientY - rect.top) / rect.height) * state.viewport.height;
    await act("click", { x, y }, "Action acknowledged.");
  });

  image.addEventListener("error", () => announce("Live session disconnected.", true));

  image.addEventListener("keydown", async (event) => {
    const supported = ["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", " "];
    if (!supported.includes(event.key) || !ownsCurrentEpoch()) return;
    event.preventDefault();
    const key = event.shiftKey && event.key === "Tab" ? "Shift+Tab" : event.key === " " ? "Space" : event.key;
    await act("key", { key }, "Key acknowledged.");
  });

  typeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!ownsCurrentEpoch() || typeInput.value.length === 0) return;
    const value = typeInput.value;
    try {
      await request("type", "POST", { claimId: claim.claimId, epoch: claim.epoch, value });
      typeInput.value = "";
      announce("Input acknowledged.", false);
      await refreshState(true);
    } catch (error) {
      if (error.code === "CONTROL_LOST" || error.code === "LEASE_EXPIRED") claim = undefined;
      announce(error.message, true);
      await refreshState(false).catch(() => undefined);
    }
  });

  captureButton.addEventListener("click", () => act("capture", {}, "Evidence captured."));

  resumeButton.addEventListener("click", async () => {
    if (!ownsCurrentEpoch()) return;
    try {
      const result = await request("resume", "POST", { claimId: claim.claimId, epoch: claim.epoch });
      claim = undefined;
      announce(result.checkpoint.passed ? "Checkpoint passed." : "Checkpoint requires automation retry.", false);
      await refreshState(true);
    } catch (error) {
      announce(error.message, true);
      await refreshState(false).catch(() => undefined);
    }
  });

  refreshState(false).catch((error) => announce(error.message, true));
  window.setInterval(() => refreshState(false).catch(() => undefined), 2000);
})();
`;
