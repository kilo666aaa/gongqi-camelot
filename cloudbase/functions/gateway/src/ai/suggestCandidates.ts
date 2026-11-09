import { z } from 'zod';
import {
  candidateSuggestionSchema,
  suggestCandidatesResultSchema,
  type CandidateSuggestion,
  type RoomSnapshot,
  type SuggestCandidatesResult,
} from '@gongqi/contracts/v2';
import { AiError } from './errors';
import type { AiTextProvider } from './deepseekProvider';

export type { AiTextProvider } from './deepseekProvider';

export interface SuggestCandidatesService {
  suggest(input: {
    actorUid: string;
    roomId: string;
    snapshot: RoomSnapshot;
    revalidate?: () => Promise<number>;
  }): Promise<SuggestCandidatesResult>;
}

interface SuggestionContext {
  roomTitle: string;
  purpose: string;
  ideas: { id: string; text: string }[];
  existingCandidates: { title: string; body: string }[];
}

const ELIGIBLE_PHASES = new Set(['CANDIDATE_REVIEW', 'DISCUSSING']);
const MAX_SUGGESTIONS = 5;

export function buildSuggestionContext(snapshot: RoomSnapshot): SuggestionContext {
  const shared = snapshot.shared;
  if (!ELIGIBLE_PHASES.has(shared.phase)) throw new AiError('AI_PHASE_NOT_ELIGIBLE');
  const ideas = shared.publicIdeas.map(idea => ({ id: idea.id, text: idea.text }));
  if (ideas.length === 0) throw new AiError('AI_NO_PUBLIC_INPUT');
  const activeRevisionIds = new Set(
    shared.candidates.filter(candidate => candidate.withdrawnAt === null).map(candidate => candidate.currentRevisionId),
  );
  return {
    roomTitle: shared.title,
    purpose: shared.purpose,
    ideas,
    existingCandidates: shared.currentRevisions
      .filter(revision => activeRevisionIds.has(revision.id))
      .map(revision => ({ title: revision.title, body: revision.body })),
  };
}

export function buildSuggestionPrompt(context: SuggestionContext): { system: string; user: string } {
  return {
    system: [
      '你是“共契”房间的候选整理助手。',
      '只允许使用用户消息中给出的公开输入和现有候选，不得引入外部事实，也不得编造来源。',
      '输出必须是严格 JSON 对象：{"suggestions":[{"title":"...","body":"...","sourceIdeaIds":["..."]}]}。',
      `最多 ${MAX_SUGGESTIONS} 条建议；每条建议至少引用一个给定的公开输入 ID，sourceIdeaIds 只能使用给定 ID。`,
      '建议只是草案，不是决定；不要声称已获得同意，不要输出投票、排名或最终结论。',
      '使用简体中文，标题不超过 80 字，具体安排不超过 4000 字。',
    ].join('\n'),
    user: JSON.stringify({
      roomTitle: context.roomTitle,
      purpose: context.purpose,
      publicIdeas: context.ideas,
      existingCandidates: context.existingCandidates,
    }, null, 2),
  };
}

function parseJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  try {
    return JSON.parse(fenced ? fenced[1]! : trimmed);
  } catch {
    throw new AiError('AI_INVALID_OUTPUT');
  }
}

const providerOutputSchema = z.object({
  suggestions: z.array(candidateSuggestionSchema).min(1).max(MAX_SUGGESTIONS),
}).strict();

export function validateSuggestions(value: unknown, allowedIdeaIds: ReadonlySet<string>): CandidateSuggestion[] {
  const parsed = providerOutputSchema.safeParse(value);
  if (!parsed.success) throw new AiError('AI_INVALID_OUTPUT');
  const seen = new Set<string>();
  for (const suggestion of parsed.data.suggestions) {
    if (!suggestion.sourceIdeaIds.every(id => allowedIdeaIds.has(id))) {
      throw new AiError('AI_INVALID_OUTPUT');
    }
    const key = `${suggestion.title}\u0000${suggestion.body}`;
    if (seen.has(key)) throw new AiError('AI_INVALID_OUTPUT');
    seen.add(key);
  }
  return parsed.data.suggestions;
}

export function createSuggestCandidatesService(options: {
  provider?: AiTextProvider | undefined;
  now?: () => Date;
  cacheLimit?: number;
  rateLimitMs?: number;
}): SuggestCandidatesService {
  const now = options.now ?? (() => new Date());
  const cacheLimit = options.cacheLimit ?? 50;
  const rateLimitMs = options.rateLimitMs ?? 5_000;
  const cache = new Map<string, SuggestCandidatesResult>();
  const lastModelCall = new Map<string, number>();

  return {
    async suggest({ actorUid, roomId, snapshot, revalidate }): Promise<SuggestCandidatesResult> {
      const context = buildSuggestionContext(snapshot);
      const cacheKey = `PUBLIC:${roomId}:${snapshot.version}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;
      if (!options.provider) throw new AiError('AI_UNAVAILABLE');

      const rateKey = `${actorUid}:${roomId}`;
      const nowMs = now().getTime();
      const previous = lastModelCall.get(rateKey);
      if (previous !== undefined && nowMs - previous < rateLimitMs) throw new AiError('AI_RATE_LIMITED');
      lastModelCall.set(rateKey, nowMs);

      let raw: string;
      try {
        raw = await options.provider.complete(buildSuggestionPrompt(context));
      } catch (error) {
        if (error instanceof AiError) throw error;
        throw new AiError('AI_UNAVAILABLE');
      }

      const suggestions = validateSuggestions(
        parseJson(raw),
        new Set(context.ideas.map(idea => idea.id)),
      );
      if (revalidate) {
        const currentVersion = await revalidate();
        if (currentVersion !== snapshot.version) throw new AiError('AI_STALE_CONTEXT');
      }

      const result = suggestCandidatesResultSchema.parse({
        status: 'suggested',
        roomId,
        snapshotVersion: snapshot.version,
        scope: 'PUBLIC',
        generatedAt: now().toISOString(),
        suggestions,
      });
      cache.set(cacheKey, result);
      while (cache.size > cacheLimit) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return result;
    },
  };
}
