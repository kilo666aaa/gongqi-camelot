import type { RoomPhase } from '@gongqi/contracts/v2';
import {
  guardMember,
  isFrozenRoster,
  sameRoster,
  type GuardResult,
} from './authorization';
import { majorityThreshold } from './rounds';

export interface ReopenRequest {
  id: string;
  cycleId: string;
  rosterUids: readonly string[];
  rosterRevision: number;
  targetRevisionIds: readonly string[];
  status: 'OPEN' | 'APPROVED' | 'CANCELLED';
}

export interface ReopenVote {
  requestId: string;
  uid: string;
  choice: 'REOPEN' | 'KEEP_DISCUSSING';
}

export interface ReopenContext {
  phase: RoomPhase;
  rosterRevision: number;
  rosterUids: readonly string[];
  targetRevisionIds: readonly string[];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length
    && left.every(id => right.includes(id));
}

function guardReopenContext(request: ReopenRequest, context: ReopenContext): GuardResult {
  if (context.phase !== 'DISCUSSING') return { ok: false, code: 'INVALID_STATE' };
  if (!isFrozenRoster(context.rosterUids)) return { ok: false, code: 'ROSTER_NOT_READY' };
  if (request.rosterRevision !== context.rosterRevision
    || !sameRoster(request.rosterUids, context.rosterUids)) {
    return { ok: false, code: 'ROSTER_CHANGED' };
  }
  if (!sameIds(request.targetRevisionIds, context.targetRevisionIds)) {
    return { ok: false, code: 'CANDIDATE_REVISION_MISMATCH' };
  }
  return { ok: true };
}

export function guardReopenVote(
  request: ReopenRequest,
  actorUid: string,
  context: ReopenContext,
): GuardResult {
  const contextGuard = guardReopenContext(request, context);
  if (!contextGuard.ok) return contextGuard;
  if (request.status !== 'OPEN') return { ok: false, code: 'INVALID_STATE' };
  return guardMember(actorUid, request.rosterUids);
}

export function resolveReopenRequest(
  request: ReopenRequest,
  votes: readonly ReopenVote[],
): ReopenRequest {
  if (request.status !== 'OPEN' || !isFrozenRoster(request.rosterUids)) return request;
  const reopenVoters = new Set(votes
    .filter(vote => vote.requestId === request.id && vote.choice === 'REOPEN'
      && request.rosterUids.includes(vote.uid))
    .map(vote => vote.uid));
  return reopenVoters.size >= majorityThreshold(request.rosterUids)
    ? { ...request, status: 'APPROVED' }
    : request;
}

export function guardApprovedReopen(request: ReopenRequest, context: ReopenContext): GuardResult {
  const contextGuard = guardReopenContext(request, context);
  if (!contextGuard.ok) return contextGuard;
  return request.status === 'APPROVED' ? { ok: true } : { ok: false, code: 'REOPEN_NOT_APPROVED' };
}

export function cancelReopenForRosterChange(
  request: ReopenRequest,
  currentRosterRevision: number,
  currentRosterUids: readonly string[],
): ReopenRequest {
  if (request.status !== 'OPEN') return request;
  if (request.rosterRevision === currentRosterRevision && sameRoster(request.rosterUids, currentRosterUids)) {
    return request;
  }
  return { ...request, status: 'CANCELLED' };
}

export function phaseAfterRosterChange(hasPublicCandidates: boolean): RoomPhase {
  return hasPublicCandidates ? 'CANDIDATE_REVIEW' : 'COLLECTING';
}
