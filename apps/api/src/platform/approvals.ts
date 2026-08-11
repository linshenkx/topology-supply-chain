import { PlatformError } from "../errors.js";
import type { QueryExecutor } from "../infrastructure/database.js";

export interface ApprovalClaim {
  action: string;
  challengeNo: string;
  objectId: string;
  objectType: string;
  objectVersion: number;
  requestDigest: string;
  sessionId: number;
  userId: number;
}

export interface ApprovalPolicyDecision {
  allowed: boolean;
  reasonCode: string;
}

export interface ApprovalPolicyPort {
  evaluate(claim: ApprovalClaim): Promise<ApprovalPolicyDecision>;
}

export class ApprovalPolicyRegistry implements ApprovalPolicyPort {
  readonly #policies = new Map<string, ApprovalPolicyPort>();

  register(objectType: string, policy: ApprovalPolicyPort): void {
    const key = objectType.trim();
    if (!key || this.#policies.has(key)) throw new Error("Approval policy registration rejected");
    this.#policies.set(key, policy);
  }

  async evaluate(claim: ApprovalClaim): Promise<ApprovalPolicyDecision> {
    const policy = this.#policies.get(claim.objectType);
    return policy === undefined
      ? { allowed: false, reasonCode: "NO_DOMAIN_POLICY" }
      : policy.evaluate(claim);
  }
}

export interface ApprovalEffectContext {
  claim: ApprovalClaim;
  transaction: QueryExecutor;
}

export interface ApprovalEffectPort<Result = unknown> {
  effectType: string;
  execute(context: ApprovalEffectContext): Promise<Result>;
}

export class ApprovalEffectRegistry {
  readonly #effects = new Map<string, ApprovalEffectPort>();

  register(effect: ApprovalEffectPort): void {
    const type = effect.effectType.trim();
    if (type.length === 0 || this.#effects.has(type)) {
      throw new Error("Approval effect registration rejected");
    }
    this.#effects.set(type, effect);
  }

  resolve(effectType: string): ApprovalEffectPort {
    const effect = this.#effects.get(effectType);
    if (effect === undefined) {
      throw new PlatformError(404, "NOT_FOUND", "Approval effect not registered");
    }
    return effect;
  }

  registeredTypes(): readonly string[] {
    return [...this.#effects.keys()].sort();
  }
}

export async function consumeStepUpClaim(
  transaction: QueryExecutor,
  claim: ApprovalClaim,
): Promise<void> {
  const consumed = await transaction.execute(
    `UPDATE auth_challenges
     SET consumed_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
     WHERE challenge_no = ? AND user_id = ? AND session_id = ?
       AND purpose = 'high_risk' AND action = ? AND object_type = ?
       AND object_id = ? AND object_version = ? AND request_digest = ?
       AND verified_at IS NOT NULL AND consumed_at IS NULL
       AND expires_at > ?`,
    [
      claim.challengeNo,
      claim.userId,
      claim.sessionId,
      claim.action,
      claim.objectType,
      claim.objectId,
      claim.objectVersion,
      claim.requestDigest,
      new Date().toISOString(),
    ],
  );
  if (consumed.affectedRows !== 1) {
    throw new PlatformError(409, "CONFLICT", "Step-up claim is invalid or consumed");
  }
}
