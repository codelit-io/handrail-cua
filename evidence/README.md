# Handrail evidence bundle

This is the evaluator index for sanitized release evidence. Every visible record is synthetic. A release candidate must provide a machine-readable [manifest](manifest.json) using schema v1.2 that binds source, target, runtime, model, artifact approval, discovery, replay, exception, handoff, event-log, and screenshot provenance. `npm run evidence:validate` is the authority for whether the checked-in bundle is release-valid; prose in this file does not override that result.

## Acceptance contract

| Claim | Manifest v1.2 proof |
| --- | --- |
| Genuine discovery | Exactly one live native Ollama discovery with `transport: native-ollama`, the selected model digest, `liveModel: true`, one or more model decisions, fresh semantic observations, semantic-only model input, the internally started bundled fixture, and model/artifact provenance that agrees across the manifest, summary, events, and capability. |
| Reviewable artifact | One typed capability with a valid canonical digest plus a current strict approval record bound to its ID, revision, digest, reviewer, approval timestamp, and optional expiry. Qualifying live generation pauses after discovery and requires that record to be issued through a separate approval command before replay. |
| Deterministic replay | At least ten manifest-matched successful fresh-session runs in [the stability report](stability.json), each bound to the exact artifact and recording zero model calls. |
| Expected exception | At least one exceptional replay that preserves `business_outcome / MEMBER_NOT_FOUND` and records zero model calls. |
| Same-session handoff | At least one successful handoff replay whose result, original/resumed session ID, monotonic ownership epochs, pre-dispatch authorizations, completed operator actions, fresh resume checkpoint, and capture hashes agree across the summary, events, and manifest. |

## Validated v0.2.0 snapshot

- Source revision: `8d3029388b7dc83d71449075dca42f285e143aaf`
- Live planner: native Ollama `qwen3:4b`, digest `359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7`, semantic-only input, four observation-bound decisions
- Capability: `member.balance.lookup` revision 1, digest `4b2635ee63206087a393fd94d916d60322206db3ac350b72a1fcff2849ea3c11`, separately reviewed and approved after discovery
- Deterministic proof: 10/10 successful fresh-session replays, zero replay model calls, mean 2,112.7 ms, p95 2,222 ms
- Exception proof: `business_outcome / MEMBER_NOT_FOUND`, zero model calls
- Handoff proof: one unchanged surface session, ownership epochs 1 -> 3 -> 4, 11 operator audit events, two operator captures, passing fresh resume checkpoint, and zero model calls
- Bundle inventory: manifest v1.2, 50 files, 13 runs, 18 referenced PNGs, and 8 unique images

These values are also machine-derived from [the manifest](manifest.json), [the stability report](stability.json), and the manifest-bound run records. Regenerate the bundle rather than editing them independently.

## Evidence boundary

The manifest inventories every retained run summary, redacted JSONL event log, and PNG screenshot by bounded relative path, SHA-256 hash, byte length, and MIME type. The validator also checks native planner transport/model identity, effective screenshot-input and bundled-target provenance, PNG structure, CRCs, bounded dimensions, decompression, and scanlines, canonical run layout, duplicate/orphan files, contiguous event order, replay duration timestamps, approval-after-discovery ordering, run identity, artifact/result binding, source revision/tree agreement, the recorded generator Node version's schema, the installed Playwright version, and sensitive-text patterns.

The bundle excludes raw prompts, model responses, request bodies, browser storage, cookies, URL-fragment capabilities, ownership claims, credentials, and real PII. Redacted JSONL retains structural observation metadata, decision/action kinds, safe reason codes, and action receipts; it omits page text, planner rationale, typed values, and other free-form surface/model text. Retained browser screenshots are allowed only for the conspicuously labeled synthetic fixture and still require manual pixel review.

The handoff record is part of manifest v1.2 rather than a separate narrative claim. Evaluator entrypoints persist an authorization-intent event before each operator surface action and a completion event afterward. If a configured audit or capture sink fails, the control lease fails and resume is blocked. The URL-fragment capability remains reusable for the intervention lifetime but is retained only as a server-side digest and is never release evidence.

## Reproduce

Validate the committed evidence without Ollama or an API key:

```bash
npm ci
npx playwright install chromium
npm run evidence:validate
```

Generate a new live discovery/replay bundle locally from a committed source tree:

```bash
HANDRAIL_OLLAMA_BASE_URL=http://127.0.0.1:11434 \
HANDRAIL_MODEL=qwen3:4b \
npm run demo:live -- \
  --run-id assignment-live \
  --replays 10 \
  --artifact-approval work/assignment-live-approval/artifact-approval.json \
  --source-revision "$(git rev-parse HEAD)" \
  --output work/assignment-live-evidence
```

When the command reports `awaiting_approval`, review its persisted artifact and run `npm run approve` into the declared external approval directory. A qualifying live run rejects a pre-existing approval path, validates approval chronology, and pins the native Ollama digest before and after model use.

Revision-bound generation rejects a source revision that is not the checked-out commit and rejects uncommitted `src/` changes. Evidence writes are immutable and refuse to replace an existing file. Use a new disposable `--output` path unless intentionally preparing a fresh release bundle.

The same-session run is interactive and is attached after it successfully resumes. Follow [the demo guide](../docs/DEMO.md) for the exact handoff, attachment, and combined validation commands. Do not publish a generated bundle until every unique screenshot has been manually inspected and the combined manifest passes validation.
