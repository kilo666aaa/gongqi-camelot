import type { RoomPhase } from '@gongqi/contracts/v2';

const phaseFlow: readonly RoomPhase[] = [
  'COLLECTING',
  'CANDIDATE_REVIEW',
  'EVALUATING',
  'DISCUSSING',
  'CONFIRMING',
  'COMPLETED',
];

const guardedReturnEdges: Partial<Record<RoomPhase, readonly RoomPhase[]>> = {
  CANDIDATE_REVIEW: ['COLLECTING'],
  EVALUATING: ['CANDIDATE_REVIEW', 'COLLECTING'],
  DISCUSSING: ['EVALUATING', 'CANDIDATE_REVIEW', 'COLLECTING'],
  CONFIRMING: ['DISCUSSING', 'CANDIDATE_REVIEW', 'COLLECTING'],
  COMPLETED: ['COLLECTING'],
};

export function canTransitionPhase(from: RoomPhase, to: RoomPhase): boolean {
  return phaseFlow[phaseFlow.indexOf(from) + 1] === to
    || guardedReturnEdges[from]?.includes(to) === true;
}
