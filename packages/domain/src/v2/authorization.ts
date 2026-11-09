export type GuardCode =
  | 'FORBIDDEN'
  | 'ROSTER_NOT_READY'
  | 'ROSTER_CHANGED'
  | 'ROUND_CLOSED'
  | 'CANDIDATE_REVISION_MISMATCH'
  | 'INVALID_DEADLINE'
  | 'INVALID_REASON'
  | 'PROPOSAL_CLOSED'
  | 'PROPOSAL_EXPIRED'
  | 'PROPOSAL_MISMATCH'
  | 'VERSION_CONFLICT'
  | 'INVALID_STATE'
  | 'REOPEN_NOT_APPROVED';
export type GuardResult = { ok: true } | { ok: false; code: GuardCode };
export type RuleResult<T> = { ok: true; value: T } | { ok: false; code: GuardCode };

export function isFrozenRoster(uids: readonly string[]): boolean {
  return uids.length >= 2 && uids.length <= 6 && new Set(uids).size === uids.length;
}

export function sameRoster(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length
    && left.every(uid => right.includes(uid));
}

export function guardHost(actorUid: string, hostUid: string): GuardResult {
  return actorUid === hostUid ? { ok: true } : { ok: false, code: 'FORBIDDEN' };
}

export function guardMember(actorUid: string, rosterUids: readonly string[]): GuardResult {
  return rosterUids.includes(actorUid) ? { ok: true } : { ok: false, code: 'FORBIDDEN' };
}
