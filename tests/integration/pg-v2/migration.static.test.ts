import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'cloudbase/migrations/20261103080337_gq_vtwo_core.sql'),
  'utf8',
);
const repository = readFileSync(
  resolve(process.cwd(), 'cloudbase/functions/gateway/src/repositories/pgV2Repository.ts'),
  'utf8',
);

const expectedTables = [
  'gq_rooms', 'gq_members', 'gq_cycles', 'gq_ideas', 'gq_candidates',
  'gq_candidate_revisions', 'gq_evaluation_rounds', 'gq_evaluations',
  'gq_close_votes', 'gq_reopen_requests', 'gq_reopen_votes', 'gq_comments',
  'gq_proposals', 'gq_final_responses', 'gq_decision_records', 'gq_operations',
  'gq_events', 'gq_invites',
];

const exposedRpcSignatures = [
  'gq_create_room(text, jsonb)',
  'gq_rotate_invite(text, jsonb)',
  'gq_join_room(text, jsonb)',
  'gq_submit_idea(text, jsonb)',
  'gq_submit_idea_skip(text, jsonb)',
  'gq_close_collection(text, jsonb)',
  'gq_add_comment(text, jsonb)',
  'gq_create_candidate(text, jsonb)',
  'gq_withdraw_candidate(text, jsonb)',
  'gq_open_evaluation(text, jsonb)',
  'gq_submit_evaluation(text, jsonb)',
  'gq_close_evaluation(text, jsonb)',
  'gq_propose_final(text, jsonb)',
  'gq_respond_final(text, jsonb)',
  'gq_close_unresolved(text, jsonb)',
  'gq_get_snapshot(text, text)',
  'gq_revise_candidate(text, jsonb)',
  'gq_request_reopen(text, jsonb)',
  'gq_vote_reopen(text, jsonb)',
  'gq_cancel_reopen(text, jsonb)',
  'gq_change_roster(text, jsonb)',
];

describe('T3 migration static review (not a PostgreSQL execution)', () => {
  it('declares exactly the 18 planned business tables', () => {
    const actual = [...migration.matchAll(/CREATE TABLE public\.(gq_[a-z_]+)/g)].map(match => match[1]);
    expect(actual).toEqual(expectedTables);
  });

  it('keeps the scoped idempotency key and unanimous-agreement database checks', () => {
    expect(migration).toContain('PRIMARY KEY (actor_uid, room_id, action, operation_id)');
    expect(migration).toContain("ON public.gq_operations(actor_uid, operation_id) WHERE action = 'createRoom'");
    expect(migration).toContain("ON public.gq_operations(actor_uid, operation_id) WHERE action = 'joinRoom'");
    expect(migration).toContain('accepted + declined + abstained + pending = cardinality(roster_snapshot)');
    expect(migration).toContain('accepted = cardinality(roster_snapshot)');
    expect(migration).toContain("AND declined = 0 AND abstained = 0 AND pending = 0");
    expect(migration).toContain('proposal_id text UNIQUE REFERENCES public.gq_proposals(id)');
  });

  it('samples the decision time with clock_timestamp after the room lock', () => {
    // now() is pinned to the transaction start, so a command that waited across a
    // deadline would be accepted with a stale timestamp.
    expect(migration).not.toMatch(/v_now\s+timestamptz\s*:=\s*now\(\)/);
    expect(migration).not.toMatch(/v_now\s*:=\s*now\(\)/);
    expect(migration).toContain('v_now := clock_timestamp();');
    expect(migration).toContain('CREATE FUNCTION public.gq_settle_room(p_room_id text, p_now timestamptz)');
    expect(migration).toContain('v_now timestamptz := p_now;');
    expect(migration).toContain('PERFORM public.gq_settle_room(v_room_id, v_now);');
    expect(migration).toContain('PERFORM public.gq_settle_room(p_room_id, v_now);');
    // The sampled command time is the only time source handed to settlement.
    expect(migration).not.toMatch(/gq_settle_room\(\s*[a-z_.]+,\s*now\(\)/);
  });

  it('revokes direct table and RPC access and grants write RPC only to service_role', () => {
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    for (const signature of exposedRpcSignatures) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
    }
    // The internal settlement helper must stay unreachable from every runtime role.
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.gq_settle_room(text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;');
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.gq_settle_room/);
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.gq_(?:iso|prevent_immutable_mutation)/);
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.gq_\w+[\s\S]*?TO (?:anon|authenticated)/);
  });

  it('keeps reopen events and atomic target-round creation in the migration', () => {
    for (const type of ['REOPEN_REQUESTED', 'REOPEN_OPENED', 'REOPEN_CANCELLED']) {
      expect(migration).toContain(`'${type}'`);
    }
    expect(migration).toContain('round_id text NOT NULL UNIQUE');
    expect(migration).toContain("action = 'requestReopen'");
    expect(migration).toContain("action = 'voteReopen'");
    expect(migration).toContain("action = 'cancelReopen'");
    expect(migration).toContain('v_request.round_id, v_request.cycle_id, v_request.roster_uids');
    expect(migration).toContain("SET phase = 'EVALUATING', current_evaluation_round_id = v_request.round_id");
  });

  it('uses fixed empty search paths for every SQL and PL/pgSQL function', () => {
    const definitions = migration.split('CREATE FUNCTION ').slice(1);
    expect(definitions.length).toBeGreaterThanOrEqual(8);
    for (const definition of definitions) {
      const body = definition.split(';', 1)[0];
      expect(body).toContain("SET search_path = ''");
    }
  });

  it('does not mutate M0 and uses the real pg driver with Zod-boundary validation', () => {
    expect(migration).not.toMatch(/(?:DROP|ALTER) TABLE public\.m0_/);
    expect(repository).toContain("from 'pg'");
    // The pool accepts a full config so tests can pin a real service_role session.
    expect(repository).toContain('new Pool(config)');
    expect(repository).toContain('type PoolConfig');
    expect(repository).toContain('roomSnapshotForMemberSchema(uid).parse(value)');
    expect(repository).not.toContain('pg-mem');
  });
});
