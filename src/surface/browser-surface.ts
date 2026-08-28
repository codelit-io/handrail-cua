import { createHash, randomUUID } from "node:crypto";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type ElementHandle,
  type Frame,
  type Locator,
  type Page,
} from "playwright";
import type {
  AppBinding,
  AtomicPredicate,
  ExtractorSpec,
  ModelDecision,
  Predicate,
  TargetCandidate,
  TargetSpec,
  ValueExpression,
} from "../domain/schema.js";
import type { ControlCoordinator, ControlGrant } from "../runtime/control.js";
import { routeMatches } from "../runtime/policy.js";
import type {
  ActionReceipt,
  DispatchContext,
  ElementContext,
  NormalizedBounds,
  ObservedElement,
  PredicateContext,
  PredicateResult,
  SurfaceAdapter,
  SurfaceObservation,
  SurfaceSession,
} from "./types.js";

export interface BrowserSurfaceOptions {
  control: ControlCoordinator;
  headless?: boolean;
  viewport?: { width: number; height: number };
  slowMoMs?: number;
}

interface SessionRecord {
  descriptor: SurfaceSession;
  binding: AppBinding;
  context: BrowserContext;
  page: Page;
  hasNavigated: boolean;
  latestObservationId?: string;
}

interface EphemeralElement {
  observationId: string;
  sessionId: string;
  frame: Frame;
  handle: ElementHandle<HTMLElement>;
  observed: ObservedElement;
}

interface ObservationRecord {
  observation: SurfaceObservation;
  elements: Map<string, EphemeralElement>;
}

interface RawElementInfo {
  tagName: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  inputType?: string;
  interactive: boolean;
  enabled: boolean;
  context: ElementContext;
}

interface DeclarativeNavigationTarget {
  url: string;
  kind: "link" | "form";
}

const ELEMENT_SELECTOR = "input, button, select, textarea, a[href], [role], td, th";
const SCHEMA_ROLES = new Set([
  "button",
  "cell",
  "checkbox",
  "combobox",
  "dialog",
  "heading",
  "link",
  "row",
  "rowheader",
  "spinbutton",
  "status",
  "tab",
  "textbox",
]);

export class SurfaceResolutionError extends Error {
  constructor(
    readonly code: "TARGET_NOT_FOUND" | "TARGET_AMBIGUOUS" | "STALE_OBSERVATION",
    message: string,
  ) {
    super(message);
    this.name = "SurfaceResolutionError";
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function routeOnly(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}

function normalizedText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

function cssQuoted(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function frameSegment(frame: Frame): string {
  const name = frame.name();
  return name ? `name:${name}` : `path:${routeOnly(frame.url())}`;
}

function framePath(frame: Frame): string[] {
  const segments: string[] = [];
  let current: Frame | null = frame;
  while (current?.parentFrame()) {
    segments.unshift(frameSegment(current));
    current = current.parentFrame();
  }
  return segments;
}

function clampBounds(
  box: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
): NormalizedBounds {
  const x = Math.max(0, Math.min(1, box.x / viewport.width));
  const y = Math.max(0, Math.min(1, box.y / viewport.height));
  const width = Math.max(0.0001, Math.min(1 - x, box.width / viewport.width));
  const height = Math.max(0.0001, Math.min(1 - y, box.height / viewport.height));
  return { x, y, width, height };
}

const INSPECT_ELEMENT_EXPRESSION = String.raw`(element) => {
    const normalize = (value) =>
      (value ?? "").replace(/\s+/gu, " ").trim();
    const tagName = element.tagName.toLowerCase();
    const explicitRole = element.getAttribute("role") ?? undefined;
    let role = explicitRole;
    let name = normalize(element.getAttribute("aria-label")) || undefined;
    let value;
    let inputType;
    let interactive = false;
    let enabled = true;

    if (element instanceof HTMLInputElement) {
      inputType = element.type || "text";
      value = element.value;
      enabled = !element.disabled;
      interactive = true;
      if (["button", "submit", "reset"].includes(element.type)) {
        role = role ?? "button";
        name = name ?? (normalize(element.value) || undefined);
      } else if (element.type === "checkbox") {
        role = role ?? "checkbox";
      } else if (element.type === "number") {
        role = role ?? "spinbutton";
      } else {
        role = role ?? "textbox";
      }
      name =
        name ??
        (normalize(element.labels?.[0]?.textContent) ||
          normalize(element.placeholder) ||
          undefined);
    } else if (element instanceof HTMLTextAreaElement) {
      role = role ?? "textbox";
      value = element.value;
      enabled = !element.disabled;
      interactive = true;
      name = name ?? (normalize(element.labels?.[0]?.textContent) || undefined);
    } else if (element instanceof HTMLSelectElement) {
      role = role ?? "combobox";
      value = element.value;
      enabled = !element.disabled;
      interactive = true;
      name = name ?? (normalize(element.labels?.[0]?.textContent) || undefined);
    } else if (element instanceof HTMLButtonElement) {
      role = role ?? "button";
      enabled = !element.disabled;
      interactive = true;
      name = name ?? (normalize(element.textContent) || undefined);
    } else if (element instanceof HTMLAnchorElement) {
      role = role ?? "link";
      interactive = true;
      name = name ?? (normalize(element.textContent) || undefined);
    } else if (tagName === "td") {
      role = role ?? "cell";
    } else if (tagName === "th") {
      role = role ?? "columnheader";
    } else if (explicitRole) {
      interactive = ["button", "checkbox", "combobox", "link", "spinbutton", "textbox"].includes(
        explicitRole,
      );
    }

    const text = normalize(element.textContent) || undefined;
    const row = element.closest("tr");
    const directCells = row
      ? Array.from(row.children).filter((child) => child instanceof HTMLTableCellElement)
      : [];
    const rowText = directCells.map((cell) => normalize(cell.textContent)).filter(Boolean);
    const containingCell = element.closest("td,th");
    const containingIndex = containingCell ? directCells.indexOf(containingCell) : -1;
    const precedingLabel =
      containingIndex > 0
        ? [...directCells]
            .slice(0, containingIndex)
            .map((cell) => normalize(cell.textContent))
            .filter(Boolean)
            .at(-1)
        : undefined;
    const table = element.closest("table");
    const caption = normalize(table?.querySelector(":scope > caption")?.textContent) || undefined;
    let columnLabel;
    let rowLabel;
    if (containingCell && table && containingIndex >= 0) {
      const headers = Array.from(table.querySelectorAll(":scope > thead th"));
      columnLabel = normalize(headers[containingIndex]?.textContent) || undefined;
      rowLabel = rowText.find((cellText, index) => index !== containingIndex && cellText) || undefined;
    }

    return {
      tagName,
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(text ? { text } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(inputType ? { inputType } : {}),
      interactive,
      enabled,
      context: {
        ...(precedingLabel ? { precedingLabel } : {}),
        ...(rowText.length > 0 ? { rowText } : {}),
        ...(rowLabel ? { rowLabel } : {}),
        ...(columnLabel ? { columnLabel } : {}),
        ...(caption ? { tableCaption: caption } : {}),
      },
    };
  }`;

// Playwright serializes this runtime-constructed function verbatim. This avoids
// build-tool helper references leaking into the browser execution context.
const INSPECT_ELEMENT_FUNCTION = Function(
  `"use strict"; return (${INSPECT_ELEMENT_EXPRESSION});`,
)() as (element: HTMLElement) => RawElementInfo;

const NAVIGATION_TARGET_EXPRESSION = `(element) => {
    const anchor = element.closest("a[href]");
    if (anchor instanceof HTMLAnchorElement) {
      return { url: anchor.href, kind: "link" };
    }
    if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) {
      const type = (element.type || "submit").toLowerCase();
      if ((type === "submit" || type === "image") && element.form) {
        return { url: element.formAction || element.form.action, kind: "form" };
      }
    }
    return undefined;
  }`;

const NAVIGATION_TARGET_FUNCTION = Function(
  `"use strict"; return (${NAVIGATION_TARGET_EXPRESSION});`,
)() as (element: HTMLElement) => DeclarativeNavigationTarget | undefined;

async function inspectElement(handle: ElementHandle<HTMLElement>): Promise<RawElementInfo> {
  return handle.evaluate<RawElementInfo>(INSPECT_ELEMENT_FUNCTION);
}

async function declarativeNavigationTarget(
  handle: ElementHandle<HTMLElement>,
): Promise<DeclarativeNavigationTarget | undefined> {
  return handle.evaluate<DeclarativeNavigationTarget | undefined>(NAVIGATION_TARGET_FUNCTION);
}

async function visibleHandles(locator: Locator): Promise<Array<ElementHandle<HTMLElement>>> {
  const handles: Array<ElementHandle<HTMLElement>> = [];
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const handle = await candidate.elementHandle();
    if (handle) handles.push(handle as ElementHandle<HTMLElement>);
  }
  return handles;
}

function surfaceSignature(page: Page): Promise<string> {
  return Promise.all([
    Promise.resolve(page.url()),
    page
      .locator("body")
      .innerText({ timeout: 1_000 })
      .catch(() => ""),
  ]).then(([url, text]) =>
    createHash("sha256")
      .update(`${routeOnly(url)}\n${normalizedText(text)}`)
      .digest("hex"),
  );
}

function matcherPasses(
  value: string,
  predicate: AtomicPredicate & { kind: "target_text_matches" },
): boolean {
  const actual = predicate.matcher.caseSensitive ? value : value.toLowerCase();
  const expected = predicate.matcher.caseSensitive
    ? predicate.matcher.value
    : predicate.matcher.value.toLowerCase();
  switch (predicate.matcher.mode) {
    case "exact":
      return actual === expected;
    case "contains":
      return actual.includes(expected);
    case "regex":
      return new RegExp(predicate.matcher.value, predicate.matcher.caseSensitive ? "u" : "iu").test(
        value,
      );
  }
}

function applyTransforms(value: unknown, transforms: ExtractorSpec["transforms"]): unknown {
  let current = value;
  for (const transform of transforms) {
    if (transform === "trim") {
      current = String(current ?? "").trim();
    } else if (transform === "number") {
      const parsed = Number(String(current).replace(/,/gu, ""));
      if (!Number.isFinite(parsed)) throw new Error(`Cannot parse ${String(current)} as a number.`);
      current = parsed;
    } else if (transform === "currency_to_number") {
      const text = String(current).trim();
      const negative = /^\(.*\)$/u.test(text);
      const parsed = Number(text.replace(/[^0-9.-]/gu, ""));
      if (!Number.isFinite(parsed)) throw new Error(`Cannot parse ${text} as currency.`);
      current = negative ? -Math.abs(parsed) : parsed;
    }
  }
  return current;
}

export class BrowserSurface implements SurfaceAdapter {
  readonly #browser: Browser;
  readonly #control: ControlCoordinator;
  readonly #viewport: { width: number; height: number };
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #observations = new Map<string, ObservationRecord>();

  private constructor(browser: Browser, options: BrowserSurfaceOptions) {
    this.#browser = browser;
    this.#control = options.control;
    this.#viewport = options.viewport ?? { width: 1280, height: 800 };
  }

  static async launch(options: BrowserSurfaceOptions): Promise<BrowserSurface> {
    const browser = await chromium.launch({
      headless: options.headless ?? true,
      slowMo: options.slowMoMs ?? 0,
    });
    return new BrowserSurface(browser, options);
  }

  async createSession(binding: AppBinding): Promise<SurfaceSession> {
    const id = `surface-${randomUUID()}`;
    const context = await this.#browser.newContext({
      viewport: this.#viewport,
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "reduce",
      colorScheme: "light",
    });
    let bootstrapComplete = false;
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();
      if (!isHttpUrl(url)) {
        const isMainFrameBootstrap =
          !bootstrapComplete &&
          url === "about:blank" &&
          request.isNavigationRequest() &&
          request.frame().parentFrame() === null;
        if (!request.isNavigationRequest() || isMainFrameBootstrap) {
          await route.continue();
          return;
        }
        await route.abort("blockedbyclient");
        return;
      }
      try {
        this.#assertUrlAllowed(binding, url);
      } catch {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    bootstrapComplete = true;
    const descriptor: SurfaceSession = {
      id,
      adapter: "playwright-web",
      createdAt: isoNow(),
      viewport: { ...this.#viewport },
    };
    this.#sessions.set(id, { descriptor, binding, context, page, hasNavigated: false });
    return descriptor;
  }

  async navigate(
    sessionId: string,
    url: string,
    grant: ControlGrant,
    signal?: AbortSignal,
  ): Promise<ActionReceipt> {
    throwIfAborted(signal);
    const record = this.#requireSession(sessionId);
    await this.#validateReadySurface(record);
    throwIfAborted(signal);
    this.#assertUrlAllowed(record.binding, url);
    return this.#control.withControl(grant, async () => {
      throwIfAborted(signal);
      const startedAt = isoNow();
      const started = Date.now();
      const before = await surfaceSignature(record.page);
      record.hasNavigated = true;
      await record.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await record.page.waitForLoadState("load", { timeout: 2_000 }).catch(() => undefined);
      throwIfAborted(signal);
      await this.#postValidateSurface(record);
      const after = await surfaceSignature(record.page);
      return {
        command: "navigate",
        startedAt,
        finishedAt: isoNow(),
        durationMs: Date.now() - started,
        changedSurface: before !== after,
        summary: `Navigated to ${routeOnly(record.page.url())}.`,
      };
    });
  }

  async observe(sessionId: string, signal?: AbortSignal): Promise<SurfaceObservation> {
    throwIfAborted(signal);
    const session = this.#requireSession(sessionId);
    await this.#validateReadySurface(session);
    throwIfAborted(signal);
    await this.#discardLatestObservation(session);
    const observationId = `observation-${randomUUID()}`;
    const elements = new Map<string, EphemeralElement>();
    const observed: ObservedElement[] = [];
    const frameTexts: string[] = [];

    for (const frame of session.page.frames()) {
      throwIfAborted(signal);
      const text = await frame
        .locator("body")
        .innerText({ timeout: 2_000 })
        .catch(() => "");
      if (text) frameTexts.push(`[${frameSegment(frame)}]\n${normalizedText(text)}`);
      const locator = frame.locator(ELEMENT_SELECTOR);
      const count = Math.min(await locator.count(), 160);
      for (let index = 0; index < count; index += 1) {
        throwIfAborted(signal);
        const item = locator.nth(index);
        if (!(await item.isVisible().catch(() => false))) continue;
        const handle = await item.elementHandle();
        const box = await item.boundingBox();
        if (!handle || !box || box.width < 1 || box.height < 1) {
          await handle?.dispose();
          continue;
        }
        const typedHandle = handle as ElementHandle<HTMLElement>;
        const raw = await inspectElement(typedHandle);
        if (!raw.interactive && !raw.text) {
          await typedHandle.dispose();
          continue;
        }
        const ref = `e${observed.length + 1}`;
        const element: ObservedElement = {
          ref,
          framePath: framePath(frame),
          tagName: raw.tagName,
          ...(raw.role ? { role: raw.role } : {}),
          ...(raw.name ? { name: raw.name } : {}),
          ...(raw.text ? { text: raw.text } : {}),
          ...(raw.value !== undefined ? { value: raw.value } : {}),
          ...(raw.inputType ? { inputType: raw.inputType } : {}),
          interactive: raw.interactive,
          enabled: raw.enabled,
          bounds: clampBounds(box, session.descriptor.viewport),
          context: raw.context,
        };
        observed.push(element);
        elements.set(ref, {
          observationId,
          sessionId,
          frame,
          handle: typedHandle,
          observed: element,
        });
      }
    }

    const screenshotPng = await session.page.screenshot({
      type: "png",
      animations: "disabled",
      caret: "hide",
    });
    throwIfAborted(signal);
    const stableSignals = observed.map((element) => ({
      framePath: element.framePath,
      role: element.role,
      name: element.context.columnLabel ? undefined : element.name,
      precedingLabel: element.context.precedingLabel,
      rowLabel: element.context.rowLabel,
      columnLabel: element.context.columnLabel,
      tableCaption: element.context.tableCaption,
    }));
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          route: routeOnly(session.page.url()),
          title: await session.page.title(),
          frames: session.page.frames().map(frameSegment),
          stableSignals,
        }),
      )
      .digest("hex");
    const observation: SurfaceObservation = {
      id: observationId,
      sessionId,
      route: routeOnly(session.page.url()),
      title: await session.page.title(),
      capturedAt: isoNow(),
      screenshotPng,
      viewport: { ...session.descriptor.viewport },
      visibleText: frameTexts.join("\n\n").slice(0, 16_000),
      elements: observed,
      fingerprint,
    };
    this.#observations.set(observationId, { observation, elements });
    session.latestObservationId = observationId;
    return observation;
  }

  async dispatch(
    sessionId: string,
    decision: ModelDecision,
    context: DispatchContext,
  ): Promise<ActionReceipt> {
    throwIfAborted(context.signal);
    const session = this.#requireSession(sessionId);
    await this.#validateReadySurface(session);
    throwIfAborted(context.signal);
    if (decision.observationId !== context.observationId) {
      throw new SurfaceResolutionError(
        "STALE_OBSERVATION",
        "Decision and dispatch observation IDs differ.",
      );
    }
    const observation = this.#requireObservation(session, context.observationId);
    return this.#control.withControl(context.grant, async () => {
      throwIfAborted(context.signal);
      const startedAt = isoNow();
      const started = Date.now();
      const before = await surfaceSignature(session.page);
      let element: EphemeralElement | undefined;
      let value: unknown;

      if ("elementRef" in decision) {
        element = observation.elements.get(decision.elementRef);
        if (!element) {
          throw new SurfaceResolutionError(
            "TARGET_NOT_FOUND",
            `Element ref ${decision.elementRef} is absent from the current observation.`,
          );
        }
        if (!(await element.handle.isVisible().catch(() => false))) {
          throw new SurfaceResolutionError(
            "STALE_OBSERVATION",
            "The observed element is no longer visible.",
          );
        }
      }

      switch (decision.kind) {
        case "set_value": {
          if (!element)
            throw new SurfaceResolutionError("TARGET_NOT_FOUND", "Missing set-value target.");
          value = this.resolveValue(decision.value, context.inputs);
          throwIfAborted(context.signal);
          await element.handle.fill(String(value ?? ""));
          throwIfAborted(context.signal);
          break;
        }
        case "activate":
          if (!element)
            throw new SurfaceResolutionError("TARGET_NOT_FOUND", "Missing activation target.");
          await this.#assertDeclarativeNavigationAllowed(session.binding, element.handle);
          throwIfAborted(context.signal);
          await element.handle.click();
          throwIfAborted(context.signal);
          break;
        case "activate_coordinate":
          await session.page.mouse.click(
            decision.x * session.descriptor.viewport.width,
            decision.y * session.descriptor.viewport.height,
          );
          throwIfAborted(context.signal);
          break;
        case "wait":
          await session.page.waitForTimeout(decision.durationMs);
          throwIfAborted(context.signal);
          break;
        case "extract":
          if (!element)
            throw new SurfaceResolutionError("TARGET_NOT_FOUND", "Missing extraction target.");
          value = normalizedText(await element.handle.innerText().catch(() => ""));
          break;
        case "finish":
        case "request_help":
          break;
      }

      if (decision.kind !== "wait") await session.page.waitForTimeout(40);
      throwIfAborted(context.signal);
      if (decision.kind === "activate" || decision.kind === "activate_coordinate") {
        await this.#postValidateSurface(session);
      }
      const after = await surfaceSignature(session.page);
      return {
        command: decision.kind,
        startedAt,
        finishedAt: isoNow(),
        durationMs: Date.now() - started,
        changedSurface: before !== after,
        summary: this.#receiptSummary(decision),
        ...(element ? { element: element.observed } : {}),
        ...(decision.kind === "extract" ? { value } : {}),
      };
    });
  }

  compileTarget(observationId: string, elementRef: string, description: string): TargetSpec {
    const record = this.#observations.get(observationId);
    const ephemeral = record?.elements.get(elementRef);
    if (!ephemeral) {
      throw new SurfaceResolutionError(
        "TARGET_NOT_FOUND",
        `Cannot compile missing ref ${elementRef}.`,
      );
    }
    const source = ephemeral.observed;
    const candidates: TargetCandidate[] = [];
    const candidateFrame = source.framePath.length > 0 ? { framePath: source.framePath } : {};
    const isRelationalCell = Boolean(source.context.columnLabel && source.context.rowLabel);

    if (source.role && source.name && SCHEMA_ROLES.has(source.role) && !isRelationalCell) {
      candidates.push({
        kind: "role",
        role: source.role as
          | "button"
          | "cell"
          | "checkbox"
          | "combobox"
          | "dialog"
          | "heading"
          | "link"
          | "row"
          | "rowheader"
          | "spinbutton"
          | "status"
          | "tab"
          | "textbox",
        name: source.name,
        exact: true,
        rationale:
          "The accessible role and exact user-visible name are stable across DOM reshaping.",
        ...candidateFrame,
      });
    }
    if (source.context.precedingLabel && !isRelationalCell) {
      candidates.push({
        kind: "relation",
        anchorText: source.context.precedingLabel,
        relationship: "labelled_control",
        ...(source.role ? { role: source.role } : {}),
        rationale:
          "The control is resolved from its visible table-row label instead of an implementation selector.",
        ...candidateFrame,
      });
    }
    if (source.context.rowLabel && source.context.columnLabel) {
      candidates.push({
        kind: "table",
        rowLabel: source.context.rowLabel,
        columnLabel: source.context.columnLabel,
        rationale:
          "The value is resolved by stable row and column meaning, so the changing value is never a locator.",
        ...candidateFrame,
      });
    }

    const visualAnchor =
      source.context.columnLabel ??
      source.context.precedingLabel ??
      source.name ??
      source.context.rowLabel ??
      description;
    candidates.push({
      kind: "visual",
      anchorText: visualAnchor,
      region: source.bounds,
      minimumConfidence: 0.85,
      rationale: "A constrained visual region is the final fallback for sparse legacy semantics.",
      ...candidateFrame,
    });

    const nearbyText = [
      source.context.precedingLabel,
      source.context.rowLabel,
      source.context.columnLabel,
      source.context.tableCaption,
    ].filter((value): value is string => Boolean(value));
    return {
      description,
      candidates,
      match: "exactly_one_visible",
      fingerprint: {
        ...(source.role ? { role: source.role } : {}),
        ...(source.name && !isRelationalCell ? { accessibleName: source.name } : {}),
        ...(nearbyText.length > 0 ? { nearbyText } : {}),
        minimumScore: 0.6,
      },
      robustnessRationale:
        "Candidates follow user-perceived semantics first, fail on ambiguity, and reserve the normalized visual region for last.",
    };
  }

  async evaluate(
    sessionId: string,
    predicate: Predicate,
    context: PredicateContext,
    signal?: AbortSignal,
  ): Promise<PredicateResult> {
    throwIfAborted(signal);
    await this.#validateReadySurface(this.#requireSession(sessionId));
    throwIfAborted(signal);
    if (predicate.kind === "all" || predicate.kind === "any") {
      const results = await Promise.all(
        predicate.predicates.map((item) => this.#evaluateAtomic(sessionId, item, context)),
      );
      throwIfAborted(signal);
      const passed =
        predicate.kind === "all"
          ? results.every((item) => item.passed)
          : results.some((item) => item.passed);
      return { passed, observed: results.map((item) => item.observed).join("; ") };
    }
    if (predicate.kind === "not") {
      const result = await this.#evaluateAtomic(sessionId, predicate.predicate, context);
      throwIfAborted(signal);
      return { passed: !result.passed, observed: `not (${result.observed})` };
    }
    const result = await this.#evaluateAtomic(sessionId, predicate, context);
    throwIfAborted(signal);
    return result;
  }

  async extract(
    sessionId: string,
    target: TargetSpec,
    extractor: ExtractorSpec,
    signal?: AbortSignal,
  ): Promise<unknown> {
    throwIfAborted(signal);
    await this.#validateReadySurface(this.#requireSession(sessionId));
    throwIfAborted(signal);
    const handle = await this.#resolveTarget(sessionId, target);
    throwIfAborted(signal);
    let value: unknown;
    if (extractor.kind === "target_text") {
      value = await handle.innerText();
    } else if (extractor.kind === "target_value") {
      value = await handle.inputValue();
    } else {
      value = await handle.getAttribute(extractor.attribute);
    }
    throwIfAborted(signal);
    return applyTransforms(value, extractor.transforms);
  }

  resolveValue(expression: ValueExpression, inputs: Record<string, unknown>): unknown {
    switch (expression.kind) {
      case "input":
        if (!(expression.name in inputs)) throw new Error(`Missing input ${expression.name}.`);
        return inputs[expression.name];
      case "literal":
        return expression.value;
      case "step_output":
        throw new Error("Step-output expressions must be bound before surface dispatch.");
      case "secret_ref":
        throw new Error(
          "Secret references require a runtime broker and are never exposed to the surface directly.",
        );
    }
  }

  async captureEvidence(sessionId: string, _label: string, signal?: AbortSignal): Promise<Buffer> {
    throwIfAborted(signal);
    const session = this.#requireSession(sessionId);
    await this.#validateReadySurface(session);
    throwIfAborted(signal);
    const screenshot = await session.page.screenshot({
      type: "png",
      animations: "disabled",
      caret: "hide",
    });
    throwIfAborted(signal);
    return screenshot;
  }

  async pressKey(
    sessionId: string,
    key: string,
    grant: ControlGrant,
    signal?: AbortSignal,
  ): Promise<ActionReceipt> {
    throwIfAborted(signal);
    const session = this.#requireSession(sessionId);
    await this.#validateReadySurface(session);
    throwIfAborted(signal);
    return this.#control.withControl(grant, async () => {
      throwIfAborted(signal);
      const startedAt = isoNow();
      const started = Date.now();
      await session.page.keyboard.press(key);
      throwIfAborted(signal);
      await this.#postValidateSurface(session);
      return {
        command: "press_key",
        startedAt,
        finishedAt: isoNow(),
        durationMs: Date.now() - started,
        changedSurface: true,
        summary: `Pressed ${key}.`,
      };
    });
  }

  async clickAt(
    sessionId: string,
    x: number,
    y: number,
    grant: ControlGrant,
  ): Promise<ActionReceipt> {
    const session = this.#requireSession(sessionId);
    await this.#validateReadySurface(session);
    if (
      x < 0 ||
      y < 0 ||
      x > session.descriptor.viewport.width ||
      y > session.descriptor.viewport.height
    ) {
      throw new Error("Operator click is outside the live viewport.");
    }
    return this.#control.withControl(grant, async () => {
      const startedAt = isoNow();
      const started = Date.now();
      await session.page.mouse.click(x, y);
      await this.#postValidateSurface(session);
      return {
        command: "activate_coordinate",
        startedAt,
        finishedAt: isoNow(),
        durationMs: Date.now() - started,
        changedSurface: true,
        summary: `Operator clicked the live session at (${Math.round(x)}, ${Math.round(y)}).`,
      };
    });
  }

  async typeFocused(sessionId: string, value: string, grant: ControlGrant): Promise<ActionReceipt> {
    const session = this.#requireSession(sessionId);
    await this.#validateReadySurface(session);
    return this.#control.withControl(grant, async () => {
      const startedAt = isoNow();
      const started = Date.now();
      await session.page.keyboard.type(value);
      await this.#postValidateSurface(session);
      return {
        command: "set_value",
        startedAt,
        finishedAt: isoNow(),
        durationMs: Date.now() - started,
        changedSurface: true,
        summary: "Operator typed a redacted value into the focused control.",
      };
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    await this.#discardLatestObservation(session);
    await session.context.close();
    this.#sessions.delete(sessionId);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((sessionId) => this.closeSession(sessionId)));
    await this.#browser.close();
  }

  async #evaluateAtomic(
    sessionId: string,
    predicate: AtomicPredicate,
    context: PredicateContext,
  ): Promise<PredicateResult> {
    if (predicate.kind === "route_matches") {
      const route = routeOnly(this.#requireSession(sessionId).page.url());
      return { passed: routeMatches(predicate.route, route), observed: `route=${route}` };
    }
    if (predicate.kind === "output_valid") {
      const present = context.outputs[predicate.output] !== undefined;
      return {
        passed: present,
        observed: `output ${predicate.output} ${present ? "present" : "missing"}`,
      };
    }
    if (predicate.kind === "surface_fingerprint") {
      const latest = this.#latestObservation(this.#requireSession(sessionId));
      const passed = Boolean(latest?.fingerprint);
      return {
        passed,
        observed: passed ? "surface fingerprint captured" : "surface fingerprint missing",
      };
    }

    const target = context.targets[predicate.target];
    if (!target)
      return { passed: false, observed: `target ${predicate.target} missing from artifact` };
    let handle: ElementHandle<HTMLElement>;
    try {
      handle = await this.#resolveTarget(sessionId, target);
    } catch (error) {
      if (
        predicate.kind === "target_visible" &&
        predicate.expected === false &&
        error instanceof SurfaceResolutionError &&
        error.code === "TARGET_NOT_FOUND"
      ) {
        return { passed: true, observed: `target ${predicate.target} absent` };
      }
      throw error;
    }

    if (predicate.kind === "target_visible") {
      const visible = await handle.isVisible();
      return { passed: visible === predicate.expected, observed: `visible=${visible}` };
    }
    if (predicate.kind === "target_text_matches") {
      const text = normalizedText(await handle.innerText().catch(() => ""));
      return { passed: matcherPasses(text, predicate), observed: `text=${text.slice(0, 240)}` };
    }
    let value: string;
    try {
      value = await handle.inputValue();
    } catch {
      value = normalizedText(await handle.innerText().catch(() => ""));
    }
    const expected = this.resolveValue(predicate.expected, context.inputs);
    return {
      passed: value === String(expected ?? ""),
      observed: `value=${String(value).slice(0, 120)}`,
    };
  }

  async #resolveTarget(sessionId: string, target: TargetSpec): Promise<ElementHandle<HTMLElement>> {
    const session = this.#requireSession(sessionId);
    for (const candidate of target.candidates) {
      const handles = await this.#resolveCandidate(session, candidate);
      const matching: Array<ElementHandle<HTMLElement>> = [];
      for (const handle of handles) {
        if (await this.#matchesFingerprint(handle, target)) matching.push(handle);
      }
      if (matching.length === 1) return matching[0] as ElementHandle<HTMLElement>;
      if (matching.length > 1) {
        throw new SurfaceResolutionError(
          "TARGET_AMBIGUOUS",
          `Candidate ${candidate.kind} resolved ${matching.length} matching visible elements.`,
        );
      }
    }
    throw new SurfaceResolutionError(
      "TARGET_NOT_FOUND",
      `No candidate resolved ${target.description}.`,
    );
  }

  async #resolveCandidate(
    session: SessionRecord,
    candidate: TargetCandidate,
  ): Promise<Array<ElementHandle<HTMLElement>>> {
    const frame = this.#frameForPath(session.page, candidate.framePath ?? []);
    if (!frame) return [];
    switch (candidate.kind) {
      case "role":
        return visibleHandles(
          frame.getByRole(candidate.role, { name: candidate.name, exact: true }),
        );
      case "label":
        return visibleHandles(frame.getByLabel(candidate.label, { exact: true }));
      case "attribute":
        return visibleHandles(
          frame.locator(`[${candidate.attribute}=${cssQuoted(candidate.value)}]`),
        );
      case "relation":
        return this.#resolveRelation(frame, candidate);
      case "table":
        return this.#resolveTable(frame, candidate.rowLabel, candidate.columnLabel);
      case "visual":
        return this.#resolveVisual(frame, candidate.region, session.descriptor.viewport);
    }
  }

  async #resolveRelation(
    frame: Frame,
    candidate: Extract<TargetCandidate, { kind: "relation" }>,
  ): Promise<Array<ElementHandle<HTMLElement>>> {
    const rows = frame.locator("tr");
    const matches: Array<ElementHandle<HTMLElement>> = [];
    for (let index = 0; index < (await rows.count()); index += 1) {
      const row = rows.nth(index);
      const directCells = row.locator(":scope > td, :scope > th");
      const texts = (await directCells.allTextContents()).map(normalizedText);
      if (!texts.some((text) => text.toLowerCase() === candidate.anchorText.toLowerCase()))
        continue;
      const controls = candidate.role
        ? this.#locatorByRole(row, candidate.role)
        : row.locator("input, button, select, textarea, a[href], [role]");
      matches.push(...(await visibleHandles(controls)));
    }
    return matches;
  }

  #locatorByRole(scope: Locator, role: string): Locator {
    switch (role) {
      case "textbox":
        return scope.locator('input:not([type="button"]):not([type="submit"]), textarea');
      case "button":
        return scope.locator('button, input[type="button"], input[type="submit"], [role="button"]');
      case "combobox":
        return scope.locator('select, [role="combobox"]');
      case "link":
        return scope.locator('a[href], [role="link"]');
      default:
        return scope.locator(`[role=${cssQuoted(role)}]`);
    }
  }

  async #resolveTable(
    frame: Frame,
    rowLabel: string,
    columnLabel: string,
  ): Promise<Array<ElementHandle<HTMLElement>>> {
    const tables = frame.locator("table");
    const matches: Array<ElementHandle<HTMLElement>> = [];
    for (let tableIndex = 0; tableIndex < (await tables.count()); tableIndex += 1) {
      const table = tables.nth(tableIndex);
      const headers = (await table.locator(":scope > thead th").allTextContents()).map(
        normalizedText,
      );
      const columnIndex = headers.findIndex(
        (header) => header.toLowerCase() === columnLabel.toLowerCase(),
      );
      if (columnIndex < 0) continue;
      const rows = table.locator(":scope > tbody > tr");
      for (let rowIndex = 0; rowIndex < (await rows.count()); rowIndex += 1) {
        const cells = rows.nth(rowIndex).locator(":scope > th, :scope > td");
        const texts = (await cells.allTextContents()).map(normalizedText);
        if (!texts.some((text) => text.toLowerCase() === rowLabel.toLowerCase())) continue;
        const target = cells.nth(columnIndex);
        if (!(await target.isVisible().catch(() => false))) continue;
        const handle = await target.elementHandle();
        if (handle) matches.push(handle as ElementHandle<HTMLElement>);
      }
    }
    return matches;
  }

  async #resolveVisual(
    frame: Frame,
    region: NormalizedBounds,
    viewport: { width: number; height: number },
  ): Promise<Array<ElementHandle<HTMLElement>>> {
    const center = {
      x: (region.x + region.width / 2) * viewport.width,
      y: (region.y + region.height / 2) * viewport.height,
    };
    const locator = frame.locator(ELEMENT_SELECTOR);
    const matches: Array<ElementHandle<HTMLElement>> = [];
    for (let index = 0; index < (await locator.count()); index += 1) {
      const item = locator.nth(index);
      const box = await item.boundingBox();
      if (!box || !(await item.isVisible().catch(() => false))) continue;
      if (
        center.x >= box.x &&
        center.x <= box.x + box.width &&
        center.y >= box.y &&
        center.y <= box.y + box.height
      ) {
        const handle = await item.elementHandle();
        if (handle) matches.push(handle as ElementHandle<HTMLElement>);
      }
    }
    return matches;
  }

  async #matchesFingerprint(
    handle: ElementHandle<HTMLElement>,
    target: TargetSpec,
  ): Promise<boolean> {
    const observed = await inspectElement(handle);
    let possible = 0;
    let matched = 0;
    if (target.fingerprint.role) {
      possible += 1;
      if (observed.role === target.fingerprint.role) matched += 1;
    }
    if (target.fingerprint.accessibleName) {
      possible += 1;
      if (observed.name === target.fingerprint.accessibleName) matched += 1;
    }
    for (const expected of target.fingerprint.nearbyText ?? []) {
      possible += 1;
      const actual = [
        observed.context.precedingLabel,
        observed.context.rowLabel,
        observed.context.columnLabel,
        observed.context.tableCaption,
        ...(observed.context.rowText ?? []),
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase());
      if (actual.includes(expected.toLowerCase())) matched += 1;
    }
    if (possible === 0) return false;
    return matched / possible >= target.fingerprint.minimumScore;
  }

  #frameForPath(page: Page, path: string[]): Frame | undefined {
    let frame = page.mainFrame();
    for (const segment of path) {
      const next = frame.childFrames().find((candidate) => {
        if (segment.startsWith("name:")) return candidate.name() === segment.slice(5);
        if (segment.startsWith("path:")) return routeOnly(candidate.url()) === segment.slice(5);
        return false;
      });
      if (!next) return undefined;
      frame = next;
    }
    return frame;
  }

  #receiptSummary(decision: ModelDecision): string {
    switch (decision.kind) {
      case "set_value":
        return `Set ${decision.elementRef} from a typed value expression.`;
      case "activate":
        return `Activated ${decision.elementRef}.`;
      case "activate_coordinate":
        return "Activated a policy-checked coordinate from the current observation.";
      case "wait":
        return `Waited ${decision.durationMs}ms within the discovery bound.`;
      case "extract":
        return `Extracted ${decision.output} from ${decision.elementRef}.`;
      case "finish":
        return "Planner reported the goal complete; runtime checkpoint still required.";
      case "request_help":
        return `Planner requested human help: ${decision.reason}.`;
    }
  }

  #requireSession(sessionId: string): SessionRecord {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Unknown browser surface session ${sessionId}.`);
    return session;
  }

  #requireObservation(session: SessionRecord, observationId: string): ObservationRecord {
    if (session.latestObservationId !== observationId) {
      throw new SurfaceResolutionError(
        "STALE_OBSERVATION",
        "Only the latest observation may dispatch actions.",
      );
    }
    const observation = this.#observations.get(observationId);
    if (!observation) {
      throw new SurfaceResolutionError("STALE_OBSERVATION", "Observation handles have expired.");
    }
    return observation;
  }

  #latestObservation(session: SessionRecord): SurfaceObservation | undefined {
    return session.latestObservationId
      ? this.#observations.get(session.latestObservationId)?.observation
      : undefined;
  }

  async #discardLatestObservation(session: SessionRecord): Promise<void> {
    if (!session.latestObservationId) return;
    const record = this.#observations.get(session.latestObservationId);
    if (record) {
      await Promise.all(
        [...record.elements.values()].map((element) =>
          element.handle.dispose().catch(() => undefined),
        ),
      );
      this.#observations.delete(session.latestObservationId);
    }
    delete session.latestObservationId;
  }

  async #assertDeclarativeNavigationAllowed(
    binding: AppBinding,
    handle: ElementHandle<HTMLElement>,
  ): Promise<void> {
    const target = await declarativeNavigationTarget(handle);
    if (target) this.#assertUrlAllowed(binding, target.url);
  }

  async #validateReadySurface(session: SessionRecord): Promise<void> {
    if (session.hasNavigated) await this.#postValidateSurface(session);
  }

  async #postValidateSurface(session: SessionRecord): Promise<void> {
    try {
      for (const frame of session.page.frames()) {
        this.#assertUrlAllowed(session.binding, frame.url());
      }
    } catch (error) {
      await this.#discardLatestObservation(session);
      await session.context.close().catch(() => undefined);
      this.#sessions.delete(session.descriptor.id);
      throw error;
    }
  }

  #assertUrlAllowed(binding: AppBinding, url: string): void {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Surface navigation must use HTTP(S); received ${parsed.protocol}`);
    }
    if (parsed.username || parsed.password) {
      throw new Error("Surface navigation URLs cannot contain credentials.");
    }
    if (!binding.policy.allowedOrigins.includes(parsed.origin)) {
      throw new Error(`Origin ${parsed.origin} is outside the surface binding allowlist.`);
    }
    if (!binding.policy.allowedRoutes.some((pattern) => routeMatches(pattern, parsed.pathname))) {
      throw new Error(`Route ${parsed.pathname} is outside the surface binding allowlist.`);
    }
  }
}
