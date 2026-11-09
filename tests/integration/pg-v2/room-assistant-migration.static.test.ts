import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'cloudbase/migrations/20261107090000_gq_room_assistant.sql'),
  'utf8',
);

const exposedRpcSignatures = [
  'gq_register_assistant_request(text, jsonb)',
  'gq_complete_assistant_request(text, jsonb)',
  'gq_get_assistant_messages(text, text)',
];

describe('T6 room assistant migration static review (not a PostgreSQL execution)', () => {
  it('keeps assistant records separate and PUBLIC scoped', () => {
    expect(migration).toContain('CREATE TABLE public.gq_assistant_messages');
    expect(migration).toContain("UNIQUE (actor_uid, room_id, request_id)");
    expect(migration).toContain("status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'STALE')");
    expect(migration).toContain("CHECK (scope = 'PUBLIC')");
    expect(migration).toContain('context_snapshot_version integer NOT NULL');
    expect(migration).toContain('source_ids jsonb');
  });

  it('never writes candidates, evaluations, votes or final decisions', () => {
    expect(migration).not.toMatch(/INSERT INTO public\.gq_candidates/);
    expect(migration).not.toMatch(/UPDATE public\.gq_candidates/);
    expect(migration).not.toMatch(/INSERT INTO public\.gq_evaluations/);
    expect(migration).not.toMatch(/UPDATE public\.gq_evaluations/);
    expect(migration).not.toMatch(/INSERT INTO public\.gq_final_responses/);
    expect(migration).not.toMatch(/UPDATE public\.gq_rooms/);
  });

  it('keeps the model call outside the database transaction', () => {
    // The migration exposes registration and completion as separate short RPCs,
    // so the gateway can call the model between them without a room lock.
    expect(migration).toContain('gq_register_assistant_request');
    expect(migration).toContain('gq_complete_assistant_request');
    expect(migration).toContain('FOR SHARE');
    expect(migration).not.toMatch(/gq_register_assistant_request[\s\S]*?interval '20 seconds'/);
  });

  it('enforces server-side rate limiting, output limits and revoked members', () => {
    expect(migration).toContain("interval '60 seconds'");
    expect(migration).toContain('v_recent_count >= 6');
    expect(migration).toContain('length(v_answer) > 4000');
    expect(migration).toContain('jsonb_array_length(v_source_ids) > 20');
    expect(migration).toContain("'MEMBER_REVOKED'");
    expect(migration).toContain("interval '2 minutes'");
    expect(migration).toContain("'AI_TIMEOUT'");
  });

  it('revokes direct table and RPC access and grants only service_role', () => {
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain("REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated");
    for (const signature of exposedRpcSignatures) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
    }
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.\w+[\s\S]*?TO (?:anon|authenticated)/);
    // The payload helper must stay internal.
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.gq_assistant_message_payload/);
  });

  it('uses fixed empty search paths for every SQL and PL/pgSQL function', () => {
    const definitions = migration.split('CREATE FUNCTION ').slice(1);
    expect(definitions.length).toBe(4);
    for (const definition of definitions) {
      const header = definition.split(';', 1)[0];
      expect(header).toContain("SET search_path = ''");
    }
  });
});
