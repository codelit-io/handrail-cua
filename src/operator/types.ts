import type { EffectClass } from "../domain/schema.js";
import type { ControlGrant, ControlSnapshot } from "../runtime/control.js";
import type { ActionReceipt, SurfaceObservation, SurfaceSession } from "../surface/types.js";

export type OperatorPolicyAction =
  | "activate_coordinate"
  | "type"
  | "press_key"
  | "capture_evidence";

/**
 * Audit-safe context supplied immediately before an operator action can reach
 * the SurfaceAdapter. Raw typed values and the opaque control token are never
 * exposed to the authorization hook.
 */
export interface OperatorAuthorizationContext {
  readonly requestedAt: string;
  readonly runId: string;
  readonly capability: string;
  readonly currentStep: string;
  readonly action: OperatorPolicyAction;
  readonly effect: EffectClass;
  readonly session: SurfaceSession;
  readonly sessionId: string;
  readonly ownerEpoch: number;
  readonly operatorId: string;
  readonly operatorLeaseExpiresAt: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface OperatorPolicyGrant {
  readonly allowed: true;
  /** Audit-safe policy or approval mode, for example `human_control`. */
  readonly authorization: string;
}

export interface OperatorPolicyDenial {
  readonly allowed: false;
  readonly code: string;
  readonly summary: string;
}

export type OperatorPolicyDecision = OperatorPolicyGrant | OperatorPolicyDenial;

export type OperatorActionAuthorizer = (
  context: OperatorAuthorizationContext,
) => OperatorPolicyDecision | Promise<OperatorPolicyDecision>;

export type OperatorAuditAction =
  | "automation_paused"
  | "control_claimed"
  | "operator_clicked"
  | "operator_typed"
  | "operator_pressed_key"
  | "evidence_captured"
  | "control_returned"
  | "audit_sink_failed";

export interface OperatorAuditEvent extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: "1.0.0";
  readonly eventId: string;
  readonly type: "operator.audit";
  readonly sequence: number;
  readonly timestamp: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly actor: "automation" | "operator" | "system";
  readonly actorId: string;
  readonly ownerEpoch: number;
  readonly action: OperatorAuditAction;
  readonly summary: string;
  /** Values are redacted before this object is retained or sent to a sink. */
  readonly details: Readonly<Record<string, unknown>>;
}

export interface ResumeCheckpointSignal {
  readonly passed: boolean;
  readonly observed: string;
}

export interface OperatorCapture {
  readonly schemaVersion: "1.0.0";
  readonly id: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly capturedAt: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mimeType: "image/png";
  readonly screenshotPng: Buffer;
}

/**
 * Sink return values are deliberately opaque. The server awaits promises, so a
 * durable writer may return its native append/write receipt without an adapter
 * that discards it.
 */
export type OperatorAuditSink = (event: OperatorAuditEvent) => unknown;
export type OperatorCaptureSink = (capture: OperatorCapture) => unknown;

export interface OpenOperatorInterventionInput {
  readonly runId: string;
  readonly capability: string;
  readonly currentStep: string;
  readonly reason: string;
  readonly stoppedBecause: string;
  /** The existing session. The operator layer never creates or replaces it. */
  readonly session: SurfaceSession;
  /** The current automation grant, revoked when this intervention opens. */
  readonly automationGrant: ControlGrant;
  readonly automationId?: string;
  readonly operatorLeaseTtlMs?: number;
  readonly automationLeaseTtlMs?: number;
  readonly evaluateCheckpoint: (context: {
    readonly session: SurfaceSession;
    readonly observation: SurfaceObservation;
  }) => Promise<ResumeCheckpointSignal>;
}

export interface OperatorObservationSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly capturedAt: string;
  readonly fingerprint: string;
  readonly viewport: { readonly width: number; readonly height: number };
}

export interface OperatorConsoleState {
  readonly runId: string;
  readonly sessionId: string;
  readonly capability: string;
  readonly currentStep: string;
  readonly interventionReason: string;
  readonly stoppedBecause: string;
  readonly control: ControlSnapshot;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly latestObservation?: OperatorObservationSummary;
  readonly activities: readonly OperatorAuditEvent[];
  readonly canClaim: boolean;
  readonly canAct: boolean;
  readonly canResume: boolean;
  readonly connected: boolean;
}

export interface OperatorResumeResult {
  readonly runId: string;
  readonly sessionId: string;
  readonly resumedAt: string;
  readonly automationGrant: ControlGrant;
  readonly observation: SurfaceObservation;
  readonly checkpoint: ResumeCheckpointSignal;
}

export interface OperatorConsoleOptions {
  readonly control: import("../runtime/control.js").ControlCoordinator;
  readonly surface: import("../surface/types.js").SurfaceAdapter;
  readonly host?: string;
  readonly port?: number;
  readonly now?: () => Date;
  /** Omission denies every operator surface action and evidence capture. */
  readonly authorizeOperatorAction?: OperatorActionAuthorizer;
  readonly auditSink?: OperatorAuditSink;
  readonly captureSink?: OperatorCaptureSink;
}

export interface OperatorInterventionHandle {
  readonly runId: string;
  readonly sessionId: string;
  /** Bearer-capability URL. Display to the assigned operator; never persist or audit it. */
  readonly url: string;
  state: () => OperatorConsoleState;
  audit: () => readonly OperatorAuditEvent[];
  captures: () => readonly OperatorCapture[];
  waitForResume: (signal?: AbortSignal) => Promise<OperatorResumeResult>;
}

export interface OperatorConsoleHandle {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  openIntervention: (input: OpenOperatorInterventionInput) => Promise<OperatorInterventionHandle>;
  state: (sessionId: string) => OperatorConsoleState;
  audit: (sessionId: string) => readonly OperatorAuditEvent[];
  captures: (sessionId: string) => readonly OperatorCapture[];
  close: () => Promise<void>;
}

export interface OperatorActionResult {
  readonly sessionId: string;
  readonly epoch: number;
  readonly receipt: ActionReceipt;
}
