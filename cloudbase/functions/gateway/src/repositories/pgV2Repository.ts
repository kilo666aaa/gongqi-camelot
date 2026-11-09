import { createHash } from 'node:crypto';
import { Pool, type PoolConfig } from 'pg';
import { z } from 'zod';
import { noteEnvelopeShape, setStage } from '../diagnostics';
import {
  addCommentCommandSchema,
  addCommentResultSchema,
  archiveRoomCommandSchema,
  askRoomAssistantInputSchema,
  cancelReopenCommandSchema,
  cancelReopenResultSchema,
  changeRosterCommandSchema,
  changeRosterResultSchema,
  closeCollectionCommandSchema,
  closeCollectionResultSchema,
  closeEvaluationCommandSchema,
  closeEvaluationResultSchema,
  closeRoomCommandSchema,
  closeUnresolvedCommandSchema,
  closeUnresolvedResultSchema,
  deleteRoomCommandSchema,
  createCandidateCommandSchema,
  createCandidateResultSchema,
  createRoomCommandSchema,
  createRoomResultSchema,
  idSchema,
  ideaSubmissionResultSchema,
  joinRoomCommandSchema,
  joinRoomResultSchema,
  openEvaluationCommandSchema,
  openEvaluationResultSchema,
  proposeFinalCommandSchema,
  proposeFinalResultSchema,
  respondFinalCommandSchema,
  respondFinalResultSchema,
  retractRoundCloseVoteCommandSchema,
  retractRoundCloseVoteResultSchema,
  roomAssistantMessageSchema,
  roomAssistantMessagesResultSchema,
  requestReopenCommandSchema,
  requestReopenResultSchema,
  reviseCandidateCommandSchema,
  reviseCandidateResultSchema,
  roomLifecycleResultSchema,
  roomSnapshotForMemberSchema,
  rotateInviteCommandSchema,
  rotateInviteResultSchema,
  setRoundDeadlineCommandSchema,
  setRoundDeadlineResultSchema,
  startNextCycleCommandSchema,
  startNextCycleResultSchema,
  submitEvaluationCommandSchema,
  submitEvaluationResultSchema,
  submitIdeaCommandSchema,
  submitIdeaSkipCommandSchema,
  transferHostCommandSchema,
  transferHostResultSchema,
  uidSchema,
  voteReopenCommandSchema,
  voteReopenResultSchema,
  voteRoundCloseCommandSchema,
  voteRoundCloseResultSchema,
  withdrawCandidateCommandSchema,
  withdrawCandidateResultSchema,
  type AddCommentCommand,
  type AddCommentResult,
  type ArchiveRoomCommand,
  type AskRoomAssistantInput,
  type CancelReopenCommand,
  type CancelReopenResult,
  type ChangeRosterCommand,
  type ChangeRosterResult,
  type CloseCollectionCommand,
  type CloseCollectionResult,
  type CloseEvaluationCommand,
  type CloseRoomCommand,
  type CloseUnresolvedCommand,
  type CloseUnresolvedResult,
  type CreateCandidateCommand,
  type CreateCandidateResult,
  type CreateRoomCommand,
  type CreateRoomResult,
  type DeleteRoomCommand,
  type IdeaSubmissionResult,
  type JoinRoomCommand,
  type JoinRoomResult,
  type OpenEvaluationCommand,
  type ProposeFinalCommand,
  type ProposeFinalResult,
  type RequestReopenCommand,
  type RequestReopenResult,
  type RoomLifecycleResult,
  type RespondFinalCommand,
  type RespondFinalResult,
  type RetractRoundCloseVoteCommand,
  type ReviseCandidateCommand,
  type ReviseCandidateResult,
  type RoomAssistantMessage,
  type RoomAssistantMessagesResult,
  type RotateInviteCommand,
  type SetRoundDeadlineCommand,
  type RotateInviteResult,
  type StartNextCycleCommand,
  type StartNextCycleResult,
  type SubmitEvaluationCommand,
  type TransferHostCommand,
  type TransferHostResult,
  type SubmitIdeaCommand,
  type SubmitIdeaSkipCommand,
  type VoteReopenCommand,
  type VoteReopenResult,
  type VoteRoundCloseCommand,
  type WithdrawCandidateCommand,
  type WithdrawCandidateResult,
} from '@gongqi/contracts/v2';

const rpcEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string().regex(/^[A-Z0-9_]+$/) }).strict(),
  }).strict(),
]);

export type OpenEvaluationResult = z.infer<typeof openEvaluationResultSchema>;
export type SubmitEvaluationResult = z.infer<typeof submitEvaluationResultSchema>;
export type CloseEvaluationResult = z.infer<typeof closeEvaluationResultSchema>;

export class PgV2CommandError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PgV2CommandError';
  }
}

function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface PgV2RpcTransport {
  call(actorUid: string, rpcName: string, commands: readonly unknown[]): Promise<unknown>;
  close?(): Promise<void>;
}

class LocalPgRpcTransport implements PgV2RpcTransport {
  readonly #pool: Pool;

  constructor(config: PoolConfig) {
    this.#pool = new Pool(config);
  }

  async call(actorUid: string, rpcName: string, commands: readonly unknown[]): Promise<unknown> {
    const roomIdParameter = rpcName === 'gq_get_snapshot' || rpcName === 'gq_get_assistant_messages'
      ? '$2'
      : '$2::jsonb';
    const result = await this.#pool.query<{ result: unknown }>(
      `SELECT public.${rpcName}($1, ${roomIdParameter}) AS result`,
      [actorUid, ...commands.map(command => typeof command === 'string' ? command : JSON.stringify(command))],
    );
    if (result.rowCount !== 1) throw new Error('PG_RPC_ROW_COUNT_INVALID');
    return result.rows[0]?.result;
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

export class PgV2Repository {
  readonly #transport: PgV2RpcTransport;

  constructor(configOrTransport: PoolConfig | PgV2RpcTransport) {
    this.#transport = 'call' in configOrTransport
      ? configOrTransport
      : new LocalPgRpcTransport(configOrTransport);
  }

  async createRoom(actorUid: string, input: CreateRoomCommand): Promise<CreateRoomResult> {
    const command = createRoomCommandSchema.parse(input);
    return createRoomResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_create_room',
      [command],
    ));
  }

  async rotateInvite(actorUid: string, input: RotateInviteCommand): Promise<RotateInviteResult> {
    const { inviteToken, ...command } = rotateInviteCommandSchema.parse(input);
    const result = rotateInviteResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_rotate_invite',
      [{ ...command, inviteTokenHash: hashInviteToken(inviteToken) }],
    ));
    // The bearer token is returned only from the validated request, never persisted in RPC responses.
    return { ...result, inviteToken };
  }

  async joinRoom(actorUid: string, input: JoinRoomCommand): Promise<JoinRoomResult> {
    const { inviteToken, ...command } = joinRoomCommandSchema.parse(input);
    return joinRoomResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_join_room',
      [{ ...command, inviteTokenHash: hashInviteToken(inviteToken) }],
    ));
  }

  async submitIdea(actorUid: string, input: SubmitIdeaCommand): Promise<IdeaSubmissionResult> {
    const command = submitIdeaCommandSchema.parse(input);
    return ideaSubmissionResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_submit_idea',
      [command],
    ));
  }

  async submitIdeaSkip(actorUid: string, input: SubmitIdeaSkipCommand): Promise<IdeaSubmissionResult> {
    const command = submitIdeaSkipCommandSchema.parse(input);
    return ideaSubmissionResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_submit_idea_skip',
      [command],
    ));
  }

  async closeCollection(actorUid: string, input: CloseCollectionCommand): Promise<CloseCollectionResult> {
    const command = closeCollectionCommandSchema.parse(input);
    return closeCollectionResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_close_collection',
      [command],
    ));
  }

  async openEvaluation(actorUid: string, input: OpenEvaluationCommand): Promise<OpenEvaluationResult> {
    const command = openEvaluationCommandSchema.parse(input);
    return openEvaluationResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_open_evaluation',
      [command],
    ));
  }

  async submitEvaluation(actorUid: string, input: SubmitEvaluationCommand): Promise<SubmitEvaluationResult> {
    const command = submitEvaluationCommandSchema.parse(input);
    return submitEvaluationResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_submit_evaluation',
      [command],
    ));
  }

  async closeEvaluation(actorUid: string, input: CloseEvaluationCommand): Promise<CloseEvaluationResult> {
    const command = closeEvaluationCommandSchema.parse(input);
    return closeEvaluationResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_close_evaluation',
      [command],
    ));
  }

  async voteRoundClose(actorUid: string, input: VoteRoundCloseCommand) {
    const command = voteRoundCloseCommandSchema.parse(input);
    return voteRoundCloseResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_vote_round_close',
      [command],
    ));
  }

  async retractRoundCloseVote(actorUid: string, input: RetractRoundCloseVoteCommand) {
    const command = retractRoundCloseVoteCommandSchema.parse(input);
    return retractRoundCloseVoteResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_retract_round_close_vote',
      [command],
    ));
  }

  async setRoundDeadline(actorUid: string, input: SetRoundDeadlineCommand) {
    const command = setRoundDeadlineCommandSchema.parse(input);
    return setRoundDeadlineResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_set_round_deadline',
      [command],
    ));
  }

  async proposeFinal(actorUid: string, input: ProposeFinalCommand): Promise<ProposeFinalResult> {
    const command = proposeFinalCommandSchema.parse(input);
    return proposeFinalResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_propose_final',
      [command],
    ));
  }

  async respondFinal(actorUid: string, input: RespondFinalCommand): Promise<RespondFinalResult> {
    const command = respondFinalCommandSchema.parse(input);
    return respondFinalResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_respond_final',
      [command],
    ));
  }

  async closeUnresolved(actorUid: string, input: CloseUnresolvedCommand): Promise<CloseUnresolvedResult> {
    const command = closeUnresolvedCommandSchema.parse(input);
    return closeUnresolvedResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_close_unresolved',
      [command],
    ));
  }

  async addComment(actorUid: string, input: AddCommentCommand): Promise<AddCommentResult> {
    const command = addCommentCommandSchema.parse(input);
    return addCommentResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_add_comment',
      [command],
    ));
  }

  async createCandidate(actorUid: string, input: CreateCandidateCommand): Promise<CreateCandidateResult> {
    const command = createCandidateCommandSchema.parse(input);
    return createCandidateResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_create_candidate',
      [command],
    ));
  }

  async withdrawCandidate(actorUid: string, input: WithdrawCandidateCommand): Promise<WithdrawCandidateResult> {
    const command = withdrawCandidateCommandSchema.parse(input);
    return withdrawCandidateResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_withdraw_candidate',
      [command],
    ));
  }

  async reviseCandidate(actorUid: string, input: ReviseCandidateCommand): Promise<ReviseCandidateResult> {
    const command = reviseCandidateCommandSchema.parse(input);
    return reviseCandidateResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_revise_candidate',
      [command],
    ));
  }

  async requestReopen(actorUid: string, input: RequestReopenCommand): Promise<RequestReopenResult> {
    const command = requestReopenCommandSchema.parse(input);
    return requestReopenResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_request_reopen',
      [command],
    ));
  }

  async voteReopen(actorUid: string, input: VoteReopenCommand): Promise<VoteReopenResult> {
    const command = voteReopenCommandSchema.parse(input);
    return voteReopenResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_vote_reopen',
      [command],
    ));
  }

  async cancelReopen(actorUid: string, input: CancelReopenCommand): Promise<CancelReopenResult> {
    const command = cancelReopenCommandSchema.parse(input);
    return cancelReopenResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_cancel_reopen',
      [command],
    ));
  }

  async changeRoster(actorUid: string, input: ChangeRosterCommand): Promise<ChangeRosterResult> {
    const command = changeRosterCommandSchema.parse(input);
    return changeRosterResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_change_roster',
      [command],
    ));
  }

  async changeRoomLifecycle(
    actorUid: string,
    action: 'ARCHIVE' | 'CLOSE' | 'DELETE',
    input: ArchiveRoomCommand | CloseRoomCommand | DeleteRoomCommand,
  ): Promise<RoomLifecycleResult> {
    const schema = action === 'ARCHIVE'
      ? archiveRoomCommandSchema
      : action === 'CLOSE'
        ? closeRoomCommandSchema
        : deleteRoomCommandSchema;
    const command = schema.parse(input);
    return roomLifecycleResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_change_room_lifecycle',
      [{ action, ...command }],
    ));
  }

  async startNextCycle(actorUid: string, input: StartNextCycleCommand): Promise<StartNextCycleResult> {
    const command = startNextCycleCommandSchema.parse(input);
    return startNextCycleResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_start_next_cycle',
      [command],
    ));
  }

  async transferHost(actorUid: string, input: TransferHostCommand): Promise<TransferHostResult> {
    const command = transferHostCommandSchema.parse(input);
    return transferHostResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_transfer_host',
      [command],
    ));
  }

  async getSnapshot(actorUid: string, roomId: string) {
    const uid = uidSchema.parse(actorUid);
    const value = await this.#call(
      uid,
      'gq_get_snapshot',
      [idSchema.parse(roomId)],
    );
    return roomSnapshotForMemberSchema(uid).parse(value);
  }

  async registerAssistantRequest(actorUid: string, input: AskRoomAssistantInput): Promise<RoomAssistantMessage> {
    const command = askRoomAssistantInputSchema.parse(input);
    return roomAssistantMessageSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_register_assistant_request',
      [command],
    ));
  }

  async completeAssistantRequest(actorUid: string, input: {
    roomId: string;
    requestId: string;
    status: 'SUCCEEDED' | 'FAILED' | 'STALE';
    answer?: string;
    sourceIds: string[];
    errorCode?: string;
  }): Promise<RoomAssistantMessage> {
    return roomAssistantMessageSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_complete_assistant_request',
      [{ schemaVersion: 2, ...input }],
    ));
  }

  async getRoomAssistantMessages(actorUid: string, roomId: string): Promise<RoomAssistantMessagesResult> {
    return roomAssistantMessagesResultSchema.parse(await this.#call(
      uidSchema.parse(actorUid),
      'gq_get_assistant_messages',
      [idSchema.parse(roomId)],
    ));
  }

  async close(): Promise<void> {
    await this.#transport.close?.();
  }

  async #call(actorUid: string, rpcName: string, commands: readonly unknown[]): Promise<unknown> {
    setStage('rpc-transport');
    const raw = await this.#transport.call(actorUid, rpcName, commands);
    setStage('rpc-envelope');
    noteEnvelopeShape(raw);
    const envelope = rpcEnvelopeSchema.parse(raw);
    if (!envelope.ok) throw new PgV2CommandError(envelope.error.code);
    setStage('response');
    return envelope.value;
  }
}
