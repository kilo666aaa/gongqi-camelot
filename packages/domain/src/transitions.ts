import { evaluateCandidate, missingCandidateFields } from './evaluate';
import type { GuardResult, ProposalInput } from './types';

export function canPropose(state:ProposalInput):GuardResult {
  if (state.actorUid!==state.hostUid) return {ok:false,code:'FORBIDDEN'};
  if (state.status!=='ACTIVE'||state.phase!=='OPEN') return {ok:false,code:'INVALID_STATE'};
  if (state.expectedDecisionRevision!==state.decisionRevision) return {ok:false,code:'VERSION_CONFLICT'};
  const uids=state.members.map(member=>member.uid);
  const active=new Set(uids),confirmed=new Set(state.confirmedRoster);
  if (active.size<2||active.size>6||active.size!==uids.length||confirmed.size!==state.confirmedRoster.length||
      state.rosterConfirmedRevision!==state.rosterRevision||active.size!==confirmed.size||
      !uids.every(uid=>confirmed.has(uid))||!active.has(state.hostUid)) {
    return {ok:false,code:'ROSTER_NOT_READY'};
  }
  if (state.members.some(member=>!member.submitted||state.conditionsByUid[member.uid]===undefined)) {
    return {ok:false,code:'MEMBERS_NOT_READY'};
  }
  if (state.candidate.roomId!==state.roomId||state.candidate.roundId!==state.roundId||
      missingCandidateFields(state.candidate).length>0) {
    return {ok:false,code:'CANDIDATE_INCOMPLETE'};
  }
  if (evaluateCandidate(state.candidate,state.members,state.conditionsByUid,state.travelByUid).status!=='PASS') {
    return {ok:false,code:'NOT_FEASIBLE'};
  }
  return {ok:true};
}
