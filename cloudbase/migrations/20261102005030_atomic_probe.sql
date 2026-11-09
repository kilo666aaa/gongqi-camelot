CREATE TABLE public.m0_probe_private (
  room_id text PRIMARY KEY,
  secret_note text NOT NULL,
  public_note text NOT NULL,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.m0_probe_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id text NOT NULL REFERENCES public.m0_probe_private(room_id),
  operation_id text NOT NULL,
  actor_uid text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'rollback_test')),
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, operation_id)
);

ALTER TABLE public.m0_probe_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.m0_probe_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.m0_probe_private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.m0_probe_audit FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.m0_probe_private TO service_role;
GRANT ALL ON public.m0_probe_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.m0_probe_audit_audit_id_seq TO service_role;

CREATE VIEW public.m0_probe_public
WITH (security_barrier = true) AS
SELECT room_id, public_note, version
FROM public.m0_probe_private;

REVOKE ALL ON public.m0_probe_public FROM PUBLIC;
GRANT SELECT ON public.m0_probe_public TO anon, authenticated, service_role;

CREATE FUNCTION public.m0_probe_write(
  p_room_id text,
  p_operation_id text,
  p_actor_uid text,
  p_public_note text,
  p_expected_version integer,
  p_force_rollback boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $m0_probe$
DECLARE
  v_version integer;
  v_next_version integer;
  v_existing_hash text;
  v_existing_response jsonb;
  v_request_hash text;
  v_response jsonb;
BEGIN
  IF length(trim(p_room_id)) = 0 OR length(trim(p_operation_id)) = 0 OR length(trim(p_actor_uid)) = 0 THEN
    RAISE EXCEPTION 'INVALID_PROBE_ARGUMENT';
  END IF;

  SELECT version
  INTO v_version
  FROM public.m0_probe_private
  WHERE room_id = p_room_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROOM_NOT_FOUND';
  END IF;

  v_request_hash := md5(concat_ws(
    chr(31),
    p_room_id,
    p_operation_id,
    p_actor_uid,
    p_public_note,
    p_expected_version::text,
    p_force_rollback::text
  ));

  SELECT request_hash, response
  INTO v_existing_hash, v_existing_response
  FROM public.m0_probe_audit
  WHERE room_id = p_room_id AND operation_id = p_operation_id;

  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
    END IF;
    RETURN v_existing_response;
  END IF;

  IF v_version <> p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT: expected %, actual %', p_expected_version, v_version;
  END IF;

  UPDATE public.m0_probe_private
  SET public_note = p_public_note,
      version = version + 1,
      updated_at = now()
  WHERE room_id = p_room_id
  RETURNING version INTO v_next_version;

  v_response := jsonb_build_object(
    'status', 'applied',
    'room_id', p_room_id,
    'operation_id', p_operation_id,
    'version', v_next_version
  );

  INSERT INTO public.m0_probe_audit (
    room_id,
    operation_id,
    actor_uid,
    outcome,
    request_hash,
    response
  ) VALUES (
    p_room_id,
    p_operation_id,
    p_actor_uid,
    CASE WHEN p_force_rollback THEN 'rollback_test' ELSE 'applied' END,
    v_request_hash,
    v_response
  );

  IF p_force_rollback THEN
    RAISE EXCEPTION 'ROLLBACK_TEST';
  END IF;

  RETURN v_response;
END;
$m0_probe$;

REVOKE ALL ON FUNCTION public.m0_probe_write(text, text, text, text, integer, boolean)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.m0_probe_write(text, text, text, text, integer, boolean)
TO service_role;

-- Rollback order:
-- DROP FUNCTION public.m0_probe_write(text, text, text, text, integer, boolean);
-- DROP VIEW public.m0_probe_public;
-- DROP TABLE public.m0_probe_audit;
-- DROP TABLE public.m0_probe_private;
