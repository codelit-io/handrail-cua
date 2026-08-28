# Handrail evidence bundle

This is the evaluator index for the sanitized release evidence. Every visible record is synthetic. The machine-readable [manifest](manifest.json) binds each summary, redacted event log, and screenshot to its path, SHA-256 hash, byte length, and MIME type. `npm run evidence:validate` recomputes the inventory and rejects malformed provenance, path escapes, symlinks, duplicate runs, raw provider files, sensitive-text patterns, missing or orphan screenshots, invalid PNG signatures, artifact drift, or any replay model call.

## Acceptance snapshot

| Claim | Evidence |
| --- | --- |
| Genuine discovery | [Discovery summary](runs/submission-live-qwen3-4b-discovery/summary.json): native Ollama, `qwen3:4b`, `liveModel: true`, four model calls |
| Reviewable artifact | [Capability](artifacts/member.balance.lookup.v1.json): typed contract, three ordered steps, durable targets, declared outcome, compound checkpoint, canonical digest |
| Deterministic replay | [Stability report](stability.json): 10/10 fresh-session successes, 100% success, zero total model calls, 1,967.4 ms mean, 2,028 ms p95 |
| Different input | [First replay summary](runs/submission-live-qwen3-4b-replay-success-01/summary.json): output `8912.04` from the live-discovered artifact |
| Expected exception | [Not-found summary](runs/submission-live-qwen3-4b-replay-not-found/summary.json): `business_outcome / MEMBER_NOT_FOUND`, zero model calls |

Artifact canonical digest:

```text
d06ba78e8be50f9ff23bf0a5bb51ae5c05a043c9cb66bf85b4ac0c38bbc3da64
```

Ollama model digest recorded at discovery:

```text
359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7
```

## Evidence boundary

The four discovery screenshots show observation before input, after typed input, and the verified synthetic result. All 10 success screenshots have the same SHA-256 because deterministic replay reaches the same rendered terminal surface. The exceptional screenshot shows the application-authored `No member found.` state. Each image is 1280 by 800 and was manually reviewed.

The bundle intentionally excludes raw prompts, model responses, request bodies, browser storage, cookies, claim tokens, credentials, and real PII. Redacted JSONL retains structural observation metadata, decision kinds and references, and action receipts; it omits page text, planner rationales, and other free-form surface/model text. The four retained browser screenshots contain only the conspicuously labeled synthetic fixture data and were reviewed separately at the pixel boundary. The same-session handoff is documented in [the QA record](../docs/QA.md) because this manifest covers discovery and replay runs only.

## Reproduce

Validate the committed evidence without Ollama or an API key:

```bash
npm ci
npx playwright install chromium
npm run evidence:validate
```

Generate a new live bundle locally:

```bash
HANDRAIL_OLLAMA_BASE_URL=http://127.0.0.1:11434 \
HANDRAIL_MODEL=qwen3:4b \
npm run demo:live -- \
  --run-id assignment-live \
  --replays 10 \
  --output work/assignment-live-evidence
```

Evidence writes are immutable and refuse to replace an existing file. Use a new disposable `--output` path unless intentionally preparing a fresh release bundle.
