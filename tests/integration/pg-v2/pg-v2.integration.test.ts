import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AddCommentCommand,
  CancelReopenCommand,
  ChangeRosterCommand,
  CloseCollectionCommand,
  CloseEvaluationCommand,
  CloseUnresolvedCommand,
  CreateCandidateCommand,
  CreateRoomCommand,
  JoinRoomCommand,
  OpenEvaluationCommand,
  ProposeFinalCommand,
  RequestReopenCommand,
  RespondFinalCommand,
  RetractRoundCloseVoteCommand,
  ReviseCandidateCommand,
  RotateInviteCommand,
  SetRoundDeadlineCommand,
  StartNextCycleCommand,
  SubmitEvaluationCommand,
  SubmitIdeaCommand,
  SubmitIdeaSkipCommand,
  TransferHostCommand,
  VoteReopenCommand,
  VoteRoundCloseCommand,
  WithdrawCandidateCommand,
} from '@gongqi/contracts/v2';
import { PgV2Repository } from '../../../cloudbase/functions/gateway/src/repositories/pgV2Repository';

const connectionString = process.env.GQ_TEST_DATABASE_URL;
const describeWithPg = connectionString === undefined ? describe.skip : describe;
const suiteName = connectionString === undefined
  ? 'real PostgreSQL T3 (NOT RUN: set GQ_TEST_DATABASE_URL to a fresh dedicated test database)'
  : 'real PostgreSQL T3';

const ADMIN_APPLICATION_NAME = 'gq-v2-admin-test';
const SERVICE_APPLICATION_NAME = 'gq-v2-service-test';

// The admin pool is the migration owner: it installs the schema, seeds fixtures and reads raw rows.
// It is never used as evidence that a runtime role works.
const adminPool = connectionString === undefined
  ? undefined
  : new Pool({ connectionString, application_name: ADMIN_APPLICATION_NAME, statement_timeout: 0 });
// A real service_role session: the role is pinned at connection time, so a business success cannot be
// an owner/superuser success in disguise. A blocked statement must not be aborted by a statement timeout.
const serviceRawPool = connectionString === undefined
  ? undefined
  : new Pool({
      connectionString,
      application_name: 'gq-v2-service-raw',
      options: '-c role=service_role',
      statement_timeout: 0,
    });
const repository = connectionString === undefined
  ? undefined
  : new PgV2Repository({
      connectionString,
      application_name: SERVICE_APPLICATION_NAME,
      options: '-c role=service_role',
      statement_timeout: 0,
    });

function admin(): Pool {
  if (adminPool === undefined) throw new Error('GQ_TEST_DATABASE_URL is required');
  return adminPool;
}

function service(): PgV2Repository {
  if (repository === undefined) throw new Error('GQ_TEST_DATABASE_URL is required');
  return repository;
}

function serviceRaw(): Pool {
  if (serviceRawPool === undefined) throw new Error('GQ_TEST_DATABASE_URL is required');
  return serviceRawPool;
}

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolveDelay => setTimeout(resolveDelay, ms));
}

async function dbNow(): Promise<Date> {
  return firstRow((await admin().query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows).now;
}

interface Settled<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

function settled<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    value => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await admin().connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Real evidence that a command is blocked on the room row lock: the backend shows
 * wait_event_type = 'Lock' while its current statement is the RPC itself. A setImmediate
 * tick is not accepted as proof of lock waiting.
 */
async function waitForLockWait(applicationName: string, statementFragment: string): Promise<void> {
  const deadlineMs = Date.now() + 20_000;
  for (;;) {
    const blocked = await admin().query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
        WHERE application_name = $1
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE $2
        LIMIT 1`,
      [applicationName, `%${statementFragment}%`],
    );
    if (blocked.rowCount === 1) return;
    if (Date.now() > deadlineMs) {
      throw new Error(`no lock wait observed for ${applicationName} / ${statementFragment}`);
    }
    await delay(50);
  }
}

async function waitUntilPast(target: Date, marginMs = 300): Promise<void> {
  for (;;) {
    if ((await dbNow()).getTime() > target.getTime() + marginMs) return;
    await delay(50);
  }
}

async function holdRoomLock(roomId: string): Promise<{
  release: () => Promise<void>;
  rollback: () => Promise<void>;
}> {
  const client = await admin().connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM public.gq_rooms WHERE id = $1 FOR UPDATE', [roomId]);
  let finished = false;
  return {
    release: async () => {
      if (finished) return;
      finished = true;
      await client.query('COMMIT');
      client.release();
    },
    rollback: async () => {
      if (finished) return;
      finished = true;
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    },
  };
}

/** Holds the room row lock, runs `work` (which releases it when the competing command is queued), then guarantees release. */
async function withRoomLock<T>(roomId: string, work: (release: () => Promise<void>) => Promise<T>): Promise<T> {
  const lock = await holdRoomLock(roomId);
  try {
    return await work(lock.release);
  } finally {
    await lock.rollback();
  }
}

interface Fixture {
  roomId: string;
  cycleId: string;
  roundId: string;
  candidateId: string;
  revisionId: string;
  hostUid: string;
  memberUid: string;
  candidateSnapshot: Record<string, unknown>;
}

interface SeedOptions {
  phase?: 'COLLECTING' | 'CANDIDATE_REVIEW' | 'EVALUATING' | 'DISCUSSING';
  roundDeadlineSeconds?: number;
  candidateTitle?: string;
}

async function seedRoom(options: SeedOptions = {}): Promise<Fixture> {
  const phase = options.phase ?? 'EVALUATING';
  const candidateTitle = options.candidateTitle ?? '通用候选';
  const key = randomUUID();
  const fixture: Fixture = {
    roomId: `room-${key}`,
    cycleId: `cycle-${key}`,
    roundId: `round-${key}`,
    candidateId: `candidate-${key}`,
    revisionId: `revision-${key}`,
    hostUid: `host-${key}`,
    memberUid: `member-${key}`,
    candidateSnapshot: {},
  };
  const createdAt = new Date().toISOString().replace('Z', '000Z');
  fixture.candidateSnapshot = {
    schemaVersion: 2,
    id: fixture.revisionId,
    candidateId: fixture.candidateId,
    revision: 1,
    title: candidateTitle,
    body: '不依赖活动字段的方案内容',
    templateId: 'general',
    templatePayload: {},
    sourceIdeaIds: [],
    createdBy: fixture.hostUid,
    createdAt,
  };

  await inTransaction(async client => {
    await client.query(
      `INSERT INTO public.gq_rooms(
        id, title, purpose, template_id, phase, room_status, host_uid, current_cycle_id
      ) VALUES ($1, '测试房间', '真实PG隔离验证', 'general', $2, 'ACTIVE', $3, $4)`,
      [fixture.roomId, phase, fixture.hostUid, fixture.cycleId],
    );
    await client.query(
      'INSERT INTO public.gq_cycles(id, room_id, cycle_number) VALUES ($1, $2, 1)',
      [fixture.cycleId, fixture.roomId],
    );
    await client.query(
      `INSERT INTO public.gq_members(room_id, uid, role, status, roster_revision)
       VALUES ($1, $2, 'HOST', 'JOINED', 1), ($1, $3, 'MEMBER', 'JOINED', 1)`,
      [fixture.roomId, fixture.hostUid, fixture.memberUid],
    );
    await client.query(
      `INSERT INTO public.gq_candidates(id, room_id, current_revision_id, created_by)
       VALUES ($1, $2, $3, $4)`,
      [fixture.candidateId, fixture.roomId, fixture.revisionId, fixture.hostUid],
    );
    await client.query(
      `INSERT INTO public.gq_candidate_revisions(
        id, candidate_id, revision, title, body, template_id, template_payload,
        source_idea_ids, created_by, created_at
      ) VALUES ($1, $2, 1, $5, '不依赖活动字段的方案内容', 'general', '{}', '{}', $3, $4)`,
      [fixture.revisionId, fixture.candidateId, fixture.hostUid, createdAt, candidateTitle],
    );
    if (phase === 'EVALUATING') {
      const roundDeadline = options.roundDeadlineSeconds === undefined
        ? null
        : options.roundDeadlineSeconds;
      await client.query(
        `INSERT INTO public.gq_evaluation_rounds(
          id, cycle_id, roster_uids, roster_revision, target_revision_ids, status, deadline_at
        ) VALUES (
          $1, $2, $3::text[], 1, $4::text[], 'OPEN',
          CASE WHEN $5::text IS NULL THEN NULL
               ELSE clock_timestamp() + ($5::text || ' seconds')::interval END
        )`,
        [
          fixture.roundId,
          fixture.cycleId,
          [fixture.hostUid, fixture.memberUid],
          [fixture.revisionId],
          roundDeadline === null ? null : String(roundDeadline),
        ],
      );
      await client.query(
        'UPDATE public.gq_rooms SET current_evaluation_round_id = $2 WHERE id = $1',
        [fixture.roomId, fixture.roundId],
      );
    }
  });
  return fixture;
}

interface ProposalOptions {
  createdSecondsAgo?: number;
  deadlineSecondsFromNow?: number;
}

/** Configures a CONFIRMING room with one OPEN proposal targeted at the candidate current revision. */
async function addProposal(fixture: Fixture, options: ProposalOptions = {}): Promise<string> {
  const proposalId = `proposal-${randomUUID()}`;
  const createdOffset = options.createdSecondsAgo === undefined ? 0 : -options.createdSecondsAgo;
  const deadlineOffset = options.deadlineSecondsFromNow ?? 3600;
  await inTransaction(async client => {
    await client.query(
      `INSERT INTO public.gq_proposals(
        id, cycle_id, roster_uids, roster_revision, candidate_revision_id,
        candidate_revision_snapshot, decision_revision, deadline_at, status, created_at
      ) VALUES (
        $1, $2, $3::text[], 1, $4, $5::jsonb, 1,
        clock_timestamp() + ($6::text || ' seconds')::interval, 'OPEN',
        clock_timestamp() + ($7::text || ' seconds')::interval
      )`,
      [
        proposalId,
        fixture.cycleId,
        [fixture.hostUid, fixture.memberUid],
        fixture.revisionId,
        JSON.stringify(fixture.candidateSnapshot),
        String(deadlineOffset),
        String(createdOffset),
      ],
    );
    await client.query(
      `UPDATE public.gq_rooms
       SET phase = 'CONFIRMING', current_evaluation_round_id = NULL, current_proposal_id = $2
       WHERE id = $1`,
      [fixture.roomId, proposalId],
    );
  });
  return proposalId;
}

function evaluationCommand(fixture: Fixture, operationId: string): SubmitEvaluationCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision: 1,
    roundId: fixture.roundId,
    candidateRevisionId: fixture.revisionId,
    attitude: 'SUPPORT',
    score: null,
    reason: `blind-${randomUUID()}`,
    submissionState: 'EVALUATED',
  };
}

function openEvaluationCommand(fixture: Fixture, operationId: string): OpenEvaluationCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision: 1,
    expectedRosterRevision: 1,
    roomId: fixture.roomId,
    roundId: fixture.roundId,
    targetRevisionIds: [fixture.revisionId],
  };
}

function closeEvaluationCommand(
  fixture: Fixture,
  operationId: string,
  expectedIncompleteCount: number,
): CloseEvaluationCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision: 1,
    roundId: fixture.roundId,
    expectedIncompleteCount,
  };
}

function voteRoundCloseCommand(fixture: Fixture, operationId: string): VoteRoundCloseCommand {
  return { schemaVersion: 2, operationId, expectedDecisionRevision: 1, roundId: fixture.roundId };
}

function retractRoundCloseVoteCommand(fixture: Fixture, operationId: string): RetractRoundCloseVoteCommand {
  return { schemaVersion: 2, operationId, expectedDecisionRevision: 1, roundId: fixture.roundId };
}

function setRoundDeadlineCommand(
  fixture: Fixture,
  operationId: string,
  deadlineAt: string,
  reason = '需要更多时间完成独立评价',
): SetRoundDeadlineCommand {
  return { schemaVersion: 2, operationId, expectedDecisionRevision: 1, roundId: fixture.roundId, deadlineAt, reason };
}

function commentCommand(
  fixture: Fixture,
  operationId: string,
  overrides: Partial<Pick<AddCommentCommand,
    'commentId' | 'candidateId' | 'candidateRevisionId' | 'body' | 'visibility' | 'publicationState' | 'expectedDecisionRevision'>> = {},
): AddCommentCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision: 1,
    roomId: fixture.roomId,
    commentId: `comment-${randomUUID()}`,
    candidateId: fixture.candidateId,
    candidateRevisionId: fixture.revisionId,
    body: `comment-${randomUUID()}`,
    visibility: 'PUBLIC',
    publicationState: 'DRAFT',
    ...overrides,
  };
}

function finalCommand(fixture: Fixture, proposalId: string, operationId: string): RespondFinalCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision: 1,
    proposalId,
    candidateRevisionId: fixture.revisionId,
    choice: 'ACCEPT',
  };
}

function proposeFinalCommand(
  fixture: Fixture,
  operationId: string,
  deadlineAt: string,
  overrides: Partial<Pick<ProposeFinalCommand, 'proposalId' | 'candidateRevisionId' | 'expectedDecisionRevision'>> = {},
): ProposeFinalCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision: 1,
    roomId: fixture.roomId,
    proposalId: `proposal-${randomUUID()}`,
    candidateRevisionId: fixture.revisionId,
    deadlineAt,
    ...overrides,
  };
}

function closeUnresolvedCommand(proposalId: string, operationId: string): CloseUnresolvedCommand {
  return { schemaVersion: 2, operationId, expectedDecisionRevision: 1, proposalId };
}

interface CreateCandidateOverrides {
  candidateId?: string;
  revisionId?: string;
  title?: string;
  expectedDecisionRevision?: number;
  sourceIdeaIds?: string[];
}

function createCandidateCommand(
  fixture: Fixture,
  operationId: string,
  overrides: CreateCandidateOverrides = {},
): CreateCandidateCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision: overrides.expectedDecisionRevision ?? 1,
    roomId: fixture.roomId,
    candidateId: overrides.candidateId ?? `candidate-${randomUUID()}`,
    revisionId: overrides.revisionId ?? `revision-${randomUUID()}`,
    title: overrides.title ?? '新增的通用候选',
    body: '完整且不依赖活动字段的候选内容',
    templateId: 'general',
    templatePayload: {},
    sourceIdeaIds: overrides.sourceIdeaIds ?? [],
  };
}

function withdrawCandidateCommand(
  fixture: Fixture,
  operationId: string,
  expectedDecisionRevision = 1,
  candidateId = fixture.candidateId,
): WithdrawCandidateCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision,
    candidateId,
  };
}

async function seedIdea(
  fixture: Fixture,
  options: { visibility?: 'PUBLIC' | 'PRIVATE'; skipped?: boolean; cycleId?: string } = {},
): Promise<string> {
  const ideaId = `idea-${randomUUID()}`;
  const skipped = options.skipped ?? false;
  await admin().query(
    `INSERT INTO public.gq_ideas(id, cycle_id, author_uid, text, visibility, skipped)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      ideaId,
      options.cycleId ?? fixture.cycleId,
      fixture.hostUid,
      skipped ? '' : `source-${randomUUID()}`,
      options.visibility ?? 'PUBLIC',
      skipped,
    ],
  );
  return ideaId;
}

interface ReviseOverrides {
  revisionId?: string;
  title?: string;
  body?: string;
  expectedDecisionRevision?: number;
}

function reviseCommand(
  fixture: Fixture,
  operationId: string,
  overrides: ReviseOverrides = {},
): ReviseCandidateCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision: overrides.expectedDecisionRevision ?? 1,
    candidateId: fixture.candidateId,
    revisionId: overrides.revisionId ?? `revision-${randomUUID()}`,
    title: overrides.title ?? '修订后的方案标题',
    body: overrides.body ?? '修订后的方案内容',
    templateId: 'general',
    templatePayload: {},
  };
}

function reopenRequestCommand(
  fixture: Fixture,
  operationId: string,
  overrides: Partial<Pick<RequestReopenCommand,
    'requestId' | 'roundId' | 'targetRevisionIds' | 'expectedDecisionRevision' | 'expectedRosterRevision'>> = {},
): RequestReopenCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision: 1,
    expectedRosterRevision: 1,
    roomId: fixture.roomId,
    requestId: `reopen-${randomUUID()}`,
    roundId: `reopen-round-${randomUUID()}`,
    targetRevisionIds: [fixture.revisionId],
    ...overrides,
  };
}

function reopenVoteCommand(
  requestId: string,
  operationId: string,
  overrides: Partial<Pick<VoteReopenCommand, 'choice' | 'expectedDecisionRevision'>> = {},
): VoteReopenCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision: 1,
    requestId,
    choice: 'REOPEN',
    ...overrides,
  };
}

function reopenCancelCommand(
  requestId: string,
  operationId: string,
  expectedDecisionRevision = 1,
): CancelReopenCommand {
  return { schemaVersion: 2, operationId, expectedDecisionRevision, requestId };
}

function rosterCommand(
  fixture: Fixture,
  operationId: string,
  action: 'REMOVE' | 'LEAVE',
  targetUid: string,
  expectedDecisionRevision = 1,
): ChangeRosterCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision,
    roomId: fixture.roomId,
    targetUid,
    action,
  };
}

function lifecycleCommand(
  fixture: Fixture,
  operationId: string,
  expectedDecisionRevision = 1,
) {
  return {
    schemaVersion: 2 as const,
    operationId,
    expectedDecisionRevision,
    roomId: fixture.roomId,
  };
}

function startNextCycleCommand(
  fixture: Fixture,
  nextCycleId: string,
  operationId: string,
  expectedDecisionRevision = 1,
): StartNextCycleCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision,
    roomId: fixture.roomId,
    nextCycleId,
  };
}

function transferHostCommand(
  fixture: Fixture,
  targetUid: string,
  operationId: string,
  expectedDecisionRevision = 1,
): TransferHostCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision,
    roomId: fixture.roomId,
    targetUid,
  };
}

function newInviteToken(): string {
  return `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
}

function inviteHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function createCommand(operationId: string): CreateRoomCommand {
  return {
    schemaVersion: 2,
    operationId,
    templateId: 'general',
    title: '真实建房验证',
    purpose: '验证创建、邀请与加入的原子边界',
  };
}

function rotateCommand(
  fixture: Fixture,
  inviteToken: string,
  operationId: string,
  expectedDecisionRevision = 1,
): RotateInviteCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision,
    roomId: fixture.roomId,
    inviteToken,
  };
}

function joinCommand(inviteToken: string, operationId: string): JoinRoomCommand {
  return { schemaVersion: 2, operationId, inviteToken };
}

function ideaCommand(
  fixture: Fixture,
  operationId: string,
  overrides: Partial<Pick<SubmitIdeaCommand, 'ideaId' | 'text' | 'visibility' | 'expectedDecisionRevision'>> = {},
): SubmitIdeaCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision: 1,
    roomId: fixture.roomId,
    ideaId: `idea-${randomUUID()}`,
    text: `collection-${randomUUID()}`,
    visibility: 'PUBLIC',
    ...overrides,
  };
}

function ideaSkipCommand(
  fixture: Fixture,
  operationId: string,
  overrides: Partial<Pick<SubmitIdeaSkipCommand, 'ideaId' | 'expectedDecisionRevision'>> = {},
): SubmitIdeaSkipCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision: 1,
    roomId: fixture.roomId,
    ideaId: `idea-skip-${randomUUID()}`,
    ...overrides,
  };
}

function closeCommand(
  fixture: Fixture,
  operationId: string,
  overrides: Partial<Pick<CloseCollectionCommand, 'expectedDecisionRevision' | 'expectedRosterRevision' | 'expectedUnsubmittedCount'>> = {},
): CloseCollectionCommand {
  return {
    schemaVersion: 2,
    operationId,
    expectedDecisionRevision: 1,
    roomId: fixture.roomId,
    expectedRosterRevision: 1,
    expectedUnsubmittedCount: 0,
    ...overrides,
  };
}

/** Seeds invite rows only; every join under test still enters through the real service_role RPC. */
async function seedInvite(roomId: string, createdBy: string, token: string): Promise<string> {
  const inviteId = `invite-${randomUUID()}`;
  await admin().query(
    `INSERT INTO public.gq_invites(id, room_id, token_hash, status, created_by, expires_at)
     VALUES ($1, $2, $3, 'ACTIVE', $4, clock_timestamp() + interval '7 days')`,
    [inviteId, roomId, inviteHash(token), createdBy],
  );
  return inviteId;
}

const businessTables = [
  'gq_rooms', 'gq_members', 'gq_cycles', 'gq_ideas', 'gq_candidates',
  'gq_candidate_revisions', 'gq_evaluation_rounds', 'gq_evaluations',
  'gq_close_votes', 'gq_reopen_requests', 'gq_reopen_votes', 'gq_comments',
  'gq_proposals', 'gq_final_responses', 'gq_decision_records', 'gq_operations',
  'gq_events', 'gq_invites',
];

const rpcCalls: ReadonlyArray<{ label: string; sql: string; params: unknown[] }> = [
  { label: 'gq_create_room', sql: 'SELECT public.gq_create_room($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_rotate_invite', sql: 'SELECT public.gq_rotate_invite($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_join_room', sql: 'SELECT public.gq_join_room($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_submit_idea', sql: 'SELECT public.gq_submit_idea($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_submit_idea_skip', sql: 'SELECT public.gq_submit_idea_skip($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_close_collection', sql: 'SELECT public.gq_close_collection($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_create_candidate', sql: 'SELECT public.gq_create_candidate($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_withdraw_candidate', sql: 'SELECT public.gq_withdraw_candidate($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_open_evaluation', sql: 'SELECT public.gq_open_evaluation($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_submit_evaluation', sql: 'SELECT public.gq_submit_evaluation($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_close_evaluation', sql: 'SELECT public.gq_close_evaluation($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_vote_round_close', sql: 'SELECT public.gq_vote_round_close($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_retract_round_close_vote', sql: 'SELECT public.gq_retract_round_close_vote($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_set_round_deadline', sql: 'SELECT public.gq_set_round_deadline($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_propose_final', sql: 'SELECT public.gq_propose_final($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_respond_final', sql: 'SELECT public.gq_respond_final($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_close_unresolved', sql: 'SELECT public.gq_close_unresolved($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_add_comment', sql: 'SELECT public.gq_add_comment($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_get_snapshot', sql: 'SELECT public.gq_get_snapshot($1, $2)', params: ['uid-1', 'room-1'] },
  { label: 'gq_revise_candidate', sql: 'SELECT public.gq_revise_candidate($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_request_reopen', sql: 'SELECT public.gq_request_reopen($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_vote_reopen', sql: 'SELECT public.gq_vote_reopen($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_cancel_reopen', sql: 'SELECT public.gq_cancel_reopen($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_change_roster', sql: 'SELECT public.gq_change_roster($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_change_room_lifecycle', sql: 'SELECT public.gq_change_room_lifecycle($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_start_next_cycle', sql: 'SELECT public.gq_start_next_cycle($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_transfer_host', sql: 'SELECT public.gq_transfer_host($1, $2::jsonb)', params: ['uid-1', '{}'] },
  { label: 'gq_settle_room', sql: 'SELECT public.gq_settle_room($1, $2)', params: ['room-1', new Date()] },
  { label: 'gq_close_round', sql: 'SELECT public.gq_close_round($1, $2, $3, $4)', params: ['room-1', 'round-1', new Date(), 'HOST_END'] },
];

describeWithPg(suiteName, () => {
  beforeAll(async () => {
    if (adminPool === undefined) return;
    const database = await admin().query<{ current_database: string }>('SELECT current_database()');
    if (!/test/i.test(firstRow(database.rows).current_database)) {
      throw new Error('GQ_TEST_DATABASE_URL must use a dedicated database whose name contains test');
    }
    const existing = await admin().query(
      "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND left(tablename, 3) = 'gq_' LIMIT 1",
    );
    if (existing.rowCount !== 0) throw new Error('Use a fresh dedicated test database without gq_ objects');
    const roles = await admin().query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')",
    );
    if (roles.rowCount !== 3) throw new Error('Test database must provide CloudBase anon/authenticated/service_role roles');

    const migration = readFileSync(
      resolve(process.cwd(), 'cloudbase/migrations/20261103080337_gq_vtwo_core.sql'),
      'utf8',
    );
    await admin().query(migration);
    const lifecycleMigration = readFileSync(
      resolve(process.cwd(), 'cloudbase/migrations/20261107120000_gq_room_lifecycle.sql'),
      'utf8',
    );
    await admin().query(lifecycleMigration);
    const cycleHostMigration = readFileSync(
      resolve(process.cwd(), 'cloudbase/migrations/20261107130000_gq_cycle_host_transfer.sql'),
      'utf8',
    );
    await admin().query(cycleHostMigration);

    // Fail loudly instead of silently reporting owner/superuser success as runtime-role success.
    const probe = await serviceRaw().query<{ current_user: string }>('SELECT current_user');
    const runtimeRole = firstRow(probe.rows).current_user;
    if (runtimeRole !== 'service_role') {
      throw new Error(
        `business connections must run as service_role but authenticated as ${runtimeRole}; `
        + 'grant the test role to the connection user (e.g. GRANT service_role TO <admin>) so SET ROLE is allowed',
      );
    }
  });

  afterAll(async () => {
    await repository?.close();
    await serviceRawPool?.end();
    await adminPool?.end();
  });

  it('denies anon and authenticated every business table and RPC while service_role executes them', async () => {
    const fixture = await seedRoom();
    for (const role of ['anon', 'authenticated']) {
      const client = await admin().connect();
      try {
        await client.query(`SET ROLE ${role}`);
        for (const table of businessTables) {
          await expect(client.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: '42501' });
        }
        for (const call of rpcCalls) {
          await expect(client.query(call.sql, call.params)).rejects.toMatchObject({ code: '42501' });
        }
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
    }

    const allowed = await serviceRaw().query<{ result: { ok: boolean } }>(
      'SELECT public.gq_get_snapshot($1, $2) AS result',
      [fixture.hostUid, fixture.roomId],
    );
    expect(firstRow(allowed.rows).result).toMatchObject({ ok: true });
    // The internal settlement helper stays unreachable even for the runtime role.
    await expect(serviceRaw().query('SELECT public.gq_settle_room($1, $2)', [fixture.roomId, new Date()]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(serviceRaw().query(
      'SELECT public.gq_close_round($1, $2, $3, $4)',
      [fixture.roomId, fixture.roundId, new Date(), 'HOST_END'],
    )).rejects.toMatchObject({ code: '42501' });
  });

  it('creates one host room and serializes concurrent idempotent create retries', async () => {
    const hostUid = `host-${randomUUID()}`;
    const operationId = `operation-${randomUUID()}`;
    const command = createCommand(operationId);
    const [first, retry] = await Promise.all([
      service().createRoom(hostUid, command),
      service().createRoom(hostUid, command),
    ]);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      status: 'applied',
      hostUid,
      phase: 'COLLECTING',
      roomStatus: 'ACTIVE',
      snapshotVersion: 1,
      decisionRevision: 1,
      rosterRevision: 1,
    });
    await expect(service().createRoom(hostUid, { ...command, title: '异载荷房间' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const room = await admin().query<{
      id: string;
      current_cycle_id: string;
      cycle_number: number;
      role: string;
      member_status: string;
    }>(
      `SELECT r.id, r.current_cycle_id, c.cycle_number, m.role, m.status AS member_status
       FROM public.gq_rooms r
       JOIN public.gq_cycles c ON c.id = r.current_cycle_id
       JOIN public.gq_members m ON m.room_id = r.id AND m.uid = r.host_uid
       WHERE r.host_uid = $1`,
      [hostUid],
    );
    expect(room.rows).toEqual([{
      id: first.roomId,
      current_cycle_id: first.cycleId,
      cycle_number: 1,
      role: 'HOST',
      member_status: 'JOINED',
    }]);
    const operations = await admin().query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM public.gq_operations
       WHERE actor_uid = $1 AND action = 'createRoom' AND operation_id = $2`,
      [hostUid, operationId],
    );
    expect(firstRow(operations.rows).count).toBe(1);
    const snapshot = await service().getSnapshot(hostUid, first.roomId);
    expect(snapshot.shared).toMatchObject({
      roomId: first.roomId,
      title: command.title,
      purpose: command.purpose,
      templateId: command.templateId,
      hostUid,
      currentCycleId: first.cycleId,
      decisionRevision: first.decisionRevision,
      rosterRevision: first.rosterRevision,
    });
  }, 20_000);

  it('rotates hashed invites with safe events, idempotency, authority and revocation', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const firstToken = newInviteToken();
    const operationId = `operation-${randomUUID()}`;
    const command = rotateCommand(fixture, firstToken, operationId);
    await expect(service().rotateInvite(
      fixture.memberUid,
      rotateCommand(fixture, newInviteToken(), `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'NOT_HOST' });
    await expect(service().rotateInvite(
      fixture.hostUid,
      rotateCommand(fixture, newInviteToken(), `operation-${randomUUID()}`, 99),
    )).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const first = await service().rotateInvite(fixture.hostUid, command);
    const retry = await service().rotateInvite(fixture.hostUid, command);
    expect(retry).toEqual(first);
    expect(first.inviteToken).toBe(firstToken);
    await expect(service().rotateInvite(fixture.hostUid, { ...command, inviteToken: newInviteToken() }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const secondToken = newInviteToken();
    const second = await service().rotateInvite(
      fixture.hostUid,
      rotateCommand(fixture, secondToken, `operation-${randomUUID()}`),
    );
    expect(second.inviteId).not.toBe(first.inviteId);
    const invites = await admin().query<{
      id: string;
      token_hash: string;
      status: string;
      seven_days: boolean;
    }>(
      `SELECT id, token_hash, status, expires_at = created_at + interval '7 days' AS seven_days
       FROM public.gq_invites WHERE room_id = $1 ORDER BY created_at, id`,
      [fixture.roomId],
    );
    expect(invites.rows).toHaveLength(2);
    expect(invites.rows.find(row => row.id === first.inviteId)).toMatchObject({ status: 'REVOKED' });
    expect(invites.rows.find(row => row.id === second.inviteId)).toMatchObject({
      token_hash: inviteHash(secondToken),
      status: 'ACTIVE',
      seven_days: true,
    });

    const persistedSafety = await admin().query(
      `SELECT
         (SELECT jsonb_agg(o.response) FROM public.gq_operations o WHERE o.room_id = $1) AS responses,
         (SELECT jsonb_agg(e.payload) FROM public.gq_events e WHERE e.room_id = $1) AS event_payloads`,
      [fixture.roomId],
    );
    expect(JSON.stringify(persistedSafety.rows)).not.toContain(firstToken);
    expect(JSON.stringify(persistedSafety.rows)).not.toContain(secondToken);
    expect(JSON.stringify(invites.rows)).not.toContain(firstToken);
    expect(JSON.stringify(invites.rows)).not.toContain(secondToken);

    const snapshot = await service().getSnapshot(fixture.hostUid, fixture.roomId);
    expect(snapshot.shared.events.filter(event => event.type === 'INVITE_ROTATED')).toHaveLength(2);
    expect(JSON.stringify(snapshot.shared)).not.toContain(firstToken);
    expect(JSON.stringify(snapshot.shared)).not.toContain(secondToken);
    expect(JSON.stringify(snapshot.shared)).not.toContain(inviteHash(secondToken));
    await expect(service().joinRoom(
      `guest-${randomUUID()}`,
      joinCommand(firstToken, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'INVITE_REVOKED' });
  }, 20_000);

  it('joins once by invite hash and reuses the actor-global operation result', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const token = newInviteToken();
    const invite = await service().rotateInvite(
      fixture.hostUid,
      rotateCommand(fixture, token, `operation-${randomUUID()}`),
    );
    const uid = `guest-${randomUUID()}`;
    const operationId = `operation-${randomUUID()}`;
    const command = joinCommand(token, operationId);
    const [first, retry] = await Promise.all([
      service().joinRoom(uid, command),
      service().joinRoom(uid, command),
    ]);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      status: 'applied',
      roomId: fixture.roomId,
      cycleId: fixture.cycleId,
      uid,
      memberStatus: 'JOINED',
      phase: 'CANDIDATE_REVIEW',
      decisionRevision: 2,
      rosterRevision: 2,
    });
    await expect(service().joinRoom(uid, joinCommand(newInviteToken(), operationId)))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(service().joinRoom(
      `other-${randomUUID()}`,
      joinCommand(token, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'INVITE_CONSUMED' });
    await expect(service().joinRoom(
      `other-${randomUUID()}`,
      joinCommand(newInviteToken(), `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'INVITE_NOT_FOUND' });

    const operations = await admin().query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM public.gq_operations
       WHERE actor_uid = $1 AND action = 'joinRoom' AND operation_id = $2`,
      [uid, operationId],
    );
    expect(firstRow(operations.rows).count).toBe(1);
    const consumed = await admin().query<{ status: string; consumed_by: string }>(
      'SELECT status, consumed_by FROM public.gq_invites WHERE id = $1',
      [invite.inviteId],
    );
    expect(firstRow(consumed.rows)).toEqual({ status: 'CONSUMED', consumed_by: uid });

    const freshToken = newInviteToken();
    const freshInvite = await service().rotateInvite(
      fixture.hostUid,
      rotateCommand(fixture, freshToken, `operation-${randomUUID()}`, 2),
    );
    await expect(service().joinRoom(
      fixture.memberUid,
      joinCommand(freshToken, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'ALREADY_MEMBER' });
    const unconsumed = await admin().query<{ status: string }>(
      'SELECT status FROM public.gq_invites WHERE id = $1',
      [freshInvite.inviteId],
    );
    expect(firstRow(unconsumed.rows).status).toBe('ACTIVE');
  }, 20_000);

  it('persists invite expiration without consuming it or adding a member', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const token = newInviteToken();
    const invite = await service().rotateInvite(
      fixture.hostUid,
      rotateCommand(fixture, token, `operation-${randomUUID()}`),
    );
    await admin().query(
      `UPDATE public.gq_invites
       SET created_at = clock_timestamp() - interval '8 days',
           expires_at = clock_timestamp() - interval '1 day'
       WHERE id = $1`,
      [invite.inviteId],
    );
    const uid = `guest-${randomUUID()}`;
    await expect(service().joinRoom(uid, joinCommand(token, `operation-${randomUUID()}`)))
      .rejects.toMatchObject({ code: 'INVITE_EXPIRED' });
    const expired = await admin().query<{
      status: string;
      consumed_by: string | null;
      consumed_at: Date | null;
    }>(
      'SELECT status, consumed_by, consumed_at FROM public.gq_invites WHERE id = $1',
      [invite.inviteId],
    );
    expect(firstRow(expired.rows)).toMatchObject({ status: 'EXPIRED', consumed_by: null, consumed_at: null });
    const members = await admin().query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM public.gq_members WHERE room_id = $1 AND uid = $2',
      [fixture.roomId, uid],
    );
    expect(firstRow(members.rows).count).toBe(0);
  });

  it('cancels a blind round on join without rewriting its frozen roster or revealing votes', async () => {
    const fixture = await seedRoom();
    const secret = `join-blind-${randomUUID()}`;
    await service().submitEvaluation(fixture.hostUid, {
      ...evaluationCommand(fixture, `operation-${randomUUID()}`),
      reason: secret,
    });
    const token = newInviteToken();
    await service().rotateInvite(
      fixture.hostUid,
      rotateCommand(fixture, token, `operation-${randomUUID()}`),
    );
    const uid = `guest-${randomUUID()}`;
    const joined = await service().joinRoom(uid, joinCommand(token, `operation-${randomUUID()}`));
    expect(joined).toMatchObject({ phase: 'CANDIDATE_REVIEW', decisionRevision: 2, rosterRevision: 2 });

    const round = await admin().query<{
      status: string;
      reveal_at: Date | null;
      roster_uids: string[];
      roster_revision: number;
    }>(
      `SELECT status, reveal_at, roster_uids, roster_revision
       FROM public.gq_evaluation_rounds WHERE id = $1`,
      [fixture.roundId],
    );
    expect(firstRow(round.rows)).toMatchObject({
      status: 'CANCELLED',
      reveal_at: null,
      roster_uids: [fixture.hostUid, fixture.memberUid],
      roster_revision: 1,
    });
    const member = await admin().query<{ roster_revision: number }>(
      'SELECT roster_revision FROM public.gq_members WHERE room_id = $1 AND uid = $2',
      [fixture.roomId, uid],
    );
    expect(firstRow(member.rows).roster_revision).toBe(2);
    const snapshot = await service().getSnapshot(uid, fixture.roomId);
    expect(JSON.stringify(snapshot.shared)).not.toContain(secret);
    expect(JSON.stringify(snapshot.shared)).not.toContain('SUPPORT');
    expect(snapshot.mine.evaluations).toEqual([]);
  }, 20_000);

  it('invalidates open proposals and reopen requests without changing their frozen rosters', async () => {
    const proposalFixture = await seedRoom({ phase: 'DISCUSSING' });
    const proposalId = await addProposal(proposalFixture, { deadlineSecondsFromNow: 600 });
    const proposalToken = newInviteToken();
    await service().rotateInvite(
      proposalFixture.hostUid,
      rotateCommand(proposalFixture, proposalToken, `operation-${randomUUID()}`),
    );
    await service().joinRoom(
      `guest-${randomUUID()}`,
      joinCommand(proposalToken, `operation-${randomUUID()}`),
    );
    const proposal = await admin().query<{
      status: string;
      roster_uids: string[];
      roster_revision: number;
    }>(
      'SELECT status, roster_uids, roster_revision FROM public.gq_proposals WHERE id = $1',
      [proposalId],
    );
    expect(firstRow(proposal.rows)).toMatchObject({
      status: 'INVALIDATED',
      roster_uids: [proposalFixture.hostUid, proposalFixture.memberUid],
      roster_revision: 1,
    });

    const reopenFixture = await seedRoom({ phase: 'DISCUSSING' });
    const reopenId = `reopen-${randomUUID()}`;
    await admin().query(
      `INSERT INTO public.gq_reopen_requests(
        id, cycle_id, roster_uids, roster_revision, target_revision_ids, requested_by, round_id, status
      ) VALUES ($1, $2, $3::text[], 1, $4::text[], $5, $6, 'OPEN')`,
      [
        reopenId,
        reopenFixture.cycleId,
        [reopenFixture.hostUid, reopenFixture.memberUid],
        [reopenFixture.revisionId],
        reopenFixture.hostUid,
        `reopen-round-${randomUUID()}`,
      ],
    );
    const reopenToken = newInviteToken();
    await service().rotateInvite(
      reopenFixture.hostUid,
      rotateCommand(reopenFixture, reopenToken, `operation-${randomUUID()}`),
    );
    await service().joinRoom(
      `guest-${randomUUID()}`,
      joinCommand(reopenToken, `operation-${randomUUID()}`),
    );
    const reopen = await admin().query<{
      status: string;
      roster_uids: string[];
      roster_revision: number;
    }>(
      'SELECT status, roster_uids, roster_revision FROM public.gq_reopen_requests WHERE id = $1',
      [reopenId],
    );
    expect(firstRow(reopen.rows)).toMatchObject({
      status: 'CANCELLED',
      roster_uids: [reopenFixture.hostUid, reopenFixture.memberUid],
      roster_revision: 1,
    });
  }, 20_000);

  it('enforces the six-member capacity when valid joins compete concurrently', async () => {
    const hostUid = `host-${randomUUID()}`;
    const room = await service().createRoom(hostUid, createCommand(`operation-${randomUUID()}`));
    const attempts = await Promise.all(Array.from({ length: 6 }, async () => {
      const token = newInviteToken();
      await seedInvite(room.roomId, hostUid, token);
      const uid = `guest-${randomUUID()}`;
      const outcome = await settled(service().joinRoom(uid, joinCommand(token, `operation-${randomUUID()}`)));
      return { token, outcome };
    }));
    const succeeded = attempts.filter(attempt => attempt.outcome.ok);
    const failed = attempts.filter(attempt => !attempt.outcome.ok);
    expect(succeeded).toHaveLength(5);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.outcome.error).toMatchObject({ code: 'ROOM_FULL' });

    const members = await admin().query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.gq_members WHERE room_id = $1 AND status = 'JOINED'",
      [room.roomId],
    );
    expect(firstRow(members.rows).count).toBe(6);
    const inviteStates = await admin().query<{ status: string; count: number }>(
      'SELECT status, count(*)::integer AS count FROM public.gq_invites WHERE room_id = $1 GROUP BY status ORDER BY status',
      [room.roomId],
    );
    expect(inviteStates.rows).toEqual([{ status: 'ACTIVE', count: 1 }, { status: 'CONSUMED', count: 5 }]);
    const remaining = await admin().query<{ status: string }>(
      'SELECT status FROM public.gq_invites WHERE room_id = $1 AND token_hash = $2',
      [room.roomId, inviteHash(failed[0]?.token ?? '')],
    );
    expect(firstRow(remaining.rows).status).toBe('ACTIVE');
  }, 40_000);

  it('keeps collection inputs private until close and stores no text in operation responses', async () => {
    const fixture = await seedRoom({ phase: 'COLLECTING' });
    const hostPublic = `host-public-${randomUUID()}`;
    const hostPrivate = `host-private-${randomUUID()}`;
    const memberPrivate = `member-private-${randomUUID()}`;
    const operationId = `operation-${randomUUID()}`;
    const command = ideaCommand(fixture, operationId, { text: `  ${hostPublic}  ` });
    const [first, retry] = await Promise.all([
      service().submitIdea(fixture.hostUid, command),
      service().submitIdea(fixture.hostUid, command),
    ]);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({ ideaId: command.ideaId, visibility: 'PUBLIC', skipped: false });
    await expect(service().submitIdea(fixture.hostUid, { ...command, text: '异载荷输入' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await service().submitIdea(
      fixture.hostUid,
      ideaCommand(fixture, `operation-${randomUUID()}`, { text: hostPrivate, visibility: 'PRIVATE' }),
    );
    await service().submitIdea(
      fixture.memberUid,
      ideaCommand(fixture, `operation-${randomUUID()}`, { text: memberPrivate, visibility: 'PRIVATE' }),
    );

    const stored = await admin().query<{ text: string; visibility: string; skipped: boolean }>(
      'SELECT text, visibility, skipped FROM public.gq_ideas WHERE cycle_id = $1 ORDER BY submitted_at, id',
      [fixture.cycleId],
    );
    expect(stored.rows).toHaveLength(3);
    expect(stored.rows.find(row => row.text === hostPublic)).toMatchObject({ visibility: 'PUBLIC', skipped: false });
    const operation = await admin().query<{ response: string }>(
      `SELECT response::text AS response FROM public.gq_operations
       WHERE actor_uid = $1 AND action = 'submitIdea' AND operation_id = $2`,
      [fixture.hostUid, operationId],
    );
    expect(firstRow(operation.rows).response).not.toContain(hostPublic);

    const hostSnapshot = await service().getSnapshot(fixture.hostUid, fixture.roomId);
    const memberSnapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(hostSnapshot.shared.publicIdeas).toEqual([]);
    expect(memberSnapshot.shared.publicIdeas).toEqual([]);
    expect(hostSnapshot.shared.progress).toMatchObject({ ideaSubmittedCount: 2, ideaSkippedCount: 0 });
    expect(hostSnapshot.mine.ideas.map(idea => idea.text).sort()).toEqual([hostPrivate, hostPublic].sort());
    expect(memberSnapshot.mine.ideas.map(idea => idea.text)).toEqual([memberPrivate]);
    for (const secret of [hostPublic, hostPrivate, memberPrivate]) {
      expect(JSON.stringify(hostSnapshot.shared)).not.toContain(secret);
      expect(JSON.stringify(memberSnapshot.shared)).not.toContain(secret);
    }
  }, 20_000);

  it('enforces idea submission and explicit skip as mutually exclusive choices', async () => {
    const fixture = await seedRoom({ phase: 'COLLECTING' });
    const submitted = await service().submitIdea(
      fixture.hostUid,
      ideaCommand(fixture, `operation-${randomUUID()}`),
    );
    await expect(service().submitIdeaSkip(
      fixture.hostUid,
      ideaSkipCommand(fixture, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'IDEA_ALREADY_SUBMITTED' });

    const skipped = await service().submitIdeaSkip(
      fixture.memberUid,
      ideaSkipCommand(fixture, `operation-${randomUUID()}`),
    );
    expect(skipped).toMatchObject({ visibility: 'PRIVATE', skipped: true });
    await expect(service().submitIdea(
      fixture.memberUid,
      ideaCommand(fixture, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'IDEA_ALREADY_SKIPPED' });
    await expect(service().submitIdea(
      fixture.memberUid,
      ideaCommand(fixture, `operation-${randomUUID()}`, { ideaId: submitted.ideaId }),
    )).rejects.toMatchObject({ code: 'IDEA_ALREADY_EXISTS' });

    const snapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(snapshot.shared.progress).toMatchObject({ ideaSubmittedCount: 1, ideaSkippedCount: 1 });
    expect(snapshot.mine.ideas).toEqual([expect.objectContaining({
      id: skipped.ideaId,
      text: '',
      visibility: 'PRIVATE',
      skipped: true,
    })]);
  });

  it('closes collection only with host, roster and unsubmitted confirmation then reveals public ideas', async () => {
    const fixture = await seedRoom({ phase: 'COLLECTING' });
    const publicText = `revealed-${randomUUID()}`;
    const privateText = `still-private-${randomUUID()}`;
    const publicIdea = await service().submitIdea(
      fixture.hostUid,
      ideaCommand(fixture, `operation-${randomUUID()}`, { text: publicText }),
    );
    await service().submitIdea(
      fixture.hostUid,
      ideaCommand(fixture, `operation-${randomUUID()}`, { text: privateText, visibility: 'PRIVATE' }),
    );
    const skipped = await service().submitIdeaSkip(
      fixture.memberUid,
      ideaSkipCommand(fixture, `operation-${randomUUID()}`),
    );

    await expect(service().closeCollection(
      fixture.memberUid,
      closeCommand(fixture, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'NOT_HOST' });
    await expect(service().closeCollection(
      fixture.hostUid,
      closeCommand(fixture, `operation-${randomUUID()}`, { expectedDecisionRevision: 99 }),
    )).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(service().closeCollection(
      fixture.hostUid,
      closeCommand(fixture, `operation-${randomUUID()}`, { expectedRosterRevision: 99 }),
    )).rejects.toMatchObject({ code: 'ROSTER_VERSION_CONFLICT' });
    await expect(service().closeCollection(
      fixture.hostUid,
      closeCommand(fixture, `operation-${randomUUID()}`, { expectedUnsubmittedCount: 1 }),
    )).rejects.toMatchObject({ code: 'COLLECTION_CONFIRMATION_CONFLICT' });

    const operationId = `operation-${randomUUID()}`;
    const command = closeCommand(fixture, operationId);
    const first = await service().closeCollection(fixture.hostUid, command);
    const retry = await service().closeCollection(fixture.hostUid, command);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      phase: 'CANDIDATE_REVIEW',
      submittedCount: 1,
      skippedCount: 1,
      unsubmittedCount: 0,
      decisionRevision: 1,
      rosterRevision: 1,
    });
    await expect(service().closeCollection(
      fixture.hostUid,
      { ...command, expectedUnsubmittedCount: 1 },
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const hostSnapshot = await service().getSnapshot(fixture.hostUid, fixture.roomId);
    const memberSnapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(hostSnapshot.shared.publicIdeas.map(idea => idea.id)).toEqual([publicIdea.ideaId]);
    expect(memberSnapshot.shared.publicIdeas.map(idea => idea.text)).toEqual([publicText]);
    expect(memberSnapshot.mine.ideas.map(idea => idea.id)).toEqual([skipped.ideaId]);
    expect(JSON.stringify(memberSnapshot.shared)).not.toContain(privateText);
    expect(JSON.stringify(memberSnapshot)).not.toContain(privateText);
  }, 20_000);

  it('allows collection close with an explicitly confirmed unsubmitted member', async () => {
    const fixture = await seedRoom({ phase: 'COLLECTING' });
    await service().submitIdea(fixture.hostUid, ideaCommand(fixture, `operation-${randomUUID()}`));
    const result = await service().closeCollection(
      fixture.hostUid,
      closeCommand(fixture, `operation-${randomUUID()}`, { expectedUnsubmittedCount: 1 }),
    );
    expect(result).toMatchObject({ submittedCount: 1, skippedCount: 0, unsubmittedCount: 1 });
  });

  it('serializes closeCollection on the room lock and rejects later submissions', async () => {
    const fixture = await seedRoom({ phase: 'COLLECTING' });
    const outcome = await withRoomLock(fixture.roomId, async release => {
      const pending = settled(service().closeCollection(
        fixture.hostUid,
        closeCommand(fixture, `operation-${randomUUID()}`, { expectedUnsubmittedCount: 2 }),
      ));
      await waitForLockWait(SERVICE_APPLICATION_NAME, 'gq_close_collection');
      await release();
      return pending;
    });
    expect(outcome).toMatchObject({
      ok: true,
      value: { phase: 'CANDIDATE_REVIEW', unsubmittedCount: 2 },
    });
    await expect(service().submitIdea(
      fixture.hostUid,
      ideaCommand(fixture, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'INVALID_PHASE' });
  }, 20_000);

  it('opens an evaluation only for the host with the current roster and candidate targets', async () => {
    const fixture = await seedRoom({ phase: 'CANDIDATE_REVIEW' });
    const command = openEvaluationCommand(fixture, `operation-${randomUUID()}`);
    await expect(service().openEvaluation(fixture.memberUid, command))
      .rejects.toMatchObject({ code: 'NOT_HOST' });
    const first = await service().openEvaluation(fixture.hostUid, command);
    expect(first).toMatchObject({
      phase: 'EVALUATING', rosterRevision: 1, targetRevisionIds: [fixture.revisionId],
    });
    expect(await service().openEvaluation(fixture.hostUid, command)).toEqual(first);
    await expect(service().openEvaluation(fixture.hostUid, { ...command, expectedRosterRevision: 2 }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const snapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(snapshot.shared.activeEvaluationRound).toMatchObject({
      id: fixture.roundId,
      rosterUids: [fixture.hostUid, fixture.memberUid],
      targetRevisionIds: [fixture.revisionId],
      status: 'OPEN',
    });
    expect(snapshot.shared.revealedEvaluations).toEqual([]);
  });

  it('requires current incomplete-count confirmation before a host closes and reveals evaluations', async () => {
    const fixture = await seedRoom();
    const hostEvaluation = evaluationCommand(fixture, `operation-${randomUUID()}`);
    await service().submitEvaluation(fixture.hostUid, hostEvaluation);
    const blind = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(blind.shared.revealedEvaluations).toEqual([]);
    expect(JSON.stringify(blind.shared)).not.toContain(hostEvaluation.reason);

    await expect(service().closeEvaluation(
      fixture.hostUid,
      closeEvaluationCommand(fixture, `operation-${randomUUID()}`, 0),
    )).rejects.toMatchObject({ code: 'EVALUATION_CONFIRMATION_CONFLICT' });
    await service().submitEvaluation(fixture.memberUid, {
      ...evaluationCommand(fixture, `operation-${randomUUID()}`),
      attitude: undefined,
      score: undefined,
      reason: undefined,
      submissionState: 'SKIPPED',
    });
    const command = closeEvaluationCommand(fixture, `operation-${randomUUID()}`, 0);
    const closed = await service().closeEvaluation(fixture.hostUid, command);
    expect(closed).toMatchObject({ phase: 'DISCUSSING', closeReason: 'HOST_END' });
    expect(await service().closeEvaluation(fixture.hostUid, command)).toEqual(closed);

    for (const uid of [fixture.hostUid, fixture.memberUid]) {
      const snapshot = await service().getSnapshot(uid, fixture.roomId);
      expect(snapshot.shared.phase).toBe('DISCUSSING');
      expect(snapshot.shared.activeEvaluationRound).toBeNull();
      expect(snapshot.shared.revealedEvaluationRoundIds).toEqual([fixture.roundId]);
      expect(snapshot.shared.revealedEvaluations).toHaveLength(2);
      expect(snapshot.shared.revealedEvaluations.some(item => item.reason === hostEvaluation.reason)).toBe(true);
      expect(snapshot.shared.revealedEvaluations.some(item => item.submissionState === 'SKIPPED')).toBe(true);
    }
    const events = await admin().query(
      "SELECT count(*)::integer AS count FROM public.gq_events WHERE room_id = $1 AND type = 'ROUND_CLOSED'",
      [fixture.roomId],
    );
    expect(firstRow(events.rows).count).toBe(1);
  });

  it('allows a confirmed incomplete close without inventing missing evaluations', async () => {
    const fixture = await seedRoom();
    await service().submitEvaluation(
      fixture.hostUid,
      evaluationCommand(fixture, `operation-${randomUUID()}`),
    );
    await service().closeEvaluation(
      fixture.hostUid,
      closeEvaluationCommand(fixture, `operation-${randomUUID()}`, 1),
    );
    const snapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(snapshot.shared.revealedEvaluations).toHaveLength(1);
    expect(snapshot.mine.evaluations).toEqual([]);
  });

  it('keeps blind comment drafts private until an explicit post-reveal publication', async () => {
    const fixture = await seedRoom();
    const body = `blind-comment-${randomUUID()}`;
    const command = commentCommand(fixture, `operation-${randomUUID()}`, { body });
    const draft = await service().addComment(fixture.hostUid, command);
    expect(draft).toMatchObject({ publicationState: 'DRAFT', decisionRevision: 1 });
    expect(draft.publishedAt).toBeUndefined();
    expect(await service().addComment(fixture.hostUid, command)).toEqual(draft);
    await expect(service().addComment(fixture.hostUid, { ...command, body: 'changed-payload' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const hostBlind = await service().getSnapshot(fixture.hostUid, fixture.roomId);
    const memberBlind = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(hostBlind.mine.comments).toContainEqual(expect.objectContaining({ id: command.commentId, body, publicationState: 'DRAFT' }));
    expect(hostBlind.shared.comments).toEqual([]);
    expect(memberBlind.mine.comments).toEqual([]);
    expect(memberBlind.shared.comments).toEqual([]);
    expect(JSON.stringify(memberBlind)).not.toContain(body);
    await expect(service().addComment(fixture.memberUid, commentCommand(
      fixture,
      `operation-${randomUUID()}`,
      { publicationState: 'PUBLISHED' },
    ))).rejects.toMatchObject({ code: 'COMMENT_PUBLICATION_NOT_ALLOWED' });

    await service().closeEvaluation(
      fixture.hostUid,
      closeEvaluationCommand(fixture, `operation-${randomUUID()}`, 2),
    );
    const hostRevealed = await service().getSnapshot(fixture.hostUid, fixture.roomId);
    expect(hostRevealed.shared.phase).toBe('DISCUSSING');
    expect(hostRevealed.shared.comments).toEqual([]);
    expect(hostRevealed.mine.comments).toContainEqual(expect.objectContaining({ id: command.commentId, publicationState: 'DRAFT' }));

    const publish = { ...command, operationId: `operation-${randomUUID()}`, publicationState: 'PUBLISHED' as const };
    const published = await service().addComment(fixture.hostUid, publish);
    expect(published).toMatchObject({ publicationState: 'PUBLISHED', decisionRevision: 1, createdAt: draft.createdAt });
    expect(published.publishedAt).toBeDefined();
    expect(await service().addComment(fixture.hostUid, publish)).toEqual(published);
    for (const uid of [fixture.hostUid, fixture.memberUid]) {
      const snapshot = await service().getSnapshot(uid, fixture.roomId);
      expect(snapshot.shared.comments).toContainEqual(expect.objectContaining({
        id: command.commentId, body, publicationState: 'PUBLISHED', visibility: 'PUBLIC',
        candidateId: fixture.candidateId, candidateRevisionId: fixture.revisionId,
      }));
      expect(snapshot.shared.decisionRevision).toBe(1);
    }
    expect((await service().getSnapshot(fixture.memberUid, fixture.roomId)).mine.comments).toEqual([]);
    await expect(service().addComment(fixture.hostUid, {
      ...publish, operationId: `operation-${randomUUID()}`, body: 'published comments are immutable',
    })).rejects.toMatchObject({ code: 'COMMENT_ALREADY_PUBLISHED' });
  });

  it('isolates private published comments and enforces ownership, candidate binding and draft updates', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const body = `private-comment-${randomUUID()}`;
    const privateCommand = commentCommand(fixture, `operation-${randomUUID()}`, {
      body, visibility: 'PRIVATE', publicationState: 'PUBLISHED',
    });
    await service().addComment(fixture.hostUid, privateCommand);
    const host = await service().getSnapshot(fixture.hostUid, fixture.roomId);
    const member = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(host.shared.comments).toEqual([]);
    expect(host.mine.comments).toContainEqual(expect.objectContaining({ id: privateCommand.commentId, body, visibility: 'PRIVATE' }));
    expect(member.shared.comments).toEqual([]);
    expect(member.mine.comments).toEqual([]);
    expect(JSON.stringify(member)).not.toContain(body);

    await expect(service().addComment(fixture.memberUid, commentCommand(fixture, `operation-${randomUUID()}`, {
      commentId: privateCommand.commentId,
    }))).rejects.toMatchObject({ code: 'COMMENT_ID_CONFLICT' });
    await expect(service().addComment(fixture.hostUid, commentCommand(fixture, `operation-${randomUUID()}`, {
      candidateRevisionId: `revision-${randomUUID()}`,
    }))).rejects.toMatchObject({ code: 'CANDIDATE_REVISION_MISMATCH' });
    await expect(service().addComment(fixture.hostUid, commentCommand(fixture, `operation-${randomUUID()}`, {
      candidateId: `candidate-${randomUUID()}`, candidateRevisionId: undefined,
    }))).rejects.toMatchObject({ code: 'CANDIDATE_NOT_FOUND' });
    await expect(service().addComment(`outsider-${randomUUID()}`, commentCommand(
      fixture, `operation-${randomUUID()}`,
    ))).rejects.toMatchObject({ code: 'NOT_MEMBER' });

    const draftCommand = commentCommand(fixture, `operation-${randomUUID()}`, { body: 'first draft', visibility: 'PRIVATE' });
    const first = await service().addComment(fixture.memberUid, draftCommand);
    const updatedBody = `updated-draft-${randomUUID()}`;
    const updated = await service().addComment(fixture.memberUid, {
      ...draftCommand, operationId: `operation-${randomUUID()}`, body: updatedBody,
    });
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.snapshotVersion).toBeGreaterThan(first.snapshotVersion);
    expect(updated.decisionRevision).toBe(1);
    const updatedSnapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(updatedSnapshot.mine.comments).toContainEqual(expect.objectContaining({ id: draftCommand.commentId, body: updatedBody }));
    expect(updatedSnapshot.mine.comments.filter(item => item.id === draftCommand.commentId)).toHaveLength(1);
    expect(JSON.stringify(await service().getSnapshot(fixture.hostUid, fixture.roomId))).not.toContain(updatedBody);
  });

  it('adds comments during confirmation without changing the decision or invalidating the proposal', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const proposalId = await addProposal(fixture);
    const before = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    const body = `confirming-comment-${randomUUID()}`;
    await service().addComment(fixture.memberUid, commentCommand(fixture, `operation-${randomUUID()}`, {
      body, publicationState: 'PUBLISHED',
    }));
    const after = await service().getSnapshot(fixture.hostUid, fixture.roomId);
    expect(after.shared.phase).toBe('CONFIRMING');
    expect(after.shared.decisionRevision).toBe(before.shared.decisionRevision);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.mine.activeProposal).toMatchObject({ id: proposalId, status: 'OPEN', decisionRevision: 1 });
    expect(after.mine.finalResponses).toEqual([]);
    expect(after.shared.comments).toContainEqual(expect.objectContaining({ body, publicationState: 'PUBLISHED' }));
    expect(after.shared.events.some(event => event.type === 'PROPOSAL_INVALIDATED')).toBe(false);
  });

  it('closes only at a frozen-roster majority and exposes counts without other voter identities', async () => {
    const fixture = await seedRoom();
    await expect(service().voteRoundClose(
      `outsider-${randomUUID()}`,
      voteRoundCloseCommand(fixture, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'NOT_MEMBER' });

    const firstCommand = voteRoundCloseCommand(fixture, `operation-${randomUUID()}`);
    const first = await service().voteRoundClose(fixture.hostUid, firstCommand);
    expect(first).toMatchObject({
      roundStatus: 'OPEN', endVoteCount: 1, majorityThreshold: 2,
    });
    expect(await service().voteRoundClose(fixture.hostUid, firstCommand)).toEqual(first);
    await expect(service().voteRoundClose(fixture.hostUid, {
      ...firstCommand,
      expectedDecisionRevision: 2,
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const hostSnapshot = await service().getSnapshot(fixture.hostUid, fixture.roomId);
    const memberSnapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(hostSnapshot.shared.activeRoundClose).toEqual({
      roundId: fixture.roundId, endVoteCount: 1, majorityThreshold: 2,
    });
    expect(memberSnapshot.shared.activeRoundClose).toEqual(hostSnapshot.shared.activeRoundClose);
    expect(hostSnapshot.mine.roundCloseVote).toEqual({ roundId: fixture.roundId, choice: 'END' });
    expect(memberSnapshot.mine.roundCloseVote).toBeUndefined();
    expect(JSON.stringify(memberSnapshot.shared.activeRoundClose)).not.toContain(fixture.hostUid);
    expect(hostSnapshot.shared.decisionRevision).toBe(1);

    const retractCommand = retractRoundCloseVoteCommand(fixture, `operation-${randomUUID()}`);
    const retracted = await service().retractRoundCloseVote(fixture.hostUid, retractCommand);
    expect(retracted).toMatchObject({ endVoteCount: 0, majorityThreshold: 2 });
    expect(await service().retractRoundCloseVote(fixture.hostUid, retractCommand)).toEqual(retracted);
    expect((await service().getSnapshot(fixture.hostUid, fixture.roomId)).mine.roundCloseVote).toBeUndefined();

    await service().voteRoundClose(
      fixture.hostUid,
      voteRoundCloseCommand(fixture, `operation-${randomUUID()}`),
    );
    const secondCommand = voteRoundCloseCommand(fixture, `operation-${randomUUID()}`);
    const [second, retry] = await Promise.all([
      service().voteRoundClose(fixture.memberUid, secondCommand),
      service().voteRoundClose(fixture.memberUid, secondCommand),
    ]);
    expect(second).toMatchObject({
      roundStatus: 'CLOSED', closeReason: 'MAJORITY_END', endVoteCount: 2, majorityThreshold: 2,
    });
    expect(retry).toEqual(second);
    for (const uid of [fixture.hostUid, fixture.memberUid]) {
      const snapshot = await service().getSnapshot(uid, fixture.roomId);
      expect(snapshot.shared.phase).toBe('DISCUSSING');
      expect(snapshot.shared.activeRoundClose).toBeNull();
      expect(snapshot.shared.revealedEvaluationRoundIds).toEqual([fixture.roundId]);
      expect(snapshot.shared.events).toContainEqual(expect.objectContaining({
        type: 'ROUND_CLOSED', roundId: fixture.roundId, closeReason: 'MAJORITY_END',
      }));
    }
    const closeEvents = await admin().query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM public.gq_events WHERE room_id = $1 AND type = 'ROUND_CLOSED'",
      [fixture.roomId],
    );
    expect(firstRow(closeEvents.rows).count).toBe(1);

    const changedRoster = await seedRoom();
    const lateUid = `late-${randomUUID()}`;
    await admin().query(
      "INSERT INTO public.gq_members(room_id, uid, role, status, roster_revision) VALUES ($1, $2, 'MEMBER', 'JOINED', 1)",
      [changedRoster.roomId, lateUid],
    );
    await expect(service().voteRoundClose(
      lateUid,
      voteRoundCloseCommand(changedRoster, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'NOT_IN_ROSTER' });
  }, 20_000);

  it('disables new close votes while a deadline exists', async () => {
    const fixture = await seedRoom({ phase: 'EVALUATING', roundDeadlineSeconds: 3600 });
    await expect(service().voteRoundClose(
      fixture.memberUid,
      voteRoundCloseCommand(fixture, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'ROUND_CLOSE_VOTING_DISABLED' });
    const snapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(snapshot.shared.phase).toBe('EVALUATING');
    expect(snapshot.shared.activeRoundClose).toEqual({
      roundId: fixture.roundId, endVoteCount: 0, majorityThreshold: 2,
    });
    expect(snapshot.mine.permissions).toMatchObject({ canVoteRoundClose: false });
    const votes = await admin().query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM public.gq_close_votes WHERE round_id = $1',
      [fixture.roundId],
    );
    expect(firstRow(votes.rows).count).toBe(0);
  });

  it('sets and extends only future deadlines with authority, idempotency and safe events', async () => {
    const fixture = await seedRoom();
    const firstDeadline = new Date(Date.now() + 3600_000).toISOString();
    await expect(service().setRoundDeadline(
      fixture.memberUid,
      setRoundDeadlineCommand(fixture, `operation-${randomUUID()}`, firstDeadline),
    )).rejects.toMatchObject({ code: 'NOT_HOST' });
    await expect(service().setRoundDeadline(
      fixture.hostUid,
      setRoundDeadlineCommand(
        fixture,
        `operation-${randomUUID()}`,
        new Date(Date.now() - 60_000).toISOString(),
      ),
    )).rejects.toMatchObject({ code: 'INVALID_DEADLINE' });

    const command = setRoundDeadlineCommand(
      fixture,
      `operation-${randomUUID()}`,
      firstDeadline,
      '  需要更多时间核对候选  ',
    );
    const first = await service().setRoundDeadline(fixture.hostUid, command);
    expect(first).toMatchObject({ reason: '需要更多时间核对候选' });
    expect(Date.parse(first.deadlineAt)).toBe(Date.parse(firstDeadline));
    expect(await service().setRoundDeadline(fixture.hostUid, command)).toEqual(first);
    await expect(service().setRoundDeadline(fixture.hostUid, {
      ...command,
      reason: '不同原因',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(service().setRoundDeadline(
      fixture.hostUid,
      setRoundDeadlineCommand(fixture, `operation-${randomUUID()}`, firstDeadline),
    )).rejects.toMatchObject({ code: 'INVALID_DEADLINE' });

    const laterDeadline = new Date(Date.now() + 7200_000).toISOString();
    const extended = await service().setRoundDeadline(
      fixture.hostUid,
      setRoundDeadlineCommand(fixture, `operation-${randomUUID()}`, laterDeadline, '延长时间以完成评价'),
    );
    const snapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(snapshot.shared.activeEvaluationRound?.deadlineAt).toBe(extended.deadlineAt);
    expect(snapshot.shared.decisionRevision).toBe(1);
    expect(snapshot.shared.events).toContainEqual(expect.objectContaining({
      type: 'ROUND_DEADLINE_CHANGED',
      roundId: fixture.roundId,
      deadlineAt: extended.deadlineAt,
      reason: '延长时间以完成评价',
    }));
    expect(snapshot.shared.events.every(event => !('payload' in event))).toBe(true);
    await expect(service().voteRoundClose(
      fixture.memberUid,
      voteRoundCloseCommand(fixture, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'ROUND_CLOSE_VOTING_DISABLED' });
  });

  it('rejects an extension that really waited on the room lock across the deadline', async () => {
    const fixture = await seedRoom({ phase: 'EVALUATING', roundDeadlineSeconds: 3 });
    const deadline = firstRow((await admin().query<{ deadline_at: Date }>(
      'SELECT deadline_at FROM public.gq_evaluation_rounds WHERE id = $1',
      [fixture.roundId],
    )).rows).deadline_at;
    const lock = await holdRoomLock(fixture.roomId);
    try {
      const issuedAt = await dbNow();
      expect(issuedAt.getTime()).toBeLessThan(deadline.getTime());
      const pending = settled(service().setRoundDeadline(
        fixture.hostUid,
        setRoundDeadlineCommand(
          fixture,
          `operation-${randomUUID()}`,
          new Date(deadline.getTime() + 3600_000).toISOString(),
          '锁等待期间已经到期，不得延期复活',
        ),
      ));
      await waitForLockWait(SERVICE_APPLICATION_NAME, 'gq_set_round_deadline');
      const waitingAt = await dbNow();
      expect(waitingAt.getTime()).toBeLessThan(deadline.getTime());
      await waitUntilPast(deadline);
      await lock.release();
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatchObject({ code: 'ROUND_CLOSED' });
    } finally {
      await lock.rollback();
    }

    const state = await admin().query<{
      status: string;
      close_reason: string | null;
      reveal_at: Date | null;
      deadline_at: Date;
      phase: string;
      current_evaluation_round_id: string | null;
    }>(
      `SELECT er.status, er.close_reason, er.reveal_at, er.deadline_at,
              r.phase, r.current_evaluation_round_id
       FROM public.gq_evaluation_rounds er
       JOIN public.gq_rooms r ON r.id = $2
       WHERE er.id = $1`,
      [fixture.roundId, fixture.roomId],
    );
    expect(firstRow(state.rows)).toMatchObject({
      status: 'CLOSED', close_reason: 'TIMEOUT', phase: 'DISCUSSING', current_evaluation_round_id: null,
    });
    expect(firstRow(state.rows).reveal_at).not.toBeNull();
    expect(firstRow(state.rows).deadline_at).toEqual(deadline);
    const events = await admin().query<{ type: string; payload: { closeReason?: string } }>(
      "SELECT type, payload FROM public.gq_events WHERE room_id = $1 AND type LIKE 'ROUND_%'",
      [fixture.roomId],
    );
    expect(events.rows).toEqual([
      { type: 'ROUND_CLOSED', payload: { roundId: fixture.roundId, closeReason: 'TIMEOUT' } },
    ]);
  }, 40_000);

  it('rolls back the deciding vote, round close and reveal when the operation write fails', async () => {
    const fixture = await seedRoom();
    await service().voteRoundClose(
      fixture.hostUid,
      voteRoundCloseCommand(fixture, `operation-${randomUUID()}`),
    );
    const operationId = `rollback-${randomUUID()}`;
    await admin().query(`
      CREATE FUNCTION public.test_force_gq_rollback() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.operation_id LIKE 'rollback-%' THEN RAISE EXCEPTION 'FORCE_ROLLBACK'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER test_force_gq_rollback BEFORE INSERT ON public.gq_operations
      FOR EACH ROW EXECUTE FUNCTION public.test_force_gq_rollback();
    `);
    try {
      await expect(service().voteRoundClose(
        fixture.memberUid,
        voteRoundCloseCommand(fixture, operationId),
      )).rejects.toThrow('FORCE_ROLLBACK');

      const state = await admin().query<{
        status: string;
        closed_at: Date | null;
        reveal_at: Date | null;
        close_reason: string | null;
        phase: string;
        current_evaluation_round_id: string | null;
      }>(
        `SELECT er.status, er.closed_at, er.reveal_at, er.close_reason,
                r.phase, r.current_evaluation_round_id
         FROM public.gq_evaluation_rounds er
         JOIN public.gq_rooms r ON r.id = $2
         WHERE er.id = $1`,
        [fixture.roundId, fixture.roomId],
      );
      expect(firstRow(state.rows)).toEqual({
        status: 'OPEN', closed_at: null, reveal_at: null, close_reason: null,
        phase: 'EVALUATING', current_evaluation_round_id: fixture.roundId,
      });
      const writes = await admin().query<{ close_votes: number; close_events: number; operations: number }>(
        `SELECT
           (SELECT count(*)::integer FROM public.gq_close_votes WHERE round_id = $1) AS close_votes,
           (SELECT count(*)::integer FROM public.gq_events
             WHERE room_id = $2 AND type = 'ROUND_CLOSED') AS close_events,
           (SELECT count(*)::integer FROM public.gq_operations WHERE operation_id = $3) AS operations`,
        [fixture.roundId, fixture.roomId, operationId],
      );
      expect(firstRow(writes.rows)).toEqual({ close_votes: 1, close_events: 0, operations: 0 });
      const snapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
      expect(snapshot.shared.phase).toBe('EVALUATING');
      expect(snapshot.shared.revealedEvaluationRoundIds).toEqual([]);
      expect(snapshot.shared.activeRoundClose).toEqual({
        roundId: fixture.roundId, endVoteCount: 1, majorityThreshold: 2,
      });
    } finally {
      await admin().query('DROP TRIGGER test_force_gq_rollback ON public.gq_operations');
      await admin().query('DROP FUNCTION public.test_force_gq_rollback()');
    }
  });

  it('reuses identical idempotent results and rejects a changed payload', async () => {
    const fixture = await seedRoom();
    const operationId = `operation-${randomUUID()}`;
    const command = evaluationCommand(fixture, operationId);
    const first = await service().submitEvaluation(fixture.hostUid, command);
    const retry = await service().submitEvaluation(fixture.hostUid, command);
    expect(retry).toEqual(first);
    await expect(service().submitEvaluation(fixture.hostUid, { ...command, score: 5 }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const operations = await admin().query(
      'SELECT count(*)::integer AS count FROM public.gq_operations WHERE operation_id = $1',
      [operationId],
    );
    expect(firstRow(operations.rows).count).toBe(1);
  });

  it('returns only the actor blind evaluation and safe shared progress', async () => {
    const fixture = await seedRoom();
    const command = evaluationCommand(fixture, `operation-${randomUUID()}`);
    await service().submitEvaluation(fixture.hostUid, command);
    const hostSnapshot = await service().getSnapshot(fixture.hostUid, fixture.roomId);
    const memberSnapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(hostSnapshot.mine.evaluations[0]?.reason).toBe(command.reason);
    expect(memberSnapshot.mine.evaluations).toEqual([]);
    expect(memberSnapshot.shared.progress.evaluationSubmittedCount).toBe(1);
    expect(JSON.stringify(memberSnapshot.shared)).not.toContain(command.reason);
    expect(JSON.stringify(memberSnapshot.shared)).not.toContain('SUPPORT');
  });

  it('rejects a contradictory AGREED decision record at the database boundary', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const proposalId = await addProposal(fixture);
    await expect(admin().query(
      `INSERT INTO public.gq_decision_records(
        id, cycle_id, proposal_id, outcome, candidate_revision_snapshot,
        roster_snapshot, accepted, declined, abstained, pending
      ) VALUES ($1, $2, $1, 'AGREED', $3::jsonb, $4::text[], 1, 1, 0, 0)`,
      [proposalId, fixture.cycleId, JSON.stringify(fixture.candidateSnapshot), [fixture.hostUid, fixture.memberUid]],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('proposes a frozen final confirmation atomically with idempotent retries and safe aggregates', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const deadlineAt = new Date((await dbNow()).getTime() + 3_600_000).toISOString();
    const command = proposeFinalCommand(fixture, `operation-${randomUUID()}`, deadlineAt);
    const first = await service().proposeFinal(fixture.hostUid, command);
    const retry = await service().proposeFinal(fixture.hostUid, command);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      status: 'applied', roomId: fixture.roomId, proposalId: command.proposalId,
      candidateRevisionId: fixture.revisionId, phase: 'CONFIRMING',
      rosterUids: [fixture.hostUid, fixture.memberUid],
    });
    expect(Date.parse(first.deadlineAt)).toBe(Date.parse(deadlineAt));
    await expect(service().proposeFinal(fixture.hostUid, {
      ...command,
      deadlineAt: new Date(Date.parse(deadlineAt) + 1000).toISOString(),
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const stored = await admin().query<{
      roster_uids: string[];
      candidate_revision_snapshot: Record<string, unknown>;
      status: string;
    }>('SELECT roster_uids, candidate_revision_snapshot, status FROM public.gq_proposals WHERE id = $1', [command.proposalId]);
    expect(firstRow(stored.rows)).toEqual({
      roster_uids: [fixture.hostUid, fixture.memberUid],
      candidate_revision_snapshot: fixture.candidateSnapshot,
      status: 'OPEN',
    });
    const snapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(snapshot.shared.phase).toBe('CONFIRMING');
    expect(snapshot.shared.finalResponseSummary).toEqual({ accepted: 0, declined: 0, abstained: 0, pending: 2 });
    expect(snapshot.shared.decisionRecords).toEqual([]);
    expect(snapshot.mine.activeProposal).toMatchObject({
      id: command.proposalId,
      rosterUids: [fixture.hostUid, fixture.memberUid],
      candidateRevisionSnapshot: fixture.candidateSnapshot,
    });
  });

  it('enforces host, version, current revision and 5-minute-to-7-day proposal boundaries', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const now = await dbNow();
    const validDeadline = new Date(now.getTime() + 3_600_000).toISOString();
    await expect(service().proposeFinal(fixture.memberUid,
      proposeFinalCommand(fixture, `operation-${randomUUID()}`, validDeadline)))
      .rejects.toMatchObject({ code: 'NOT_HOST' });
    await expect(service().proposeFinal(fixture.hostUid,
      proposeFinalCommand(fixture, `operation-${randomUUID()}`, validDeadline, { expectedDecisionRevision: 2 })))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(service().proposeFinal(fixture.hostUid,
      proposeFinalCommand(fixture, `operation-${randomUUID()}`, validDeadline, { candidateRevisionId: `revision-${randomUUID()}` })))
      .rejects.toMatchObject({ code: 'CANDIDATE_REVISION_MISMATCH' });
    await expect(service().proposeFinal(fixture.hostUid,
      proposeFinalCommand(fixture, `operation-${randomUUID()}`, new Date(now.getTime() + 60_000).toISOString())))
      .rejects.toMatchObject({ code: 'INVALID_DEADLINE' });
    await expect(service().proposeFinal(fixture.hostUid,
      proposeFinalCommand(fixture, `operation-${randomUUID()}`, new Date(now.getTime() + 8 * 24 * 3_600_000).toISOString())))
      .rejects.toMatchObject({ code: 'INVALID_DEADLINE' });
    const room = await admin().query<{ phase: string; current_proposal_id: string | null }>(
      'SELECT phase, current_proposal_id FROM public.gq_rooms WHERE id = $1', [fixture.roomId]);
    expect(firstRow(room.rows)).toEqual({ phase: 'DISCUSSING', current_proposal_id: null });
  });

  it('closes explicitly as UNRESOLVED with changed votes, one record and private individual choices', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const deadlineAt = new Date((await dbNow()).getTime() + 3_600_000).toISOString();
    const proposal = proposeFinalCommand(fixture, `operation-${randomUUID()}`, deadlineAt);
    await service().proposeFinal(fixture.hostUid, proposal);
    await service().respondFinal(fixture.hostUid, finalCommand(fixture, proposal.proposalId, `operation-${randomUUID()}`));
    await service().respondFinal(fixture.memberUid, {
      ...finalCommand(fixture, proposal.proposalId, `operation-${randomUUID()}`), choice: 'ABSTAIN',
    });
    await service().respondFinal(fixture.memberUid, {
      ...finalCommand(fixture, proposal.proposalId, `operation-${randomUUID()}`), choice: 'DECLINE',
    });

    const confirming = await service().getSnapshot(fixture.hostUid, fixture.roomId);
    expect(confirming.shared.finalResponseSummary).toEqual({ accepted: 1, declined: 1, abstained: 0, pending: 0 });
    expect(confirming.mine.finalResponses.map(response => response.choice)).toEqual(['ACCEPT']);
    expect(JSON.stringify(confirming.shared)).not.toContain('DECLINE');
    await expect(service().closeUnresolved(fixture.memberUid,
      closeUnresolvedCommand(proposal.proposalId, `operation-${randomUUID()}`)))
      .rejects.toMatchObject({ code: 'NOT_HOST' });

    const close = closeUnresolvedCommand(proposal.proposalId, `operation-${randomUUID()}`);
    const first = await service().closeUnresolved(fixture.hostUid, close);
    const retry = await service().closeUnresolved(fixture.hostUid, close);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      outcome: 'UNRESOLVED', phase: 'COMPLETED',
      responseSummary: { accepted: 1, declined: 1, abstained: 0, pending: 0 },
    });
    const hostSnapshot = await service().getSnapshot(fixture.hostUid, fixture.roomId);
    const memberSnapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(hostSnapshot.shared.phase).toBe('COMPLETED');
    expect(hostSnapshot.shared.finalResponseSummary).toBeNull();
    expect(hostSnapshot.shared.decisionRecords).toEqual(memberSnapshot.shared.decisionRecords);
    expect(hostSnapshot.shared.decisionRecords).toHaveLength(1);
    expect(hostSnapshot.shared.decisionRecords[0]).toMatchObject({
      proposalId: proposal.proposalId,
      outcome: 'UNRESOLVED',
      candidateRevisionSnapshot: fixture.candidateSnapshot,
      rosterSnapshot: [fixture.hostUid, fixture.memberUid],
      responseSummary: { accepted: 1, declined: 1, abstained: 0, pending: 0 },
      unresolvedSummary: '未全员明确接受',
    });
    expect(hostSnapshot.mine.finalResponses.map(response => response.choice)).toEqual(['ACCEPT']);
    expect(memberSnapshot.mine.finalResponses.map(response => response.choice)).toEqual(['DECLINE']);
    const records = await admin().query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM public.gq_decision_records WHERE proposal_id = $1', [proposal.proposalId]);
    expect(firstRow(records.rows).count).toBe(1);
  });

  it('serializes the final ACCEPT with idempotent retries and writes one immutable result', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const proposalId = await addProposal(fixture);
    await service().respondFinal(fixture.hostUid, finalCommand(fixture, proposalId, `operation-${randomUUID()}`));
    const command = finalCommand(fixture, proposalId, `operation-${randomUUID()}`);
    const [first, retry] = await Promise.all([
      service().respondFinal(fixture.memberUid, command),
      service().respondFinal(fixture.memberUid, command),
    ]);
    expect(first).toEqual(retry);
    expect(first.proposalStatus).toBe('AGREED');
    const result = await admin().query(
      `SELECT outcome, accepted, declined, abstained, pending
       FROM public.gq_decision_records WHERE proposal_id = $1`,
      [proposalId],
    );
    expect(result.rows).toEqual([{ outcome: 'AGREED', accepted: 2, declined: 0, abstained: 0, pending: 0 }]);
    await expect(admin().query('DELETE FROM public.gq_decision_records WHERE proposal_id = $1', [proposalId]))
      .rejects.toThrow(/IMMUTABLE/);
  });

  it('commits deadline settlement while rejecting the late response', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const proposalId = await addProposal(fixture, { createdSecondsAgo: 7200, deadlineSecondsFromNow: -3600 });
    await expect(service().respondFinal(
      fixture.hostUid,
      finalCommand(fixture, proposalId, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'PROPOSAL_EXPIRED' });
    const result = await admin().query(
      `SELECT dr.outcome, dr.pending, r.phase
       FROM public.gq_decision_records dr
       JOIN public.gq_rooms r ON r.current_cycle_id = dr.cycle_id
       WHERE dr.proposal_id = $1`,
      [proposalId],
    );
    expect(result.rows).toEqual([{ outcome: 'UNRESOLVED', pending: 2, phase: 'COMPLETED' }]);
  });

  it('rolls back an evaluation when a later write in the RPC fails', async () => {
    const fixture = await seedRoom();
    await admin().query(`
      CREATE FUNCTION public.test_force_gq_rollback() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.operation_id LIKE 'rollback-%' THEN RAISE EXCEPTION 'FORCE_ROLLBACK'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER test_force_gq_rollback BEFORE INSERT ON public.gq_operations
      FOR EACH ROW EXECUTE FUNCTION public.test_force_gq_rollback();
    `);
    try {
      await expect(service().submitEvaluation(fixture.hostUid, {
        ...evaluationCommand(fixture, `rollback-${randomUUID()}`),
      })).rejects.toThrow('FORCE_ROLLBACK');
      const evaluations = await admin().query(
        'SELECT count(*)::integer AS count FROM public.gq_evaluations WHERE round_id = $1',
        [fixture.roundId],
      );
      expect(firstRow(evaluations.rows).count).toBe(0);
    } finally {
      await admin().query('DROP TRIGGER test_force_gq_rollback ON public.gq_operations');
      await admin().query('DROP FUNCTION public.test_force_gq_rollback()');
    }
  });

  it('rejects a final response that really waited on the room lock across the deadline', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const proposalId = await addProposal(fixture, { deadlineSecondsFromNow: 3 });
    const deadline = firstRow((await admin().query<{ deadline_at: Date }>(
      'SELECT deadline_at FROM public.gq_proposals WHERE id = $1',
      [proposalId],
    )).rows).deadline_at;
    const lock = await holdRoomLock(fixture.roomId);
    try {
      const issuedAt = await dbNow();
      expect(issuedAt.getTime()).toBeLessThan(deadline.getTime());
      const pending = settled(service().respondFinal(
        fixture.hostUid,
        finalCommand(fixture, proposalId, `operation-${randomUUID()}`),
      ));
      // Real evidence: the backend is on wait_event_type = 'Lock' for this exact statement.
      await waitForLockWait(SERVICE_APPLICATION_NAME, 'gq_respond_final');
      const waitingAt = await dbNow();
      expect(waitingAt.getTime()).toBeLessThan(deadline.getTime());
      await waitUntilPast(deadline);
      await lock.release();
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatchObject({ code: 'PROPOSAL_EXPIRED' });
    } finally {
      await lock.rollback();
    }

    const proposal = await admin().query<{ status: string }>(
      'SELECT status FROM public.gq_proposals WHERE id = $1',
      [proposalId],
    );
    expect(firstRow(proposal.rows).status).toBe('UNRESOLVED');
    const records = await admin().query(
      `SELECT outcome, accepted, declined, abstained, pending, count(*) OVER ()::integer AS total
       FROM public.gq_decision_records WHERE proposal_id = $1`,
      [proposalId],
    );
    expect(records.rows).toEqual([{ outcome: 'UNRESOLVED', accepted: 0, declined: 0, abstained: 0, pending: 2, total: 1 }]);
    const room = await admin().query<{ phase: string }>('SELECT phase FROM public.gq_rooms WHERE id = $1', [fixture.roomId]);
    expect(firstRow(room.rows).phase).toBe('COMPLETED');
    const responses = await admin().query(
      'SELECT count(*)::integer AS count FROM public.gq_final_responses WHERE proposal_id = $1',
      [proposalId],
    );
    expect(firstRow(responses.rows).count).toBe(0);
  }, 40_000);

  it('rejects an evaluation that really waited on the room lock across the round deadline', async () => {
    const fixture = await seedRoom({ phase: 'EVALUATING', roundDeadlineSeconds: 3 });
    const deadline = firstRow((await admin().query<{ deadline_at: Date }>(
      'SELECT deadline_at FROM public.gq_evaluation_rounds WHERE id = $1',
      [fixture.roundId],
    )).rows).deadline_at;
    const lock = await holdRoomLock(fixture.roomId);
    try {
      const pending = settled(service().submitEvaluation(
        fixture.hostUid,
        evaluationCommand(fixture, `operation-${randomUUID()}`),
      ));
      await waitForLockWait(SERVICE_APPLICATION_NAME, 'gq_submit_evaluation');
      const waitingAt = await dbNow();
      expect(waitingAt.getTime()).toBeLessThan(deadline.getTime());
      await waitUntilPast(deadline);
      await lock.release();
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatchObject({ code: 'ROUND_CLOSED' });
    } finally {
      await lock.rollback();
    }

    const round = await admin().query<{ status: string; reveal_at: Date | null }>(
      'SELECT status, reveal_at FROM public.gq_evaluation_rounds WHERE id = $1',
      [fixture.roundId],
    );
    expect(firstRow(round.rows).status).toBe('CLOSED');
    expect(firstRow(round.rows).reveal_at).not.toBeNull();
    const room = await admin().query<{ phase: string; current_evaluation_round_id: string | null }>(
      'SELECT phase, current_evaluation_round_id FROM public.gq_rooms WHERE id = $1',
      [fixture.roomId],
    );
    expect(firstRow(room.rows)).toMatchObject({ phase: 'DISCUSSING', current_evaluation_round_id: null });
    const evaluations = await admin().query(
      'SELECT count(*)::integer AS count FROM public.gq_evaluations WHERE round_id = $1',
      [fixture.roundId],
    );
    expect(firstRow(evaluations.rows).count).toBe(0);
  }, 40_000);

  it('rejects a response issued after the deadline inside a transaction started before it', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const proposalId = await addProposal(fixture, { deadlineSecondsFromNow: 3 });
    const deadline = firstRow((await admin().query<{ deadline_at: Date }>(
      'SELECT deadline_at FROM public.gq_proposals WHERE id = $1',
      [proposalId],
    )).rows).deadline_at;
    // One acceptance already recorded, so a wrongly accepted late ACCEPT would produce AGREED.
    await service().respondFinal(fixture.hostUid, finalCommand(fixture, proposalId, `operation-${randomUUID()}`));

    const client = await serviceRaw().connect();
    try {
      await client.query('BEGIN');
      const begunAt = await dbNow();
      expect(begunAt.getTime()).toBeLessThan(deadline.getTime());
      await waitUntilPast(deadline);
      const command = finalCommand(fixture, proposalId, `operation-${randomUUID()}`);
      const result = await client.query<{ result: { ok: boolean; error?: { code: string } } }>(
        'SELECT public.gq_respond_final($1, $2::jsonb) AS result',
        [fixture.memberUid, JSON.stringify(command)],
      );
      // now() would still report the pre-deadline transaction start; clock_timestamp() does not.
      expect(firstRow(result.rows).result).toMatchObject({ ok: false, error: { code: 'PROPOSAL_EXPIRED' } });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const records = await admin().query(
      'SELECT outcome, accepted, pending FROM public.gq_decision_records WHERE proposal_id = $1',
      [proposalId],
    );
    expect(records.rows).toEqual([{ outcome: 'UNRESOLVED', accepted: 1, pending: 1 }]);
    const agreed = await admin().query(
      "SELECT count(*)::integer AS count FROM public.gq_decision_records WHERE proposal_id = $1 AND outcome = 'AGREED'",
      [proposalId],
    );
    expect(firstRow(agreed.rows).count).toBe(0);
  }, 40_000);

  it('creates a sourced candidate atomically and lets its non-host creator withdraw it', async () => {
    const fixture = await seedRoom({ phase: 'CANDIDATE_REVIEW' });
    const sourceIdeaId = await seedIdea(fixture);
    const command = createCandidateCommand(fixture, `operation-${randomUUID()}`, {
      sourceIdeaIds: [sourceIdeaId],
    });
    const result = await service().createCandidate(fixture.memberUid, command);
    expect(result).toMatchObject({
      status: 'applied',
      roomId: fixture.roomId,
      candidateId: command.candidateId,
      revisionId: command.revisionId,
      revision: 1,
      phase: 'CANDIDATE_REVIEW',
      snapshotVersion: 1,
      decisionRevision: 2,
    });

    const stored = await admin().query<{
      created_by: string;
      revision: number;
      source_idea_ids: string[];
      withdrawn_at: Date | null;
    }>(
      `SELECT c.created_by, c.withdrawn_at, cr.revision, cr.source_idea_ids
       FROM public.gq_candidates c
       JOIN public.gq_candidate_revisions cr ON cr.id = c.current_revision_id
       WHERE c.id = $1`,
      [command.candidateId],
    );
    expect(firstRow(stored.rows)).toMatchObject({
      created_by: fixture.memberUid,
      revision: 1,
      source_idea_ids: [sourceIdeaId],
      withdrawn_at: null,
    });
    const snapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(snapshot.shared.candidates.find(candidate => candidate.id === command.candidateId)).toMatchObject({
      currentRevisionId: command.revisionId,
      withdrawnAt: null,
      createdBy: fixture.memberUid,
    });
    expect(snapshot.shared.currentRevisions.find(revision => revision.id === command.revisionId)).toMatchObject({
      candidateId: command.candidateId,
      sourceIdeaIds: [sourceIdeaId],
      createdBy: fixture.memberUid,
    });

    const withdrawn = await service().withdrawCandidate(
      fixture.memberUid,
      withdrawCandidateCommand(fixture, `operation-${randomUUID()}`, 2, command.candidateId),
    );
    expect(withdrawn).toMatchObject({
      candidateId: command.candidateId,
      revisionId: command.revisionId,
      proposalInvalidated: false,
      phase: 'CANDIDATE_REVIEW',
      decisionRevision: 3,
    });
    const revision = await admin().query<{ title: string; body: string }>(
      'SELECT title, body FROM public.gq_candidate_revisions WHERE id = $1',
      [command.revisionId],
    );
    expect(firstRow(revision.rows)).toEqual({ title: command.title, body: command.body });
  }, 20_000);

  it('rejects private, skipped, old-cycle and unknown candidate sources without partial writes', async () => {
    const fixture = await seedRoom({ phase: 'CANDIDATE_REVIEW' });
    const oldCycleId = `cycle-${randomUUID()}`;
    await admin().query('INSERT INTO public.gq_cycles(id, room_id, cycle_number) VALUES ($1, $2, 2)', [oldCycleId, fixture.roomId]);
    const invalidSources = [
      await seedIdea(fixture, { visibility: 'PRIVATE' }),
      await seedIdea(fixture, { skipped: true }),
      await seedIdea(fixture, { cycleId: oldCycleId }),
      `idea-${randomUUID()}`,
    ];
    for (const sourceIdeaId of invalidSources) {
      await expect(service().createCandidate(
        fixture.hostUid,
        createCandidateCommand(fixture, `operation-${randomUUID()}`, { sourceIdeaIds: [sourceIdeaId] }),
      )).rejects.toMatchObject({ code: 'INVALID_SOURCE_IDEA' });
    }
    await expect(service().createCandidate(fixture.hostUid, {
      ...createCandidateCommand(fixture, `operation-${randomUUID()}`),
      templateId: 'activity',
      templatePayload: {},
    })).rejects.toMatchObject({ code: 'TEMPLATE_MISMATCH' });
    await expect(service().createCandidate(
      `outsider-${randomUUID()}`,
      createCandidateCommand(fixture, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'NOT_MEMBER' });

    const candidates = await admin().query(
      'SELECT count(*)::integer AS count FROM public.gq_candidates WHERE room_id = $1',
      [fixture.roomId],
    );
    expect(firstRow(candidates.rows).count).toBe(1);
    const operations = await admin().query(
      "SELECT count(*)::integer AS count FROM public.gq_operations WHERE room_id = $1 AND action = 'createCandidate'",
      [fixture.roomId],
    );
    expect(firstRow(operations.rows).count).toBe(0);
  }, 20_000);

  it('enforces ten active candidates inside the room lock and reuses withdrawn capacity', async () => {
    const fixture = await seedRoom({ phase: 'CANDIDATE_REVIEW' });
    for (let index = 0; index < 9; index += 1) {
      await service().createCandidate(
        fixture.hostUid,
        createCandidateCommand(fixture, `operation-${randomUUID()}`, { expectedDecisionRevision: index + 1 }),
      );
    }
    await expect(service().createCandidate(
      fixture.hostUid,
      createCandidateCommand(fixture, `operation-${randomUUID()}`, { expectedDecisionRevision: 10 }),
    )).rejects.toMatchObject({ code: 'CANDIDATE_LIMIT' });

    await service().withdrawCandidate(fixture.hostUid, withdrawCandidateCommand(fixture, `operation-${randomUUID()}`, 10));
    const replacement = await service().createCandidate(
      fixture.hostUid,
      createCandidateCommand(fixture, `operation-${randomUUID()}`, { expectedDecisionRevision: 11 }),
    );
    expect(replacement.decisionRevision).toBe(12);
    const active = await admin().query(
      'SELECT count(*)::integer AS count FROM public.gq_candidates WHERE room_id = $1 AND withdrawn_at IS NULL',
      [fixture.roomId],
    );
    expect(firstRow(active.rows).count).toBe(10);
  }, 30_000);

  it('serializes identical candidate creation retries and rejects a changed payload', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const operationId = `operation-${randomUUID()}`;
    const command = createCandidateCommand(fixture, operationId);
    const [first, retry] = await Promise.all([
      service().createCandidate(fixture.hostUid, command),
      service().createCandidate(fixture.hostUid, command),
    ]);
    expect(retry).toEqual(first);
    await expect(service().createCandidate(fixture.hostUid, { ...command, title: '异载荷候选' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const candidates = await admin().query(
      'SELECT count(*)::integer AS count FROM public.gq_candidates WHERE id = $1',
      [command.candidateId],
    );
    expect(firstRow(candidates.rows).count).toBe(1);
    const operations = await admin().query(
      "SELECT count(*)::integer AS count FROM public.gq_operations WHERE room_id = $1 AND action = 'createCandidate' AND operation_id = $2",
      [fixture.roomId, operationId],
    );
    expect(firstRow(operations.rows).count).toBe(1);

    const collecting = await seedRoom({ phase: 'COLLECTING' });
    await expect(service().createCandidate(
      collecting.hostUid,
      createCandidateCommand(collecting, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'INVALID_STATE' });
  }, 20_000);

  it('enforces withdrawal authority, versions, lock state and idempotent projection', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    await expect(service().withdrawCandidate(
      fixture.memberUid,
      withdrawCandidateCommand(fixture, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    await expect(service().withdrawCandidate(
      fixture.hostUid,
      withdrawCandidateCommand(fixture, `operation-${randomUUID()}`, 99),
    )).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const operationId = `operation-${randomUUID()}`;
    const command = withdrawCandidateCommand(fixture, operationId);
    const first = await service().withdrawCandidate(fixture.hostUid, command);
    const retry = await service().withdrawCandidate(fixture.hostUid, command);
    expect(retry).toEqual(first);
    await expect(service().withdrawCandidate(fixture.hostUid, { ...command, expectedDecisionRevision: 2 }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(service().withdrawCandidate(
      fixture.hostUid,
      withdrawCandidateCommand(fixture, `operation-${randomUUID()}`, 2),
    )).rejects.toMatchObject({ code: 'CANDIDATE_WITHDRAWN' });

    const candidate = await admin().query<{ current_revision_id: string; withdrawn_at: Date | null }>(
      'SELECT current_revision_id, withdrawn_at FROM public.gq_candidates WHERE id = $1',
      [fixture.candidateId],
    );
    expect(firstRow(candidate.rows).current_revision_id).toBe(fixture.revisionId);
    expect(firstRow(candidate.rows).withdrawn_at).not.toBeNull();
    const snapshot = await service().getSnapshot(fixture.hostUid, fixture.roomId);
    expect(snapshot.shared.candidates.find(item => item.id === fixture.candidateId)?.withdrawnAt).toBe(first.withdrawnAt);
    expect(snapshot.shared.events.some(event => event.type === 'CANDIDATE_WITHDRAWN')).toBe(true);

    const evaluating = await seedRoom({ phase: 'EVALUATING' });
    await expect(service().withdrawCandidate(
      evaluating.hostUid,
      withdrawCandidateCommand(evaluating, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'CANDIDATE_LOCKED' });
  }, 20_000);

  it('serializes withdrawal before a late final ACCEPT and invalidates the proposal', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const proposalId = await addProposal(fixture, { deadlineSecondsFromNow: 600 });
    const withdrawOutcome = await withRoomLock(fixture.roomId, async release => {
      const pending = settled(service().withdrawCandidate(
        fixture.hostUid,
        withdrawCandidateCommand(fixture, `operation-${randomUUID()}`),
      ));
      await waitForLockWait(SERVICE_APPLICATION_NAME, 'gq_withdraw_candidate');
      await release();
      return pending;
    });
    expect(withdrawOutcome.ok).toBe(true);
    expect(withdrawOutcome.value).toMatchObject({
      proposalInvalidated: true,
      phase: 'DISCUSSING',
      decisionRevision: 2,
    });

    const late = await settled(service().respondFinal(
      fixture.memberUid,
      finalCommand(fixture, proposalId, `operation-${randomUUID()}`),
    ));
    expect(late.ok).toBe(false);
    expect(late.error).toMatchObject({ code: 'PROPOSAL_CLOSED' });
    const proposal = await admin().query<{ status: string }>(
      'SELECT status FROM public.gq_proposals WHERE id = $1',
      [proposalId],
    );
    expect(firstRow(proposal.rows).status).toBe('INVALIDATED');
    const agreed = await admin().query(
      "SELECT count(*)::integer AS count FROM public.gq_decision_records WHERE proposal_id = $1 AND outcome = 'AGREED'",
      [proposalId],
    );
    expect(firstRow(agreed.rows).count).toBe(0);
    const revision = await admin().query<{ title: string; body: string }>(
      'SELECT title, body FROM public.gq_candidate_revisions WHERE id = $1',
      [fixture.revisionId],
    );
    expect(firstRow(revision.rows)).toEqual({
      title: '通用候选',
      body: '不依赖活动字段的方案内容',
    });
  }, 40_000);

  it('applies a substantive candidate revision and invalidates the open proposal atomically', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const proposalId = await addProposal(fixture, { deadlineSecondsFromNow: 600 });
    const nextRevisionId = `revision-${randomUUID()}`;
    const result = await service().reviseCandidate(
      fixture.hostUid,
      reviseCommand(fixture, `operation-${randomUUID()}`, { revisionId: nextRevisionId }),
    );
    expect(result).toMatchObject({
      status: 'applied',
      candidateId: fixture.candidateId,
      revisionId: nextRevisionId,
      revision: 2,
      substantive: true,
      proposalInvalidated: true,
      phase: 'DISCUSSING',
      decisionRevision: 2,
    });

    const room = await admin().query<{ phase: string; decision_revision: number; current_proposal_id: string | null }>(
      'SELECT phase, decision_revision, current_proposal_id FROM public.gq_rooms WHERE id = $1',
      [fixture.roomId],
    );
    expect(firstRow(room.rows)).toMatchObject({ phase: 'DISCUSSING', decision_revision: 2, current_proposal_id: null });
    const proposal = await admin().query<{ status: string }>('SELECT status FROM public.gq_proposals WHERE id = $1', [proposalId]);
    expect(firstRow(proposal.rows).status).toBe('INVALIDATED');
    const candidate = await admin().query<{ current_revision_id: string }>(
      'SELECT current_revision_id FROM public.gq_candidates WHERE id = $1',
      [fixture.candidateId],
    );
    expect(firstRow(candidate.rows).current_revision_id).toBe(nextRevisionId);
    const events = await admin().query<{ type: string }>(
      "SELECT type FROM public.gq_events WHERE room_id = $1 AND type IN ('CANDIDATE_REVISION_CREATED', 'PROPOSAL_INVALIDATED') ORDER BY id",
      [fixture.roomId],
    );
    expect(events.rows.map(row => row.type)).toEqual(['CANDIDATE_REVISION_CREATED', 'PROPOSAL_INVALIDATED']);
    const decisions = await admin().query(
      'SELECT count(*)::integer AS count FROM public.gq_decision_records WHERE proposal_id = $1',
      [proposalId],
    );
    expect(firstRow(decisions.rows).count).toBe(0);
  }, 20_000);

  it('records a whitespace-only candidate revision without changing the decision revision', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING', candidateTitle: '通用 候选' });
    const nextRevisionId = `revision-${randomUUID()}`;
    const result = await service().reviseCandidate(
      fixture.hostUid,
      reviseCommand(fixture, `operation-${randomUUID()}`, {
        revisionId: nextRevisionId,
        title: '通用   候选',
        body: '不依赖活动字段的方案内容',
      }),
    );
    expect(result).toMatchObject({ substantive: false, proposalInvalidated: false, phase: 'DISCUSSING', decisionRevision: 1 });
    const room = await admin().query<{ decision_revision: number }>(
      'SELECT decision_revision FROM public.gq_rooms WHERE id = $1',
      [fixture.roomId],
    );
    expect(firstRow(room.rows).decision_revision).toBe(1);
    const candidate = await admin().query<{ current_revision_id: string }>(
      'SELECT current_revision_id FROM public.gq_candidates WHERE id = $1',
      [fixture.candidateId],
    );
    expect(firstRow(candidate.rows).current_revision_id).toBe(nextRevisionId);
  }, 20_000);

  it('locks candidate fields while a round is evaluating', async () => {
    const fixture = await seedRoom({ phase: 'EVALUATING' });
    await expect(service().reviseCandidate(fixture.hostUid, reviseCommand(fixture, `operation-${randomUUID()}`)))
      .rejects.toMatchObject({ code: 'CANDIDATE_LOCKED' });
  });

  it('enforces revise permission, version and revision identity from the real command entry', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    await expect(service().reviseCandidate(fixture.memberUid, reviseCommand(fixture, `operation-${randomUUID()}`)))
      .rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    await expect(service().reviseCandidate(
      fixture.hostUid,
      reviseCommand(fixture, `operation-${randomUUID()}`, { expectedDecisionRevision: 99 }),
    )).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(service().reviseCandidate(
      fixture.hostUid,
      reviseCommand(fixture, `operation-${randomUUID()}`, { revisionId: fixture.revisionId }),
    )).rejects.toMatchObject({ code: 'REVISION_ALREADY_EXISTS' });
  });

  it('reuses an identical revise result and rejects a changed payload', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const operationId = `operation-${randomUUID()}`;
    const command = reviseCommand(fixture, operationId);
    const first = await service().reviseCandidate(fixture.hostUid, command);
    const retry = await service().reviseCandidate(fixture.hostUid, command);
    expect(retry).toEqual(first);
    await expect(service().reviseCandidate(fixture.hostUid, { ...command, title: '另一个标题' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  }, 20_000);

  it('removes a member atomically, cancelling the open round without revealing it', async () => {
    const fixture = await seedRoom({ phase: 'EVALUATING' });
    const result = await service().changeRoster(
      fixture.hostUid,
      rosterCommand(fixture, `operation-${randomUUID()}`, 'REMOVE', fixture.memberUid),
    );
    expect(result).toMatchObject({
      status: 'applied',
      roomId: fixture.roomId,
      uid: fixture.memberUid,
      action: 'REMOVE',
      memberStatus: 'REMOVED',
      phase: 'CANDIDATE_REVIEW',
      decisionRevision: 2,
      rosterRevision: 2,
      cancelledRoundId: fixture.roundId,
    });
    expect(result.invalidatedProposalId).toBeUndefined();

    const member = await admin().query<{ status: string; roster_revision: number }>(
      'SELECT status, roster_revision FROM public.gq_members WHERE room_id = $1 AND uid = $2',
      [fixture.roomId, fixture.memberUid],
    );
    expect(firstRow(member.rows)).toMatchObject({ status: 'REMOVED', roster_revision: 2 });
    const round = await admin().query<{ status: string; reveal_at: Date | null; close_reason: string | null }>(
      'SELECT status, reveal_at, close_reason FROM public.gq_evaluation_rounds WHERE id = $1',
      [fixture.roundId],
    );
    expect(firstRow(round.rows)).toMatchObject({ status: 'CANCELLED', reveal_at: null, close_reason: null });
    const room = await admin().query<{ phase: string; roster_revision: number; decision_revision: number; current_evaluation_round_id: string | null }>(
      'SELECT phase, roster_revision, decision_revision, current_evaluation_round_id FROM public.gq_rooms WHERE id = $1',
      [fixture.roomId],
    );
    expect(firstRow(room.rows)).toMatchObject({
      phase: 'CANDIDATE_REVIEW',
      roster_revision: 2,
      decision_revision: 2,
      current_evaluation_round_id: null,
    });
  }, 20_000);

  it('lets a member leave and cancels the open round', async () => {
    const fixture = await seedRoom({ phase: 'EVALUATING' });
    const result = await service().changeRoster(
      fixture.memberUid,
      rosterCommand(fixture, `operation-${randomUUID()}`, 'LEAVE', fixture.memberUid),
    );
    expect(result).toMatchObject({ uid: fixture.memberUid, action: 'LEAVE', memberStatus: 'LEFT', decisionRevision: 2, rosterRevision: 2 });
    const member = await admin().query<{ status: string }>(
      'SELECT status FROM public.gq_members WHERE room_id = $1 AND uid = $2',
      [fixture.roomId, fixture.memberUid],
    );
    expect(firstRow(member.rows).status).toBe('LEFT');
    const round = await admin().query<{ status: string }>(
      'SELECT status FROM public.gq_evaluation_rounds WHERE id = $1',
      [fixture.roundId],
    );
    expect(firstRow(round.rows).status).toBe('CANCELLED');
  }, 20_000);

  it('enforces roster change authority from the real command entry', async () => {
    const fixture = await seedRoom({ phase: 'EVALUATING' });
    await expect(service().changeRoster(
      fixture.hostUid,
      rosterCommand(fixture, `operation-${randomUUID()}`, 'REMOVE', fixture.hostUid),
    )).rejects.toMatchObject({ code: 'HOST_MUST_TRANSFER' });
    await expect(service().changeRoster(
      fixture.memberUid,
      rosterCommand(fixture, `operation-${randomUUID()}`, 'REMOVE', fixture.memberUid),
    )).rejects.toMatchObject({ code: 'NOT_HOST' });
    await expect(service().changeRoster(
      fixture.memberUid,
      rosterCommand(fixture, `operation-${randomUUID()}`, 'LEAVE', fixture.hostUid),
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service().changeRoster(
      fixture.hostUid,
      rosterCommand(fixture, `operation-${randomUUID()}`, 'REMOVE', `ghost-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });
    const room = await admin().query<{ phase: string; decision_revision: number }>(
      'SELECT phase, decision_revision FROM public.gq_rooms WHERE id = $1',
      [fixture.roomId],
    );
    expect(firstRow(room.rows)).toMatchObject({ phase: 'EVALUATING', decision_revision: 1 });
  }, 20_000);

  it('archives a room without revoking members and blocks every later write', async () => {
    const fixture = await seedRoom({ phase: 'EVALUATING' });
    const operationId = `operation-${randomUUID()}`;
    const command = lifecycleCommand(fixture, operationId);
    const result = await service().changeRoomLifecycle(fixture.hostUid, 'ARCHIVE', command);
    expect(result).toMatchObject({
      status: 'applied',
      action: 'ARCHIVE',
      roomStatus: 'ARCHIVED',
      phase: 'EVALUATING',
      decisionRevision: 1,
      rosterRevision: 1,
      snapshotVersion: 1,
      revokedMemberCount: 0,
    });

    const room = await admin().query<{ room_status: string; phase: string; current_evaluation_round_id: string | null }>(
      'SELECT room_status, phase, current_evaluation_round_id FROM public.gq_rooms WHERE id = $1',
      [fixture.roomId],
    );
    expect(firstRow(room.rows)).toMatchObject({
      room_status: 'ARCHIVED',
      phase: 'EVALUATING',
      current_evaluation_round_id: fixture.roundId,
    });
    const members = await admin().query<{ status: string }>(
      'SELECT status FROM public.gq_members WHERE room_id = $1 ORDER BY uid',
      [fixture.roomId],
    );
    expect(members.rows.map(row => row.status)).toEqual(['JOINED', 'JOINED']);

    const snapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(snapshot.shared.roomStatus).toBe('ARCHIVED');
    await expect(service().changeRoster(
      fixture.hostUid,
      rosterCommand(fixture, `operation-${randomUUID()}`, 'REMOVE', fixture.memberUid),
    )).rejects.toMatchObject({ code: 'ROOM_NOT_ACTIVE' });

    expect(await service().changeRoomLifecycle(fixture.hostUid, 'ARCHIVE', command)).toEqual(result);
    await expect(service().changeRoomLifecycle(fixture.hostUid, 'ARCHIVE', {
      ...command,
      expectedDecisionRevision: 2,
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  }, 20_000);

  it('lets only the host archive and rejects stale revisions', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    await expect(service().changeRoomLifecycle(
      fixture.memberUid,
      'ARCHIVE',
      lifecycleCommand(fixture, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'NOT_HOST' });
    await expect(service().changeRoomLifecycle(
      fixture.hostUid,
      'ARCHIVE',
      lifecycleCommand(fixture, `operation-${randomUUID()}`, 99),
    )).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const room = await admin().query<{ room_status: string; decision_revision: number }>(
      'SELECT room_status, decision_revision FROM public.gq_rooms WHERE id = $1',
      [fixture.roomId],
    );
    expect(firstRow(room.rows)).toMatchObject({ room_status: 'ACTIVE', decision_revision: 1 });
  }, 20_000);

  it('closes a room, revoking every non-host member and cancelling the open round', async () => {
    const fixture = await seedRoom({ phase: 'EVALUATING' });
    const operationId = `operation-${randomUUID()}`;
    const command = lifecycleCommand(fixture, operationId);
    const result = await service().changeRoomLifecycle(fixture.hostUid, 'CLOSE', command);
    expect(result).toMatchObject({
      status: 'applied',
      action: 'CLOSE',
      roomStatus: 'CLOSED',
      phase: 'CANDIDATE_REVIEW',
      decisionRevision: 2,
      rosterRevision: 2,
      revokedMemberCount: 1,
      cancelledRoundId: fixture.roundId,
    });

    const member = await admin().query<{ status: string; roster_revision: number }>(
      'SELECT status, roster_revision FROM public.gq_members WHERE room_id = $1 AND uid = $2',
      [fixture.roomId, fixture.memberUid],
    );
    expect(firstRow(member.rows)).toMatchObject({ status: 'LEFT', roster_revision: 2 });
    const host = await admin().query<{ status: string }>(
      'SELECT status FROM public.gq_members WHERE room_id = $1 AND uid = $2',
      [fixture.roomId, fixture.hostUid],
    );
    expect(firstRow(host.rows).status).toBe('JOINED');
    const round = await admin().query<{ status: string }>(
      'SELECT status FROM public.gq_evaluation_rounds WHERE id = $1',
      [fixture.roundId],
    );
    expect(firstRow(round.rows).status).toBe('CANCELLED');
    const room = await admin().query<{ room_status: string; phase: string; current_evaluation_round_id: string | null }>(
      'SELECT room_status, phase, current_evaluation_round_id FROM public.gq_rooms WHERE id = $1',
      [fixture.roomId],
    );
    expect(firstRow(room.rows)).toMatchObject({
      room_status: 'CLOSED',
      phase: 'CANDIDATE_REVIEW',
      current_evaluation_round_id: null,
    });

    const hostSnapshot = await service().getSnapshot(fixture.hostUid, fixture.roomId);
    expect(hostSnapshot.shared.roomStatus).toBe('CLOSED');
    expect(hostSnapshot.shared.memberUids).toEqual([fixture.hostUid]);
    await expect(service().getSnapshot(fixture.memberUid, fixture.roomId))
      .rejects.toMatchObject({ code: 'NOT_MEMBER' });
    await expect(service().changeRoster(
      fixture.memberUid,
      rosterCommand(fixture, `operation-${randomUUID()}`, 'LEAVE', fixture.memberUid, 2),
    )).rejects.toMatchObject({ code: 'NOT_MEMBER' });

    expect(await service().changeRoomLifecycle(fixture.hostUid, 'CLOSE', command)).toEqual(result);
    const second = await service().changeRoomLifecycle(
      fixture.hostUid,
      'CLOSE',
      lifecycleCommand(fixture, `operation-${randomUUID()}`, 2),
    );
    expect(second).toMatchObject({ roomStatus: 'CLOSED', decisionRevision: 2, rosterRevision: 2, revokedMemberCount: 0 });
  }, 20_000);

  it('turns deletion into a soft close that keeps history and host read access', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const result = await service().changeRoomLifecycle(
      fixture.hostUid,
      'DELETE',
      lifecycleCommand(fixture, `operation-${randomUUID()}`),
    );
    expect(result).toMatchObject({
      action: 'DELETE',
      roomStatus: 'DELETING',
      phase: 'CANDIDATE_REVIEW',
      decisionRevision: 2,
      rosterRevision: 2,
      revokedMemberCount: 1,
    });

    const counts = await admin().query<{ rooms: string; revisions: string; members: string }>(
      `SELECT
         (SELECT count(*) FROM public.gq_rooms WHERE id = $1)::text AS rooms,
         (SELECT count(*) FROM public.gq_candidate_revisions WHERE candidate_id = $2)::text AS revisions,
         (SELECT count(*) FROM public.gq_members WHERE room_id = $1)::text AS members`,
      [fixture.roomId, fixture.candidateId],
    );
    expect(firstRow(counts.rows)).toEqual({ rooms: '1', revisions: '1', members: '2' });
    const event = await admin().query<{ type: string }>(
      "SELECT type FROM public.gq_events WHERE room_id = $1 AND type IN ('ROOM_DELETE_REQUESTED', 'ROOM_CLOSED')",
      [fixture.roomId],
    );
    expect(event.rows.map(row => row.type)).toEqual(['ROOM_DELETE_REQUESTED']);

    const hostSnapshot = await service().getSnapshot(fixture.hostUid, fixture.roomId);
    expect(hostSnapshot.shared.roomStatus).toBe('DELETING');
    await expect(service().getSnapshot(fixture.memberUid, fixture.roomId))
      .rejects.toMatchObject({ code: 'NOT_MEMBER' });

    const second = await service().changeRoomLifecycle(
      fixture.hostUid,
      'DELETE',
      lifecycleCommand(fixture, `operation-${randomUUID()}`, 2),
    );
    expect(second).toMatchObject({ roomStatus: 'DELETING', decisionRevision: 2, rosterRevision: 2, revokedMemberCount: 0 });
  }, 20_000);

  it('serializes the lifecycle change behind the room row lock', async () => {
    const fixture = await seedRoom({ phase: 'EVALUATING' });
    const command = lifecycleCommand(fixture, `operation-${randomUUID()}`);
    const outcome = await withRoomLock(fixture.roomId, async release => {
      const pending = settled(service().changeRoomLifecycle(fixture.hostUid, 'CLOSE', command));
      await waitForLockWait(SERVICE_APPLICATION_NAME, 'gq_change_room_lifecycle');
      await release();
      return pending;
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({ roomStatus: 'CLOSED', revokedMemberCount: 1 });
  }, 20_000);

  it('starts the next cycle only from COMPLETED and keeps earlier cycles immutable', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    await expect(service().startNextCycle(
      fixture.hostUid,
      startNextCycleCommand(fixture, `cycle-${randomUUID()}`, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'INVALID_PHASE' });

    const deadlineAt = new Date((await dbNow()).getTime() + 3_600_000).toISOString();
    const proposal = proposeFinalCommand(fixture, `operation-${randomUUID()}`, deadlineAt);
    await service().proposeFinal(fixture.hostUid, proposal);
    await service().closeUnresolved(
      fixture.hostUid,
      closeUnresolvedCommand(proposal.proposalId, `operation-${randomUUID()}`),
    );

    const nextCycleId = `cycle-${randomUUID()}`;
    await expect(service().startNextCycle(
      fixture.memberUid,
      startNextCycleCommand(fixture, nextCycleId, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'NOT_HOST' });
    await expect(service().startNextCycle(
      fixture.hostUid,
      startNextCycleCommand(fixture, nextCycleId, `operation-${randomUUID()}`, 99),
    )).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(service().startNextCycle(
      fixture.hostUid,
      startNextCycleCommand(fixture, fixture.cycleId, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'CYCLE_EXISTS' });

    const command = startNextCycleCommand(fixture, nextCycleId, `operation-${randomUUID()}`);
    const first = await service().startNextCycle(fixture.hostUid, command);
    expect(first).toMatchObject({
      status: 'applied',
      roomId: fixture.roomId,
      previousCycleId: fixture.cycleId,
      cycleId: nextCycleId,
      cycleNumber: 2,
      phase: 'COLLECTING',
      decisionRevision: 2,
      rosterRevision: 1,
    });
    expect(await service().startNextCycle(fixture.hostUid, command)).toEqual(first);
    await expect(service().startNextCycle(
      fixture.hostUid,
      startNextCycleCommand(fixture, `cycle-${randomUUID()}`, `operation-${randomUUID()}`, 2),
    )).rejects.toMatchObject({ code: 'INVALID_PHASE' });

    const room = await admin().query<{
      current_cycle_id: string;
      phase: string;
      decision_revision: number;
      current_evaluation_round_id: string | null;
      current_proposal_id: string | null;
    }>(
      `SELECT current_cycle_id, phase, decision_revision,
              current_evaluation_round_id, current_proposal_id
       FROM public.gq_rooms WHERE id = $1`,
      [fixture.roomId],
    );
    expect(firstRow(room.rows)).toEqual({
      current_cycle_id: nextCycleId,
      phase: 'COLLECTING',
      decision_revision: 2,
      current_evaluation_round_id: null,
      current_proposal_id: null,
    });
    const cycles = await admin().query<{ id: string; cycle_number: number }>(
      'SELECT id, cycle_number FROM public.gq_cycles WHERE room_id = $1 ORDER BY cycle_number',
      [fixture.roomId],
    );
    expect(cycles.rows).toEqual([
      { id: fixture.cycleId, cycle_number: 1 },
      { id: nextCycleId, cycle_number: 2 },
    ]);
    const records = await admin().query<{ outcome: string; cycle_id: string }>(
      'SELECT outcome, cycle_id FROM public.gq_decision_records WHERE proposal_id = $1',
      [proposal.proposalId],
    );
    expect(records.rows).toEqual([{ outcome: 'UNRESOLVED', cycle_id: fixture.cycleId }]);
    const event = await admin().query<{ type: string }>(
      "SELECT type FROM public.gq_events WHERE room_id = $1 AND type = 'CYCLE_STARTED'",
      [fixture.roomId],
    );
    expect(event.rowCount).toBe(1);

    const snapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(snapshot.shared.currentCycleId).toBe(nextCycleId);
    expect(snapshot.shared.phase).toBe('COLLECTING');
    expect(snapshot.shared.decisionRecords).toEqual([]);
    expect(snapshot.shared.publicIdeas).toEqual([]);
    expect(snapshot.shared.candidates).toHaveLength(1);
    expect(snapshot.version).toBe(first.snapshotVersion);
  }, 20_000);

  it('transfers the host role to a joined member without changing the decision basis', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    await expect(service().transferHost(
      fixture.memberUid,
      transferHostCommand(fixture, fixture.memberUid, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'NOT_HOST' });
    await expect(service().transferHost(
      fixture.hostUid,
      transferHostCommand(fixture, fixture.hostUid, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
    await expect(service().transferHost(
      fixture.hostUid,
      transferHostCommand(fixture, `ghost-${randomUUID()}`, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });
    await expect(service().transferHost(
      fixture.hostUid,
      transferHostCommand(fixture, fixture.memberUid, `operation-${randomUUID()}`, 99),
    )).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const command = transferHostCommand(fixture, fixture.memberUid, `operation-${randomUUID()}`);
    const first = await service().transferHost(fixture.hostUid, command);
    expect(first).toMatchObject({
      status: 'applied',
      roomId: fixture.roomId,
      hostUid: fixture.memberUid,
      previousHostUid: fixture.hostUid,
      phase: 'DISCUSSING',
      decisionRevision: 1,
      rosterRevision: 2,
    });
    expect(await service().transferHost(fixture.hostUid, command)).toEqual(first);

    const room = await admin().query<{ host_uid: string; roster_revision: number; decision_revision: number }>(
      'SELECT host_uid, roster_revision, decision_revision FROM public.gq_rooms WHERE id = $1',
      [fixture.roomId],
    );
    expect(firstRow(room.rows)).toEqual({
      host_uid: fixture.memberUid,
      roster_revision: 2,
      decision_revision: 1,
    });
    const members = await admin().query<{ uid: string; role: string; status: string; roster_revision: number }>(
      'SELECT uid, role, status, roster_revision FROM public.gq_members WHERE room_id = $1 ORDER BY uid',
      [fixture.roomId],
    );
    expect(members.rows).toEqual([
      { uid: fixture.hostUid, role: 'MEMBER', status: 'JOINED', roster_revision: 2 },
      { uid: fixture.memberUid, role: 'HOST', status: 'JOINED', roster_revision: 2 },
    ]);
    const event = await admin().query<{ payload: { previousHostUid: string; hostUid: string } }>(
      "SELECT payload FROM public.gq_events WHERE room_id = $1 AND type = 'HOST_TRANSFERRED'",
      [fixture.roomId],
    );
    expect(event.rows).toHaveLength(1);
    expect(firstRow(event.rows).payload).toMatchObject({
      previousHostUid: fixture.hostUid,
      hostUid: fixture.memberUid,
    });

    const memberSnapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(memberSnapshot.shared.hostUid).toBe(fixture.memberUid);
    expect(memberSnapshot.shared.memberUids).toEqual([fixture.hostUid, fixture.memberUid]);

    await expect(service().changeRoomLifecycle(
      fixture.hostUid,
      'ARCHIVE',
      lifecycleCommand(fixture, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'NOT_HOST' });
    expect(await service().changeRoomLifecycle(
      fixture.memberUid,
      'ARCHIVE',
      lifecycleCommand(fixture, `operation-${randomUUID()}`),
    )).toMatchObject({ action: 'ARCHIVE', roomStatus: 'ARCHIVED' });
  }, 20_000);

  it('refuses a final ACCEPT that arrives after a substantive revision won the room lock', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const proposalId = await addProposal(fixture, { deadlineSecondsFromNow: 600 });
    const reviseOutcome = await withRoomLock(fixture.roomId, async release => {
      const pending = settled(service().reviseCandidate(fixture.hostUid, reviseCommand(fixture, `operation-${randomUUID()}`)));
      await waitForLockWait(SERVICE_APPLICATION_NAME, 'gq_revise_candidate');
      await release();
      return pending;
    });
    expect(reviseOutcome.ok).toBe(true);
    expect(reviseOutcome.value).toMatchObject({ substantive: true, proposalInvalidated: true, decisionRevision: 2 });

    const late = await settled(service().respondFinal(
      fixture.memberUid,
      finalCommand(fixture, proposalId, `operation-${randomUUID()}`),
    ));
    expect(late.ok).toBe(false);
    expect(late.error).toMatchObject({ code: 'PROPOSAL_CLOSED' });

    const proposal = await admin().query<{ status: string }>('SELECT status FROM public.gq_proposals WHERE id = $1', [proposalId]);
    expect(firstRow(proposal.rows).status).toBe('INVALIDATED');
    const agreed = await admin().query(
      "SELECT count(*)::integer AS count FROM public.gq_decision_records WHERE proposal_id = $1 AND outcome = 'AGREED'",
      [proposalId],
    );
    expect(firstRow(agreed.rows).count).toBe(0);
  }, 40_000);

  it('invalidates the proposal when a final ACCEPT is followed by a substantive revision', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const proposalId = await addProposal(fixture, { deadlineSecondsFromNow: 600 });
    const acceptOutcome = await withRoomLock(fixture.roomId, async release => {
      const pending = settled(service().respondFinal(fixture.hostUid, finalCommand(fixture, proposalId, `operation-${randomUUID()}`)));
      await waitForLockWait(SERVICE_APPLICATION_NAME, 'gq_respond_final');
      await release();
      return pending;
    });
    expect(acceptOutcome.ok).toBe(true);
    expect(acceptOutcome.value).toMatchObject({ proposalStatus: 'OPEN' });

    const reviseOutcome = await settled(service().reviseCandidate(fixture.hostUid, reviseCommand(fixture, `operation-${randomUUID()}`)));
    expect(reviseOutcome.ok).toBe(true);
    expect(reviseOutcome.value).toMatchObject({ substantive: true, proposalInvalidated: true, decisionRevision: 2 });

    const proposal = await admin().query<{ status: string }>('SELECT status FROM public.gq_proposals WHERE id = $1', [proposalId]);
    expect(firstRow(proposal.rows).status).toBe('INVALIDATED');
    const records = await admin().query(
      'SELECT count(*)::integer AS count FROM public.gq_decision_records WHERE proposal_id = $1',
      [proposalId],
    );
    expect(firstRow(records.rows).count).toBe(0);
  }, 40_000);

  it('requests reopen with the initiator vote and exposes only aggregates plus the own vote', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const command = reopenRequestCommand(fixture, `operation-${randomUUID()}`);
    const result = await service().requestReopen(fixture.memberUid, command);
    expect(result).toMatchObject({
      status: 'applied',
      roomId: fixture.roomId,
      requestId: command.requestId,
      roundId: command.roundId,
      phase: 'DISCUSSING',
      requestStatus: 'OPEN',
      reopenVoteCount: 1,
      majorityThreshold: 2,
      snapshotVersion: 1,
    });

    const hostSnapshot = await service().getSnapshot(fixture.hostUid, fixture.roomId);
    const memberSnapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(hostSnapshot.shared.activeReopen).toEqual({
      requestId: command.requestId,
      roundId: command.roundId,
      requestedBy: fixture.memberUid,
      targetRevisionIds: [fixture.revisionId],
      reopenVoteCount: 1,
      majorityThreshold: 2,
    });
    expect(hostSnapshot.mine.reopenVote).toBeUndefined();
    expect(memberSnapshot.mine.reopenVote).toEqual({ requestId: command.requestId, choice: 'REOPEN' });
    expect(hostSnapshot.shared.events).toContainEqual(expect.objectContaining({
      type: 'REOPEN_REQUESTED',
      requestId: command.requestId,
    }));

    const votes = await admin().query<{ uid: string; choice: string }>(
      'SELECT uid, choice FROM public.gq_reopen_votes WHERE request_id = $1',
      [command.requestId],
    );
    expect(votes.rows).toEqual([{ uid: fixture.memberUid, choice: 'REOPEN' }]);
  }, 20_000);

  it('changes own reopen support without duplicate votes and restricts cancellation to the requester', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const request = reopenRequestCommand(fixture, `operation-${randomUUID()}`);
    await service().requestReopen(fixture.memberUid, request);

    const withdrawn = await service().voteReopen(
      fixture.memberUid,
      reopenVoteCommand(request.requestId, `operation-${randomUUID()}`, { choice: 'KEEP_DISCUSSING' }),
    );
    expect(withdrawn).toMatchObject({ choice: 'KEEP_DISCUSSING', requestStatus: 'OPEN', phase: 'DISCUSSING', reopenVoteCount: 0 });
    const restored = await service().voteReopen(
      fixture.memberUid,
      reopenVoteCommand(request.requestId, `operation-${randomUUID()}`, { choice: 'REOPEN' }),
    );
    expect(restored).toMatchObject({ reopenVoteCount: 1, requestStatus: 'OPEN' });
    const hostVote = await service().voteReopen(
      fixture.hostUid,
      reopenVoteCommand(request.requestId, `operation-${randomUUID()}`, { choice: 'KEEP_DISCUSSING' }),
    );
    expect(hostVote).toMatchObject({ choice: 'KEEP_DISCUSSING', reopenVoteCount: 1, phase: 'DISCUSSING' });

    await expect(service().cancelReopen(
      fixture.hostUid,
      reopenCancelCommand(request.requestId, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'NOT_REQUESTER' });
    const cancelled = await service().cancelReopen(
      fixture.memberUid,
      reopenCancelCommand(request.requestId, `operation-${randomUUID()}`),
    );
    expect(cancelled).toMatchObject({ requestStatus: 'CANCELLED', phase: 'DISCUSSING' });

    const votes = await admin().query<{ uid: string; choice: string }>(
      'SELECT uid, choice FROM public.gq_reopen_votes WHERE request_id = $1 ORDER BY uid',
      [request.requestId],
    );
    expect(votes.rows).toHaveLength(2);
    expect(votes.rows).toContainEqual({ uid: fixture.memberUid, choice: 'REOPEN' });
    expect(votes.rows).toContainEqual({ uid: fixture.hostUid, choice: 'KEEP_DISCUSSING' });
    const snapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(snapshot.shared.activeReopen).toBeNull();
    expect(snapshot.mine.reopenVote).toBeUndefined();
    expect(snapshot.shared.events).toContainEqual(expect.objectContaining({
      type: 'REOPEN_CANCELLED',
      requestId: request.requestId,
    }));
  }, 20_000);

  it('opens exactly the requested target round when the second reopen vote reaches majority', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const request = reopenRequestCommand(fixture, `operation-${randomUUID()}`);
    await service().requestReopen(fixture.memberUid, request);
    const vote = reopenVoteCommand(request.requestId, `operation-${randomUUID()}`);
    const result = await service().voteReopen(fixture.hostUid, vote);
    expect(result).toMatchObject({
      choice: 'REOPEN',
      requestStatus: 'APPROVED',
      phase: 'EVALUATING',
      roundId: request.roundId,
      reopenVoteCount: 2,
      majorityThreshold: 2,
    });
    expect(await service().voteReopen(fixture.hostUid, vote)).toEqual(result);
    await expect(service().voteReopen(fixture.hostUid, { ...vote, choice: 'KEEP_DISCUSSING' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const round = await admin().query<{
      id: string;
      cycle_id: string;
      roster_uids: string[];
      roster_revision: number;
      target_revision_ids: string[];
      status: string;
    }>(
      `SELECT id, cycle_id, roster_uids, roster_revision, target_revision_ids, status
       FROM public.gq_evaluation_rounds WHERE id = $1`,
      [request.roundId],
    );
    expect(firstRow(round.rows)).toMatchObject({
      id: request.roundId,
      cycle_id: fixture.cycleId,
      roster_uids: [fixture.hostUid, fixture.memberUid],
      roster_revision: 1,
      target_revision_ids: [fixture.revisionId],
      status: 'OPEN',
    });
    const requestRow = await admin().query<{ status: string; round_id: string }>(
      'SELECT status, round_id FROM public.gq_reopen_requests WHERE id = $1',
      [request.requestId],
    );
    expect(firstRow(requestRow.rows)).toEqual({ status: 'APPROVED', round_id: request.roundId });

    const snapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
    expect(snapshot.shared.phase).toBe('EVALUATING');
    expect(snapshot.shared.activeEvaluationRound).toMatchObject({ id: request.roundId, targetRevisionIds: [fixture.revisionId] });
    expect(snapshot.shared.activeReopen).toBeNull();
    expect(snapshot.mine.reopenVote).toBeUndefined();
    expect(snapshot.shared.events).toContainEqual(expect.objectContaining({
      type: 'REOPEN_OPENED',
      requestId: request.requestId,
      roundId: request.roundId,
    }));
  }, 20_000);

  it('enforces reopen membership, phase, versions, current targets and the single-open-request rule', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    await expect(service().requestReopen(
      `outsider-${randomUUID()}`,
      reopenRequestCommand(fixture, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'NOT_MEMBER' });
    await expect(service().requestReopen(
      fixture.memberUid,
      reopenRequestCommand(fixture, `operation-${randomUUID()}`, { expectedDecisionRevision: 99 }),
    )).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(service().requestReopen(
      fixture.memberUid,
      reopenRequestCommand(fixture, `operation-${randomUUID()}`, { expectedRosterRevision: 99 }),
    )).rejects.toMatchObject({ code: 'ROSTER_VERSION_CONFLICT' });
    await expect(service().requestReopen(
      fixture.memberUid,
      reopenRequestCommand(fixture, `operation-${randomUUID()}`, { targetRevisionIds: [`missing-${randomUUID()}`] }),
    )).rejects.toMatchObject({ code: 'CANDIDATE_REVISION_MISMATCH' });
    await expect(service().openEvaluation(
      fixture.hostUid,
      openEvaluationCommand(fixture, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'INVALID_PHASE' });

    await service().requestReopen(fixture.memberUid, reopenRequestCommand(fixture, `operation-${randomUUID()}`));
    await expect(service().requestReopen(
      fixture.hostUid,
      reopenRequestCommand(fixture, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'REOPEN_ALREADY_OPEN' });

    const evaluating = await seedRoom({ phase: 'EVALUATING' });
    await expect(service().requestReopen(
      evaluating.memberUid,
      reopenRequestCommand(evaluating, `operation-${randomUUID()}`),
    )).rejects.toMatchObject({ code: 'INVALID_PHASE' });
  }, 20_000);

  it('reuses identical reopen request and cancellation results and rejects changed payloads', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const request = reopenRequestCommand(fixture, `operation-${randomUUID()}`);
    const first = await service().requestReopen(fixture.memberUid, request);
    expect(await service().requestReopen(fixture.memberUid, request)).toEqual(first);
    await expect(service().requestReopen(fixture.memberUid, { ...request, roundId: `other-${randomUUID()}` }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const cancel = reopenCancelCommand(request.requestId, `operation-${randomUUID()}`);
    const cancelled = await service().cancelReopen(fixture.memberUid, cancel);
    expect(await service().cancelReopen(fixture.memberUid, cancel)).toEqual(cancelled);
    await expect(service().cancelReopen(fixture.memberUid, { ...cancel, expectedDecisionRevision: 2 }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  }, 20_000);

  it('cancels an open reopen request when its target is revised or withdrawn', async () => {
    for (const action of ['revise', 'withdraw'] as const) {
      const fixture = await seedRoom({ phase: 'DISCUSSING' });
      const request = reopenRequestCommand(fixture, `operation-${randomUUID()}`);
      await service().requestReopen(fixture.memberUid, request);
      if (action === 'revise') {
        await service().reviseCandidate(fixture.hostUid, reviseCommand(fixture, `operation-${randomUUID()}`));
      } else {
        await service().withdrawCandidate(
          fixture.hostUid,
          withdrawCandidateCommand(fixture, `operation-${randomUUID()}`),
        );
      }

      const requestRow = await admin().query<{ status: string }>(
        'SELECT status FROM public.gq_reopen_requests WHERE id = $1',
        [request.requestId],
      );
      expect(firstRow(requestRow.rows).status).toBe('CANCELLED');
      await expect(service().voteReopen(
        fixture.hostUid,
        reopenVoteCommand(request.requestId, `operation-${randomUUID()}`, { expectedDecisionRevision: 2 }),
      )).rejects.toMatchObject({ code: 'REOPEN_CLOSED' });
      const snapshot = await service().getSnapshot(fixture.memberUid, fixture.roomId);
      expect(snapshot.shared.activeReopen).toBeNull();
      expect(snapshot.shared.events).toContainEqual(expect.objectContaining({
        type: 'REOPEN_CANCELLED',
        requestId: request.requestId,
      }));
    }
  }, 30_000);

  it('serializes competing majority votes so only one new evaluation round is created', async () => {
    const fixture = await seedRoom({ phase: 'DISCUSSING' });
    const thirdUid = `third-${randomUUID()}`;
    await admin().query(
      `INSERT INTO public.gq_members(room_id, uid, role, status, roster_revision)
       VALUES ($1, $2, 'MEMBER', 'JOINED', 1)`,
      [fixture.roomId, thirdUid],
    );
    const request = reopenRequestCommand(fixture, `operation-${randomUUID()}`);
    const started = await service().requestReopen(fixture.hostUid, request);
    expect(started).toMatchObject({ reopenVoteCount: 1, majorityThreshold: 2 });

    const outcomes = await Promise.all([
      settled(service().voteReopen(
        fixture.memberUid,
        reopenVoteCommand(request.requestId, `operation-${randomUUID()}`),
      )),
      settled(service().voteReopen(
        thirdUid,
        reopenVoteCommand(request.requestId, `operation-${randomUUID()}`),
      )),
    ]);
    expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
    const failed = outcomes.find(outcome => !outcome.ok);
    expect(failed?.error).toMatchObject({ code: 'INVALID_PHASE' });
    const approved = outcomes.find(outcome => outcome.ok);
    expect(approved?.value).toMatchObject({ requestStatus: 'APPROVED', phase: 'EVALUATING', roundId: request.roundId });

    const rounds = await admin().query(
      'SELECT count(*)::integer AS count FROM public.gq_evaluation_rounds WHERE cycle_id = $1',
      [fixture.cycleId],
    );
    expect(firstRow(rounds.rows).count).toBe(1);
    const room = await admin().query<{ phase: string; current_evaluation_round_id: string }>(
      'SELECT phase, current_evaluation_round_id FROM public.gq_rooms WHERE id = $1',
      [fixture.roomId],
    );
    expect(firstRow(room.rows)).toEqual({ phase: 'EVALUATING', current_evaluation_round_id: request.roundId });
  }, 30_000);
});
