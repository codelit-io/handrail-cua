import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { type AutomationEvent, AutomationEventSchema } from "../src/domain/schema.js";
import {
  assertNoTextCanaries,
  EvidenceWriter,
  scanTextCanaries,
  summarizeEvent,
} from "../src/runtime/evidence.js";
import {
  classified,
  findSensitivePatterns,
  INTERNAL_REDACTION,
  PII_REDACTION,
  redactText,
  redactValue,
  SECRET_REDACTION,
  stringifyRedacted,
} from "../src/runtime/redaction.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("recursive redaction", () => {
  it("redacts nested secret and PII keys without mutating the source", () => {
    const source = {
      action: "member lookup",
      nested: {
        apiKey: "runtime-canary-value",
        memberId: "SYN-1002",
        profile: [{ email: "synthetic@example.test", safe: true }],
      },
    };
    const result = redactValue(source);
    assert.deepEqual(result, {
      action: "member lookup",
      nested: {
        apiKey: SECRET_REDACTION,
        memberId: PII_REDACTION,
        profile: [{ email: PII_REDACTION, safe: true }],
      },
    });
    assert.equal(source.nested.apiKey, "runtime-canary-value");
  });

  it("honors classification wrappers for scalar and composite values", () => {
    const result = redactValue({
      publicValue: classified("visible", "public"),
      internalValue: classified("diagnostic", "internal"),
      privateProfile: classified({ name: "Synthetic Person" }, "pii"),
      brokerValue: classified({ nested: "never traverse this" }, "secret"),
    });
    assert.deepEqual(result, {
      publicValue: "visible",
      internalValue: "diagnostic",
      privateProfile: PII_REDACTION,
      brokerValue: SECRET_REDACTION,
    });

    assert.deepEqual(
      redactValue(classified("diagnostic", "internal"), { redactInternal: true }),
      INTERNAL_REDACTION,
    );
  });

  it("does not confuse domain value expressions with redaction wrappers", () => {
    const expression = {
      kind: "literal",
      value: "SYNTHETIC_ONLY",
      classification: "public",
      rationale: "fixed synthetic fixture",
    } as const;
    assert.deepEqual(redactValue(expression), expression);

    assert.deepEqual(
      redactValue(
        { secretRefs: { session: { brokerKey: "preauthenticated-session" } } },
        { classifications: { secretRefs: "public" } },
      ),
      { secretRefs: { session: { brokerKey: "preauthenticated-session" } } },
    );
  });

  it("applies dot-path and JSON-pointer lineage classifications", () => {
    const result = redactValue(
      {
        observation: {
          visibleText: "a value not recognizable by pattern",
          nested: { value: "another opaque value" },
        },
      },
      {
        classifications: {
          "observation.visibleText": "pii",
          "/observation/nested/value": "secret",
        },
      },
    );
    assert.deepEqual(result, {
      observation: {
        visibleText: PII_REDACTION,
        nested: { value: SECRET_REDACTION },
      },
    });
  });

  it("never lets a lower wrapper classification declassify stronger lineage", () => {
    const result = redactValue(
      { payload: classified("must remain hidden", "public") },
      { classifications: { payload: "secret" } },
    );
    assert.deepEqual(result, { payload: SECRET_REDACTION });

    assert.equal(
      redactValue({ classification: "unknown", value: "must remain hidden" }),
      SECRET_REDACTION,
    );
    assert.throws(
      () =>
        redactValue("must remain hidden", {
          classifications: { "": "unknown" as "secret" },
        }),
      /unknown classification/u,
    );
  });

  it("redacts sensitive patterns embedded in otherwise public text", () => {
    const providerKey = `sk-${"a".repeat(24)}`;
    const email = ["person", "example.test"].join("@");
    const input = `Authorization: Bearer ${"b".repeat(24)}; key=${providerKey}; email=${email}; password=hunter2`;
    const result = redactText(input);
    assert.equal(result.includes(providerKey), false);
    assert.equal(result.includes(email), false);
    assert.equal(result.includes("hunter2"), false);
    assert.match(result, /\[REDACTED:SECRET\]/u);
    assert.match(result, /\[REDACTED:PII\]/u);

    const quoted = redactText('password="a phrase with spaces"; status=blocked');
    assert.equal(quoted.includes("a phrase with spaces"), false);
    assert.equal(quoted.includes("status=blocked"), true);
  });

  it("redacts secrets used as object keys and never invokes accessors", () => {
    const secretKey = `sk-${"z".repeat(24)}`;
    let getterCalled = false;
    const source: Record<string, unknown> = { [secretKey]: true };
    Object.defineProperty(source, "danger", {
      enumerable: true,
      get() {
        getterCalled = true;
        return "do not read";
      },
    });
    const result = redactValue(source);
    assert.equal(getterCalled, false);
    assert.deepEqual(result, { [SECRET_REDACTION]: true, danger: "[ACCESSOR]" });
  });

  it("is JSON-safe for cycles, errors, dates, bigint, and binary values", () => {
    const cyclic: Record<string, unknown> = { count: 2n };
    cyclic.self = cyclic;
    const result = redactValue({
      cyclic,
      error: new Error(`Bearer ${"q".repeat(20)}`),
      at: new Date("2030-01-01T00:00:00.000Z"),
      bytes: Buffer.from([1, 2, 3]),
    });
    assert.deepEqual(result, {
      cyclic: { count: "2", self: "[CIRCULAR]" },
      error: { name: "Error", message: SECRET_REDACTION },
      at: "2030-01-01T00:00:00.000Z",
      bytes: "[BINARY:3 bytes]",
    });
    assert.doesNotThrow(() => JSON.parse(stringifyRedacted(result)));
  });

  it("reports only pattern names and counts, never matched values", () => {
    const providerKey = `sk-${"x".repeat(24)}`;
    const findings = findSensitivePatterns(`token ${providerKey}`);
    assert.deepEqual(findings, [{ kind: "secret", pattern: "provider-key", count: 1 }]);
    assert.equal(JSON.stringify(findings).includes(providerKey), false);
  });
});

describe("sanitized evidence", () => {
  it("serializes concurrent JSONL appends without retaining raw classified values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "handrail-evidence-"));
    temporaryDirectories.push(root);
    const writer = new EvidenceWriter({
      rootDirectory: root,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        writer.appendEvent({
          kind: "action.receipt",
          runId: "run-001",
          summary: `receipt ${index}`,
          sequence: index,
          password: `opaque-${index}`,
        }),
      ),
    );
    const text = await readFile(path.join(root, "events.redacted.jsonl"), "utf8");
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.length, 12);
    assert.deepEqual(
      records.map((record) => record.sequence),
      Array.from({ length: 12 }, (_, index) => index),
    );
    assert.equal(text.includes("opaque-"), false);
    assert.equal(
      records.every((record) => record.password === SECRET_REDACTION),
      true,
    );
    assert.equal(
      records.every(
        (record) =>
          record.schemaVersion === "1.0.0" &&
          record.runId === "run-001" &&
          record.correlationId === "run-001" &&
          record.actor === "automation" &&
          record.ownerEpoch === 0 &&
          record.type === "action.receipt" &&
          Object.hasOwn(record, "kind") === false,
      ),
      true,
    );
    const ref = await writer.eventLogRef();
    assert.equal(ref.kind, "event_log");
    assert.equal(ref.byteLength, Buffer.byteLength(text));
  });

  it("accepts canonical AutomationEvent records without reshaping their type", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "handrail-schema-event-"));
    temporaryDirectories.push(root);
    const writer = new EvidenceWriter({ rootDirectory: root });
    const event: AutomationEvent = {
      schemaVersion: "1.0.0",
      eventId: "evt_started",
      sequence: 0,
      timestamp: "2030-01-01T00:00:00.000Z",
      runId: "run_schema",
      correlationId: "corr_schema",
      actor: "automation",
      ownerEpoch: 0,
      type: "run.started",
      mode: "replay",
    };
    await writer.appendEvent(event);
    const record = JSON.parse(
      await readFile(path.join(root, "events.redacted.jsonl"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(record.type, "run.started");
    assert.equal(record.eventId, "evt_started");
    assert.equal(Object.hasOwn(record, "kind"), false);
    assert.equal(Object.hasOwn(record, "summary"), false);
  });

  it("projects raw surface, model, intervention, receipt, recovery, and fault text out of events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "handrail-event-projection-"));
    temporaryDirectories.push(root);
    const writer = new EvidenceWriter({ rootDirectory: root });
    const unusualPii = "violet-orbit-person-7Qm";

    await writer.appendEvent({
      kind: "observation.captured",
      runId: "run-projection",
      observationId: "observation-projection",
      route: "/legacy",
      surfaceFingerprint: "a".repeat(64),
      elementCount: 12,
      summary: `Member ${unusualPii} is visible.`,
    });
    await writer.appendEvent({
      kind: "model.decision",
      runId: "run-projection",
      provider: "test-provider",
      modelId: "test-model",
      decision: {
        decisionId: "decision-projection",
        observationId: "observation-projection",
        kind: "finish",
        rationale: `The page contains ${unusualPii}.`,
        summary: `Completed for ${unusualPii}.`,
      },
    });
    await writer.appendEvent({
      kind: "model.decision",
      runId: "run-projection",
      provider: "test-provider",
      modelId: "test-model",
      decision: {
        decisionId: "decision-literal",
        observationId: "observation-projection",
        kind: "set_value",
        elementRef: "field-projection",
        rationale: `Populate ${unusualPii}.`,
        value: { kind: "literal", value: unusualPii, classification: "pii" },
      },
    });
    await writer.appendEvent({
      kind: "intervention.created",
      runId: "run-projection",
      intervention: {
        id: "intervention-projection",
        runId: "run-projection",
        sessionId: "session-projection",
        reason: "SESSION_EXPIRED",
        summary: `Operator help for ${unusualPii}.`,
        observedState: `Dialog beside ${unusualPii}.`,
        allowedActions: ["claim", "resume"],
        evidence: [],
        ownerEpoch: 2,
        createdAt: "2030-01-01T00:00:00.000Z",
      },
    });
    await writer.appendEvent({
      type: "replay.intervention.resumed",
      runId: "run-projection",
      observationId: "observation-resumed",
      checkpointObserved: `Restored ${unusualPii}.`,
      checkpointPassed: true,
    });
    await writer.appendEvent({
      kind: "action.completed",
      runId: "run-projection",
      command: "activate",
      durationMs: 5,
      changedSurface: true,
      summary: `Activated account for ${unusualPii}.`,
    });
    await writer.appendEvent({
      kind: "recovery.attempted",
      runId: "run-projection",
      code: "KNOWN_LOADING_STATE",
      attempt: 1,
      summary: `Loading state contains ${unusualPii}.`,
    });
    await writer.appendEvent({
      kind: "fault.raised",
      runId: "run-projection",
      code: "POSTCONDITION_FAILED",
      summary: `Failed beside ${unusualPii}.`,
      fault: {
        code: "POSTCONDITION_FAILED",
        message: `Failure for ${unusualPii}.`,
        phase: "replay",
        retryable: false,
        expected: `Expected ${unusualPii}.`,
        observed: `Observed ${unusualPii}.`,
        evidence: [],
      },
    });
    const predicateEvent = AutomationEventSchema.parse({
      schemaVersion: "1.0.0",
      eventId: "event_predicate_projection",
      sequence: 8,
      timestamp: "2030-01-01T00:00:08.000Z",
      runId: "run-projection",
      correlationId: "correlation-projection",
      actor: "automation",
      ownerEpoch: 2,
      type: "predicate.evaluated",
      predicate: {
        kind: "target_value_equals",
        target: "field-projection",
        expected: {
          kind: "literal",
          value: unusualPii,
          classification: "pii",
          rationale: `Compare ${unusualPii}.`,
        },
      },
      passed: false,
      observedSummary: `Observed ${unusualPii}.`,
    });
    await writer.appendEvent(predicateEvent);
    const controlEvent = AutomationEventSchema.parse({
      schemaVersion: "1.0.0",
      eventId: "event_control_projection",
      sequence: 9,
      timestamp: "2030-01-01T00:00:09.000Z",
      runId: "run-projection",
      correlationId: "correlation-projection",
      actor: "system",
      ownerEpoch: 2,
      type: "control.transferred",
      from: "automation",
      to: "operator",
      reason: `Transfer for ${unusualPii}.`,
      newOwnerEpoch: 3,
    });
    await writer.appendEvent(controlEvent);

    const text = await readFile(path.join(root, "events.redacted.jsonl"), "utf8");
    assert.equal(text.includes(unusualPii), false);
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(records[1]?.decision, {
      decisionId: "decision-projection",
      observationId: "observation-projection",
      kind: "finish",
      reasonCode: "planner_finish",
    });
    assert.deepEqual((records[2]?.decision as Record<string, unknown> | undefined)?.value, {
      kind: "literal",
      classification: "pii",
    });
    assert.deepEqual(records[3]?.intervention, {
      id: "intervention-projection",
      runId: "run-projection",
      sessionId: "session-projection",
      reason: "SESSION_EXPIRED",
      allowedActions: ["claim", "resume"],
      evidence: [],
      ownerEpoch: 2,
      createdAt: "2030-01-01T00:00:00.000Z",
    });
    assert.equal(records[4]?.checkpointPassed, true);
    assert.equal(Object.hasOwn(records[4] ?? {}, "checkpointObserved"), false);
    assert.equal(records[5]?.command, "activate");
    assert.equal(Object.hasOwn(records[5] ?? {}, "summary"), false);
    assert.equal(records[6]?.attempt, 1);
    assert.equal(Object.hasOwn(records[6] ?? {}, "summary"), false);
    assert.deepEqual(records[7]?.fault, {
      code: "POSTCONDITION_FAILED",
      phase: "replay",
      retryable: false,
      evidence: [],
      diagnostic: {
        expectedCategory: "declared_step_postcondition",
        observedCategory: "postcondition_not_satisfied",
      },
    });
    assert.deepEqual(records[8]?.predicate, {
      kind: "target_value_equals",
      target: "field-projection",
      expected: {
        kind: "literal",
        classification: "pii",
        value: "[PERSISTENCE-OMITTED]",
        rationale: "Literal omitted from persistent evidence.",
      },
    });
    assert.equal(
      records[8]?.observedSummary,
      "Predicate observation omitted from persistent evidence.",
    );
    assert.doesNotThrow(() => AutomationEventSchema.parse(records[8]));
    assert.equal(records[9]?.reason, "Control reason omitted from persistent evidence.");
    assert.doesNotThrow(() => AutomationEventSchema.parse(records[9]));
  });

  it("does not invoke event getters or follow a symlinked append target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "handrail-event-guard-"));
    temporaryDirectories.push(root);
    const writer = new EvidenceWriter({ rootDirectory: root });
    let getterCalled = false;
    const event: Record<string, unknown> = {
      kind: "action.receipt",
      runId: "run-guard",
      summary: "safe summary",
    };
    Object.defineProperty(event, "secret", {
      enumerable: true,
      get() {
        getterCalled = true;
        return "must not be read";
      },
    });
    await writer.appendEvent(event as Parameters<EvidenceWriter["appendEvent"]>[0]);
    assert.equal(getterCalled, false);

    const parent = await mkdtemp(path.join(tmpdir(), "handrail-event-link-"));
    temporaryDirectories.push(parent);
    const linkedRoot = path.join(parent, "run");
    const outside = path.join(parent, "outside.txt");
    await mkdir(linkedRoot);
    await writeFile(outside, "untouched\n", "utf8");
    await symlink(outside, path.join(linkedRoot, "events.redacted.jsonl"));
    const linkedWriter = new EvidenceWriter({ rootDirectory: linkedRoot });
    await assert.rejects(
      linkedWriter.appendEvent({
        kind: "action.receipt",
        runId: "run-link",
        summary: "must not follow",
      }),
    );
    assert.equal(await readFile(outside, "utf8"), "untouched\n");
  });

  it("requires caller-verified screenshot buffers and writes immutable evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "handrail-screenshot-"));
    temporaryDirectories.push(root);
    const writer = new EvidenceWriter({ rootDirectory: root });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const ref = await writer.writeScreenshot("screenshots/paused.png", png, {
      redactionVerified: true,
    });
    assert.equal(ref.kind, "screenshot");
    assert.equal(ref.mimeType, "image/png");
    await assert.rejects(
      writer.writeScreenshot("screenshots/paused.png", png, { redactionVerified: true }),
    );
    await assert.rejects(
      writer.writeScreenshot("screenshots/bad.png", Buffer.from("not an image"), {
        redactionVerified: true,
      }),
    );
  });

  it("finds filesystem text canaries without echoing their values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "handrail-canary-"));
    temporaryDirectories.push(root);
    const value = ["release", "canary", "value"].join("-");
    await writeFile(path.join(root, "safe.txt"), "nothing to see\n", "utf8");
    await writeFile(path.join(root, "leak.jsonl"), `first line\n${value}\n`, "utf8");
    const findings = await scanTextCanaries(root, [{ id: "release-canary", value }]);
    assert.deepEqual(findings, [
      { canaryId: "release-canary", relativePath: "leak.jsonl", line: 2, column: 1 },
    ]);
    assert.equal(JSON.stringify(findings).includes(value), false);
    await assert.rejects(
      assertNoTextCanaries(root, [{ id: "release-canary", value }]),
      (error: unknown) => error instanceof Error && !error.message.includes(value),
    );
  });

  it("creates concise single-line summaries after pattern redaction", () => {
    const providerKey = `sk-${"y".repeat(24)}`;
    const summary = summarizeEvent({
      kind: "policy.denied",
      status: "failed",
      summary: `blocked key ${providerKey}\nwith detail`,
    });
    assert.equal(summary.includes(providerKey), false);
    assert.equal(summary.includes("\n"), false);
    assert.ok(summary.length <= 240);
  });
});
