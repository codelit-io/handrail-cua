import type { ControlGrant, ControlSnapshot } from "../runtime/control.js";
import type { ActionReceipt, SurfaceObservation, SurfaceSession } from "../surface/types.js";

export type OperatorAuditAction =
  | "automation_paused"
  | "control_claimed"
  | "operator_clicked"
  | "operator_typed"
  | "operator_pressed_key"
  | "evidence_captured"
  | "control_returned"
  | "audit_sink_failed";

export interface OperatorAuditEvent {
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
  readonly id: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly capturedAt: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly screenshotPng: Buffer;
}

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
  readonly auditSink?: (event: OperatorAuditEvent) => Promise<void> | void;
  readonly captureSink?: (capture: OperatorCapture) => Promise<void> | void;
}

export interface OperatorInterventionHandle {
  readonly runId: string;
  readonly sessionId: string;
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
