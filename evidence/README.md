# Handrail evidence bundle

This is the evaluator index for the sanitized v0.2.0 release evidence. The bundle was generated against the repository's conspicuously synthetic legacy member-services target. It contains no real customer system, account, credential, browser storage, model transcript, or remote production interaction.

## Acceptance snapshot

| Property | Validated value |
| --- | --- |
| Contract | manifest v1.2.0, live mode, 51 files, 13 runs |
| Runtime source | `2ae4515747c49b11ae49dfd6fbd44b730113ab49` |
| Target | internally started `bundled-fixture`; screenshot model input disabled |
| Discovery | `release-live-2ae4515-discovery`; 4 native Ollama decisions; 0 recoveries |
| Model | local `qwen3:4b`; transport `native-ollama`; digest `359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7` |
| Artifact | `member.balance.lookup` revision 1; digest `7d630ecefe5e11341b59cba004a66c9e21b531e488c4c382dab6d8ed156a1d58` |
| Approval | separately issued by `independent-process-review` at `2026-08-28T19:08:45.788Z` |
| Stability | 10/10 fresh-session successes; 0 replay model calls |
| Latency | min 2,120 ms; mean 2,157.2 ms; p50 2,140 ms; p95/max 2,217 ms |
| Expected exception | `business_outcome / MEMBER_NOT_FOUND`; 0 model calls |
| Handoff | same session; epochs 1 -> 3 -> 4; 13 operator audit events; 3 captures; fresh passing checkpoint; 0 model calls |
| Images | 19 PNG files, 8 unique pixel hashes; every unique image manually inspected |

The reviewer label documents a separate local approval command after artifact inspection. It is not a claim of a third-party auditor or external attestation.

## Read this evidence in order

1. [Manifest](manifest.json) binds runtime and target provenance, model identity, artifact and approval hashes, stability, every run, and every screenshot reference.
2. [Compiled capability](artifacts/member.balance.lookup.v1.json) is the immutable declarative artifact; [approval](artifacts/member.balance.lookup.v1.approval.json) is a separate digest-bound decision.
3. [Discovery summary](runs/release-live-2ae4515-discovery/summary.json) and [redacted event log](runs/release-live-2ae4515-discovery/events.redacted.jsonl) prove fresh observation/decision/action bindings and artifact compilation.
4. [Stability report](stability.json) binds all ten successful fresh-session replays to the same artifact digest with zero replay model calls. One representative [success summary](runs/release-live-2ae4515-replay-success-01/summary.json) includes its typed result and terminal checkpoint.
5. [Not-found summary](runs/release-live-2ae4515-replay-not-found/summary.json) preserves the declared business outcome rather than collapsing it into success or a generic fault.
6. [Handoff summary](runs/release-handoff-2ae4515-final/summary.json) and [redacted audit log](runs/release-handoff-2ae4515-final/events.redacted.jsonl) prove exclusive same-session operator recovery and return to automation.

The handoff includes two identical expired-state captures because the operator pressed capture twice before recovery, plus one byte-distinct restored-state capture after the authorized click. This is retained rather than edited away. Validation requires every capture to remain uniquely audit-bound and requires a byte-distinct pair on opposite sides of the recovery click.

## Visual QA anchors

- [Initial discovery state](runs/release-live-2ae4515-discovery/screenshots/002-observation-4aa77c2b-48b1-403e-8161-3ef4aa50aab3.png)
- [Successful replay checkpoint](runs/release-live-2ae4515-replay-success-01/screenshots/release-live-2ae4515-replay-success-01-terminal-checkpoint.png)
- [Expected not-found outcome](runs/release-live-2ae4515-replay-not-found/screenshots/release-live-2ae4515-replay-not-found-outcome-MEMBER_NOT_FOUND.png)
- [Expired handoff state](runs/release-handoff-2ae4515-final/screenshots/operator-capture-7a3beab9-a6a3-446d-9c72-98c7908c7377.png)
- [Restored handoff state](runs/release-handoff-2ae4515-final/screenshots/operator-capture-fea1e356-7055-45e7-be37-8ac9f61712da.png)
- [Resumed terminal checkpoint](runs/release-handoff-2ae4515-final/screenshots/release-handoff-2ae4515-final-terminal-checkpoint.png)

Every image displays the synthetic-data banner. Screenshot evidence is safe here only because the target is a local fixture; a production adapter would need masking before capture.

## Reproduce the gate

Use a full-history checkout because the manifest intentionally binds a historical source commit:

```bash
npm ci
npx playwright install chromium
npm run verify
```

`npm run evidence:validate` may be run independently. It rejects missing historical source, mutable or orphaned files, source/target/model/artifact drift, invalid approval chronology, replay model calls, malformed event order, substituted handoff sessions, stale epochs, unbound captures, invalid PNGs, unsupported files, and sensitive structured text. A depth-limited clone must fetch full history before this check can succeed.
