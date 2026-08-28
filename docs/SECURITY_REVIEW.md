# Security Review Snapshot

This document records the immutable pre-remediation review of the Handrail v0.2 candidate and the evidence used to close every resulting release gate. The snapshot preserves what was originally assessed; the status tables record the reviewed remediations and final public verification.

The assessed working tree was based on revision `cc43457f53c7785a7316300f0012fa9838a2b54c` and sealed as snapshot `codex-security-snapshot/v1:sha256:faf05824fcff564768c19bcc5975fcbfa7e15bb6e79856168075ba65719cfcc6`. Review ID `be401ed4-407d-47f5-9635-0aad432d33b4` is retained so later verification can be compared with the exact pre-remediation state.

## Review status

| Field | Status |
| --- | --- |
| Review scope | Entire repository working-tree snapshot |
| Coverage | Complete for the repository snapshot; ignored work output and generated evidence bytes were treated as release inputs rather than executable source |
| Review result | Five validated findings: four medium, one low |
| Remediation | **CLOSED in source** |
| Post-remediation verification | **PASSED: focused regression suites, full non-evidence suite, typecheck, lint, and independent source review** |
| Release decision | **APPROVED FOR SUBMISSION: source findings closed and public release gates passed** |

The review combined source tracing with focused, isolated reproductions. It did not test an external service or production deployment. The detailed design and acceptance context remain in the [system design specification](SYSTEM_DESIGN_SPEC.md), [requirements trace](REQUIREMENTS.md), [architecture](ARCHITECTURE.md), [QA plan](QA.md), and [release checklist](../CHECKLIST.md).

## Validated findings

All five findings are high confidence in the pre-remediation snapshot. Status fields below are intentionally updateable; they must not be changed to `CLOSED` until the required code review, regression evidence, and full release verification exist.

### SR-01: Handoff attachment can follow a symlinked `runs` directory

| Field | Value |
| --- | --- |
| Severity | Medium |
| Remediation status | **CLOSED** |
| Closure evidence | `test/attach-handoff-evidence.test.ts`: symlinked parent, parent replacement, rollback, concurrency, and positive publication pass |
| Affected area | `scripts/attach-handoff-evidence.ts` |

The attachment helper validates the top-level bundle and source run, but the pre-remediation implementation does not establish that `bundle/runs` is a real directory contained by the bundle before staging and publishing a handoff. An isolated valid-fixture reproduction published the run through a symlink to a location outside the bundle and then updated the bundle manifest.

Required closure:

- Require the canonical `runs` directory to be a non-symlink whose real path is exactly beneath the canonical bundle root.
- Revalidate parent identity immediately before publication, including device and inode where available.
- Add negative tests proving a symlinked parent and an identity swap fail before any outside write or manifest change.
- Retain a positive attachment test for a normal bundle and complete bundle validation after attachment.

Closure: the helper now captures canonical bundle/`runs` device and inode identity, derives all publication paths from that real directory, and rechecks it before copy, run publication, and manifest commit. Seven focused attachment tests pass, including an outside-directory unchanged assertion.

### SR-02: Artifact-controlled regular expressions can block the event loop

| Field | Value |
| --- | --- |
| Severity | Medium |
| Remediation status | **CLOSED** |
| Closure evidence | `test/artifact.test.ts` and `test/discovery.test.ts`: unsafe operators and unbounded patterns fail before surface creation; fixed-width demo patterns pass |
| Affected areas | `src/domain/schema.ts`, `src/runtime/artifact.ts`, `src/surface/browser-surface.ts` |

The capability format accepts syntactically valid regular expressions and evaluates them with synchronous native JavaScript matching. A short nested-quantifier pattern blocked the single Node.js event loop for about 1.2 seconds on a 25-character non-match; replay timers cannot interrupt synchronous matching.

Required closure:

- Remove artifact-controlled native regular expressions or replace them with an intentionally constrained, linear-time matching subset.
- Bound every value and page-text input before pattern evaluation.
- Add rejection tests for nested quantifiers, lookarounds, backreferences, ambiguous alternation, and unbounded constructs.
- Add an adversarial rejection test proving unsafe operators never reach native evaluation, and preserve normal exact/contains behavior.

Closure: `src/runtime/constrained-pattern.ts` implements only fully anchored ASCII literals/classes with fixed counts and a mandatory maximum input length. Artifact lint, binding, and discovery all use it; browser text predicates reject regex mode. The former eight-character nested-quantifier input is rejected without native evaluation.

### SR-03: Exported replay defaults to approval-free mode

| Field | Value |
| --- | --- |
| Severity | Medium |
| Remediation status | **CLOSED** |
| Closure evidence | `test/replay.test.ts`: omitted mode and approval fail before surface creation; the wrapper is also strict; explicit fixture mode remains covered |
| Affected area | `src/runtime/replay.ts` |

The public CLI explicitly requests strict artifact approval, but the exported `ReplayEngine` and `replayCapability` APIs choose `non_strict` when a caller omits `artifactApprovalMode`. A focused fake-surface reproduction created a session and completed replay with a valid but unapproved artifact.

Required closure:

- Make strict approval the exported default and require deliberate `non_strict` selection only at trusted internal fixture or discovery composition points.
- Prove that an omitted mode or omitted approval fails before surface creation.
- Preserve an explicit internal non-strict fixture path without weakening public replay or live demo construction.
- Re-run artifact, replay, CLI, and end-to-end approval tests.

Closure: `ReplayEngine` now defaults to `strict`, and every intended internal fixture path spells out `non_strict`. Public CLI/live callers remain explicitly strict. Replay, CLI, and real-browser end-to-end suites pass.

### SR-04: Coordinate discovery can click a different element than the one authorized

| Field | Value |
| --- | --- |
| Severity | Medium |
| Remediation status | **CLOSED** |
| Closure evidence | `test/discovery.test.ts`: coordinate activation is absent from every offered action set and an injected coordinate decision fails before dispatch |
| Affected areas | `src/runtime/discovery.ts`, `src/surface/browser-surface.ts` |

When coordinate discovery is explicitly enabled, policy and effect classification apply to the element observed under a point, but dispatch later retains only the original coordinates. A dynamic same-origin page can move or overlay another control before the raw click, separating the authorized element from the element that receives the action. The submitted demo does not enable this optional path, but the exported feature crosses a real authorization boundary.

Required closure:

- Remove `activate_coordinate` from model discovery, or use geometry only to resolve a retained semantic element reference and dispatch through the normal handle-bound activation path.
- Add a dynamic-overlay test proving that a changed hit target produces a stale rejection and fires no click handler.
- Prove the planner schema no longer advertises a raw coordinate action.
- Preserve semantic activation and deterministic replay behavior.

Closure: `DiscoveryRequest` no longer exposes a coordinate opt-in, its action type excludes `activate_coordinate`, and freshness validation rejects any injected coordinate decision. Human-console coordinate clicks remain separately capability-, lease-, URL-, and commit-policy authorized.

### SR-05: Event logs can append to preexisting or hard-linked files

| Field | Value |
| --- | --- |
| Severity | Low |
| Remediation status | **CLOSED** |
| Closure evidence | `test/evidence-writer-security.test.ts`: exclusive creation, hard links, post-creation links, size tampering, inode replacement, and normal ordered appends pass |
| Affected area | `src/runtime/evidence.ts` |

`O_NOFOLLOW` protects against a final-path symlink, but the pre-remediation event writer opens an existing regular file with append semantics and does not bind later appends to a single-link inode. Isolated filesystem checks confirmed append behavior for both a precreated log and a hard-linked outside inode.

Required closure:

- Exclusively create the event log on first use and reject every preexisting path.
- Record expected device, inode, size, and link count, then revalidate them for every append and final evidence reference.
- Add negative tests that leave preexisting and outside hard-linked files byte-identical.
- Retain ordered multi-event append and final event-log reference tests.

Closure: first append is exclusive; later append/reference operations require the same regular, single-link device/inode at the exact expected size before and after I/O. Four focused integrity tests pass and prove external bytes remain unchanged.

## Boundary decisions that were not findings

Two concerns were investigated and rejected as security findings because they match explicit prototype boundaries. They remain important release documentation and production migration requirements.

### Local catalog approval is a deliberate stand-in

The submitted prototype treats the local trusted-host catalog decision as authoritative and represents it with an approval file. The live workflow still requires a separate post-discovery approval bound to the exact artifact ID, revision, digest, and creation time before strict replay. The absence of a production authenticated and signed catalog is therefore a documented architecture cut, not by itself an approval bypass.

SR-03 is different: it is reportable because a reusable exported API silently omits that declared approval boundary unless its caller remembers to select strict mode.

### Remote semantic model egress is explicit and governed

Local Ollama is the default. A non-loopback model endpoint requires HTTPS and an explicit remote-egress opt-in; screenshot input is independently disabled by default and requires a second opt-in. Treating every configured remote request as unintended exfiltration would contradict the declared data-governance boundary.

When remote egress is enabled, that endpoint becomes an approved data processor and must be reviewed accordingly. The release evidence path remains local, native-Ollama, semantic-only, and model-digest bound.

## Trust boundaries and production cuts

The security model depends on the following real boundaries:

- Untrusted page DOM, frames, scripts, navigation, timing, and layout enter through the Playwright surface. Exact origin and route policy, one-page containment, fresh observation references, and handle-bound dispatch are runtime controls.
- Model output is untrusted. The planner receives a bounded semantic projection, and discovery owns action freshness, allowed-action checks, policy authorization, and dispatch.
- Artifact, binding, approval, and input files cross into executable replay authority. Canonical digest validation, strict approval, typed contracts, reviewed overrides, and three-layer policy intersection must fail before browser activity.
- Automation and operator control cross an exclusive in-process lease boundary. The old automation grant must be invalid, operator actions must be serialized and policy checked, and return must preserve the same browser session under a newer epoch and fresh checkpoint.
- Events, summaries, approvals, and screenshots cross into a caller-selected local evidence root. Containment, no-follow access, immutable publication, append identity, redaction, exact inventory, and source/run hashes must remain independently verifiable.

The submitted runtime intentionally does not provide a distributed lease or queue service, remote workforce authentication, cross-process approval nonce consumption, an authenticated production artifact catalog, a production secret broker, a remote operator gateway, or a durable shared evidence service. Browser support is Chromium-only. Operator audit and capture are durable only when evaluator call sites configure their sinks; a generic embedding can otherwise retain audit in memory. These cuts are acceptable for the synthetic single-host evaluation only when the documentation and evidence do not imply the stronger production controls.

## Release gates

No finding or gate below is complete merely because a patch exists. The release owner should update each status only after inspecting the named evidence.

| Gate | Required evidence | Status |
| --- | --- | --- |
| Findings remediated | Reviewed source changes and the finding-specific negative and positive regression tests above | **PASSED** |
| Post-remediation source review | Independent bypass review plus lint, typecheck, and the 85-test focused runtime/hardening batch | **PASSED** |
| Immutable source basis | Final hardened source committed with a clean `src/` tree before release evidence generation | **PASSED: `2ae4515747c49b11ae49dfd6fbd44b730113ab49`** |
| Qualifying release bundle | Fresh live manifest v1.2 bound to the committed source, bundled target, native Ollama transport and stable model digest, with semantic-only model input | **PASSED: 51 files, 13 runs, native `qwen3:4b` digest bound** |
| Artifact and replay integrity | Separate current approval bound to the exact artifact plus at least ten fresh-session successful zero-model replays and the declared business outcome | **PASSED: 10/10 success plus `MEMBER_NOT_FOUND`, zero replay model calls** |
| Same-session handoff | Manifest-bound successful handoff with durable authorization and completion events, monotonic epochs, fresh passing checkpoint, and byte-distinct evidence around the recovery action | **PASSED: same session, epochs 1 -> 3 -> 4, 13 audit events, three captures** |
| Automated verification | Formatting, lint, typecheck, full tests, evidence validation, dependency audit, secret scan, and offline evaluator path all pass on the final candidate | **PASSED: 228/228 tests, strict evidence valid, both npm audits zero, offline 10/10** |
| Manual QA | Desktop, mobile, keyboard, accessibility, console, and screenshot review completed against the final candidate | **PASSED: exact-source handoff plus desktop/mobile and 8-unique-image review** |
| Public release verification | Green CI on the reviewed revision, public release record, visibility check, and anonymous-clone install and verification | **PASSED: reviewed refresh merged, final main CI green, credential-free full-history clone verified** |

The initial v0.2 candidate passed [public CI run 33200810272](https://github.com/codelit-io/handrail-cua/actions/runs/33200810272), but exact-tag smoke testing exposed a nondeterministic false positive when an otherwise valid schema-typed SHA happened to contain a Luhn-valid digit run. The release was held. Runtime source revision `2ae4515747c49b11ae49dfd6fbd44b730113ab49` narrows the exemption to exact typed digest paths while retaining scanning for an identical value anywhere untyped. The refreshed live evidence binds that runtime tree, artifact digest `7d630ecefe5e11341b59cba004a66c9e21b531e488c4c382dab6d8ed156a1d58`, 10/10 zero-model replays, the expected zero-model `MEMBER_NOT_FOUND` outcome, and the manually completed same-session handoff. A second validator regression accepts redundant same-state captures only when a byte-distinct pair still brackets the authorized recovery click. The final 228-test suite, strict 51-file/13-run validator, dependency audits, offline smoke, public CI, and full-history anonymous clone all pass. The [v0.2.0 release](https://github.com/codelit-io/handrail-cua/releases/tag/v0.2.0) is the immutable submission record and names the final release commit and CI sources. Follow the [demo and evidence workflow](DEMO.md), [QA plan](QA.md), and [release checklist](../CHECKLIST.md) to reproduce it.
