import type { Candidate, Conditions, Phase, RoomStatus, RuleResult, TravelEstimate, Visibility } from '@gongqi/contracts';

export interface MemberInput { uid:string; submitted:boolean; online?:boolean }
export type ConditionsByUid = Readonly<Record<string,Conditions|undefined>>;
export type TravelByUid = Readonly<Record<string,Readonly<Record<string,TravelEstimate|undefined>>|undefined>>;
export interface RuleCheck {
  uid:string; rule:'budget'|'time'|'travel'|'venue'; status:RuleResult; visibility:Visibility;
}
/** Internal evaluation. Must pass through a permission projection before sharing. */
export interface Evaluation {
  candidateId:string; createdAt:string; status:RuleResult; provisional:boolean;
  preferenceMatches:number; missingFields:string[]; checks:RuleCheck[];
}
export interface ProposalInput {
  roomId:string; roundId:string; status:RoomStatus; phase:Phase;
  hostUid:string; actorUid:string; decisionRevision:number; expectedDecisionRevision:number;
  rosterRevision:number; rosterConfirmedRevision:number|null; confirmedRoster:readonly string[];
  members:readonly MemberInput[]; candidate:Candidate;
  conditionsByUid:ConditionsByUid; travelByUid:TravelByUid;
}
export type GuardResult = {ok:true}|{ok:false;code:
  'FORBIDDEN'|'INVALID_STATE'|'VERSION_CONFLICT'|'ROSTER_NOT_READY'|
  'MEMBERS_NOT_READY'|'CANDIDATE_INCOMPLETE'|'NOT_FEASIBLE'};
