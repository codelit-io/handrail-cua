import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type ControlCoordinator, ControlError, type ControlGrant } from "../runtime/control.js";
import { type RedactedValue, redactText, redactValue } from "../runtime/redaction.js";
import type { SurfaceAdapter, SurfaceObservation } from "../surface/types.js";
import type {
  OpenOperatorInterventionInput,
  OperatorActionAuthorizer,
  OperatorAuditAction,
  OperatorAuditEvent,
  OperatorAuthorizationContext,
  OperatorCapture,
  OperatorConsoleHandle,
  OperatorConsoleOptions,
  OperatorConsoleState,
  OperatorInterventionHandle,
  OperatorObservationSummary,
  OperatorResumeResult,
  ResumeCheckpointSignal,
} from "./types.js";
import { OPERATOR_CSS, OPERATOR_SCRIPT, renderOperatorConsole } from "./ui.js";

const MAX_REQUEST_BYTES = 16 * 1_024;
const MAX_SCREENSHOT_BYTES = 20 * 1_024 * 1_024;
const MAX_CAPTURES_PER_SESSION = 8;
const MAX_TYPED_CHARACTERS = 4_096;
const CAPABILITY_FRAGMENT_KEY = "capability";
const CAPABILITY_HEADER = "x-handrail-capability";
const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{1,127}$/u;
const SAFE_KEYS = new Set([
  "Enter",
  "Escape",
  "Tab",
  "Shift+Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
]);

const denyUnconfiguredOperatorAction: OperatorActionAuthorizer = () => ({
  allowed: false,
  code: "POLICY_UNCONFIGURED",
  summary: "No operator action policy was configured.",
});

/**
 * Explicit compatibility policy for the synthetic, loopback-only evaluator
 * demo. Production callers should bind the authorization hook to their runtime
 * policy and approval system instead.
 */
export const allowLoopbackDemoOperatorAction: OperatorActionAuthorizer = () => ({
  allowed: true,
  authorization: "loopback_demo",
});

const OPERATOR_BOOTSTRAP_SCRIPT = `
(() => {
  "use strict";

  const sessionId = document.body.dataset.sessionId || "";
  const status = document.getElementById("console-status");
  const fail = (message) => {
    if (status) {
      status.textContent = message;
      status.dataset.error = "true";
    }
  };
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const capability = fragment.get("capability") || "";
  if (!sessionId) {
    fail("This operator link is missing its intervention context.");
    return;
  }

  fetch("/api/sessions/" + encodeURIComponent(sessionId) + "/bootstrap", {
    method: "POST",
    headers: {
      "X-Handrail-Console": "1",
      ...(capability ? { "X-Handrail-Capability": capability } : {})
    },
    credentials: "same-origin",
    cache: "no-store"
  }).then((response) => {
    if (!response.ok) throw new Error("This operator link is invalid or expired.");
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    const runtime = document.createElement("script");
    runtime.src = "/operator-runtime.js";
    runtime.addEventListener("error", () => fail("The operator console could not start."));
    document.head.append(runtime);
  }).catch((error) => fail(error.message));
})();
`;

type OperatorHttpErrorCode =
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "POLICY_DENIED"
  | "SESSION_CONFLICT"
  | "SERVER_CLOSED";

export class OperatorConsoleError extends Error {
  constructor(
    readonly code: OperatorHttpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OperatorConsoleError";
  }
}

interface ResumeWaiter {
  readonly resolve: (result: OperatorResumeResult) => void;
  readonly reject: (error: Error) => void;
}

interface InterventionRecord {
  readonly input: OpenOperatorInterventionInput;
  readonly runId: string;
  readonly capability: string;
  readonly currentStep: string;
  readonly reason: string;
  readonly stoppedBecause: string;
  readonly audit: OperatorAuditEvent[];
  readonly captures: OperatorCapture[];
  readonly waiters: Set<ResumeWaiter>;
  readonly operatorLeaseTtlMs: number;
  readonly automationLeaseTtlMs: number;
  readonly automationId: string;
  readonly capabilityHash: Buffer;
  operatorGrant?: ControlGrant;
  claimHash?: Buffer;
  latestObservation?: OperatorObservationSummary;
  latestScreenshotPng?: Buffer;
  resumeResult?: OperatorResumeResult;
  resuming: boolean;
  connected: boolean;
}

function assertFinitePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("Operator console port must be an integer between 0 and 65535.");
  }
}

function assertLoopbackHost(host: string): void {
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new OperatorConsoleError(
      "FORBIDDEN",
      "The unauthenticated demo operator console may listen only on loopback.",
    );
  }
}

function originFor(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Operator console did not expose a TCP address."));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OperatorConsoleError("BAD_REQUEST", "Request body must be a JSON object.");
  }
  return value as Readonly<Record<string, unknown>>;
}

async function readJsonBody(request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new OperatorConsoleError("BAD_REQUEST", "Content-Type must be application/json.");
  }

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > MAX_REQUEST_BYTES) {
      throw new OperatorConsoleError("BAD_REQUEST", "Request body exceeds the size limit.");
    }
    chunks.push(buffer);
  }

  try {
    return asObject(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
  } catch (error) {
    if (error instanceof OperatorConsoleError) throw error;
    throw new OperatorConsoleError("BAD_REQUEST", "Request body is not valid JSON.");
  }
}

function requiredString(
  body: Readonly<Record<string, unknown>>,
  key: string,
  maxLength: number,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new OperatorConsoleError(
      "BAD_REQUEST",
      `${key} must be a non-empty string no longer than ${maxLength} characters.`,
    );
  }
  return value;
}

function requiredNumber(body: Readonly<Record<string, unknown>>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new OperatorConsoleError("BAD_REQUEST", `${key} must be a finite number.`);
  }
  return value;
}

function requiredEpoch(
  body: Readonly<Record<string, unknown>>,
  key: "epoch" | "expectedEpoch" = "epoch",
): number {
  const epoch = requiredNumber(body, key);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new OperatorConsoleError("BAD_REQUEST", `${key} must be a non-negative safe integer.`);
  }
  return epoch;
}

function validateIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!SAFE_IDENTIFIER.test(normalized)) {
    throw new OperatorConsoleError("BAD_REQUEST", `${label} must be a safe identifier.`);
  }
  return normalized;
}

function validateDisplayText(value: string, label: string, maxLength = 2_000): string {
  const normalized = redactText(value).replaceAll(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new OperatorConsoleError(
      "BAD_REQUEST",
      `${label} must be between 1 and ${maxLength} characters.`,
    );
  }
  return normalized;
}

function digestOpaqueToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function opaqueTokenMatches(token: string, expected: Buffer): boolean {
  const actual = digestOpaqueToken(token);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function capabilityCookieName(sessionId: string): string {
  const suffix = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return `handrail_cap_${suffix}`;
}

function cookieValues(request: IncomingMessage, name: string): readonly string[] {
  const header = request.headers.cookie;
  if (!header) return [];
  return header
    .split(";")
    .map((part) => part.trim().split("=", 2))
    .filter(([key, value]) => key === name && Boolean(value))
    .map(([, value]) => value ?? "");
}

function observationSummary(observation: SurfaceObservation): OperatorObservationSummary {
  return {
    id: observation.id,
    sessionId: observation.sessionId,
    capturedAt: observation.capturedAt,
    fingerprint: observation.fingerprint,
    viewport: { ...observation.viewport },
  };
}

function assertPng(buffer: Buffer): void {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    buffer.byteLength === 0 ||
    buffer.byteLength > MAX_SCREENSHOT_BYTES ||
    signature.some((byte, index) => buffer[index] !== byte)
  ) {
    throw new Error("Surface evidence must be a bounded PNG screenshot.");
  }
}

function redactedDetails(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const redacted = redactValue(value);
  if (typeof redacted !== "object" || redacted === null || Array.isArray(redacted)) {
    return {};
  }
  return redacted as Readonly<Record<string, RedactedValue>>;
}

function effectForOperatorKey(key: string): OperatorAuthorizationContext["effect"] {
  // Enter and Space can activate an unknown focused control, so they are
  // conservatively classified as commit operations.
  if (key === "Enter" || key === "Space") return "commit";
  if (key === "Backspace" || key === "Delete") return "reversible_write";
  return "read";
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.byteLength),
    ...extraHeaders,
  });
  response.end(body);
}

function text(response: ServerResponse, status: number, body: string, contentType: string): void {
  const bytes = Buffer.from(body, "utf8");
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": String(bytes.byteLength),
  });
  response.end(bytes);
}

function errorStatus(error: unknown): number {
  if (error instanceof OperatorConsoleError) {
    switch (error.code) {
      case "BAD_REQUEST":
        return 400;
      case "FORBIDDEN":
      case "POLICY_DENIED":
        return 403;
      case "NOT_FOUND":
        return 404;
      case "SESSION_CONFLICT":
      case "SERVER_CLOSED":
        return 409;
    }
  }
  if (error instanceof ControlError) {
    return error.code === "SESSION_UNKNOWN" ? 404 : 409;
  }
  return 500;
}

function errorCode(error: unknown): string {
  if (error instanceof OperatorConsoleError || error instanceof ControlError) return error.code;
  return "INTERNAL_ERROR";
}

function errorMessage(error: unknown): string {
  if (error instanceof OperatorConsoleError || error instanceof ControlError) {
    return redactText(error.message);
  }
  return "The operator console could not complete the request.";
}

class OperatorConsoleServer implements OperatorConsoleHandle {
  readonly host: string;
  readonly #control: ControlCoordinator;
  readonly #surface: SurfaceAdapter;
  readonly #server: Server;
  readonly #now: () => Date;
  readonly #authorizeOperatorAction: OperatorActionAuthorizer;
  readonly #auditSink?: OperatorConsoleOptions["auditSink"];
  readonly #captureSink?: OperatorConsoleOptions["captureSink"];
  readonly #records = new Map<string, InterventionRecord>();
  port = 0;
  origin = "";
  #closed = false;

  private constructor(options: OperatorConsoleOptions) {
    this.host = options.host ?? "127.0.0.1";
    assertLoopbackHost(this.host);
    this.#control = options.control;
    this.#surface = options.surface;
    this.#now = options.now ?? (() => new Date());
    this.#authorizeOperatorAction =
      options.authorizeOperatorAction ?? denyUnconfiguredOperatorAction;
    this.#auditSink = options.auditSink;
    this.#captureSink = options.captureSink;
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        json(response, errorStatus(error), {
          error: { code: errorCode(error), message: errorMessage(error) },
        });
      });
    });
  }

  static async start(options: OperatorConsoleOptions): Promise<OperatorConsoleServer> {
    const consoleServer = new OperatorConsoleServer(options);
    const requestedPort = options.port ?? 0;
    assertFinitePort(requestedPort);
    consoleServer.port = await listen(consoleServer.#server, consoleServer.host, requestedPort);
    consoleServer.origin = originFor(consoleServer.host, consoleServer.port);
    return consoleServer;
  }

  async openIntervention(
    input: OpenOperatorInterventionInput,
  ): Promise<OperatorInterventionHandle> {
    if (this.#closed) {
      throw new OperatorConsoleError("SERVER_CLOSED", "Operator console is closed.");
    }
    const sessionId = validateIdentifier(input.session.id, "session ID");
    if (this.#records.has(sessionId)) {
      throw new OperatorConsoleError(
        "SESSION_CONFLICT",
        `Session ${sessionId} already has an operator intervention.`,
      );
    }
    if (input.automationGrant.sessionId !== sessionId) {
      throw new OperatorConsoleError(
        "BAD_REQUEST",
        "Automation grant does not belong to the existing surface session.",
      );
    }

    const runId = validateIdentifier(input.runId, "run ID");
    const automationId = validateIdentifier(input.automationId ?? "runtime", "automation ID");
    const capability = validateDisplayText(input.capability, "capability", 280);
    const currentStep = validateDisplayText(input.currentStep, "current step", 280);
    const reason = validateDisplayText(input.reason, "intervention reason");
    const stoppedBecause = validateDisplayText(input.stoppedBecause, "stop reason");
    const operatorLeaseTtlMs = input.operatorLeaseTtlMs ?? 10 * 60_000;
    const automationLeaseTtlMs = input.automationLeaseTtlMs ?? 30 * 60_000;
    if (
      !Number.isSafeInteger(operatorLeaseTtlMs) ||
      operatorLeaseTtlMs <= 0 ||
      !Number.isSafeInteger(automationLeaseTtlMs) ||
      automationLeaseTtlMs <= 0
    ) {
      throw new OperatorConsoleError("BAD_REQUEST", "Lease durations must be positive integers.");
    }

    this.#control.assertGrant(input.automationGrant, "automation");
    this.#control.requestPause(input.automationGrant, reason);
    const waiting = await this.#control.quiesceAutomation(input.automationGrant);
    const interventionCapability = randomBytes(32).toString("base64url");

    const record: InterventionRecord = {
      input,
      runId,
      capability,
      currentStep,
      reason,
      stoppedBecause,
      audit: [],
      captures: [],
      waiters: new Set(),
      operatorLeaseTtlMs,
      automationLeaseTtlMs,
      automationId,
      capabilityHash: digestOpaqueToken(interventionCapability),
      resuming: false,
      connected: true,
    };
    this.#records.set(sessionId, record);
    await this.#appendAudit(
      record,
      "automation_paused",
      "automation",
      automationId,
      waiting.epoch,
      "Automation paused",
      { reason },
    );

    return {
      runId,
      sessionId,
      url: `${this.origin}/operator/${encodeURIComponent(sessionId)}#${CAPABILITY_FRAGMENT_KEY}=${encodeURIComponent(interventionCapability)}`,
      state: () => this.state(sessionId),
      audit: () => this.audit(sessionId),
      captures: () => this.captures(sessionId),
      waitForResume: (signal) => this.#waitForResume(record, signal),
    };
  }

  state(sessionId: string): OperatorConsoleState {
    const record = this.#requireRecord(sessionId);
    return this.#state(record);
  }

  audit(sessionId: string): readonly OperatorAuditEvent[] {
    return this.#requireRecord(sessionId).audit.map((event) => ({
      ...event,
      details: redactedDetails(event.details),
    }));
  }

  captures(sessionId: string): readonly OperatorCapture[] {
    return this.#requireRecord(sessionId).captures.map((capture) => ({
      ...capture,
      screenshotPng: Buffer.from(capture.screenshotPng),
    }));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const closed = new OperatorConsoleError("SERVER_CLOSED", "Operator console closed.");
    for (const record of this.#records.values()) {
      for (const waiter of record.waiters) waiter.reject(closed);
      record.waiters.clear();
    }
    await closeServer(this.#server);
  }

  #requireRecord(sessionId: string): InterventionRecord {
    const record = this.#records.get(sessionId);
    if (!record) {
      throw new OperatorConsoleError("NOT_FOUND", `Unknown operator session ${sessionId}.`);
    }
    return record;
  }

  #requireCapability(request: IncomingMessage, record: InterventionRecord): string {
    const header = request.headers[CAPABILITY_HEADER];
    if (Array.isArray(header)) {
      throw new OperatorConsoleError("FORBIDDEN", "Operator capability is missing or invalid.");
    }
    const candidates = [
      ...(typeof header === "string" ? [header] : []),
      ...cookieValues(request, capabilityCookieName(record.input.session.id)),
    ];
    if (
      candidates.length === 0 ||
      candidates.some(
        (candidate) =>
          candidate.length === 0 ||
          candidate.length > 256 ||
          !opaqueTokenMatches(candidate, record.capabilityHash),
      )
    ) {
      throw new OperatorConsoleError("FORBIDDEN", "Operator capability is missing or invalid.");
    }
    return candidates[0] ?? "";
  }

  #bootstrapState(record: InterventionRecord): OperatorConsoleState {
    const sessionId = record.input.session.id;
    return {
      runId: "authorization-pending",
      sessionId,
      capability: "Authorization pending",
      currentStep: "Authorization pending",
      interventionReason: "Authorize this operator link to load intervention context",
      stoppedBecause: "Intervention details are hidden until authorization succeeds",
      control: {
        sessionId,
        phase: "AWAITING_OPERATOR",
        owner: null,
        epoch: 0,
        expiresAt: null,
        reason: null,
      },
      viewport: { ...record.input.session.viewport },
      activities: [],
      canClaim: false,
      canAct: false,
      canResume: false,
      connected: false,
    };
  }

  #controlSnapshot(sessionId: string) {
    try {
      return this.#control.snapshot(sessionId);
    } catch (error) {
      if (error instanceof ControlError && error.code === "LEASE_EXPIRED") {
        return this.#control.snapshot(sessionId);
      }
      throw error;
    }
  }

  #state(record: InterventionRecord): OperatorConsoleState {
    const control = this.#controlSnapshot(record.input.session.id);
    const operatorOwns = control.phase === "OPERATOR_ACTIVE" && control.owner?.kind === "operator";
    return {
      runId: record.runId,
      sessionId: record.input.session.id,
      capability: record.capability,
      currentStep: record.currentStep,
      interventionReason: record.reason,
      stoppedBecause: record.stoppedBecause,
      control,
      viewport: { ...record.input.session.viewport },
      ...(record.latestObservation
        ? {
            latestObservation: {
              ...record.latestObservation,
              viewport: { ...record.latestObservation.viewport },
            },
          }
        : {}),
      activities: this.audit(record.input.session.id),
      canClaim: control.phase === "AWAITING_OPERATOR" && record.connected,
      canAct: operatorOwns && record.connected && !record.resuming && !record.resumeResult,
      canResume: operatorOwns && record.connected && !record.resuming && !record.resumeResult,
      connected: record.connected,
    };
  }

  async #appendAudit(
    record: InterventionRecord,
    action: OperatorAuditAction,
    actor: OperatorAuditEvent["actor"],
    actorId: string,
    ownerEpoch: number,
    summary: string,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const event: OperatorAuditEvent = {
      schemaVersion: "1.0.0",
      eventId: `operator-audit-${randomUUID()}`,
      type: "operator.audit",
      sequence: record.audit.length + 1,
      timestamp: this.#timestamp(),
      runId: record.runId,
      sessionId: record.input.session.id,
      actor,
      actorId: validateIdentifier(actorId, "actor ID"),
      ownerEpoch,
      action,
      summary: validateDisplayText(summary, "audit summary", 280),
      details: redactedDetails(details),
    };
    record.audit.push(event);
    if (!this.#auditSink) return;

    try {
      await this.#auditSink({ ...event, details: redactedDetails(event.details) });
    } catch {
      record.audit.push({
        schemaVersion: "1.0.0",
        eventId: `operator-audit-${randomUUID()}`,
        type: "operator.audit",
        sequence: record.audit.length + 1,
        timestamp: this.#timestamp(),
        runId: record.runId,
        sessionId: record.input.session.id,
        actor: "system",
        actorId: "operator-console",
        ownerEpoch,
        action: "audit_sink_failed",
        summary: "External audit sink failed; the redacted in-memory audit remains available",
        details: {},
      });
    }
  }

  #timestamp(): string {
    const value = this.#now();
    if (Number.isNaN(value.getTime()))
      throw new Error("Operator console clock returned an invalid Date.");
    return value.toISOString();
  }

  async #observe(record: InterventionRecord): Promise<SurfaceObservation> {
    try {
      const observation = await this.#surface.observe(record.input.session.id);
      if (observation.sessionId !== record.input.session.id) {
        throw new Error("Surface adapter returned an observation for a replacement session.");
      }
      record.connected = true;
      record.latestObservation = observationSummary(observation);
      record.latestScreenshotPng = Buffer.from(observation.screenshotPng);
      return observation;
    } catch (error) {
      record.connected = false;
      throw error;
    }
  }

  async #claim(
    record: InterventionRecord,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const operatorId = validateIdentifier(requiredString(body, "operatorId", 128), "operator ID");
    const expectedEpoch = requiredEpoch(body, "expectedEpoch");
    const snapshot = this.#controlSnapshot(record.input.session.id);
    if (snapshot.epoch !== expectedEpoch) {
      throw new ControlError("CONTROL_LOST", "The claim epoch is stale.");
    }
    if (record.resuming || record.resumeResult) {
      throw new ControlError("CONTROL_LOST", "The intervention is already returning control.");
    }

    const grant = this.#control.claimOperator(
      record.input.session.id,
      operatorId,
      record.operatorLeaseTtlMs,
    );
    const claimId = randomBytes(32).toString("base64url");
    record.operatorGrant = grant;
    record.claimHash = digestOpaqueToken(claimId);
    await this.#appendAudit(
      record,
      "control_claimed",
      "operator",
      operatorId,
      grant.epoch,
      "Control transferred to operator",
      { from: "none", to: "operator" },
    );
    return {
      claimId,
      sessionId: record.input.session.id,
      epoch: grant.epoch,
      expiresAt: grant.expiresAt,
    };
  }

  #requireClaim(record: InterventionRecord, body: Readonly<Record<string, unknown>>): ControlGrant {
    if (record.resuming || record.resumeResult) {
      throw new ControlError("CONTROL_LOST", "The operator claim is stale.");
    }
    const claimId = requiredString(body, "claimId", 256);
    const epoch = requiredEpoch(body);
    if (
      !record.operatorGrant ||
      !record.claimHash ||
      record.operatorGrant.epoch !== epoch ||
      !opaqueTokenMatches(claimId, record.claimHash)
    ) {
      throw new ControlError("CONTROL_LOST", "The operator claim is stale.");
    }
    this.#control.assertGrant(record.operatorGrant, "operator");
    return record.operatorGrant;
  }

  async #authorize(
    record: InterventionRecord,
    grant: ControlGrant,
    action: OperatorAuthorizationContext["action"],
    effect: OperatorAuthorizationContext["effect"],
    details: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    const context: OperatorAuthorizationContext = {
      requestedAt: this.#timestamp(),
      runId: record.runId,
      capability: record.capability,
      currentStep: record.currentStep,
      action,
      effect,
      session: {
        ...record.input.session,
        viewport: { ...record.input.session.viewport },
      },
      sessionId: record.input.session.id,
      ownerEpoch: grant.epoch,
      operatorId: grant.actor.id,
      operatorLeaseExpiresAt: grant.expiresAt,
      details: redactedDetails(details),
    };

    let decision: unknown;
    try {
      decision = await this.#authorizeOperatorAction(context);
    } catch {
      throw new OperatorConsoleError(
        "POLICY_DENIED",
        "Operator authorization failed closed before the surface action.",
      );
    }
    if (typeof decision !== "object" || decision === null || !("allowed" in decision)) {
      throw new OperatorConsoleError(
        "POLICY_DENIED",
        "Operator authorization returned an invalid decision and failed closed.",
      );
    }
    if (decision.allowed !== true) {
      throw new OperatorConsoleError(
        "POLICY_DENIED",
        `Operator policy denied ${action} for effect ${effect}.`,
      );
    }
    const authorization = "authorization" in decision ? decision.authorization : undefined;
    if (
      typeof authorization !== "string" ||
      !SAFE_IDENTIFIER.test(authorization) ||
      authorization.length > 128
    ) {
      throw new OperatorConsoleError(
        "POLICY_DENIED",
        "Operator authorization returned an invalid grant and failed closed.",
      );
    }
    return authorization;
  }

  async #click(
    record: InterventionRecord,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const grant = this.#requireClaim(record, body);
    const x = requiredNumber(body, "x");
    const y = requiredNumber(body, "y");
    if (
      x < 0 ||
      y < 0 ||
      x > record.input.session.viewport.width ||
      y > record.input.session.viewport.height
    ) {
      throw new OperatorConsoleError(
        "BAD_REQUEST",
        "Click coordinates are outside the live viewport.",
      );
    }
    // A coordinate is not bound to a semantic target, so it may activate a
    // submit control and must carry the most conservative effect class.
    const effect = "commit";
    const authorization = await this.#authorize(record, grant, "activate_coordinate", effect, {
      x: Math.round(x),
      y: Math.round(y),
    });
    const receipt = await this.#surface.clickAt(record.input.session.id, x, y, grant);
    await this.#appendAudit(
      record,
      "operator_clicked",
      "operator",
      grant.actor.id,
      grant.epoch,
      "Operator clicked the live session",
      {
        x: Math.round(x),
        y: Math.round(y),
        policyAction: "activate_coordinate",
        effect,
        policyGrantMode: authorization,
        receiptSummary: receipt.summary,
      },
    );
    return { sessionId: record.input.session.id, epoch: grant.epoch, receipt };
  }

  async #typeFocused(
    record: InterventionRecord,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const grant = this.#requireClaim(record, body);
    const value = requiredString(body, "value", MAX_TYPED_CHARACTERS);
    const characterCount = Array.from(value).length;
    const effect = "reversible_write";
    const authorization = await this.#authorize(record, grant, "type", effect, {
      characterCount,
    });
    const receipt = await this.#surface.typeFocused(record.input.session.id, value, grant);
    await this.#appendAudit(
      record,
      "operator_typed",
      "operator",
      grant.actor.id,
      grant.epoch,
      "Operator typed a redacted value into the focused control",
      {
        characterCount,
        policyAction: "type",
        effect,
        policyGrantMode: authorization,
        receiptSummary: receipt.summary,
      },
    );
    return { sessionId: record.input.session.id, epoch: grant.epoch, receipt };
  }

  async #pressKey(
    record: InterventionRecord,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const grant = this.#requireClaim(record, body);
    const key = requiredString(body, "key", 32);
    if (!SAFE_KEYS.has(key)) {
      throw new OperatorConsoleError(
        "BAD_REQUEST",
        "Key is not permitted by the operator console.",
      );
    }
    const effect = effectForOperatorKey(key);
    const authorization = await this.#authorize(record, grant, "press_key", effect, { key });
    const receipt = await this.#surface.pressKey(record.input.session.id, key, grant);
    await this.#appendAudit(
      record,
      "operator_pressed_key",
      "operator",
      grant.actor.id,
      grant.epoch,
      "Operator pressed a permitted key",
      {
        key,
        policyAction: "press_key",
        effect,
        policyGrantMode: authorization,
        receiptSummary: receipt.summary,
      },
    );
    return { sessionId: record.input.session.id, epoch: grant.epoch, receipt };
  }

  async #capture(
    record: InterventionRecord,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const grant = this.#requireClaim(record, body);
    const effect = "read";
    const authorization = await this.#authorize(record, grant, "capture_evidence", effect, {});
    const screenshotPng = await this.#control.withControl(grant, () =>
      this.#surface.captureEvidence(record.input.session.id, "operator-handoff"),
    );
    assertPng(screenshotPng);
    const sha256 = createHash("sha256").update(screenshotPng).digest("hex");
    const capture: OperatorCapture = {
      schemaVersion: "1.0.0",
      id: `operator-capture-${randomUUID()}`,
      runId: record.runId,
      sessionId: record.input.session.id,
      capturedAt: this.#timestamp(),
      sha256,
      byteLength: screenshotPng.byteLength,
      mimeType: "image/png",
      screenshotPng: Buffer.from(screenshotPng),
    };
    record.captures.push(capture);
    if (record.captures.length > MAX_CAPTURES_PER_SESSION) record.captures.shift();
    if (this.#captureSink) {
      await this.#captureSink({ ...capture, screenshotPng: Buffer.from(capture.screenshotPng) });
    }
    await this.#appendAudit(
      record,
      "evidence_captured",
      "operator",
      grant.actor.id,
      grant.epoch,
      "Evidence captured",
      {
        captureId: capture.id,
        sha256,
        byteLength: capture.byteLength,
        policyAction: "capture_evidence",
        effect,
        policyGrantMode: authorization,
      },
    );
    return {
      sessionId: record.input.session.id,
      epoch: grant.epoch,
      capture: { id: capture.id, sha256, byteLength: capture.byteLength },
    };
  }

  async #resume(
    record: InterventionRecord,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const operatorGrant = this.#requireClaim(record, body);
    record.resuming = true;
    try {
      const fresh = await this.#control.withControl(operatorGrant, async () => {
        const observation = await this.#observe(record);
        const rawCheckpoint = await record.input.evaluateCheckpoint({
          session: record.input.session,
          observation,
        });
        if (typeof rawCheckpoint.passed !== "boolean") {
          throw new Error("Resume checkpoint must return a boolean passed signal.");
        }
        const checkpoint: ResumeCheckpointSignal = {
          passed: rawCheckpoint.passed,
          observed: validateDisplayText(rawCheckpoint.observed, "checkpoint observation"),
        };
        return { observation, checkpoint };
      });

      this.#control.requestResume(operatorGrant);
      const automationGrant = this.#control.returnToAutomation(
        operatorGrant,
        record.automationId,
        record.automationLeaseTtlMs,
      );
      const result: OperatorResumeResult = {
        runId: record.runId,
        sessionId: record.input.session.id,
        resumedAt: this.#timestamp(),
        automationGrant,
        observation: fresh.observation,
        checkpoint: fresh.checkpoint,
      };
      record.resumeResult = result;
      await this.#appendAudit(
        record,
        "control_returned",
        "system",
        "operator-console",
        automationGrant.epoch,
        "Control returned to automation after a fresh observation and checkpoint",
        {
          freshObservationId: fresh.observation.id,
          checkpointPassed: fresh.checkpoint.passed,
          checkpointObserved: fresh.checkpoint.observed,
        },
      );
      for (const waiter of record.waiters) waiter.resolve(result);
      record.waiters.clear();
      return {
        sessionId: record.input.session.id,
        epoch: automationGrant.epoch,
        phase: "AUTOMATION_ACTIVE",
        freshObservation: observationSummary(fresh.observation),
        checkpoint: fresh.checkpoint,
      };
    } finally {
      record.resuming = false;
    }
  }

  #waitForResume(record: InterventionRecord, signal?: AbortSignal): Promise<OperatorResumeResult> {
    if (record.resumeResult) return Promise.resolve(record.resumeResult);
    if (this.#closed) {
      return Promise.reject(new OperatorConsoleError("SERVER_CLOSED", "Operator console closed."));
    }
    if (signal?.aborted) return Promise.reject(signal.reason);

    return new Promise((resolve, reject) => {
      const waiter: ResumeWaiter = { resolve, reject };
      record.waiters.add(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          record.waiters.delete(waiter);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  #checkMutationRequest(request: IncomingMessage): void {
    const origin = request.headers.origin;
    if (origin && origin !== this.origin) {
      throw new OperatorConsoleError("FORBIDDEN", "Cross-origin operator action was rejected.");
    }
    if (request.headers["x-handrail-console"] !== "1") {
      throw new OperatorConsoleError("FORBIDDEN", "Operator action header is required.");
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );

    const requestUrl = new URL(request.url ?? "/", this.origin);
    if (request.method === "GET" && requestUrl.pathname === "/") {
      throw new OperatorConsoleError(
        "NOT_FOUND",
        "Open the exact capability-bearing URL for an operator intervention.",
      );
    }
    if (request.method === "GET" && requestUrl.pathname === "/operator.css") {
      text(response, 200, OPERATOR_CSS, "text/css; charset=utf-8");
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/operator.js") {
      text(response, 200, OPERATOR_BOOTSTRAP_SCRIPT, "text/javascript; charset=utf-8");
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/operator-runtime.js") {
      text(response, 200, OPERATOR_SCRIPT, "text/javascript; charset=utf-8");
      return;
    }

    const segments = requestUrl.pathname.split("/").filter(Boolean);
    if (request.method === "GET" && segments[0] === "operator" && segments.length === 2) {
      const sessionId = decodeURIComponent(segments[1] ?? "");
      const record = this.#requireRecord(sessionId);
      const screenshotSource = `src="/api/sessions/${encodeURIComponent(sessionId)}/screenshot"`;
      const shell = renderOperatorConsole(this.#bootstrapState(record)).replace(
        screenshotSource,
        "",
      );
      text(response, 200, shell, "text/html; charset=utf-8");
      return;
    }
    if (segments[0] !== "api" || segments[1] !== "sessions" || segments.length !== 4) {
      throw new OperatorConsoleError("NOT_FOUND", "Operator route not found.");
    }

    const sessionId = decodeURIComponent(segments[2] ?? "");
    const action = segments[3] ?? "";
    const record = this.#requireRecord(sessionId);
    if (action === "bootstrap") {
      if (request.method !== "POST") {
        throw new OperatorConsoleError("NOT_FOUND", "Operator route not found.");
      }
      this.#checkMutationRequest(request);
      const capability = this.#requireCapability(request, record);
      const cookieName = capabilityCookieName(record.input.session.id);
      const cookiePath = `/api/sessions/${encodeURIComponent(record.input.session.id)}/`;
      response.writeHead(204, {
        "Content-Length": "0",
        "Set-Cookie": `${cookieName}=${capability}; HttpOnly; SameSite=Strict; Path=${cookiePath}`,
      });
      response.end();
      return;
    }
    this.#requireCapability(request, record);
    if (request.method === "GET" && action === "state") {
      json(response, 200, this.#state(record));
      return;
    }
    if (request.method === "GET" && action === "screenshot") {
      const control = this.#controlSnapshot(record.input.session.id);
      const mustUseCachedScreenshot =
        record.resuming || (control.owner?.kind === "automation" && Boolean(record.resumeResult));
      let screenshotPng: Buffer;
      let summary: OperatorObservationSummary;
      if (mustUseCachedScreenshot) {
        if (!record.latestScreenshotPng || !record.latestObservation) {
          throw new ControlError(
            "CONTROL_LOST",
            "A live screenshot cannot be refreshed while automation owns the session.",
          );
        }
        screenshotPng = record.latestScreenshotPng;
        summary = record.latestObservation;
      } else {
        const observation = await this.#observe(record);
        screenshotPng = observation.screenshotPng;
        summary = observationSummary(observation);
      }
      assertPng(screenshotPng);
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": String(screenshotPng.byteLength),
        "X-Handrail-Session-Id": summary.sessionId,
        "X-Handrail-Observation-Id": summary.id,
        "X-Handrail-Viewport-Width": String(summary.viewport.width),
        "X-Handrail-Viewport-Height": String(summary.viewport.height),
      });
      response.end(screenshotPng);
      return;
    }

    if (request.method !== "POST") {
      throw new OperatorConsoleError("NOT_FOUND", "Operator route not found.");
    }
    this.#checkMutationRequest(request);
    const body = await readJsonBody(request);
    let result: Readonly<Record<string, unknown>>;
    switch (action) {
      case "claim":
        result = await this.#claim(record, body);
        break;
      case "click":
        result = await this.#click(record, body);
        break;
      case "type":
        result = await this.#typeFocused(record, body);
        break;
      case "key":
        result = await this.#pressKey(record, body);
        break;
      case "capture":
        result = await this.#capture(record, body);
        break;
      case "resume":
        result = await this.#resume(record, body);
        break;
      default:
        throw new OperatorConsoleError("NOT_FOUND", "Operator action not found.");
    }
    json(response, 200, result);
  }
}

export async function startOperatorConsole(
  options: OperatorConsoleOptions,
): Promise<OperatorConsoleHandle> {
  return OperatorConsoleServer.start(options);
}
