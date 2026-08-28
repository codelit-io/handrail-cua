import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type ControlOwnerKind = "automation" | "operator";
export type ControlPhase =
  | "AUTOMATION_ACTIVE"
  | "PAUSE_REQUESTED"
  | "AWAITING_OPERATOR"
  | "OPERATOR_ACTIVE"
  | "RESUME_REQUESTED"
  | "COMPLETED"
  | "FAILED"
  | "EXPIRED";

export interface ControlOwner {
  kind: ControlOwnerKind;
  id: string;
}

export interface ControlGrant {
  sessionId: string;
  actor: ControlOwner;
  epoch: number;
  leaseToken: string;
  expiresAt: string;
}

export interface ControlSnapshot {
  sessionId: string;
  phase: ControlPhase;
  owner: ControlOwner | null;
  epoch: number;
  expiresAt: string | null;
  reason: string | null;
}

interface LeaseRecord extends ControlSnapshot {
  tokenHash: string | null;
}

export class ControlError extends Error {
  constructor(
    readonly code: "CONTROL_LOST" | "INVALID_TRANSITION" | "SESSION_UNKNOWN" | "LEASE_EXPIRED",
    message: string,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function copySnapshot(record: LeaseRecord): ControlSnapshot {
  return {
    sessionId: record.sessionId,
    phase: record.phase,
    owner: record.owner ? { ...record.owner } : null,
    epoch: record.epoch,
    expiresAt: record.expiresAt,
    reason: record.reason,
  };
}

export class ControlCoordinator {
  readonly #leases = new Map<string, LeaseRecord>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #inFlight = new Map<string, { readonly epoch: number; readonly tokenHash: string }>();

  createAutomationLease(
    sessionId: string,
    automationId = "runtime",
    ttlMs = 30 * 60_000,
  ): ControlGrant {
    if (this.#leases.has(sessionId)) {
      throw new ControlError("INVALID_TRANSITION", `Session ${sessionId} already has a lease.`);
    }

    const grant = this.#issueGrant(sessionId, { kind: "automation", id: automationId }, 1, ttlMs);
    this.#leases.set(sessionId, {
      sessionId,
      phase: "AUTOMATION_ACTIVE",
      owner: grant.actor,
      epoch: grant.epoch,
      tokenHash: hashToken(grant.leaseToken),
      expiresAt: grant.expiresAt,
      reason: null,
    });
    return grant;
  }

  snapshot(sessionId: string): ControlSnapshot {
    const record = this.#requireRecord(sessionId);
    this.#expireIfNeeded(record, true);
    return copySnapshot(record);
  }

  assertGrant(grant: ControlGrant, expectedKind?: ControlOwnerKind): void {
    const record = this.#requireRecord(grant.sessionId);
    this.#expireIfNeeded(record);
    this.#assertGrantIdentity(record, grant, expectedKind);
  }

  requestPause(grant: ControlGrant, reason: string): ControlSnapshot {
    this.assertGrant(grant, "automation");
    const record = this.#requireRecord(grant.sessionId);
    this.#expectPhase(record, "AUTOMATION_ACTIVE");
    record.phase = "PAUSE_REQUESTED";
    record.reason = reason;
    return copySnapshot(record);
  }

  async quiesceAutomation(grant: ControlGrant): Promise<ControlSnapshot> {
    return this.#enqueue(grant.sessionId, async () => {
      this.assertGrant(grant, "automation");
      const record = this.#requireRecord(grant.sessionId);
      this.#expectPhase(record, "PAUSE_REQUESTED");
      record.phase = "AWAITING_OPERATOR";
      record.owner = null;
      record.tokenHash = null;
      record.expiresAt = null;
      record.epoch += 1;
      return copySnapshot(record);
    });
  }

  claimOperator(sessionId: string, operatorId: string, ttlMs = 10 * 60_000): ControlGrant {
    const record = this.#requireRecord(sessionId);
    this.#expireIfNeeded(record);
    this.#expectPhase(record, "AWAITING_OPERATOR");
    const grant = this.#issueGrant(
      sessionId,
      { kind: "operator", id: operatorId },
      record.epoch + 1,
      ttlMs,
    );
    record.phase = "OPERATOR_ACTIVE";
    record.owner = grant.actor;
    record.epoch = grant.epoch;
    record.tokenHash = hashToken(grant.leaseToken);
    record.expiresAt = grant.expiresAt;
    return grant;
  }

  requestResume(grant: ControlGrant): ControlSnapshot {
    this.assertGrant(grant, "operator");
    const record = this.#requireRecord(grant.sessionId);
    this.#expectPhase(record, "OPERATOR_ACTIVE");
    record.phase = "RESUME_REQUESTED";
    return copySnapshot(record);
  }

  returnToAutomation(
    grant: ControlGrant,
    automationId = "runtime",
    ttlMs = 30 * 60_000,
  ): ControlGrant {
    this.assertGrant(grant, "operator");
    const record = this.#requireRecord(grant.sessionId);
    this.#expectPhase(record, "RESUME_REQUESTED");
    const automationGrant = this.#issueGrant(
      grant.sessionId,
      { kind: "automation", id: automationId },
      record.epoch + 1,
      ttlMs,
    );
    record.phase = "AUTOMATION_ACTIVE";
    record.owner = automationGrant.actor;
    record.epoch = automationGrant.epoch;
    record.tokenHash = hashToken(automationGrant.leaseToken);
    record.expiresAt = automationGrant.expiresAt;
    record.reason = null;
    return automationGrant;
  }

  async complete(grant: ControlGrant): Promise<ControlSnapshot> {
    return this.#enqueue(grant.sessionId, async () => {
      this.assertGrant(grant);
      const record = this.#requireRecord(grant.sessionId);
      record.phase = "COMPLETED";
      record.owner = null;
      record.tokenHash = null;
      record.expiresAt = null;
      record.epoch += 1;
      return copySnapshot(record);
    });
  }

  async fail(grant: ControlGrant, reason: string): Promise<ControlSnapshot> {
    return this.#enqueue(grant.sessionId, async () => {
      this.assertGrant(grant);
      const record = this.#requireRecord(grant.sessionId);
      record.phase = "FAILED";
      record.owner = null;
      record.tokenHash = null;
      record.expiresAt = null;
      record.reason = reason;
      record.epoch += 1;
      return copySnapshot(record);
    });
  }

  async failQuiesced(
    sessionId: string,
    expectedEpoch: number,
    reason: string,
  ): Promise<ControlSnapshot> {
    return this.#enqueue(sessionId, async () => {
      const record = this.#requireRecord(sessionId);
      this.#expectPhase(record, "AWAITING_OPERATOR");
      if (record.owner !== null || record.epoch !== expectedEpoch) {
        throw new ControlError(
          "CONTROL_LOST",
          "The quiesced control epoch changed before terminal failure.",
        );
      }
      record.phase = "FAILED";
      record.owner = null;
      record.tokenHash = null;
      record.expiresAt = null;
      record.reason = reason;
      record.epoch += 1;
      return copySnapshot(record);
    });
  }

  async withControl<T>(grant: ControlGrant, action: () => Promise<T>): Promise<T> {
    return this.#enqueue(grant.sessionId, async () => {
      this.assertGrant(grant);
      const record = this.#requireRecord(grant.sessionId);
      const expectedPhase =
        grant.actor.kind === "automation" ? "AUTOMATION_ACTIVE" : "OPERATOR_ACTIVE";
      if (record.phase !== expectedPhase) {
        throw new ControlError(
          "CONTROL_LOST",
          `${grant.actor.kind} cannot start an action while control is ${record.phase}.`,
        );
      }
      const inFlight = { epoch: grant.epoch, tokenHash: hashToken(grant.leaseToken) };
      this.#inFlight.set(grant.sessionId, inFlight);
      try {
        const result = await action();
        // A pause request may arrive while an already-authorized action is in flight. The
        // grant remains valid until this boundary returns; quiescence is queued behind it.
        // Validate revocation and identity without retroactively rejecting a successful
        // mutation solely because its lease TTL elapsed while the action was in flight.
        const settledRecord = this.#requireRecord(grant.sessionId);
        this.#assertGrantIdentity(settledRecord, grant);
        return result;
      } finally {
        if (this.#inFlight.get(grant.sessionId) === inFlight) {
          const settledRecord = this.#leases.get(grant.sessionId);
          if (settledRecord && this.#grantIdentityMatches(settledRecord, grant)) {
            this.#expireSettledOperatorLease(settledRecord);
          }
          this.#inFlight.delete(grant.sessionId);
        }
      }
    });
  }

  async #enqueue<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(sessionId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#queues.set(sessionId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release?.();
      if (this.#queues.get(sessionId) === tail) this.#queues.delete(sessionId);
    }
  }

  #issueGrant(sessionId: string, actor: ControlOwner, epoch: number, ttlMs: number): ControlGrant {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new ControlError("INVALID_TRANSITION", "Lease TTL must be a positive duration.");
    }
    return {
      sessionId,
      actor,
      epoch,
      leaseToken: randomBytes(32).toString("base64url"),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
  }

  #requireRecord(sessionId: string): LeaseRecord {
    const record = this.#leases.get(sessionId);
    if (!record) throw new ControlError("SESSION_UNKNOWN", `Unknown session ${sessionId}.`);
    return record;
  }

  #expectPhase(record: LeaseRecord, expected: ControlPhase): void {
    if (record.phase !== expected) {
      throw new ControlError(
        "INVALID_TRANSITION",
        `Expected ${expected}, observed ${record.phase} for session ${record.sessionId}.`,
      );
    }
  }

  #assertGrantIdentity(
    record: LeaseRecord,
    grant: ControlGrant,
    expectedKind?: ControlOwnerKind,
  ): void {
    if (!this.#grantIdentityMatches(record, grant)) {
      throw new ControlError(
        "CONTROL_LOST",
        "The control grant is stale or does not own the session.",
      );
    }
    if (expectedKind && record.owner?.kind !== expectedKind) {
      throw new ControlError("CONTROL_LOST", `${expectedKind} does not own the session.`);
    }
  }

  #grantIdentityMatches(record: LeaseRecord, grant: ControlGrant): boolean {
    const owner = record.owner;
    return (
      record.epoch === grant.epoch &&
      owner !== null &&
      owner.kind === grant.actor.kind &&
      owner.id === grant.actor.id &&
      record.tokenHash !== null &&
      tokenMatches(grant.leaseToken, record.tokenHash)
    );
  }

  #expireSettledOperatorLease(record: LeaseRecord): void {
    if (
      record.owner?.kind !== "operator" ||
      !record.expiresAt ||
      Date.parse(record.expiresAt) > Date.now()
    ) {
      return;
    }
    record.owner = null;
    record.tokenHash = null;
    record.expiresAt = null;
    record.epoch += 1;
    record.phase = "AWAITING_OPERATOR";
  }

  #expireIfNeeded(record: LeaseRecord, deferInFlightExpiry = false): void {
    if (!record.expiresAt || Date.parse(record.expiresAt) > Date.now()) return;
    const inFlight = this.#inFlight.get(record.sessionId);
    if (
      inFlight?.epoch === record.epoch &&
      record.tokenHash !== null &&
      inFlight.tokenHash === record.tokenHash
    ) {
      if (deferInFlightExpiry) return;
      throw new ControlError("LEASE_EXPIRED", "The control lease expired during an action.");
    }
    const expiredOperator = record.owner?.kind === "operator";
    record.owner = null;
    record.tokenHash = null;
    record.expiresAt = null;
    record.epoch += 1;
    record.phase = expiredOperator ? "AWAITING_OPERATOR" : "EXPIRED";
    record.reason = expiredOperator ? record.reason : "Automation lease expired.";
    throw new ControlError("LEASE_EXPIRED", "The control lease expired.");
  }
}
