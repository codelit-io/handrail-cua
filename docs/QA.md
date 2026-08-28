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

## Release-candidate code verification

The v0.2.0 candidate must be verified from its final committed tree. Exact file, test, run, screenshot, digest, and latency values are recorded from that final run in `CHECKLIST.md`, the evidence manifest, and the GitHub release rather than copied here before the bundle exists. The release command set is:

```text
npm run verify
npm audit --omit=dev
npm audit
npm run demo:offline -- --replays 10 --output <fresh-directory>
credential-free clone -> install -> verify -> offline demo
```

Final candidate record: source revision `8d3029388b7dc83d71449075dca42f285e143aaf` produced the checked-in live manifest v1.2 bundle. It contains 50 files and 13 runs: one four-decision native Ollama discovery, 10/10 successful fresh-session zero-model replays, one zero-model `MEMBER_NOT_FOUND` outcome, and one zero-model same-session handoff. Replay latency was 2,112.7 ms mean and 2,222 ms p95. The 18 referenced PNGs reduce to 8 unique images; every unique image received a manual pixel review.

The checked-in release bundle is separate from the offline smoke. For a v0.2.0 release, manifest v1.2 must bind a genuine native Ollama discovery, strict artifact approval, at least ten fresh-session zero-model replays of the exact compiled digest, an exceptional `business_outcome / MEMBER_NOT_FOUND` replay, and a successfully resumed same-session handoff. `npm run evidence:validate` is the authoritative completion signal.

| Area | Automated coverage | Current boundary |
| --- | --- | --- |
| Artifact | Strict schemas, canonical digest, approval chronology, drift detection, linter, typed binding | Release artifact is checked in and validator-bound to the discovery run and separately issued approval. |
| Discovery | Bounded loop, fresh refs, verified compilation, stale rejection, run-local model counts, exact per-call prompt trace, help, business outcome, transient budget | Native Ollama evidence must record one or more fresh decisions, `liveModel: true`, and a model digest stable before/after model use. |
| Replay | Zero-model source boundary, fresh browser replay, output validation, digest drift, retry, intervention, terminal failure | At least ten manifest-matched replays must consume the live-discovered digest with zero model calls. |
| Policy | Exact origin/route/action/effect intersection, redirect/popup denial, unsupported browser-transport denial, approval binding | No real external tenant is in scope. |
| Redaction/evidence | Nested classification, provider/JWT/AWS/phone/email/Luhn canaries, immutable writes, structural PNG validation, path and symlink defense | Validator and independent text/image review are complete for the release bundle. |
| Handoff | Stable session ID, automation revocation, conservative commit classification, admitted-action settlement, exclusive claim, transient reconnect, stale rejection, redacted human audit, fresh resume grant | Manifest v1.2 must bind the successfully resumed run, same session ID, epochs, authorization/completion audit lifecycle, and capture hashes. |
| Browser target | Real Chromium interaction, single-page invariant, popup/WebRTC/WebTransport blocking, iframe traversal, session restore, ambiguity fixture | Chromium only; Firefox/WebKit are unqualified. |

## Required automated commands

Run from a clean, full-history checkout:

```bash
npm ci
npx playwright install chromium
npm run verify
```

The manifest is bound to historical source revision `8d3029388b7dc83d71449075dca42f285e143aaf`. A normal clone contains that revision. If an evaluator intentionally uses a shallow checkout, run `git fetch --unshallow --tags` before verification; absence of the bound source commit is a deliberate validation failure.

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

The final candidate pass must exercise the target and operator console at a 1440 x 900 desktop viewport and a 390 x 844 mobile viewport. The operator restores the expired page, captures evidence, uses the retained live session, returns control, and completes the lookup. The Playwright surface session ID must remain identical before handoff, during human ownership, and after resumed completion. Checkmarks are applied only after the final candidate is exercised:

- [x] Confirm the synthetic-data banner remains visible throughout target states.
- [x] Complete known-member lookups and verify the declared typed Savings outputs.
- [x] Confirm live discovery and replay use different browser session IDs.
- [x] Confirm every replay summary records `modelCalls: 0`.
- [x] Trigger session expiry and retain one stable surface session through handoff and resume.
- [x] Verify prior automation grants and stale operator claims are rejected by focused tests.
- [x] Use live-session click and evidence capture; cover focused typing and an allowlisted key in manual or automated QA.
- [x] Confirm typed content, capability values, and claim tokens are absent from the operator audit log.
- [x] Confirm resume performs a fresh observation and checkpoint before issuing the new automation grant.
- [x] Inspect desktop and mobile; controls remain reachable and the app shell does not horizontally overflow.
- [x] Confirm target and operator console/page-error listeners are clean.
- [x] Confirm target, Ollama, and operator endpoints remain local or explicitly authorized.

The exact-source desktop handoff was completed manually through the standalone operator console. The accepted 1440 x 900 desktop and 390 x 844 mobile references were re-inspected after the final source run; the intervening source changes affect discovery decision binding and replay time accounting, not operator markup or styling. Real-Chromium E2E additionally re-exercised same-session recovery, keyboard/action authorization, page-error listeners, and responsive control behavior.

## Visual fidelity and accessibility ledger

The final candidate desktop render must be compared directly with [the accepted concept](design/operator-console-concept.png) and [the implemented handoff reference](screenshots/operator-handoff-desktop.png).

| Fidelity point | Acceptance condition |
| --- | --- |
| Shell and hierarchy | Deep navy command bar, true-white canvas, human-ownership state, and teal return action match the concept. |
| Workspace composition | One large live-session panel plus one open intervention rail preserves the intended 70/30 desktop balance. |
| Intervention treatment | Amber warning hierarchy, reason/details, chronological activity, and outlined evidence action match. |
| Real interaction surface | The implementation uses the running synthetic browser screenshot, same-session coordinate mapping, focused typing, evidence capture, and resume rather than a mock. |
| Responsive behavior | At 390 x 844 the intervention leads, the live surface remains pannable inside its panel, controls stay reachable, and the app shell does not overflow. |

Above-the-fold copy must match the frozen UI inventory. Runtime values intentionally replace the sample run ID, current step, stop reason, and event times. The reason uses the documented ASCII hyphen, and activity entries must appear only after the corresponding real action.

The accessibility smoke gate checks that native landmarks and controls retain semantic labels, keyboard traversal reaches actions, `:focus-visible` computes to a 3 px solid outline, the target's focused control is visibly outlined, and reduced-motion CSS disables transitions. Chromium is the qualified browser; passing this smoke gate is not a claim of formal WCAG conformance.

## Cross-browser posture

Chromium is the sole qualified automation browser for this assignment. The operator console is ordinary responsive HTML and received desktop/mobile Chrome inspection, but that does not qualify the automation runtime on Firefox, WebKit, Safari, or mobile browsers. Adding another engine requires adapter tests for observation parity, iframe behavior, locator ambiguity, coordinate mapping, screenshots, keyboard semantics, and same-session handoff.

## Security and repository hygiene

Before the final release, rerun and check each item against the release commit:

- [x] `npm audit --omit=dev` and full `npm audit` report zero known vulnerabilities.
- [x] Scan source and evidence for API keys, capability values, cookies, browser state, private URLs, home-directory paths, email addresses, and non-synthetic identifiers.
- [x] Prove with non-pattern canaries that structured evidence omits raw observation text, planner rationale, receipt text, intervention state, and fault observations while classification-redacting declared PII and secret outputs.
- [x] Run the strict evidence validator and independently review every unique evidence screenshot; record duplicate-image findings from the final bundle rather than assuming a count.
- [x] Confirm `.env`, temporary runs, browser profiles, coverage, traces, videos, and raw provider files are ignored.
- [x] Confirm every GitHub Action is pinned to a verified immutable commit SHA and workflow permissions are only `contents: read`.
- [x] Confirm CI uses `npm ci`, installs only Chromium and required system dependencies, and runs `npm run verify`.
- [x] Review the release tree for generated files, large binaries, absolute paths, and accidental provider transcripts.
- [x] Confirm `private: true` prevents accidental npm publication; no open-source license is asserted for this evaluation repository.

The final local hygiene pass used the evidence contract, targeted tracked-file pattern checks, dependency metadata, workflow review, and repository inventory. It found no credential-shaped value, live capability, user home path, unexpected large file, or provider transcript in the release tree; both npm audit modes reported zero vulnerabilities.

## Evaluator-friendly evidence manifest

Manifest v1.2 records the bundle timestamp, live/scripted mode, planner-transport identity, model identity and digest, source revision/tree, bundled-fixture target source, generator Node and Playwright versions, effective screenshot-input setting, sanitized invocation, artifact and strict approval paths/hashes, stability report path/hash, and each discovery/replay/handoff run's identity, summary, events, and complete screenshot-ref inventory. The validator cross-checks the source revision/tree and target fixture, schema-checks the recorded Node version, matches the installed Playwright version, and verifies run/summary identities, artifact approval and replay binding, zero-model replays, JSONL shape, screenshot path/hash/length/MIME/signature, filesystem containment, duplicate or orphan content, sensitive-text patterns, and the complete handoff lifecycle.

The final run-evidence review additionally reconciled:

- target source (`bundled-fixture`), planner transport/provider/model/digest, `liveModel`, effective screenshot-input setting, and model call count from the summaries/events;
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
    member.balance.lookup.v1.approval.json
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
    replay-handoff-*/
      summary.json
      events.redacted.jsonl
      screenshots/
```

The release manifest must cover discovery plus successful, exceptional, and same-session handoff replay. Handoff is accepted only when the validator reconciles the approved artifact identity, original/resumed session ID, ownership epochs and actors, pre-dispatch authorizations, completion actions, resume event/checkpoint, and one-to-one capture references. Manual screenshot inspection remains an additional pixel-safety gate, not a substitute for manifest validation.

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

## Public release verification

The public repository is [codelit-io/handrail-cua](https://github.com/codelit-io/handrail-cua). Reviewed candidate `131567b61f86c5ffd83ef839c31764e441bb1073` was merged without squashing through [PR #1](https://github.com/codelit-io/handrail-cua/pull/1) as `175dc614d3d89def523f3ffbc1755748540df127`. [GitHub Actions run 33200810272](https://github.com/codelit-io/handrail-cua/actions/runs/33200810272) passed on that public merge, and GitHub reported the repository as `PUBLIC`.

A separate HTTPS clone with GitHub tokens unset and credential lookup disabled resolved public `main` to the same merge. From that clone, `npm ci`, `npx playwright install chromium`, and `npm run verify` passed: 226/226 tests, real-Chromium E2E, and strict validation of the committed 50-file/13-run manifest. A newly generated offline smoke completed 10/10 fresh-session replays with zero replay model calls; its separate exception replay returned `business_outcome / MEMBER_NOT_FOUND` with zero model calls.

Exact-tag QA subsequently exercised both depth-1 and full-history clones. The depth-1 checkout correctly rejected the unavailable evidence source revision. The full-history `v0.2.0` checkout passed 227/227 tests, real-Chromium E2E, strict evidence validation, and a new 10/10 zero-model smoke after a narrow regression fix prevented schema-validated SHA values from being misclassified as payment data. Untyped hash-shaped strings remain scanned. [v0.2.0](https://github.com/codelit-io/handrail-cua/releases/tag/v0.2.0) records the final immutable tag and release verification sources.

[GitHub Actions run 33141788185](https://github.com/codelit-io/handrail-cua/actions/runs/33141788185) and [v0.1.0](https://github.com/codelit-io/handrail-cua/releases/tag/v0.1.0) remain historical evidence for the prior baseline only.
