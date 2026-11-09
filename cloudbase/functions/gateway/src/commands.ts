import { z } from 'zod';
import {
  addCommentCommandSchema,
  archiveRoomCommandSchema,
  askRoomAssistantInputSchema,
  cancelReopenCommandSchema,
  changeRosterCommandSchema,
  closeCollectionCommandSchema,
  closeEvaluationCommandSchema,
  closeRoomCommandSchema,
  closeUnresolvedCommandSchema,
  deleteRoomCommandSchema,
  createCandidateCommandSchema,
  createRoomCommandSchema,
  idSchema,
  joinRoomCommandSchema,
  openEvaluationCommandSchema,
  proposeFinalCommandSchema,
  requestReopenCommandSchema,
  respondFinalCommandSchema,
  retractRoundCloseVoteCommandSchema,
  reviseCandidateCommandSchema,
  roomAssistantMessagesInputSchema,
  rotateInviteCommandSchema,
  setRoundDeadlineCommandSchema,
  startNextCycleCommandSchema,
  suggestCandidatesInputSchema,
  submitEvaluationCommandSchema,
  submitIdeaCommandSchema,
  submitIdeaSkipCommandSchema,
  transferHostCommandSchema,
  voteReopenCommandSchema,
  voteRoundCloseCommandSchema,
  withdrawCandidateCommandSchema,
} from '@gongqi/contracts/v2';
import { AiError } from './ai/errors';
import type { RoomAssistantService } from './ai/roomAssistant';
import type { SuggestCandidatesService } from './ai/suggestCandidates';
import { setStage } from './diagnostics';
import type { PgV2Repository } from './repositories/pgV2Repository';

export type GatewayRepository = Pick<PgV2Repository,
  | 'createRoom'
  | 'rotateInvite'
  | 'joinRoom'
  | 'submitIdea'
  | 'submitIdeaSkip'
  | 'closeCollection'
  | 'openEvaluation'
  | 'submitEvaluation'
  | 'closeEvaluation'
  | 'voteRoundClose'
  | 'retractRoundCloseVote'
  | 'setRoundDeadline'
  | 'proposeFinal'
  | 'respondFinal'
  | 'closeUnresolved'
  | 'addComment'
  | 'reviseCandidate'
  | 'requestReopen'
  | 'voteReopen'
  | 'cancelReopen'
  | 'createCandidate'
  | 'withdrawCandidate'
  | 'changeRoster'
  | 'changeRoomLifecycle'
  | 'startNextCycle'
  | 'transferHost'
  | 'getSnapshot'
  | 'registerAssistantRequest'
  | 'completeAssistantRequest'
  | 'getRoomAssistantMessages'
>;

const gatewayRequestSchema = z.object({
  action: z.enum([
    'createRoom',
    'rotateInvite',
    'joinRoom',
    'submitIdea',
    'submitIdeaSkip',
    'closeCollection',
    'openEvaluation',
    'submitEvaluation',
    'closeEvaluation',
    'voteRoundClose',
    'retractRoundCloseVote',
    'setRoundDeadline',
    'proposeFinal',
    'respondFinal',
    'closeUnresolved',
    'addComment',
    'reviseCandidate',
    'requestReopen',
    'voteReopen',
    'cancelReopen',
    'createCandidate',
    'withdrawCandidate',
    'changeRoster',
    'archiveRoom',
    'closeRoom',
    'deleteRoom',
    'startNextCycle',
    'transferHost',
    'getSnapshot',
    'suggestCandidates',
    'askRoomAssistant',
    'getRoomAssistantMessages',
  ]),
  input: z.unknown(),
}).strict();

const snapshotQuerySchema = z.object({ roomId: idSchema }).strict();

export async function dispatchCommand(
  repository: GatewayRepository,
  actorUid: string,
  request: unknown,
  ai?: SuggestCandidatesService,
  assistant?: RoomAssistantService,
): Promise<unknown> {
  const { action, input } = gatewayRequestSchema.parse(request);
  setStage('command');
  switch (action) {
    case 'createRoom':
      return repository.createRoom(actorUid, createRoomCommandSchema.parse(input));
    case 'rotateInvite':
      return repository.rotateInvite(actorUid, rotateInviteCommandSchema.parse(input));
    case 'joinRoom':
      return repository.joinRoom(actorUid, joinRoomCommandSchema.parse(input));
    case 'submitIdea':
      return repository.submitIdea(actorUid, submitIdeaCommandSchema.parse(input));
    case 'submitIdeaSkip':
      return repository.submitIdeaSkip(actorUid, submitIdeaSkipCommandSchema.parse(input));
    case 'closeCollection':
      return repository.closeCollection(actorUid, closeCollectionCommandSchema.parse(input));
    case 'openEvaluation':
      return repository.openEvaluation(actorUid, openEvaluationCommandSchema.parse(input));
    case 'submitEvaluation':
      return repository.submitEvaluation(actorUid, submitEvaluationCommandSchema.parse(input));
    case 'closeEvaluation':
      return repository.closeEvaluation(actorUid, closeEvaluationCommandSchema.parse(input));
    case 'voteRoundClose':
      return repository.voteRoundClose(actorUid, voteRoundCloseCommandSchema.parse(input));
    case 'retractRoundCloseVote':
      return repository.retractRoundCloseVote(actorUid, retractRoundCloseVoteCommandSchema.parse(input));
    case 'setRoundDeadline':
      return repository.setRoundDeadline(actorUid, setRoundDeadlineCommandSchema.parse(input));
    case 'proposeFinal':
      return repository.proposeFinal(actorUid, proposeFinalCommandSchema.parse(input));
    case 'respondFinal':
      return repository.respondFinal(actorUid, respondFinalCommandSchema.parse(input));
    case 'closeUnresolved':
      return repository.closeUnresolved(actorUid, closeUnresolvedCommandSchema.parse(input));
    case 'addComment':
      return repository.addComment(actorUid, addCommentCommandSchema.parse(input));
    case 'reviseCandidate':
      return repository.reviseCandidate(actorUid, reviseCandidateCommandSchema.parse(input));
    case 'requestReopen':
      return repository.requestReopen(actorUid, requestReopenCommandSchema.parse(input));
    case 'voteReopen':
      return repository.voteReopen(actorUid, voteReopenCommandSchema.parse(input));
    case 'cancelReopen':
      return repository.cancelReopen(actorUid, cancelReopenCommandSchema.parse(input));
    case 'createCandidate':
      return repository.createCandidate(actorUid, createCandidateCommandSchema.parse(input));
    case 'withdrawCandidate':
      return repository.withdrawCandidate(actorUid, withdrawCandidateCommandSchema.parse(input));
    case 'changeRoster':
      return repository.changeRoster(actorUid, changeRosterCommandSchema.parse(input));
    case 'archiveRoom':
      return repository.changeRoomLifecycle(actorUid, 'ARCHIVE', archiveRoomCommandSchema.parse(input));
    case 'closeRoom':
      return repository.changeRoomLifecycle(actorUid, 'CLOSE', closeRoomCommandSchema.parse(input));
    case 'deleteRoom':
      return repository.changeRoomLifecycle(actorUid, 'DELETE', deleteRoomCommandSchema.parse(input));
    case 'startNextCycle':
      return repository.startNextCycle(actorUid, startNextCycleCommandSchema.parse(input));
    case 'transferHost':
      return repository.transferHost(actorUid, transferHostCommandSchema.parse(input));
    case 'getSnapshot': {
      setStage('snapshot-query');
      const { roomId } = snapshotQuerySchema.parse(input);
      return repository.getSnapshot(actorUid, roomId);
    }
    case 'suggestCandidates': {
      setStage('ai-suggest');
      const { roomId } = suggestCandidatesInputSchema.parse(input);
      if (!ai) throw new AiError('AI_UNAVAILABLE');
      const snapshot = await repository.getSnapshot(actorUid, roomId);
      return ai.suggest({
        actorUid,
        roomId,
        snapshot,
        revalidate: async () => (await repository.getSnapshot(actorUid, roomId)).version,
      });
    }
    case 'askRoomAssistant': {
      setStage('ai-assistant');
      const command = askRoomAssistantInputSchema.parse(input);
      if (!assistant) throw new AiError('AI_UNAVAILABLE');
      const snapshot = await repository.getSnapshot(actorUid, command.roomId);
      if (snapshot.version !== command.expectedSnapshotVersion) throw new AiError('AI_STALE_CONTEXT');
      const registered = await repository.registerAssistantRequest(actorUid, command);
      if (registered.status !== 'PENDING') return { status: 'applied', message: registered };
      try {
        const generated = await assistant.answer({
          actorUid,
          roomId: command.roomId,
          snapshot,
          action: command.action,
          question: command.question,
        });
        return {
          status: 'applied',
          message: await repository.completeAssistantRequest(actorUid, {
            roomId: command.roomId,
            requestId: command.requestId,
            status: 'SUCCEEDED',
            answer: generated.answer,
            sourceIds: generated.sourceIds,
          }),
        };
      } catch (error) {
        const errorCode = error instanceof AiError ? error.code : 'AI_UNAVAILABLE';
        try {
          await repository.completeAssistantRequest(actorUid, {
            roomId: command.roomId,
            requestId: command.requestId,
            status: 'FAILED',
            sourceIds: [],
            errorCode,
          });
        } catch {
          // Keep the original failure; an abandoned PENDING row is surfaced as AI_TIMEOUT on read.
        }
        throw error;
      }
    }
    case 'getRoomAssistantMessages': {
      const { roomId } = roomAssistantMessagesInputSchema.parse(input);
      return repository.getRoomAssistantMessages(actorUid, roomId);
    }
  }
}
