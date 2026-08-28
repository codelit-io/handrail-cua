import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Browser, chromium } from "playwright";
import { type LegacyTargetHandle, startLegacyTarget } from "../src/target/server.js";

describe("legacy target UI", () => {
  let browser: Browser;
  let target: LegacyTargetHandle;

  before(async () => {
    target = await startLegacyTarget();
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await browser.close();
    await target.close();
  });

  it("completes the member lookup through the real iframe UI", async () => {
    const page = await browser.newPage();
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.goto(target.entryUrl());
    const workspace = page.frameLocator('iframe[title="Member servicing workspace"]');
    const memberRow = workspace.locator(".form-grid tr").filter({ hasText: "Member number" });
    await memberRow.getByRole("textbox").fill("84721");
    await workspace.getByRole("button", { name: "Find Member", exact: true }).click();

    const savingsRow = workspace.getByRole("row").filter({ hasText: "Savings" });
    await savingsRow.waitFor({ state: "visible" });
    assert.match((await savingsRow.innerText()) ?? "", /\$1,284\.37/);
    assert.deepEqual(browserErrors, []);
    await page.close();
  });

  it("restores an expired session without replacing the browser page", async () => {
    const page = await browser.newPage();
    await page.goto(target.entryUrl("session-expired"));
    const originalPage = page;
    const workspace = page.frameLocator('iframe[title="Member servicing workspace"]');
    await workspace
      .locator(".form-grid tr")
      .filter({ hasText: "Member number" })
      .getByRole("textbox")
      .fill("26017");
    await workspace.getByRole("button", { name: "Find Member", exact: true }).click();
    await workspace.getByRole("dialog").waitFor({ state: "visible" });
    await workspace.getByRole("button", { name: "Restore demo session", exact: true }).click();
    await workspace.getByRole("button", { name: "Find Member", exact: true }).click();

    assert.equal(page, originalPage);
    assert.equal(
      await workspace.getByText("Member profile: Jordan Lee", { exact: true }).isVisible(),
      true,
    );
    await page.close();
  });

  it("exposes ambiguity instead of hiding it in the fixture", async () => {
    const page = await browser.newPage();
    await page.goto(target.entryUrl("ambiguous"));
    const workspace = page.frameLocator('iframe[title="Member servicing workspace"]');
    assert.equal(
      await workspace.getByRole("button", { name: "Find Member", exact: true }).count(),
      2,
    );
    await page.close();
  });
});
