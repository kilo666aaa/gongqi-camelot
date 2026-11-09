import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'cloudbase/migrations/20261107130000_gq_cycle_host_transfer.sql'),
  'utf8',
);

describe('T7 next cycle and host transfer migration static review (not a PostgreSQL execution)', () => {
  it('starts a new cycle only from COMPLETED for the host and never rewrites history', () => {
    expect(migration).toContain('CREATE FUNCTION public.gq_start_next_cycle(p_actor_uid text, p_payload jsonb)');
    expect(migration).toContain("v_room.phase <> 'COMPLETED'");
    expect(migration).toContain("'code', 'NOT_HOST'");
    expect(migration).toContain("'code', 'INVALID_PHASE'");
    expect(migration).toContain("'code', 'CYCLE_EXISTS'");
    expect(migration).toContain("'startNextCycle'");
    expect(migration).toContain('INSERT INTO public.gq_cycles');
    expect(migration).not.toMatch(/UPDATE public\.gq_cycles/);
    expect(migration).not.toMatch(/(?:UPDATE|DELETE FROM) public\.gq_decision_records/);
    expect(migration).toContain('FOR UPDATE');
  });

  it('resets the active pointers and bumps the versions when the next cycle begins', () => {
    expect(migration).toContain("phase = 'COLLECTING'");
    expect(migration).toContain('current_evaluation_round_id = NULL');
    expect(migration).toContain('current_proposal_id = NULL');
    expect(migration).toContain('decision_revision = decision_revision + 1');
    expect(migration).toContain('snapshot_version = snapshot_version + 1');
  });

  it('transfers host only to a joined member and keeps both memberships', () => {
    expect(migration).toContain('CREATE FUNCTION public.gq_transfer_host(p_actor_uid text, p_payload jsonb)');
    expect(migration).toContain("v_target.status <> 'JOINED'");
    expect(migration).toContain("'code', 'MEMBER_NOT_FOUND'");
    expect(migration).toContain("SET role = 'MEMBER', roster_revision = v_roster_revision");
    expect(migration).toContain("SET role = 'HOST', roster_revision = v_roster_revision");
    expect(migration).toContain('host_uid = v_target_uid');
    expect(migration).not.toMatch(/SET status = 'LEFT'/);
    expect(migration).toContain("'transferHost'");
  });

  it('adds audit events without dropping or deleting business data', () => {
    expect(migration).not.toMatch(/DROP TABLE/i);
    expect(migration).not.toMatch(/DELETE FROM/i);
    expect(migration).not.toMatch(/TRUNCATE/i);
    expect(migration).toContain('ALTER TABLE public.gq_events DROP CONSTRAINT gq_events_type_check');
    expect(migration).toContain("'CYCLE_STARTED'");
    expect(migration).toContain("'HOST_TRANSFERRED'");
  });

  it('keeps both RPCs service_role only with a fixed empty search path', () => {
    expect(migration).toContain("SET search_path = ''");
    for (const fn of ['gq_start_next_cycle', 'gq_transfer_host']) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${fn}(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}(text, jsonb) TO service_role;`);
      expect(migration).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[\\s\\S]*?TO (?:anon|authenticated)`));
    }
  });
});
