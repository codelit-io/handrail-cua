import type {
  AppBinding,
  ExtractorSpec,
  ModelDecision,
  Predicate,
  TargetSpec,
  ValueExpression,
} from "../domain/schema.js";
import type { ControlGrant } from "../runtime/control.js";

export interface SurfaceSession {
  id: string;
  adapter: "playwright-web";
  createdAt: string;
  viewport: { width: number; height: number };
}

/** Origin/route dimensions from one independently enforced runtime policy layer. */
export interface SurfaceAccessLayer {
  readonly name: string;
  readonly allowedOrigins?: readonly string[];
  readonly allowedRoutes?: readonly string[];
}

export interface NormalizedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementContext {
  precedingLabel?: string;
  rowText?: string[];
  rowLabel?: string;
  columnLabel?: string;
  tableCaption?: string;
}

export interface ObservedElement {
  ref: string;
  framePath: string[];
  tagName: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  inputType?: string;
  interactive: boolean;
  enabled: boolean;
  bounds: NormalizedBounds;
  context: ElementContext;
}

export interface SurfaceObservation {
  id: string;
  sessionId: string;
  /** Exact top-level HTTP(S) URL at capture time; never a model/evidence field by default. */
  url: string;
  route: string;
  title: string;
  capturedAt: string;
  screenshotPng: Buffer;
  viewport: { width: number; height: number };
  visibleText: string;
  elements: ObservedElement[];
  fingerprint: string;
}

export interface ActionReceipt {
  command: ModelDecision["kind"] | "navigate" | "press_key" | "capture_evidence";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  changedSurface: boolean;
  summary: string;
  element?: ObservedElement;
  value?: unknown;
}

export interface PredicateContext {
  outputs: Record<string, unknown>;
  inputs: Record<string, unknown>;
  targets: Record<string, TargetSpec>;
  /** When supplied, predicate reads execute under the active automation lease. */
  grant?: ControlGrant;
  /** Exact URL that was authorized before the predicate read. */
  expectedUrl?: string;
}

export interface PredicateResult {
  passed: boolean;
  observed: string;
}

export interface DispatchContext {
  observationId: string;
  inputs: Record<string, unknown>;
  grant: ControlGrant;
  /** Exact URL that policy authorized for this action. */
  expectedUrl?: string;
  /** Replay deadlines abort this signal; adapters should stop or settle work promptly. */
  signal?: AbortSignal;
}

export interface SurfaceAdapter {
  createSession(
    binding: AppBinding,
    accessPolicy?: readonly SurfaceAccessLayer[],
  ): Promise<SurfaceSession>;
  navigate(
    sessionId: string,
    url: string,
    grant: ControlGrant,
    signal?: AbortSignal,
  ): Promise<ActionReceipt>;
  observe(sessionId: string, signal?: AbortSignal): Promise<SurfaceObservation>;
  dispatch(
    sessionId: string,
    decision: ModelDecision,
    context: DispatchContext,
  ): Promise<ActionReceipt>;
  compileTarget(observationId: string, elementRef: string, description: string): TargetSpec;
  evaluate(
    sessionId: string,
    predicate: Predicate,
    context: PredicateContext,
    signal?: AbortSignal,
  ): Promise<PredicateResult>;
  extract(
    sessionId: string,
    target: TargetSpec,
    extractor: ExtractorSpec,
    signal?: AbortSignal,
    grant?: ControlGrant,
    expectedUrl?: string,
  ): Promise<unknown>;
  resolveValue(expression: ValueExpression, inputs: Record<string, unknown>): unknown;
  captureEvidence(
    sessionId: string,
    label: string,
    signal?: AbortSignal,
    expectedUrl?: string,
    grant?: ControlGrant,
  ): Promise<Buffer>;
  pressKey(
    sessionId: string,
    key: string,
    grant: ControlGrant,
    signal?: AbortSignal,
    expectedUrl?: string,
  ): Promise<ActionReceipt>;
  clickAt(
    sessionId: string,
    x: number,
    y: number,
    grant: ControlGrant,
    expectedUrl?: string,
  ): Promise<ActionReceipt>;
  typeFocused(
    sessionId: string,
    value: string,
    grant: ControlGrant,
    expectedUrl?: string,
  ): Promise<ActionReceipt>;
  closeSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}
