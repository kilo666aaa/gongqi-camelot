import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'cloudbase/migrations/20261107120000_gq_room_lifecycle.sql'),
  'utf8',
);

describe('T7 room lifecycle migration static review (not a PostgreSQL execution)', () => {
  it('keeps archive, close and delete in one host-only atomic RPC', () => {
    expect(migration).toContain('CREATE FUNCTION public.gq_change_room_lifecycle(p_actor_uid text, p_payload jsonb)');
    expect(migration).toContain("v_action NOT IN ('ARCHIVE', 'CLOSE', 'DELETE')");
    expect(migration).toContain("'code', 'NOT_HOST'");
    expect(migration).toContain("'code', 'VERSION_CONFLICT'");
    expect(migration).toContain("'changeRoomLifecycle'");
    expect(migration).toContain('FOR UPDATE');
  });

  it('revokes every non-host member and keeps the host able to read history', () => {
    expect(migration).toContain("SET status = 'LEFT', roster_revision = v_room.roster_revision + 1");
    expect(migration).toContain("WHERE room_id = v_room_id AND status = 'JOINED' AND uid <> v_room.host_uid");
    expect(migration).toContain("SET status = 'REVOKED'");
    expect(migration).toContain("SET status = 'CANCELLED'");
    expect(migration).toContain("SET status = 'INVALIDATED'");
  });

  it('is a soft close that never drops or deletes business tables', () => {
    expect(migration).not.toMatch(/DROP TABLE/i);
    expect(migration).not.toMatch(/DELETE FROM/i);
    expect(migration).not.toMatch(/TRUNCATE/i);
    expect(migration).toContain("'ROOM_ARCHIVED'");
    expect(migration).toContain("'ROOM_CLOSED'");
    expect(migration).toContain("'ROOM_DELETE_REQUESTED'");
  });

  it('extends the event constraint and keeps direct access service_role only', () => {
    expect(migration).toContain('ALTER TABLE public.gq_events DROP CONSTRAINT gq_events_type_check');
    expect(migration).toContain('ROOM_DELETE_REQUESTED');
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.gq_change_room_lifecycle(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.gq_change_room_lifecycle(text, jsonb) TO service_role;");
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.gq_change_room_lifecycle[\s\S]*?TO (?:anon|authenticated)/);
  });

  it('uses a fixed empty search path like the other security definer RPCs', () => {
    expect(migration).toContain("SET search_path = ''");
  });
});
