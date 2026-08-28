import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { EvidenceWriter } from "../src/runtime/evidence.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "handrail-evidence-writer-test-"));
  temporaryDirectories.push(root);
  return root;
}

function event(runId: string, summary: string) {
  return { kind: "action.receipt", runId, summary } as const;
}

describe("EvidenceWriter event-log integrity", () => {
  it("serializes normal multi-event appends and returns a stable log reference", async () => {
    const root = await fixtureRoot();
    const writer = new EvidenceWriter({ rootDirectory: root });

    const first = await writer.appendEvent(event("run-normal", "first"));
    const second = await writer.appendEvent(event("run-normal", "second"));
    const reference = await writer.eventLogRef();
    const bytes = await readFile(path.join(root, "events.redacted.jsonl"));
    const records = bytes
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sequence: number });

    assert.equal(first.byteOffset, 0);
    assert.equal(second.byteOffset, first.byteLength);
    assert.deepEqual(
      records.map((record) => record.sequence),
      [0, 1],
    );
    assert.equal(reference.byteLength, bytes.byteLength);
  });

  it("rejects preexisting regular and hard-linked logs without changing their bytes", async () => {
    const root = await fixtureRoot();
    const regularRoot = path.join(root, "regular");
    await mkdir(regularRoot);
    const regularPath = path.join(regularRoot, "events.redacted.jsonl");
    const regularBefore = Buffer.from("preexisting regular log\n");
    await writeFile(regularPath, regularBefore);

    const regularWriter = new EvidenceWriter({ rootDirectory: regularRoot });
    await assert.rejects(
      regularWriter.appendEvent(event("run-preexisting", "must not append")),
      /must not exist before the first append/u,
    );
    assert.deepEqual(await readFile(regularPath), regularBefore);

    const linkedRoot = path.join(root, "hard-linked");
    await mkdir(linkedRoot);
    const outsidePath = path.join(root, "outside.log");
    const outsideBefore = Buffer.from("outside bytes must stay unchanged\n");
    await writeFile(outsidePath, outsideBefore);
    await link(outsidePath, path.join(linkedRoot, "events.redacted.jsonl"));

    const linkedWriter = new EvidenceWriter({ rootDirectory: linkedRoot });
    await assert.rejects(
      linkedWriter.appendEvent(event("run-hard-link", "must not append")),
      /must not exist before the first append/u,
    );
    assert.deepEqual(await readFile(outsidePath), outsideBefore);
  });

  it("rejects a hard link added after creation on append and reference reads", async () => {
    const root = await fixtureRoot();
    const writer = new EvidenceWriter({ rootDirectory: root });
    const eventPath = path.join(root, "events.redacted.jsonl");
    await writer.appendEvent(event("run-link-after-create", "first"));
    const outsidePath = path.join(root, "outside-link.log");
    await link(eventPath, outsidePath);
    const outsideBefore = await readFile(outsidePath);

    await assert.rejects(
      writer.appendEvent(event("run-link-after-create", "must not append")),
      /single-link file/u,
    );
    await assert.rejects(writer.eventLogRef(), /single-link file/u);
    assert.deepEqual(await readFile(outsidePath), outsideBefore);
  });

  it("rejects out-of-band size changes and same-size inode replacement", async () => {
    const root = await fixtureRoot();
    const sizeRoot = path.join(root, "size");
    const identityRoot = path.join(root, "identity");

    const sizeWriter = new EvidenceWriter({ rootDirectory: sizeRoot });
    const sizePath = path.join(sizeRoot, "events.redacted.jsonl");
    await sizeWriter.appendEvent(event("run-size", "first"));
    await writeFile(sizePath, "external append\n", { flag: "a" });
    const tamperedBytes = await readFile(sizePath);
    await assert.rejects(
      sizeWriter.appendEvent(event("run-size", "must not append")),
      /size changed outside the writer/u,
    );
    await assert.rejects(sizeWriter.eventLogRef(), /size changed outside the writer/u);
    assert.deepEqual(await readFile(sizePath), tamperedBytes);

    const identityWriter = new EvidenceWriter({ rootDirectory: identityRoot });
    const identityPath = path.join(identityRoot, "events.redacted.jsonl");
    await identityWriter.appendEvent(event("run-identity", "first"));
    const originalBytes = await readFile(identityPath);
    const replacementPath = path.join(identityRoot, "replacement.log");
    await writeFile(replacementPath, originalBytes);
    await rename(replacementPath, identityPath);
    await assert.rejects(
      identityWriter.appendEvent(event("run-identity", "must not append")),
      /identity changed after creation/u,
    );
    await assert.rejects(identityWriter.eventLogRef(), /identity changed after creation/u);
    assert.deepEqual(await readFile(identityPath), originalBytes);
  });
});
