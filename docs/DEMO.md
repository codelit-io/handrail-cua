# Handrail demo guide

This guide presents the assignment without blurring deterministic fixtures into live-model evidence. Use the offline path for a fast, reproducible tour; use native Ollama for the qualifying discovery run.

## Five-minute offline tour

```bash
npm ci
npx playwright install chromium
npm run demo:offline
```

What this demonstrates:

1. A local synthetic legacy member-services target is started.
2. `ScriptedPlanner` reads fresh observations and follows the same bounded action contract used by live discovery.
3. Verified actions compile into a typed, digest-bound capability.
4. A fresh Chromium session replays the artifact, extracts the Savings current balance, and reports zero model calls.
5. Sanitized summaries and evidence are written through the same evidence layer used by the live path.

What it does **not** demonstrate: an LLM choosing actions. The scripted planner is a deterministic fixture with `live: false`; its provenance must never be presented as live discovery. The discovery summary's `modelCalls` field counts planner decisions and can therefore be non-zero in this offline run. Provider `handrail-fixture` and `liveModel: false` are the decisive labels.

## Qualifying live Ollama run

The live planner uses Ollama's native structured-output endpoint. It receives the goal, contract availability/classification metadata, allowed action kinds, and a bounded redacted semantic observation containing current element references. Raw classified input/output values are kept local. The browser still captures screenshots for evidence and human review, but the default `qwen3:4b` flow does not send screenshots to the model.

In terminal A, start Ollama and leave it running:

```bash
ollama serve
```

In terminal B, pull the model:

```bash
ollama pull qwen3:4b
```

Run discovery, inspect the compiled artifact at the printed output path, then replay that exact file:

```bash
HANDRAIL_OLLAMA_BASE_URL=http://127.0.0.1:11434 \
HANDRAIL_MODEL=qwen3:4b \
HANDRAIL_HEADLESS=false \
npm run discover -- \
  --planner live \
  --goal "Look up the member by member number and return the current balance for the Savings account." \
  --member-id 84721 \
  --run-id assignment-discovery \
  --output work/assignment-discovery

# Review the exact generated artifact before issuing this digest-bound approval.
npm run approve -- \
  --artifact work/assignment-discovery/artifact.json \
  --reviewer evaluator-01 \
  --confirm-reviewed \
  --output work/assignment-approval

npm run replay -- \
  --artifact work/assignment-discovery/artifact.json \
  --artifact-approval work/assignment-approval/artifact-approval.json \
  --member-id 26017 \
  --run-id assignment-replay \
  --output work/assignment-replay
```

Omitting `--target` starts the synthetic target automatically. To exercise the independent target input, run `npm run serve -- --target-only --port 4312` in another terminal and add `--target http://127.0.0.1:4312/legacy --screenshots-safe` to discovery. The `--screenshots-safe` assertion is valid only for this known synthetic target.

The evaluator path writes a complete live bundle, one exceptional replay, and ten successful stability replays to a new ignored work directory:

```bash
HANDRAIL_OLLAMA_BASE_URL=http://127.0.0.1:11434 \
HANDRAIL_MODEL=qwen3:4b \
HANDRAIL_HEADLESS=false \
npm run demo:live -- \
  --run-id assignment-live \
  --replays 10 \
  --artifact-approval work/assignment-live-approval/artifact-approval.json \
  --source-revision "$(git rev-parse HEAD)" \
  --output work/assignment-live-evidence
```

The approval path must not exist when the live command starts and must be outside the bundle directory. After discovery, the command writes the exact artifact and prints `awaiting_approval`. Leave it running, inspect the artifact in another terminal, and then issue the independent approval:

```bash
npm run approve -- \
  --artifact work/assignment-live-evidence/artifacts/member.balance.lookup.v1.json \
  --reviewer independent-reviewer \
  --confirm-reviewed \
  --output work/assignment-live-approval
```

Only after the waiting process validates the new approval's ID, revision, digest, reviewer, and chronology does it start strict replay and stability runs. The default wait is 15 minutes and can be bounded with `--approval-timeout-ms`. The writer is immutable and will not replace the checked-in `evidence/` bundle or an existing work run. The live command also resolves the native Ollama model digest before and after discovery; any mid-run identity or digest change fails the bundle.

`--include-screenshot` is optional and only appropriate when the configured model is vision-capable. It is not part of the default `qwen3:4b` evaluator path.

The live run qualifies only when its retained summary and artifact provenance agree on:

- provider `ollama-local`;
- transport `native-ollama` and the selected model's Ollama digest;
- the actual Ollama model name;
- `liveModel: true`;
- at least one model call;
- a verified terminal checkpoint and compiled artifact digest;
- structural audit projections with no raw page text, planner rationale, provider transcript, or hidden reasoning in evidence.

For an external `--target`, set `--screenshots-safe` only after the surface adapter has independently verified pixel masking. This flag does not rewrite target provenance: committed assignment evidence requires `targetSource: bundled-fixture`. The bundled target sets the pixel assertion because every visible record is a conspicuously labeled synthetic fixture.

The public replay command requires a current approval bound to that exact artifact ID, revision, and digest before it creates a browser session. Replay qualifies only when it references that exact artifact digest, uses a fresh surface session, returns the expected typed result, and reports `modelCalls: 0`.

## Presentation script

1. Open the synthetic target and point out the synthetic-data banner, legacy styling, iframe boundary, member-number field, and initially empty results state.
2. Show one live discovery event. Explain that the model can select only a current observation ID, enumerated element reference, and allowed action kind; policy and freshness checks remain deterministic.
3. Show the artifact rather than a transcript. Highlight the typed `memberId` input reference, `savingsBalance` output validator, target locator lattice, bounded retries, compound success predicate, canonical digest, and live provenance.
4. Run replay. Point out the fresh session, deterministic target resolution, typed extraction, final checkpoint, and `modelCalls: 0`.
5. Show `MEMBER_NOT_FOUND` as a business outcome rather than a crash. Mention that malformed input fails before a surface session is created and ambiguity/policy escape fail closed.
6. Trigger session expiry. Follow the intervention URL and compare the displayed session ID with the runtime's retained session ID.
7. Claim human control, restore the session through the live screenshot, capture evidence, and return control. Show the epoch change, redacted audit actions, fresh resume observation, checkpoint signal, and new automation grant.
8. Finish with the evidence manifest and `npm run verify`, while stating which results are automated, offline, live Ollama, manual, and release-level.

## Same-session handoff behavior

Run the integrated expiry-to-resume path:

```bash
npm run replay -- \
  --artifact work/assignment-live-evidence/artifacts/member.balance.lookup.v1.json \
  --artifact-approval work/assignment-live-evidence/artifacts/member.balance.lookup.v1.approval.json \
  --member-id 84721 \
  --scenario session-expired \
  --handoff \
  --headed \
  --run-id evaluator-handoff \
  --output work/evaluator-handoff
```

Open the printed `intervention` URL. Claim control, capture the expired state, select **Restore Session** inside the live screenshot, capture the restored state, and choose **Return to automation**. Do not remove the URL fragment before the initial page loads: it contains a bearer capability and is cleared from the visible URL after the browser exchanges it for a path-scoped cookie. The capability remains reusable for the intervention lifetime, so treat the link and the bootstrapped browser session as sensitive.

When an intervention is opened, the console:

- revokes the current automation grant at an action boundary;
- requires a random per-intervention capability before exposing state or screenshots;
- displays a screenshot captured from the existing `SurfaceSession`;
- issues one opaque, epoch-bound operator claim;
- accepts click, focused typing, allowlisted keypress, and capture requests only from that claim;
- rejects duplicate/stale ownership with `CONTROL_LOST`;
- records redacted audit actions without typed values or claim tokens;
- resumes only after a fresh observation and orchestration-supplied checkpoint evaluation.

The console is loopback-only and capability-gated for this local demo. The server retains only a SHA-256 digest of the fragment capability; the browser exchanges the bearer value for a path-scoped, `HttpOnly`, `SameSite=Strict` cookie. This is not workforce identity or a remote support product, and the console never launches or substitutes a browser session. The evaluator CLI persists redacted authorization-intent and completion events plus captures into the run; a configured sink failure stops the lease and blocks resume.

To include the completed handoff in a generated manifest v1.2 bundle, attach the run and validate the combined bundle:

```bash
npm run evidence:attach-handoff -- \
  --bundle work/assignment-live-evidence \
  --run work/evaluator-handoff

npm run evidence:validate -- --root work/assignment-live-evidence
```

The validator requires the replay result to remain bound to the approved artifact and proves the original/resumed session identity, monotonic automation/operator epochs, pre-dispatch authorization events, completion events, and one-to-one screenshot capture references.

The attachment helper uses an exclusive bundle lock, manifest compare-and-swap check, unique staging paths, and rollback for handled failures, so cooperating writers cannot silently interleave. This is handled-error atomicity, not process-crash atomicity: a forced process kill at the publication boundary can leave a stale lock or orphaned run directory. Treat that generated work bundle as invalid and regenerate into a new ignored output directory; never claim or publish it as a completed transaction.

Target overrides are not a discovery shortcut. Discovery rejects every binding that contains one; replay accepts a replacement only when a current review record binds the SHA-256 digests of both the artifact target and the override target.

## Failure-injection tour

The local target and tests cover these deterministic states:

| State | Expected runtime classification |
| --- | --- |
| Known synthetic member | `succeeded` with typed `savingsBalance` |
| Unknown member | `business_outcome / MEMBER_NOT_FOUND` |
| Malformed member input | `failed / INPUT_INVALID` before surface creation |
| Known transient load | bounded configured recovery, then success or intervention |
| Session expiry | `needs_intervention` with the current session retained |
| Restricted member | `failed / PERMISSION_DENIED` |
| Duplicate eligible target | `failed / TARGET_AMBIGUOUS` |
| Off-origin redirect/action | `failed / POLICY_DENIED` before the side effect |

Use the automated suite for reproducible fault injection. Do not improvise arbitrary production URLs, credentials, JavaScript, or browser storage in the demo.

## Evidence review

Before sharing a run:

1. Confirm the target origin is loopback and all displayed records are synthetic.
2. Run `npm run evidence:validate`.
3. Inspect every screenshot manually.
4. Confirm events contain no typed secret, claim token, cookie, storage state, authorization header, raw provider response, or local absolute path.
5. Match source/target/runtime provenance, artifact and replay digests, session IDs, owner epochs, result status, and file hashes to `evidence/manifest.json`.

See [QA.md](QA.md) for the full release checklist and stop-ship gates.
