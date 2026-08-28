# Handrail QA and release gates

This document separates repeatable code verification from evidence that requires a genuine live Ollama run or a manual browser review. A scripted offline run never counts as live-model acceptance.

## Evidence labels

| Label | Acceptance meaning |
| --- | --- |
| Automated | A deterministic test or static check can reproduce the assertion locally and in CI. |
| Offline demo | The complete local workflow runs with `ScriptedPlanner`; it proves orchestration, not genuine LLM behavior. |
| Live Ollama | Native Ollama made one or more decisions from fresh live-surface observations and the run records `liveModel: true`. |
| Manual | A human inspected the rendered UI or handoff behavior and retained a sanitized screenshot or note. |
| Release | The repository, committed evidence manifest, clean clone, and public CI run all agree. |

## Current code-level verification

The release-candidate check on 2026-08-27 completed:

```text
npm run verify             passed
  biome                    35 files clean
  TypeScript               passed
  automated tests          109 passed, 0 failed
  evidence validator       44 files, 12 runs, 15 PNG refs, valid
npm audit --omit=dev       0 vulnerabilities
npm audit                  0 vulnerabilities
browser guard repeat       5 consecutive focused runs passed
npm run demo:offline       10/10 zero-model replays passed
explicit goal + target     external synthetic target discovery passed
```

The checked-in release bundle is separate from the offline smoke. Its discovery was a genuine native Ollama run with `liveModel: true` and four model calls. Ten fresh-session replays of the exact compiled digest then succeeded with zero total model calls, and the exceptional replay returned `business_outcome / MEMBER_NOT_FOUND`.

| Area | Automated coverage | Current boundary |
| --- | --- | --- |
| Artifact | Strict schemas, canonical digest, drift detection, linter, typed binding | Release artifact is checked in and validator-bound to the discovery run. |
| Discovery | Bounded loop, fresh refs, verified compilation, stale rejection, help, business outcome, transient budget | Native Ollama evidence records four fresh decisions and `liveModel: true`. |
| Replay | Zero-model source boundary, fresh browser replay, output validation, digest drift, retry, intervention, terminal failure | Ten checked-in replays consume the live-discovered digest with zero model calls. |
| Policy | Exact origin/route/action/effect intersection, redirect denial, approval binding | No real external tenant is in scope. |
| Redaction/evidence | Nested classification, pattern canaries, immutable writes, path and symlink defense | Validator and independent text/image review are complete for the release bundle. |
| Handoff | Stable session ID, automation revocation, exclusive claim, stale rejection, redacted human audit, fresh resume grant | Integrated expiry-to-console manual QA is recorded below; it is outside the discovery/replay manifest. |
| Browser target | Real Chromium interaction, iframe traversal, session restore, ambiguity fixture | Chromium only; Firefox/WebKit are unqualified. |

## Required automated commands

Run from a clean checkout:

```bash
npm ci
npx playwright install chromium
npm run verify
```

`npm run verify` is the release gate for formatting/lint, TypeScript, tests, and the sanitized evidence manifest. The GitHub workflow repeats the same sequence on Linux with no model credential and read-only repository permissions.

Individual diagnostics:

```bash
npm run lint
npm run typecheck
npm test
npm run test:unit
npm run test:e2e
npm run evidence:validate
```

## Scenario acceptance matrix

| Scenario | Deterministic proof in the suite | Release evidence required |
| --- | --- | --- |
| Happy path | Typed success and a compiled capability replay through fresh Chromium | Live discovery summary, artifact, replay summary, before/after screenshots |
| Member not found | `business_outcome / MEMBER_NOT_FOUND` before generic checkpoint failure | Sanitized exceptional replay event or summary |
| Malformed input | `INPUT_INVALID` at preflight before any surface is created | CLI exit/result sample; no browser screenshot is necessary |
| Known transient | Only configured recovery is retried within its budget | Event sequence showing bounded recovery, if included in release evidence |
| Session expiry | Retained-session intervention plus real target restoration and operator lease tests | One integrated same-session before/during/after sequence |
| Permission denial | Explicit sentinel and synthetic target state | Structured `PERMISSION_DENIED` result if used in the evidence manifest |
| Ambiguous target | Real BrowserSurface and target fixture fail closed | Optional screenshot plus `TARGET_AMBIGUOUS` result |
| Policy escape | Exact-origin and redirect policy tests deny before an action | Structured `POLICY_DENIED` event if used in the evidence manifest |

## Manual browser QA

The final pass exercised the target and operator console at a 1440 x 900 desktop viewport and a 390 x 844 mobile viewport. The operator restored the expired page, captured evidence, clicked the retained live session, typed a redacted value into the focused control, pressed the allowlisted `Tab` key, returned control, and completed the lookup. The Playwright surface session ID remained identical before handoff, during human ownership, and after resumed completion.

- [x] Confirmed the synthetic-data banner remains visible throughout target states.
- [x] Completed known-member lookups and verified Savings outputs `$1,284.37` and `$8,912.04`.
- [x] Confirmed live discovery and replay use different browser session IDs.
- [x] Confirmed every replay summary records `modelCalls: 0`.
- [x] Triggered session expiry and retained one stable surface session through handoff and resume.
- [x] Verified prior automation grants and stale operator claims are rejected by focused tests.
- [x] Used live-session click, focused typing, an allowlisted key, and evidence capture.
- [x] Confirmed typed content and claim tokens are absent from the operator audit log.
- [x] Confirmed resume performs a fresh observation and checkpoint before issuing the new automation grant.
- [x] Inspected desktop and mobile; controls remain reachable and page `scrollWidth` equals the 390 px mobile viewport.
- [x] Confirmed the target's console and page-error listeners are clean; the operator mobile view reported no warnings or errors.
- [x] Confirmed target, Ollama, and operator endpoints remain local or loopback-only.

## Visual fidelity and accessibility ledger

The final desktop render was compared directly with [the accepted concept](design/operator-console-concept.png) and [the implemented handoff](screenshots/operator-handoff-desktop.png).

| Fidelity point | Result |
| --- | --- |
| Shell and hierarchy | Deep navy command bar, true-white canvas, human-ownership state, and teal return action match the concept. |
| Workspace composition | One large live-session panel plus one open intervention rail preserves the intended 70/30 desktop balance. |
| Intervention treatment | Amber warning hierarchy, reason/details, chronological activity, and outlined evidence action match. |
| Real interaction surface | The implementation uses the running synthetic browser screenshot, same-session coordinate mapping, focused typing, evidence capture, and resume rather than a mock. |
| Responsive behavior | At 390 x 844 the intervention leads, the live surface remains pannable inside its panel, controls stay reachable, and the app shell does not overflow. |

Above-the-fold copy matches the frozen UI inventory. Runtime values intentionally replace the sample run ID, current step, stop reason, and event times. The reason uses the documented ASCII hyphen, and activity entries appear only after the corresponding real action.

Accessibility smoke checks passed: native landmarks and controls retain semantic labels, keyboard traversal reaches actions, `:focus-visible` computes to a 3 px solid outline, the target's focused control is visibly outlined, and reduced-motion CSS disables transitions. Chromium is the qualified browser; this is not a claim of formal WCAG conformance.

## Cross-browser posture

Chromium is the sole qualified automation browser for this assignment. The operator console is ordinary responsive HTML and received desktop/mobile Chrome inspection, but that does not qualify the automation runtime on Firefox, WebKit, Safari, or mobile browsers. Adding another engine requires adapter tests for observation parity, iframe behavior, locator ambiguity, coordinate mapping, screenshots, keyboard semantics, and same-session handoff.

## Security and repository hygiene

Before release:

- [x] `npm audit --omit=dev` and full `npm audit` report zero known vulnerabilities.
- [x] Scanned source and evidence for API keys, bearer tokens, cookies, browser state, private URLs, home-directory paths, email addresses, and non-synthetic identifiers.
- [x] Proved with non-pattern canaries that structured evidence omits raw observation text, planner rationale, receipt text, intervention state, and fault observations while classification-redacting declared PII and secret outputs.
- [x] Ran the strict evidence validator and independently reviewed every unique evidence screenshot; the 10 terminal replay images are byte-identical.
- [x] Confirmed `.env`, temporary runs, browser profiles, coverage, traces, videos, and raw provider files are ignored.
- [x] Confirmed every GitHub Action is pinned to a verified immutable commit SHA and workflow permissions are only `contents: read`.
- [x] Confirmed CI uses `npm ci`, installs only Chromium and required system dependencies, and runs `npm run verify`.
- [x] Reviewed the release tree for generated files, large binaries, absolute paths, and accidental provider transcripts.
- [x] Confirmed `private: true` prevents accidental npm publication; no open-source license is asserted for this evaluation repository.

## Evaluator-friendly evidence manifest

Manifest v1.1 records the bundle timestamp, live/scripted mode, model identity and digest, artifact path/hash, stability report path/hash, and each discovery/replay run's identity, summary, events, and complete screenshot-ref inventory. The validator cross-checks run and summary identities, artifact digest/provenance, zero-model replays, JSONL shape, screenshot path/hash/length/MIME/signature, filesystem containment, duplicate or orphan content, and sensitive-text patterns.

The final run-evidence review additionally reconciled:

- target origin class (`loopback synthetic`), planner provider/model, `liveModel`, and model call count from the summaries/events;
- surface session IDs and owner epochs where handoff is involved;
- screenshot evidence references, media types, byte lengths, and SHA-256 digests from manifest-bound run summaries;
- expected result and observed typed status/code;
- redaction review and screenshot review confirmations;
- explicit links from replay to the exact artifact digest and from handoff stages to the same session ID.

The public URL, final Git commit, anonymous-clone result, and GitHub CI result are release attestations recorded in the release checklist and on GitHub. They are deliberately not fields in the immutable run manifest: the run predates release, and embedding a commit's own hash into that commit would create a false self-reference.

Recommended release layout:

```text
evidence/
  README.md
  manifest.json
  stability.json
  artifacts/
    member.balance.lookup.v1.json
  runs/
    discovery-live-*/
      artifact.json
      summary.json
      events.redacted.jsonl
      screenshots/
    replay-success-*/
      summary.json
      events.redacted.jsonl
      screenshots/
    replay-exception-*/
      summary.json
      events.redacted.jsonl
      screenshots/
```

The current machine-validated manifest covers discovery plus successful and exceptional replay. Same-session handoff evidence is reviewed separately through the operator audit/session IDs and manual screenshots; it must not be described as manifest-validated unless that schema is expanded.

## Stop-ship gates

Do not release or describe the assignment as complete if any of these is true:

- `npm run verify` fails from a clean checkout.
- Native Ollama did not complete a bounded discovery against the live synthetic UI, or its evidence could be confused with scripted discovery.
- Replay does not consume the exact live-discovered digest in a fresh session with `modelCalls: 0`.
- Success lacks a typed output or compound checkpoint.
- The exception taxonomy collapses a business outcome or intervention into generic success/failure.
- Handoff replaces the session, permits simultaneous ownership, accepts a stale epoch, or resumes without a fresh observation.
- A secret, token, cookie, raw provider transcript, local absolute path, or non-synthetic PII appears in tracked files or evidence.
- A screenshot has not been manually reviewed for sensitive content.
- Any action workflow is tag-pinned instead of SHA-pinned, or CI has write permissions.
- Anonymous clean-clone setup or the public CI run has not been verified. A local pass alone is not release evidence.
