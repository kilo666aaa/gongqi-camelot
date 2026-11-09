-- T7: startNextCycle and transferHost.
-- startNextCycle only moves a COMPLETED, ACTIVE room back to COLLECTING by adding a new
-- immutable cycle row. Previous cycles, ideas, rounds, proposals and decision records are
-- never updated or deleted. Existing candidates stay available for the new cycle.
-- transferHost swaps the host role inside one room-lock transaction. Roster membership and
-- the decision basis are unchanged, so decisionRevision stays; the roster role change bumps
-- rosterRevision and snapshotVersion.

ALTER TABLE public.gq_events DROP CONSTRAINT gq_events_type_check;
ALTER TABLE public.gq_events ADD CONSTRAINT gq_events_type_check CHECK (type IN (
  'ROUND_CLOSED',
  'ROUND_DEADLINE_CHANGED',
  'CANDIDATE_REVISION_CREATED',
  'CANDIDATE_WITHDRAWN',
  'PROPOSAL_INVALIDATED',
  'MEMBER_CHANGED',
  'INVITE_ROTATED',
  'REOPEN_REQUESTED',
  'REOPEN_OPENED',
  'REOPEN_CANCELLED',
  'ROOM_ARCHIVED',
  'ROOM_CLOSED',
  'ROOM_DELETE_REQUESTED',
  'CYCLE_STARTED',
  'HOST_TRANSFERRED'
));

CREATE FUNCTION public.gq_start_next_cycle(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_start_next_cycle$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_revision numeric;
  v_next_cycle_id text;
  v_cycle_number integer;
  v_decision_revision integer;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'roomId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'nextCycleId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_expected_revision := (p_payload->>'expectedDecisionRevision')::numeric;
  v_room_id := p_payload->>'roomId';
  v_next_cycle_id := p_payload->>'nextCycleId';

  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_FOUND'));
  END IF;
  v_now := clock_timestamp();

  IF NOT EXISTS (
    SELECT 1 FROM public.gq_members m
    WHERE m.room_id = v_room_id AND m.uid = p_actor_uid AND m.status = 'JOINED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_MEMBER'));
  END IF;

  PERFORM public.gq_settle_room(v_room_id, v_now);

  v_request_hash := md5(concat_ws(chr(31), p_actor_uid, p_payload::text));
  SELECT request_hash, response INTO v_existing_hash, v_existing_response
  FROM public.gq_operations
  WHERE actor_uid = p_actor_uid AND room_id = v_room_id
    AND action = 'startNextCycle' AND operation_id = p_payload->>'operationId';

  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id;

  IF v_room.room_status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_ACTIVE'));
  END IF;
  IF v_room.host_uid <> p_actor_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_HOST'));
  END IF;
  IF v_room.phase <> 'COMPLETED' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_PHASE'));
  END IF;
  IF v_expected_revision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.gq_cycles WHERE id = v_next_cycle_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CYCLE_EXISTS'));
  END IF;

  SELECT COALESCE(MAX(cycle_number), 0) + 1 INTO v_cycle_number
  FROM public.gq_cycles WHERE room_id = v_room_id;

  INSERT INTO public.gq_cycles(id, room_id, cycle_number, created_at)
  VALUES (v_next_cycle_id, v_room_id, v_cycle_number, v_now);

  UPDATE public.gq_rooms
  SET current_cycle_id = v_next_cycle_id,
      phase = 'COLLECTING',
      current_evaluation_round_id = NULL,
      current_proposal_id = NULL,
      decision_revision = decision_revision + 1,
      snapshot_version = snapshot_version + 1,
      updated_at = v_now
  WHERE id = v_room_id
  RETURNING decision_revision INTO v_decision_revision;

  INSERT INTO public.gq_events(room_id, type, payload, created_at)
  VALUES (v_room_id, 'CYCLE_STARTED',
    jsonb_build_object(
      'previousCycleId', v_room.current_cycle_id,
      'cycleId', v_next_cycle_id,
      'cycleNumber', v_cycle_number
    ), v_now);

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied',
      'roomId', v_room_id,
      'previousCycleId', v_room.current_cycle_id,
      'cycleId', v_next_cycle_id,
      'cycleNumber', v_cycle_number,
      'phase', 'COLLECTING',
      'decisionRevision', v_decision_revision,
      'rosterRevision', v_room.roster_revision,
      'snapshotVersion', v_room.snapshot_version + 1,
      'updatedAt', public.gq_iso(v_now)
    )
  );

  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'startNextCycle', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_start_next_cycle$;

CREATE FUNCTION public.gq_transfer_host(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_transfer_host$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_revision numeric;
  v_target_uid text;
  v_target public.gq_members%ROWTYPE;
  v_previous_host_uid text;
  v_roster_revision integer;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'roomId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'targetUid', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_expected_revision := (p_payload->>'expectedDecisionRevision')::numeric;
  v_room_id := p_payload->>'roomId';
  v_target_uid := p_payload->>'targetUid';

  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_FOUND'));
  END IF;
  v_now := clock_timestamp();

  IF NOT EXISTS (
    SELECT 1 FROM public.gq_members m
    WHERE m.room_id = v_room_id AND m.uid = p_actor_uid AND m.status = 'JOINED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_MEMBER'));
  END IF;

  PERFORM public.gq_settle_room(v_room_id, v_now);

  v_request_hash := md5(concat_ws(chr(31), p_actor_uid, p_payload::text));
  SELECT request_hash, response INTO v_existing_hash, v_existing_response
  FROM public.gq_operations
  WHERE actor_uid = p_actor_uid AND room_id = v_room_id
    AND action = 'transferHost' AND operation_id = p_payload->>'operationId';

  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id;

  IF v_room.room_status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_ACTIVE'));
  END IF;
  IF v_room.host_uid <> p_actor_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_HOST'));
  END IF;
  IF v_target_uid = p_actor_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;
  IF v_expected_revision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;

  SELECT * INTO v_target
  FROM public.gq_members
  WHERE room_id = v_room_id AND uid = v_target_uid
  FOR UPDATE;
  IF NOT FOUND OR v_target.status <> 'JOINED' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'MEMBER_NOT_FOUND'));
  END IF;

  v_previous_host_uid := v_room.host_uid;
  v_roster_revision := v_room.roster_revision + 1;

  UPDATE public.gq_members
  SET role = 'MEMBER', roster_revision = v_roster_revision
  WHERE room_id = v_room_id AND uid = v_previous_host_uid;

  UPDATE public.gq_members
  SET role = 'HOST', roster_revision = v_roster_revision
  WHERE room_id = v_room_id AND uid = v_target_uid;

  UPDATE public.gq_rooms
  SET host_uid = v_target_uid,
      roster_revision = v_roster_revision,
      snapshot_version = snapshot_version + 1,
      updated_at = v_now
  WHERE id = v_room_id;

  INSERT INTO public.gq_events(room_id, type, payload, created_at)
  VALUES (v_room_id, 'HOST_TRANSFERRED',
    jsonb_build_object(
      'previousHostUid', v_previous_host_uid,
      'hostUid', v_target_uid,
      'rosterRevision', v_roster_revision
    ), v_now);

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied',
      'roomId', v_room_id,
      'hostUid', v_target_uid,
      'previousHostUid', v_previous_host_uid,
      'phase', v_room.phase,
      'decisionRevision', v_room.decision_revision,
      'rosterRevision', v_roster_revision,
      'snapshotVersion', v_room.snapshot_version + 1,
      'updatedAt', public.gq_iso(v_now)
    )
  );

  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'transferHost', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_transfer_host$;

REVOKE ALL ON FUNCTION public.gq_start_next_cycle(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gq_start_next_cycle(text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.gq_transfer_host(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gq_transfer_host(text, jsonb) TO service_role;

-- Rollback for this migration:
-- 1. DROP FUNCTION public.gq_start_next_cycle(text, jsonb);
-- 2. DROP FUNCTION public.gq_transfer_host(text, jsonb);
-- 3. Restore the gq_events_type_check constraint without CYCLE_STARTED/HOST_TRANSFERRED.
