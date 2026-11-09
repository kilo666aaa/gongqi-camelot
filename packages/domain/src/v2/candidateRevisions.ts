import type { CandidateRevision } from '@gongqi/contracts/v2';

export interface ReevaluationPlan {
  targetRevisionIds: string[];
  carriedRevisionIds: string[];
}

function canonical(value: unknown): unknown {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ');
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function hasSubstantiveRevisionChange(previous: CandidateRevision, next: CandidateRevision): boolean {
  return previous.candidateId !== next.candidateId
    || previous.templateId !== next.templateId
    || JSON.stringify(canonical(previous.title)) !== JSON.stringify(canonical(next.title))
    || JSON.stringify(canonical(previous.body)) !== JSON.stringify(canonical(next.body))
    || JSON.stringify(canonical(previous.templatePayload)) !== JSON.stringify(canonical(next.templatePayload));
}

export function planReevaluation(
  previousRevisions: readonly CandidateRevision[],
  currentRevisions: readonly CandidateRevision[],
  includeUnchangedRevisionIds: readonly string[] = [],
): ReevaluationPlan {
  const targetRevisionIds: string[] = [];
  const carriedRevisionIds: string[] = [];
  for (const current of currentRevisions) {
    const previous = previousRevisions.find(revision => revision.candidateId === current.candidateId);
    if (previous === undefined || hasSubstantiveRevisionChange(previous, current)
      || includeUnchangedRevisionIds.includes(current.id)) {
      targetRevisionIds.push(current.id);
    } else {
      carriedRevisionIds.push(current.id);
    }
  }
  return { targetRevisionIds, carriedRevisionIds };
}

export function commentRequiresReevaluation(): boolean {
  return false;
}
