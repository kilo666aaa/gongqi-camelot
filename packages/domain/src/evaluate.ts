import type { Candidate, RuleResult, TimeRange } from '@gongqi/contracts';
import type { ConditionsByUid, Evaluation, MemberInput, TravelByUid } from './types';

export function missingCandidateFields(candidate:Candidate):string[] {
  const missing:string[]=[];
  if (candidate.time===null) missing.push('time');
  if (candidate.estimatedCostFen===null) missing.push('estimatedCostFen');
  if (candidate.location===null||candidate.location.trim()==='') missing.push('location');
  if (candidate.venue===null) missing.push('venue');
  if (candidate.activityType===null) missing.push('activityType');
  if (candidate.withdrawn) missing.push('withdrawn');
  return missing;
}

function containsTime(available:readonly TimeRange[], time:TimeRange):boolean {
  const intervals=available.map(range=>[Date.parse(range.startAt),Date.parse(range.endAt)] as const)
    .sort((a,b)=>a[0]-b[0]);
  const start=Date.parse(time.startAt),end=Date.parse(time.endAt);
  let coveredUntil=start;
  for (const [a,b] of intervals) {
    if (b<coveredUntil) continue;
    if (a>coveredUntil) return false;
    coveredUntil=Math.max(coveredUntil,b);
    if (coveredUntil>=end) return true;
  }
  return false;
}

export function evaluateCandidate(
  candidate:Candidate, members:readonly MemberInput[],
  conditionsByUid:ConditionsByUid, travelByUid:TravelByUid,
):Evaluation {
  const missingFields=missingCandidateFields(candidate);
  const result:Evaluation={candidateId:candidate.id,createdAt:candidate.createdAt,status:'PASS',
    provisional:members.length===0,preferenceMatches:0,missingFields,checks:[]};
  const seen=new Set<string>();
  for (const member of members) {
    if (seen.has(member.uid)) {result.provisional=true;continue;}
    seen.add(member.uid);
    const conditions=conditionsByUid[member.uid];
    if (!member.submitted||conditions===undefined) {result.provisional=true;continue;}
    const add=(rule:'budget'|'time'|'travel'|'venue', status:RuleResult,
               visibility:'public'|'computeOnly')=>result.checks.push({uid:member.uid,rule,status,visibility});
    const budget=conditions.budgetFen;
    if (budget.kind==='value') add('budget',candidate.estimatedCostFen===null?'UNKNOWN':
      candidate.estimatedCostFen<=budget.value?'PASS':'FAIL',budget.visibility);
    const time=conditions.available;
    if (time.kind==='value') add('time',candidate.time===null?'UNKNOWN':
      containsTime(time.value,candidate.time)?'PASS':'FAIL',time.visibility);
    const travel=conditions.travelMinutes;
    if (travel.kind==='value') {
      const estimate=travelByUid[member.uid]?.[candidate.id];
      const current=estimate!==undefined && estimate.uid===member.uid &&
        estimate.candidateId===candidate.id && estimate.destinationRevision===candidate.destinationRevision;
      add('travel',!current?'UNKNOWN':estimate.minutes<=travel.value?'PASS':'FAIL',travel.visibility);
    }
    const venue=conditions.venue;
    if (venue.kind==='value') add('venue',candidate.venue===null?'UNKNOWN':
      candidate.venue===venue.value?'PASS':'FAIL',venue.visibility);
    if (candidate.activityType!==null && conditions.preferredTypes.includes(candidate.activityType)) {
      result.preferenceMatches+=1;
    }
  }
  if (result.checks.some(check=>check.status==='FAIL')) result.status='FAIL';
  else if (result.provisional||missingFields.length>0||result.checks.some(check=>check.status==='UNKNOWN')) result.status='UNKNOWN';
  return result;
}
