import type { Evaluation } from './types';

const order={PASS:0,UNKNOWN:1,FAIL:2};
export function rankCandidates(evaluations:readonly Evaluation[]):Evaluation[] {
  return [...evaluations].sort((a,b)=>order[a.status]-order[b.status]||
    b.preferenceMatches-a.preferenceMatches||Date.parse(a.createdAt)-Date.parse(b.createdAt)||
    (a.candidateId<b.candidateId?-1:a.candidateId>b.candidateId?1:0));
}
