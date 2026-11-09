-- T7 room lifecycle: archive, close and delete.
-- ARCHIVED keeps the current roster and history readable but every write RPC already
-- requires room_status = 'ACTIVE', so the room becomes read-only.
-- CLOSED / DELETING are soft closes: every non-host member is revoked immediately,
-- open rounds/proposals/reopen requests are cancelled, and immutable history is kept.
-- Physical purge for DELETING is a separate controlled maintenance action; this RPC
-- never drops tables, M0 objects or admin data.

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
  'ROOM_DELETE_REQUESTED'
));

CREATE FUNCTION public.gq_change_room_lifecycle(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_change_room_lifecycle$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_revision numeric;
  v_action text;
  v_target_status text;
  v_event_type text;
  v_revoked_count integer := 0;
  v_cancelled_round text;
  v_invalidated_proposal text;
  v_decision_revision integer;
  v_roster_revision integer;
  v_phase text;
  v_has_public_candidate boolean;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'roomId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_expected_revision := (p_payload->>'expectedDecisionRevision')::numeric;
  v_action := p_payload->>'action';
  v_room_id := p_payload->>'roomId';

  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision)
    OR v_action IS NULL OR v_action NOT IN ('ARCHIVE', 'CLOSE', 'DELETE') THEN
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
    AND action = 'changeRoomLifecycle' AND operation_id = p_payload->>'operationId';

  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id;

  IF v_room.host_uid <> p_actor_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_HOST'));
  END IF;

  IF v_action = 'ARCHIVE' THEN
    IF v_room.room_status = 'ARCHIVED' THEN
      RETURN jsonb_build_object('ok', true, 'value', jsonb_build_object(
        'status', 'applied',
        'roomId', v_room_id,
        'action', v_action,
        'roomStatus', v_room.room_status,
        'phase', v_room.phase,
        'decisionRevision', v_room.decision_revision,
        'rosterRevision', v_room.roster_revision,
        'snapshotVersion', v_room.snapshot_version,
        'revokedMemberCount', 0,
        'updatedAt', public.gq_iso(v_room.updated_at)
      ));
    END IF;
    IF v_room.room_status <> 'ACTIVE' THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_ACTIVE'));
    END IF;
    v_target_status := 'ARCHIVED';
    v_event_type := 'ROOM_ARCHIVED';
  ELSIF v_action = 'CLOSE' THEN
    IF v_room.room_status = 'CLOSED' THEN
      RETURN jsonb_build_object('ok', true, 'value', jsonb_build_object(
        'status', 'applied',
        'roomId', v_room_id,
        'action', v_action,
        'roomStatus', v_room.room_status,
        'phase', v_room.phase,
        'decisionRevision', v_room.decision_revision,
        'rosterRevision', v_room.roster_revision,
        'snapshotVersion', v_room.snapshot_version,
        'revokedMemberCount', 0,
        'updatedAt', public.gq_iso(v_room.updated_at)
      ));
    END IF;
    IF v_room.room_status NOT IN ('ACTIVE', 'ARCHIVED') THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_ACTIVE'));
    END IF;
    v_target_status := 'CLOSED';
    v_event_type := 'ROOM_CLOSED';
  ELSE
    IF v_room.room_status = 'DELETING' THEN
      RETURN jsonb_build_object('ok', true, 'value', jsonb_build_object(
        'status', 'applied',
        'roomId', v_room_id,
        'action', v_action,
        'roomStatus', v_room.room_status,
        'phase', v_room.phase,
        'decisionRevision', v_room.decision_revision,
        'rosterRevision', v_room.roster_revision,
        'snapshotVersion', v_room.snapshot_version,
        'revokedMemberCount', 0,
        'updatedAt', public.gq_iso(v_room.updated_at)
      ));
    END IF;
    -- DELETING is a soft close; the controlled purge runs separately.
    v_target_status := 'DELETING';
    v_event_type := 'ROOM_DELETE_REQUESTED';
  END IF;

  IF v_expected_revision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;

  v_decision_revision := v_room.decision_revision;
  v_roster_revision := v_room.roster_revision;
  v_phase := v_room.phase;

  IF v_action IN ('CLOSE', 'DELETE') THEN
    UPDATE public.gq_members
    SET status = 'LEFT', roster_revision = v_room.roster_revision + 1
    WHERE room_id = v_room_id AND status = 'JOINED' AND uid <> v_room.host_uid;
    GET DIAGNOSTICS v_revoked_count = ROW_COUNT;

    UPDATE public.gq_invites
    SET status = 'REVOKED'
    WHERE room_id = v_room_id AND status = 'ACTIVE';

    IF v_room.current_evaluation_round_id IS NOT NULL THEN
      UPDATE public.gq_evaluation_rounds
      SET status = 'CANCELLED', closed_at = v_now, reveal_at = NULL, close_reason = NULL
      WHERE id = v_room.current_evaluation_round_id AND status = 'OPEN';
      IF FOUND THEN
        v_cancelled_round := v_room.current_evaluation_round_id;
      END IF;
    END IF;

    IF v_room.current_proposal_id IS NOT NULL THEN
      UPDATE public.gq_proposals
      SET status = 'INVALIDATED', resolved_at = v_now
      WHERE id = v_room.current_proposal_id AND status = 'OPEN';
      IF FOUND THEN
        v_invalidated_proposal := v_room.current_proposal_id;
      END IF;
    END IF;

    UPDATE public.gq_reopen_requests
    SET status = 'CANCELLED', resolved_at = v_now
    WHERE cycle_id = v_room.current_cycle_id AND status = 'OPEN';

    -- The cancelled round/proposal must not leave EVALUATING or CONFIRMING dangling.
    SELECT EXISTS (
      SELECT 1 FROM public.gq_candidates c
      WHERE c.room_id = v_room_id AND c.withdrawn_at IS NULL
    ) INTO v_has_public_candidate;
    v_phase := CASE
      WHEN v_room.phase = 'COMPLETED' THEN 'COMPLETED'
      WHEN v_has_public_candidate THEN 'CANDIDATE_REVIEW'
      ELSE 'COLLECTING'
    END;

    v_decision_revision := v_room.decision_revision + 1;
    v_roster_revision := v_room.roster_revision + 1;
  END IF;

  UPDATE public.gq_rooms
  SET phase = v_phase,
      room_status = v_target_status,
      decision_revision = v_decision_revision,
      roster_revision = v_roster_revision,
      current_evaluation_round_id = CASE WHEN v_action IN ('CLOSE', 'DELETE') THEN NULL ELSE current_evaluation_round_id END,
      current_proposal_id = CASE WHEN v_action IN ('CLOSE', 'DELETE') THEN NULL ELSE current_proposal_id END,
      snapshot_version = snapshot_version + 1,
      updated_at = v_now
  WHERE id = v_room_id;

  INSERT INTO public.gq_events(room_id, type, payload, created_at)
  VALUES (v_room_id, v_event_type,
    jsonb_strip_nulls(jsonb_build_object(
      'action', v_action,
      'roomStatus', v_target_status,
      'phase', v_phase,
      'revokedMemberCount', v_revoked_count,
      'cancelledRoundId', v_cancelled_round,
      'invalidatedProposalId', v_invalidated_proposal
    )), v_now);

  IF v_invalidated_proposal IS NOT NULL THEN
    INSERT INTO public.gq_events(room_id, type, payload, created_at)
    VALUES (v_room_id, 'PROPOSAL_INVALIDATED',
      jsonb_build_object('proposalId', v_invalidated_proposal), v_now);
  END IF;

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_strip_nulls(jsonb_build_object(
      'status', 'applied',
      'roomId', v_room_id,
      'action', v_action,
      'roomStatus', v_target_status,
      'phase', v_phase,
      'decisionRevision', v_decision_revision,
      'rosterRevision', v_roster_revision,
      'snapshotVersion', v_room.snapshot_version + 1,
      'revokedMemberCount', v_revoked_count,
      'cancelledRoundId', v_cancelled_round,
      'invalidatedProposalId', v_invalidated_proposal,
      'updatedAt', public.gq_iso(v_now)
    ))
  );

  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'changeRoomLifecycle', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_change_room_lifecycle$;

REVOKE ALL ON FUNCTION public.gq_change_room_lifecycle(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gq_change_room_lifecycle(text, jsonb) TO service_role;

-- Rollback for this migration:
-- 1. DROP FUNCTION public.gq_change_room_lifecycle(text, jsonb);
-- 2. Restore the original gq_events_type_check constraint without the ROOM_* types.
