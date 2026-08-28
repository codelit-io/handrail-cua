# Operator console UI specification

Status: accepted visual source of truth before implementation

Concept: docs/design/operator-console-concept.png, generated specifically for this project at 1586 x 992.

## Purpose and target flow

The capability-gated console gives one operator exclusive control of the exact browser session paused by automation. The primary flow is: an assigned operator opens the bearer-capability link -> the browser exchanges the fragment value for a scoped cookie -> the operator sees the reason and live state -> the operator claims control -> the operator acts on the live screenshot or focused control -> the operator captures evidence -> the operator returns control -> automation re-observes and resumes.

The synthetic legacy banking UI inside the viewport is intentionally not modernized. Its hostile frames, table layout, sparse semantics, and old visual language are part of the test surface.

## Information architecture

- Top command bar: Handrail wordmark, run ID, ownership state, Return to automation primary action.
- Main 70/30 split: large live-session viewport on the left; intervention detail rail on the right.
- Live-session header: Live session and Same browser session.
- Intervention rail: title, reason, capability, current step, stop reason, chronological activity, Capture evidence.
- Bottom live controls: text input for the currently focused surface control and Send.

No marketing navigation, charts, fake metrics, hero content, unrelated dashboards, or card grid may be added.

## Exact visible copy

Above the fold is limited to these strings plus dynamic run data and the rendered legacy surface:

- Handrail
- Run R-2026-08-27-001
- Human control
- Return to automation
- Live session
- Same browser session
- Intervention required
- Session expired - manual recovery required
- Capability
- member.balance.lookup
- Current step
- search-member
- Stopped because
- Known session-timeout dialog detected
- Activity (chronological)
- Automation paused
- Control transferred to operator
- Evidence captured
- Capture evidence
- Type into the focused control
- Send

The implementation uses an ASCII hyphen in the reason string for reliable rendering even though the concept shows a typographic dash.

## Design tokens

| Token | Value | Role |
| --- | --- | --- |
| ink-950 | #04182f | Top shell and primary text |
| navy-800 | #0a376a | Primary controls and legacy frame accents |
| teal-600 | #0795a5 | Return-to-automation action |
| amber-600 | #b56a00 | Intervention icon and timeline |
| amber-100 | #fff3d2 | Intervention header background |
| canvas | #ffffff | Main canvas; true white is locked |
| surface | #f7f9fb | Secondary surface |
| border | #d8dde5 | Panel and control rules |
| muted | #5d6878 | Supporting text |
| focus | #1769aa | Keyboard focus outline |
| radius-sm | 6px | Inputs and small controls |
| radius-md | 9px | Panels |
| space-unit | 4px | Base spacing scale |

Typography is a modern neutral system grotesk: Inter when locally available, then ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif. UI chrome is explicitly sized from 12 to 16px; the wordmark is 25px/700; section headings are 18 to 21px/700. Controls never inherit browser-default typography.

## Component families

- AppShell: fixed top bar plus responsive workspace.
- OwnershipControl: icon, owner label, and return action.
- LiveSessionPanel: header, screenshot surface, click-coordinate mapping, focused-control strip.
- InterventionRail: warning header, detail definition list, activity timeline, evidence action.
- ControlButton: primary teal, primary navy, and outlined variants with consistent geometry.
- TimelineEvent: icon node, time, and action text.

Icons are small inline SVGs with 1.75 to 2px rounded strokes: person for human owner, monitor for same session, triangle warning, pause, operator, and camera. Text glyph substitutes are not accepted.

## Layout and responsive behavior

- Native QA viewport: 1440 x 900, matching the intended concept class.
- Desktop: top bar 64px, 70/30 workspace, bottom control strip within the live panel.
- Narrow desktop/tablet: 60/40 split while the legacy screenshot remains scrollable inside its panel.
- Mobile QA: stack the intervention rail above the live session; keep the ownership action reachable; allow the legacy viewport to pan without clipping the app shell.
- All interactive controls have visible hover, active, focus-visible, disabled, and ownership-blocked states.
- Reduced motion disables any timeline or ownership transition animation.

## Interaction contract

- The live image preserves aspect ratio and maps pointer coordinates back to the current Playwright viewport. Clicks are accepted only while the operator owns the current lease epoch.
- Send types the field value into the currently focused element, clears the console input after an acknowledged action, and never logs the raw value.
- Capture evidence saves a pixel-safety-asserted screenshot and appends an audited timeline event. In evaluator runs, configured capture and audit sinks persist the image plus authorization/completion events; sink failure stops the lease and blocks resume.
- Return to automation prompts no second confirmation for the synthetic demo, but it does not skip the current automation step. Resume forces a fresh observation and postcondition check.
- Stale ownership, disconnected session, and expired lease are visible error states; controls disable instead of acting optimistically.

## Fidelity checklist

- [x] True-white working canvas and deep navy shell match the concept.
- [x] One large viewport plus one open detail rail; no extra cards or decorative containers.
- [x] Top-bar order, copy, and control density match.
- [x] 70/30 balance and bottom control strip match at 1440 x 900.
- [x] Amber intervention hierarchy and teal return action match.
- [x] Typography, radii, borders, icon weight, and spacing are deliberate throughout.
- [x] All exact copy is present with no invented above-the-fold copy.
- [x] Same-session click, type, evidence, and return actions update real runtime state.
- [x] Desktop and mobile renders have no clipping, overlap, scroll traps, or browser-default controls.
- [x] Final render was compared directly with the concept using `view_image`.

## Intentional deviations

- The legacy surface content is generated by the running synthetic app rather than baked into the console.
- Dynamic run ID, event times, capability, step, and stop reason replace the concept examples at runtime.
- The UI is delivered as a small server-rendered HTML/CSS/JavaScript surface instead of React because it has one cohesive screen and no reusable client-side product domain; this removes a build layer without weakening the real interaction model.
