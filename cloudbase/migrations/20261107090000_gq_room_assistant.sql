-- T6 room deliberation assistant (D024). The assistant is independent of the room
-- state machine: it records request/result rows, never holds the room lock while the
-- model runs, and never writes candidates, evaluations or final decisions.

CREATE TABLE public.gq_assistant_messages (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES public.gq_rooms(id),
  cycle_id text NOT NULL,
  request_id text NOT NULL,
  actor_uid text NOT NULL,
  action text NOT NULL CHECK (action IN (
    'SYNTHESIZE_DISAGREEMENT',
    'SUGGEST_ALTERNATIVES',
    'FIND_OPEN_QUESTIONS',
    'ASK'
  )),
  question text,
  status text NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'STALE')),
  scope text NOT NULL DEFAULT 'PUBLIC' CHECK (scope = 'PUBLIC'),
  context_snapshot_version integer NOT NULL CHECK (context_snapshot_version >= 0),
  context_decision_revision numeric NOT NULL,
  source_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_ids) = 'array'),
  answer text,
  error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (actor_uid, room_id, request_id),
  CHECK (question IS NULL OR length(btrim(question)) BETWEEN 1 AND 500),
  CHECK (answer IS NULL OR length(btrim(answer)) BETWEEN 1 AND 4000),
  CHECK (action = 'ASK' OR question IS NULL),
  CHECK (status <> 'FAILED' OR answer IS NULL)
);

CREATE INDEX gq_assistant_messages_room_created_idx
  ON public.gq_assistant_messages(room_id, created_at DESC);
CREATE INDEX gq_assistant_messages_actor_created_idx
  ON public.gq_assistant_messages(actor_uid, room_id, created_at DESC);

CREATE FUNCTION public.gq_assistant_message_payload(
  p_message public.gq_assistant_messages,
  p_status text,
  p_error_code text,
  p_stale boolean
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $gq_assistant_message_payload$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 2,
    'id', p_message.id,
    'roomId', p_message.room_id,
    'cycleId', p_message.cycle_id,
    'requestId', p_message.request_id,
    'actorUid', p_message.actor_uid,
    'action', p_message.action,
    'question', p_message.question,
    'status', p_status,
    'scope', p_message.scope,
    'contextVersion', p_message.context_snapshot_version,
    'sourceIds', p_message.source_ids,
    'answer', p_message.answer,
    'errorCode', p_error_code,
    'createdAt', public.gq_iso(p_message.created_at),
    'updatedAt', public.gq_iso(p_message.updated_at),
    'stale', p_stale
  ))
$gq_assistant_message_payload$;

CREATE FUNCTION public.gq_register_assistant_request(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_register_assistant_request$
DECLARE
  v_room public.gq_rooms%ROWTYPE;
  v_existing public.gq_assistant_messages%ROWTYPE;
  v_now timestamptz;
  v_action text;
  v_question text;
  v_expected_version numeric;
  v_recent_count integer;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'roomId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'requestId', ''))) = 0
    OR COALESCE(p_payload->>'action', '') NOT IN (
      'SYNTHESIZE_DISAGREEMENT', 'SUGGEST_ALTERNATIVES', 'FIND_OPEN_QUESTIONS', 'ASK')
    OR jsonb_typeof(p_payload->'expectedSnapshotVersion') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_action := p_payload->>'action';
  v_question := NULLIF(btrim(COALESCE(p_payload->>'question', '')), '');
  IF length(v_question) > 500
    OR (v_action = 'ASK' AND v_question IS NULL)
    OR (v_action <> 'ASK' AND v_question IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_expected_version := (p_payload->>'expectedSnapshotVersion')::numeric;
  IF v_expected_version < 0 OR v_expected_version <> trunc(v_expected_version) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(concat_ws(
    chr(31), 'gq_assistant', p_actor_uid, p_payload->>'roomId', p_payload->>'requestId')));
  SELECT * INTO v_room FROM public.gq_rooms WHERE id = p_payload->>'roomId' FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_FOUND'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.gq_members m
    WHERE m.room_id = v_room.id AND m.uid = p_actor_uid AND m.status = 'JOINED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_MEMBER'));
  END IF;
  IF v_room.room_status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_ACTIVE'));
  END IF;

  v_now := clock_timestamp();
  SELECT * INTO v_existing FROM public.gq_assistant_messages am
  WHERE am.actor_uid = p_actor_uid AND am.room_id = v_room.id
    AND am.request_id = p_payload->>'requestId'
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.action <> v_action OR v_existing.question IS DISTINCT FROM v_question THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    IF v_existing.status <> 'PENDING' THEN
      RETURN jsonb_build_object('ok', true, 'value', public.gq_assistant_message_payload(
        v_existing, v_existing.status, v_existing.error_code, v_existing.status = 'STALE'));
    END IF;
    IF v_existing.created_at > v_now - interval '2 minutes' THEN
      RETURN jsonb_build_object('ok', true, 'value', public.gq_assistant_message_payload(
        v_existing, v_existing.status, v_existing.error_code, false));
    END IF;
  END IF;

  IF v_expected_version <> v_room.snapshot_version THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'AI_STALE_CONTEXT'));
  END IF;

  SELECT count(*) INTO v_recent_count FROM public.gq_assistant_messages am
  WHERE am.actor_uid = p_actor_uid AND am.room_id = v_room.id
    AND am.created_at > v_now - interval '60 seconds';
  IF v_recent_count >= 6 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'AI_RATE_LIMITED'));
  END IF;

  IF v_existing.id IS NULL THEN
    INSERT INTO public.gq_assistant_messages(
      id, room_id, cycle_id, request_id, actor_uid, action, question, status,
      scope, context_snapshot_version, context_decision_revision, source_ids,
      created_at, updated_at
    ) VALUES (
      'assistant_' || md5(concat_ws(chr(31), p_actor_uid, v_room.id,
        p_payload->>'requestId', v_now::text)),
      v_room.id, v_room.current_cycle_id, p_payload->>'requestId', p_actor_uid,
      v_action, v_question, 'PENDING', 'PUBLIC', v_room.snapshot_version,
      v_room.decision_revision, '[]'::jsonb, v_now, v_now
    )
    RETURNING * INTO v_existing;
  ELSE
    UPDATE public.gq_assistant_messages am
    SET cycle_id = v_room.current_cycle_id,
        action = v_action,
        question = v_question,
        status = 'PENDING',
        context_snapshot_version = v_room.snapshot_version,
        context_decision_revision = v_room.decision_revision,
        source_ids = '[]'::jsonb,
        answer = NULL,
        error_code = NULL,
        created_at = v_now,
        updated_at = v_now
    WHERE am.id = v_existing.id
    RETURNING * INTO v_existing;
  END IF;

  RETURN jsonb_build_object('ok', true, 'value', public.gq_assistant_message_payload(
    v_existing, v_existing.status, v_existing.error_code, false));
END;
$gq_register_assistant_request$;

CREATE FUNCTION public.gq_complete_assistant_request(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_complete_assistant_request$
DECLARE
  v_room public.gq_rooms%ROWTYPE;
  v_message public.gq_assistant_messages%ROWTYPE;
  v_now timestamptz;
  v_requested_status text;
  v_answer text;
  v_error_code text;
  v_source_ids jsonb;
  v_final_status text;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'roomId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'requestId', ''))) = 0
    OR COALESCE(p_payload->>'status', '') NOT IN ('SUCCEEDED', 'FAILED', 'STALE')
    OR jsonb_typeof(COALESCE(p_payload->'sourceIds', '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_requested_status := p_payload->>'status';
  v_answer := NULLIF(btrim(COALESCE(p_payload->>'answer', '')), '');
  v_error_code := NULLIF(btrim(COALESCE(p_payload->>'errorCode', '')), '');
  v_source_ids := COALESCE(p_payload->'sourceIds', '[]'::jsonb);

  IF v_requested_status = 'FAILED' THEN
    IF v_answer IS NOT NULL OR v_error_code IS NULL
      OR v_error_code !~ '^[A-Z0-9_]+$' OR length(v_error_code) > 64
      OR jsonb_array_length(v_source_ids) <> 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
    END IF;
  ELSIF v_answer IS NULL OR length(v_answer) > 4000
    OR v_error_code IS NOT NULL
    OR jsonb_array_length(v_source_ids) > 20 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT * INTO v_message FROM public.gq_assistant_messages am
  WHERE am.actor_uid = p_actor_uid AND am.room_id = p_payload->>'roomId'
    AND am.request_id = p_payload->>'requestId'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ASSISTANT_REQUEST_NOT_FOUND'));
  END IF;
  IF v_message.actor_uid <> p_actor_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_MEMBER'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_message.room_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_FOUND'));
  END IF;
  v_now := clock_timestamp();

  IF NOT EXISTS (
    SELECT 1 FROM public.gq_members m
    WHERE m.room_id = v_room.id AND m.uid = p_actor_uid AND m.status = 'JOINED'
  ) THEN
    UPDATE public.gq_assistant_messages am
    SET status = 'FAILED', error_code = 'MEMBER_REVOKED', answer = NULL,
        source_ids = '[]'::jsonb, updated_at = v_now
    WHERE am.id = v_message.id;
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_MEMBER'));
  END IF;

  IF v_requested_status = 'FAILED' THEN
    v_final_status := 'FAILED';
  ELSIF v_room.snapshot_version <> v_message.context_snapshot_version
    OR v_room.current_cycle_id <> v_message.cycle_id THEN
    v_final_status := 'STALE';
  ELSE
    v_final_status := v_requested_status;
  END IF;

  UPDATE public.gq_assistant_messages am
  SET status = v_final_status,
      answer = v_answer,
      error_code = v_error_code,
      source_ids = v_source_ids,
      updated_at = v_now
  WHERE am.id = v_message.id
  RETURNING * INTO v_message;

  RETURN jsonb_build_object('ok', true, 'value', public.gq_assistant_message_payload(
    v_message, v_message.status, v_message.error_code, v_message.status = 'STALE'));
END;
$gq_complete_assistant_request$;

CREATE FUNCTION public.gq_get_assistant_messages(p_actor_uid text, p_room_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_get_assistant_messages$
DECLARE
  v_room public.gq_rooms%ROWTYPE;
  v_message public.gq_assistant_messages%ROWTYPE;
  v_messages jsonb := '[]'::jsonb;
  v_status text;
  v_error_code text;
  v_stale boolean;
  v_now timestamptz;
BEGIN
  IF length(btrim(p_actor_uid)) = 0 OR length(btrim(COALESCE(p_room_id, ''))) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_FOUND'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.gq_members m
    WHERE m.room_id = p_room_id AND m.uid = p_actor_uid AND m.status = 'JOINED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_MEMBER'));
  END IF;

  v_now := clock_timestamp();
  FOR v_message IN
    SELECT am.* FROM public.gq_assistant_messages am
    WHERE am.room_id = p_room_id
    ORDER BY am.created_at DESC, am.id DESC
    LIMIT 50
  LOOP
    v_status := v_message.status;
    v_error_code := v_message.error_code;
    IF v_status = 'PENDING' AND v_message.created_at < v_now - interval '2 minutes' THEN
      v_status := 'FAILED';
      v_error_code := 'AI_TIMEOUT';
    END IF;
    v_stale := v_status = 'STALE' OR (
      v_status = 'SUCCEEDED' AND (
        v_message.context_snapshot_version <> v_room.snapshot_version
        OR v_message.cycle_id <> v_room.current_cycle_id
      )
    );
    v_messages := v_messages || jsonb_build_array(
      public.gq_assistant_message_payload(v_message, v_status, v_error_code, v_stale));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'value', jsonb_build_object(
    'status', 'ok',
    'roomId', p_room_id,
    'messages', v_messages
  ));
END;
$gq_get_assistant_messages$;

DO $gq_assistant_acl$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['gq_assistant_messages'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', v_table);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', v_table);
  END LOOP;
END;
$gq_assistant_acl$;

REVOKE ALL ON FUNCTION public.gq_assistant_message_payload(public.gq_assistant_messages, text, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_register_assistant_request(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_complete_assistant_request(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_get_assistant_messages(text, text) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.gq_register_assistant_request(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_complete_assistant_request(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_get_assistant_messages(text, text) TO service_role;

-- Rollback for this migration:
-- 1. DROP FUNCTION public.gq_get_assistant_messages(text, text);
-- 2. DROP FUNCTION public.gq_complete_assistant_request(text, jsonb);
-- 3. DROP FUNCTION public.gq_register_assistant_request(text, jsonb);
-- 4. DROP FUNCTION public.gq_assistant_message_payload(public.gq_assistant_messages, text, text, boolean);
-- 5. DROP TABLE public.gq_assistant_messages;
