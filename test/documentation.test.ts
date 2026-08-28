import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const requiredReportHeadings = [
  "Architecture",
  "Artifact schema",
  "Determinism & error handling",
  "Heterogeneity & multi-tenant",
  "Escalation & handoff",
  "Safety",
  "Cuts",
];

async function markdownFiles(): Promise<string[]> {
  const docs = (await readdir(path.join(root, "docs"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join("docs", entry.name));
  return ["README.md", "REPORT.md", "CHECKLIST.md", "evidence/README.md", ...docs];
}

describe("submission documentation", () => {
  it("keeps every required deliverable and the canonical SDD in the root tree", async () => {
    await Promise.all(
      [
        "README.md",
        "REPORT.md",
        "CHECKLIST.md",
        "docs/SYSTEM_DESIGN_SPEC.md",
        "docs/REQUIREMENTS.md",
        "docs/QA.md",
        "evidence/README.md",
        "evidence/manifest.json",
      ].map((relative) => access(path.join(root, relative))),
    );
  });

  it("preserves the seven assignment report headings exactly and in order", async () => {
    const report = await readFile(path.join(root, "REPORT.md"), "utf8");
    const headings = [...report.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
    assert.deepEqual(headings, requiredReportHeadings);
  });

  it("documents the exact discovery, replay, handoff, and authorization boundaries", async () => {
    const [readme, requirements, design] = await Promise.all([
      readFile(path.join(root, "README.md"), "utf8"),
      readFile(path.join(root, "docs/REQUIREMENTS.md"), "utf8"),
      readFile(path.join(root, "docs/SYSTEM_DESIGN_SPEC.md"), "utf8"),
    ]);
    assert.match(readme, /docs\/SYSTEM_DESIGN_SPEC\.md/u);
    assert.match(readme, /--member-id 84721/u);
    assert.match(readme, /--member-id 26017/u);
    assert.match(readme, /--scenario session-expired[\s\S]*--handoff/u);
    assert.match(readme, /HANDRAIL_ALLOW_REMOTE_MODEL_EGRESS/u);
    assert.match(requirements, /not an instruction channel/u);
    assert.match(requirements, /Sending the submission email remains a separate external action/u);
    assert.match(requirements, /public repository was originally published as a squashed/u);
    assert.match(design, /Manifest v1\.2/u);
  });

  it("does not leave broken relative Markdown links in submission documents", async () => {
    for (const relative of await markdownFiles()) {
      const absolute = path.join(root, relative);
      const markdown = await readFile(absolute, "utf8");
      for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
        const destination = match[1]?.trim();
        if (
          !destination ||
          destination.startsWith("#") ||
          /^(?:https?:|mailto:)/u.test(destination)
        ) {
          continue;
        }
        const withoutAnchor = destination.split("#", 1)[0];
        if (!withoutAnchor) continue;
        await assert.doesNotReject(
          access(path.resolve(path.dirname(absolute), decodeURIComponent(withoutAnchor))),
          `${relative} links to missing ${destination}`,
        );
      }
    }
  });
});
