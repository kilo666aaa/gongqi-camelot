BEGIN;

CREATE TABLE public.gq_rooms (
  id text PRIMARY KEY,
  schema_version smallint NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 80),
  purpose text NOT NULL CHECK (length(btrim(purpose)) BETWEEN 1 AND 500),
  template_id text NOT NULL CHECK (template_id IN ('general', 'activity')),
  phase text NOT NULL CHECK (phase IN ('COLLECTING', 'CANDIDATE_REVIEW', 'EVALUATING', 'DISCUSSING', 'CONFIRMING', 'COMPLETED')),
  room_status text NOT NULL CHECK (room_status IN ('ACTIVE', 'ARCHIVED', 'CLOSED', 'DELETING')),
  host_uid text NOT NULL,
  snapshot_version integer NOT NULL DEFAULT 0 CHECK (snapshot_version >= 0),
  decision_revision integer NOT NULL DEFAULT 1 CHECK (decision_revision > 0),
  roster_revision integer NOT NULL DEFAULT 1 CHECK (roster_revision > 0),
  current_cycle_id text NOT NULL,
  current_evaluation_round_id text,
  current_proposal_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.gq_members (
  room_id text NOT NULL REFERENCES public.gq_rooms(id),
  uid text NOT NULL,
  role text NOT NULL CHECK (role IN ('HOST', 'MEMBER')),
  status text NOT NULL CHECK (status IN ('JOINED', 'LEFT', 'REMOVED')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  roster_revision integer NOT NULL CHECK (roster_revision > 0),
  PRIMARY KEY (room_id, uid)
);

CREATE TABLE public.gq_cycles (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES public.gq_rooms(id),
  cycle_number integer NOT NULL CHECK (cycle_number > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, cycle_number)
);

ALTER TABLE public.gq_rooms
  ADD CONSTRAINT gq_rooms_current_cycle_fk
  FOREIGN KEY (current_cycle_id) REFERENCES public.gq_cycles(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.gq_ideas (
  id text PRIMARY KEY,
  cycle_id text NOT NULL REFERENCES public.gq_cycles(id),
  author_uid text NOT NULL,
  text text NOT NULL CHECK (length(text) <= 4000),
  visibility text NOT NULL CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  skipped boolean NOT NULL,
  CHECK ((skipped AND text = '') OR (NOT skipped AND length(btrim(text)) > 0))
);

CREATE TABLE public.gq_candidates (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES public.gq_rooms(id),
  current_revision_id text NOT NULL,
  withdrawn_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.gq_candidate_revisions (
  id text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES public.gq_candidates(id),
  revision integer NOT NULL CHECK (revision > 0),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  template_id text NOT NULL CHECK (template_id IN ('general', 'activity')),
  template_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_idea_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, revision),
  UNIQUE (id, candidate_id),
  CHECK (cardinality(source_idea_ids) <= 50),
  CHECK (
    (template_id = 'general' AND template_payload = '{}'::jsonb)
    OR (template_id = 'activity' AND jsonb_typeof(template_payload) = 'object')
  )
);

ALTER TABLE public.gq_candidates
  ADD CONSTRAINT gq_candidates_current_revision_fk
  FOREIGN KEY (current_revision_id, id)
  REFERENCES public.gq_candidate_revisions(id, candidate_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.gq_evaluation_rounds (
  id text PRIMARY KEY,
  cycle_id text NOT NULL REFERENCES public.gq_cycles(id),
  roster_uids text[] NOT NULL,
  roster_revision integer NOT NULL CHECK (roster_revision > 0),
  target_revision_ids text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz,
  closed_at timestamptz,
  reveal_at timestamptz,
  close_reason text CHECK (close_reason IN ('HOST_END', 'TIMEOUT', 'MAJORITY_END')),
  CHECK (cardinality(roster_uids) BETWEEN 2 AND 6),
  CHECK (cardinality(target_revision_ids) BETWEEN 1 AND 10),
  CHECK (
    (status = 'OPEN' AND closed_at IS NULL AND reveal_at IS NULL AND close_reason IS NULL)
    OR (status = 'CLOSED' AND closed_at IS NOT NULL AND reveal_at IS NOT NULL AND close_reason IS NOT NULL)
    OR (status = 'CANCELLED' AND closed_at IS NOT NULL AND reveal_at IS NULL AND close_reason IS NULL)
  )
);

CREATE TABLE public.gq_evaluations (
  round_id text NOT NULL REFERENCES public.gq_evaluation_rounds(id),
  uid text NOT NULL,
  candidate_revision_id text NOT NULL REFERENCES public.gq_candidate_revisions(id),
  attitude text CHECK (attitude IN ('SUPPORT', 'OPPOSE', 'NEUTRAL')),
  score integer CHECK (score BETWEEN 1 AND 5),
  reason text CHECK (length(reason) <= 500),
  submission_state text NOT NULL CHECK (submission_state IN ('EVALUATED', 'SKIPPED')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, uid, candidate_revision_id),
  CHECK (
    (submission_state = 'SKIPPED' AND attitude IS NULL AND score IS NULL AND reason IS NULL)
    OR (submission_state = 'EVALUATED' AND (attitude IS NOT NULL OR score IS NOT NULL))
  )
);

CREATE TABLE public.gq_close_votes (
  round_id text NOT NULL REFERENCES public.gq_evaluation_rounds(id),
  uid text NOT NULL,
  choice text NOT NULL CHECK (choice IN ('END', 'KEEP_OPEN')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, uid)
);

CREATE TABLE public.gq_reopen_requests (
  id text PRIMARY KEY,
  cycle_id text NOT NULL REFERENCES public.gq_cycles(id),
  roster_uids text[] NOT NULL,
  roster_revision integer NOT NULL CHECK (roster_revision > 0),
  target_revision_ids text[] NOT NULL,
  requested_by text NOT NULL,
  round_id text NOT NULL UNIQUE CHECK (length(btrim(round_id)) BETWEEN 1 AND 128),
  status text NOT NULL CHECK (status IN ('OPEN', 'APPROVED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (cardinality(roster_uids) BETWEEN 2 AND 6),
  CHECK (cardinality(target_revision_ids) BETWEEN 1 AND 10),
  CHECK ((status = 'OPEN' AND resolved_at IS NULL) OR (status <> 'OPEN' AND resolved_at IS NOT NULL))
);

CREATE TABLE public.gq_reopen_votes (
  request_id text NOT NULL REFERENCES public.gq_reopen_requests(id),
  uid text NOT NULL,
  choice text NOT NULL CHECK (choice IN ('REOPEN', 'KEEP_DISCUSSING')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, uid)
);

CREATE TABLE public.gq_comments (
  id text PRIMARY KEY,
  cycle_id text NOT NULL REFERENCES public.gq_cycles(id),
  candidate_id text REFERENCES public.gq_candidates(id),
  candidate_revision_id text REFERENCES public.gq_candidate_revisions(id),
  author_uid text NOT NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  visibility text NOT NULL CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
  publication_state text NOT NULL CHECK (publication_state IN ('DRAFT', 'PUBLISHED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CHECK ((publication_state = 'DRAFT' AND published_at IS NULL)
    OR (publication_state = 'PUBLISHED' AND published_at IS NOT NULL))
);

CREATE TABLE public.gq_proposals (
  id text PRIMARY KEY,
  cycle_id text NOT NULL REFERENCES public.gq_cycles(id),
  roster_uids text[] NOT NULL,
  roster_revision integer NOT NULL CHECK (roster_revision > 0),
  candidate_revision_id text NOT NULL REFERENCES public.gq_candidate_revisions(id),
  candidate_revision_snapshot jsonb NOT NULL CHECK (jsonb_typeof(candidate_revision_snapshot) = 'object'),
  decision_revision integer NOT NULL CHECK (decision_revision > 0),
  deadline_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'AGREED', 'UNRESOLVED', 'INVALIDATED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (id, candidate_revision_id),
  CHECK (cardinality(roster_uids) BETWEEN 2 AND 6),
  CHECK (deadline_at > created_at),
  CHECK ((status = 'OPEN' AND resolved_at IS NULL) OR (status <> 'OPEN' AND resolved_at IS NOT NULL))
);

ALTER TABLE public.gq_rooms
  ADD CONSTRAINT gq_rooms_current_evaluation_round_fk
  FOREIGN KEY (current_evaluation_round_id) REFERENCES public.gq_evaluation_rounds(id);

ALTER TABLE public.gq_rooms
  ADD CONSTRAINT gq_rooms_current_proposal_fk
  FOREIGN KEY (current_proposal_id) REFERENCES public.gq_proposals(id);

CREATE TABLE public.gq_final_responses (
  proposal_id text NOT NULL,
  candidate_revision_id text NOT NULL,
  uid text NOT NULL,
  choice text NOT NULL CHECK (choice IN ('ACCEPT', 'DECLINE', 'ABSTAIN')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, uid),
  FOREIGN KEY (proposal_id, candidate_revision_id)
    REFERENCES public.gq_proposals(id, candidate_revision_id)
);

CREATE TABLE public.gq_decision_records (
  id text PRIMARY KEY,
  cycle_id text NOT NULL REFERENCES public.gq_cycles(id),
  proposal_id text UNIQUE REFERENCES public.gq_proposals(id),
  outcome text NOT NULL CHECK (outcome IN ('AGREED', 'UNRESOLVED')),
  candidate_revision_snapshot jsonb,
  roster_snapshot text[] NOT NULL,
  accepted integer NOT NULL DEFAULT 0 CHECK (accepted >= 0),
  declined integer NOT NULL DEFAULT 0 CHECK (declined >= 0),
  abstained integer NOT NULL DEFAULT 0 CHECK (abstained >= 0),
  pending integer NOT NULL DEFAULT 0 CHECK (pending >= 0),
  unresolved_summary text CHECK (length(unresolved_summary) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(roster_snapshot) BETWEEN 2 AND 6),
  CHECK (accepted + declined + abstained + pending = cardinality(roster_snapshot)),
  CHECK (outcome <> 'AGREED' OR (
    proposal_id IS NOT NULL
    AND candidate_revision_snapshot IS NOT NULL
    AND accepted = cardinality(roster_snapshot)
    AND declined = 0 AND abstained = 0 AND pending = 0
  )),
  CHECK (candidate_revision_snapshot IS NULL OR jsonb_typeof(candidate_revision_snapshot) = 'object')
);

CREATE TABLE public.gq_operations (
  actor_uid text NOT NULL,
  room_id text NOT NULL REFERENCES public.gq_rooms(id),
  action text NOT NULL,
  operation_id text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_uid, room_id, action, operation_id)
);

CREATE TABLE public.gq_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id text NOT NULL REFERENCES public.gq_rooms(id),
  type text NOT NULL CHECK (type IN (
    'ROUND_CLOSED',
    'ROUND_DEADLINE_CHANGED',
    'CANDIDATE_REVISION_CREATED',
    'CANDIDATE_WITHDRAWN',
    'PROPOSAL_INVALIDATED',
    'MEMBER_CHANGED',
    'INVITE_ROTATED',
    'REOPEN_REQUESTED',
    'REOPEN_OPENED',
    'REOPEN_CANCELLED'
  )),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.gq_invites (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES public.gq_rooms(id),
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'CONSUMED', 'REVOKED', 'EXPIRED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_by text,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK ((status = 'CONSUMED' AND consumed_by IS NOT NULL AND consumed_at IS NOT NULL)
    OR (status <> 'CONSUMED' AND consumed_by IS NULL AND consumed_at IS NULL))
);

CREATE INDEX gq_members_uid_status_idx ON public.gq_members(uid, status);
CREATE INDEX gq_ideas_cycle_author_idx ON public.gq_ideas(cycle_id, author_uid);
CREATE UNIQUE INDEX gq_ideas_cycle_author_skip_uidx
  ON public.gq_ideas(cycle_id, author_uid) WHERE skipped;
CREATE INDEX gq_candidates_room_idx ON public.gq_candidates(room_id);
CREATE INDEX gq_candidate_revisions_candidate_idx ON public.gq_candidate_revisions(candidate_id, revision);
CREATE INDEX gq_evaluation_rounds_cycle_status_idx ON public.gq_evaluation_rounds(cycle_id, status);
CREATE INDEX gq_evaluations_revision_idx ON public.gq_evaluations(candidate_revision_id, round_id);
CREATE INDEX gq_comments_cycle_created_idx ON public.gq_comments(cycle_id, created_at);
CREATE INDEX gq_final_responses_revision_idx ON public.gq_final_responses(candidate_revision_id, proposal_id);
CREATE INDEX gq_operations_room_created_idx ON public.gq_operations(room_id, created_at);
CREATE UNIQUE INDEX gq_create_room_operation_uidx
  ON public.gq_operations(actor_uid, operation_id) WHERE action = 'createRoom';
CREATE UNIQUE INDEX gq_join_room_operation_uidx
  ON public.gq_operations(actor_uid, operation_id) WHERE action = 'joinRoom';
CREATE INDEX gq_events_room_id_idx ON public.gq_events(room_id, id);
CREATE INDEX gq_invites_room_status_idx ON public.gq_invites(room_id, status);
CREATE UNIQUE INDEX gq_one_open_reopen_per_cycle_idx
  ON public.gq_reopen_requests(cycle_id) WHERE status = 'OPEN';
CREATE UNIQUE INDEX gq_one_open_proposal_per_cycle_idx
  ON public.gq_proposals(cycle_id) WHERE status = 'OPEN';

CREATE FUNCTION public.gq_iso(p_value timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
STRICT
AS $gq_iso$
  SELECT to_char(p_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$gq_iso$;

CREATE FUNCTION public.gq_prevent_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $gq_immutable$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_%', TG_TABLE_NAME;
END;
$gq_immutable$;

CREATE TRIGGER gq_candidate_revisions_immutable
BEFORE UPDATE OR DELETE ON public.gq_candidate_revisions
FOR EACH ROW EXECUTE FUNCTION public.gq_prevent_immutable_mutation();

CREATE TRIGGER gq_decision_records_immutable
BEFORE UPDATE OR DELETE ON public.gq_decision_records
FOR EACH ROW EXECUTE FUNCTION public.gq_prevent_immutable_mutation();

CREATE FUNCTION public.gq_close_round(
  p_room_id text,
  p_round_id text,
  p_now timestamptz,
  p_close_reason text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_close_round$
DECLARE
  v_snapshot_version integer;
BEGIN
  -- The caller must hold the room row lock and verify this is its current OPEN round.
  UPDATE public.gq_evaluation_rounds
  SET status = 'CLOSED', closed_at = p_now, reveal_at = p_now, close_reason = p_close_reason
  WHERE id = p_round_id;

  UPDATE public.gq_rooms
  SET phase = 'DISCUSSING', current_evaluation_round_id = NULL,
      snapshot_version = snapshot_version + 1, updated_at = p_now
  WHERE id = p_room_id
  RETURNING snapshot_version INTO v_snapshot_version;

  INSERT INTO public.gq_events(room_id, type, payload, created_at)
  VALUES (p_room_id, 'ROUND_CLOSED',
    jsonb_build_object('roundId', p_round_id, 'closeReason', p_close_reason), p_now);

  RETURN v_snapshot_version;
END;
$gq_close_round$;

CREATE FUNCTION public.gq_settle_room(p_room_id text, p_now timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_settle$
DECLARE
  v_now timestamptz := p_now;
  v_room public.gq_rooms%ROWTYPE;
  v_round public.gq_evaluation_rounds%ROWTYPE;
  v_proposal public.gq_proposals%ROWTYPE;
  v_current_revision_id text;
  v_current_roster text[];
  v_frozen_roster text[];
  v_accepted integer;
  v_declined integer;
  v_abstained integer;
  v_pending integer;
  v_outcome text;
BEGIN
  -- Callers must hold the gq_rooms row lock before invoking this function.
  -- p_now must be sampled with clock_timestamp() only after that lock is held, so a
  -- command that waited across a deadline is settled with the real decision time
  -- instead of the transaction start time returned by now().
  SELECT * INTO v_room FROM public.gq_rooms WHERE id = p_room_id;

  IF v_room.current_evaluation_round_id IS NOT NULL THEN
    SELECT * INTO v_round
    FROM public.gq_evaluation_rounds
    WHERE id = v_room.current_evaluation_round_id;

    IF FOUND AND v_round.status = 'OPEN'
      AND v_round.deadline_at IS NOT NULL AND v_round.deadline_at <= v_now THEN
      PERFORM public.gq_close_round(p_room_id, v_round.id, v_now, 'TIMEOUT');
    END IF;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = p_room_id;
  IF v_room.current_proposal_id IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_proposal
  FROM public.gq_proposals
  WHERE id = v_room.current_proposal_id;

  IF NOT FOUND OR v_proposal.status <> 'OPEN' THEN
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(m.uid ORDER BY m.uid), ARRAY[]::text[])
  INTO v_current_roster
  FROM public.gq_members m
  WHERE m.room_id = p_room_id AND m.status = 'JOINED';

  SELECT array_agg(u.uid ORDER BY u.uid)
  INTO v_frozen_roster
  FROM unnest(v_proposal.roster_uids) AS u(uid);

  SELECT c.current_revision_id INTO v_current_revision_id
  FROM public.gq_candidates c
  JOIN public.gq_candidate_revisions cr ON cr.candidate_id = c.id
  WHERE c.room_id = p_room_id
    AND cr.id = v_proposal.candidate_revision_id
    AND c.withdrawn_at IS NULL;

  IF v_room.decision_revision <> v_proposal.decision_revision
    OR v_room.roster_revision <> v_proposal.roster_revision
    OR v_current_roster IS DISTINCT FROM v_frozen_roster
    OR v_current_revision_id IS DISTINCT FROM v_proposal.candidate_revision_id THEN
    UPDATE public.gq_proposals
    SET status = 'INVALIDATED', resolved_at = v_now
    WHERE id = v_proposal.id;

    UPDATE public.gq_rooms
    SET phase = 'DISCUSSING', current_proposal_id = NULL,
        snapshot_version = snapshot_version + 1, updated_at = v_now
    WHERE id = p_room_id;

    INSERT INTO public.gq_events(room_id, type, payload, created_at)
    VALUES (p_room_id, 'PROPOSAL_INVALIDATED',
      jsonb_build_object('proposalId', v_proposal.id), v_now);
    RETURN;
  END IF;

  SELECT
    count(*) FILTER (WHERE fr.choice = 'ACCEPT'),
    count(*) FILTER (WHERE fr.choice = 'DECLINE'),
    count(*) FILTER (WHERE fr.choice = 'ABSTAIN')
  INTO v_accepted, v_declined, v_abstained
  FROM public.gq_final_responses fr
  WHERE fr.proposal_id = v_proposal.id
    AND fr.uid = ANY(v_proposal.roster_uids);

  v_pending := cardinality(v_proposal.roster_uids) - v_accepted - v_declined - v_abstained;
  IF v_accepted = cardinality(v_proposal.roster_uids) THEN
    v_outcome := 'AGREED';
  ELSIF v_proposal.deadline_at <= v_now THEN
    v_outcome := 'UNRESOLVED';
  ELSE
    RETURN;
  END IF;

  UPDATE public.gq_proposals
  SET status = v_outcome, resolved_at = v_now
  WHERE id = v_proposal.id;

  INSERT INTO public.gq_decision_records(
    id, cycle_id, proposal_id, outcome, candidate_revision_snapshot,
    roster_snapshot, accepted, declined, abstained, pending,
    unresolved_summary, created_at
  ) VALUES (
    v_proposal.id, v_proposal.cycle_id, v_proposal.id, v_outcome,
    v_proposal.candidate_revision_snapshot, v_proposal.roster_uids,
    v_accepted, v_declined, v_abstained, v_pending,
    CASE WHEN v_outcome = 'UNRESOLVED' THEN '未全员明确接受' ELSE NULL END,
    v_now
  ) ON CONFLICT (proposal_id) DO NOTHING;

  UPDATE public.gq_rooms
  SET phase = 'COMPLETED', current_proposal_id = NULL,
      snapshot_version = snapshot_version + 1, updated_at = v_now
  WHERE id = p_room_id;
END;
$gq_settle$;

CREATE FUNCTION public.gq_create_room(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_create_room$
DECLARE
  v_room_id text;
  v_cycle_id text;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR p_payload->>'templateId' NOT IN ('general', 'activity')
    OR length(btrim(COALESCE(p_payload->>'title', ''))) NOT BETWEEN 1 AND 80
    OR length(btrim(COALESCE(p_payload->>'purpose', ''))) NOT BETWEEN 1 AND 500 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  -- Room creation has no room row to lock yet; serialize the actor's operation key instead.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(concat_ws(
    chr(31), 'gq_create_room', p_actor_uid, p_payload->>'operationId')));
  v_now := clock_timestamp();
  v_request_hash := md5(concat_ws(chr(31), p_actor_uid, p_payload::text));
  SELECT request_hash, response INTO v_existing_hash, v_existing_response
  FROM public.gq_operations
  WHERE actor_uid = p_actor_uid AND action = 'createRoom'
    AND operation_id = p_payload->>'operationId';

  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  v_room_id := 'room-' || pg_catalog.gen_random_uuid()::text;
  v_cycle_id := 'cycle-' || pg_catalog.gen_random_uuid()::text;
  INSERT INTO public.gq_rooms(
    id, title, purpose, template_id, phase, room_status, host_uid,
    snapshot_version, decision_revision, roster_revision, current_cycle_id,
    created_at, updated_at
  ) VALUES (
    v_room_id, btrim(p_payload->>'title'), btrim(p_payload->>'purpose'),
    p_payload->>'templateId', 'COLLECTING', 'ACTIVE', p_actor_uid,
    1, 1, 1, v_cycle_id, v_now, v_now
  );
  INSERT INTO public.gq_cycles(id, room_id, cycle_number, created_at)
  VALUES (v_cycle_id, v_room_id, 1, v_now);
  INSERT INTO public.gq_members(room_id, uid, role, status, joined_at, roster_revision)
  VALUES (v_room_id, p_actor_uid, 'HOST', 'JOINED', v_now, 1);

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied',
      'roomId', v_room_id,
      'cycleId', v_cycle_id,
      'hostUid', p_actor_uid,
      'phase', 'COLLECTING',
      'roomStatus', 'ACTIVE',
      'snapshotVersion', 1,
      'decisionRevision', 1,
      'rosterRevision', 1,
      'createdAt', public.gq_iso(v_now)
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'createRoom', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_create_room$;

CREATE FUNCTION public.gq_rotate_invite(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_rotate_invite$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_invite_id text;
  v_now timestamptz;
  v_expires_at timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_revision numeric;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'roomId', ''))) = 0
    OR COALESCE(p_payload->>'inviteTokenHash', '') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_expected_revision := (p_payload->>'expectedDecisionRevision')::numeric;
  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;
  v_room_id := p_payload->>'roomId';
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
    AND action = 'rotateInvite' AND operation_id = p_payload->>'operationId';
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
  IF v_room.room_status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_ACTIVE'));
  END IF;
  IF v_expected_revision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;

  UPDATE public.gq_invites SET status = 'REVOKED'
  WHERE room_id = v_room_id AND status = 'ACTIVE';
  v_invite_id := 'invite-' || pg_catalog.gen_random_uuid()::text;
  v_expires_at := v_now + interval '7 days';
  INSERT INTO public.gq_invites(
    id, room_id, token_hash, status, created_by, created_at, expires_at
  ) VALUES (
    v_invite_id, v_room_id, p_payload->>'inviteTokenHash', 'ACTIVE',
    p_actor_uid, v_now, v_expires_at
  );

  INSERT INTO public.gq_events(room_id, type, payload, created_at)
  VALUES (v_room_id, 'INVITE_ROTATED',
    jsonb_build_object('inviteId', v_invite_id, 'expiresAt', public.gq_iso(v_expires_at)), v_now);
  UPDATE public.gq_rooms
  SET snapshot_version = snapshot_version + 1, updated_at = v_now
  WHERE id = v_room_id;

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied',
      'roomId', v_room_id,
      'inviteId', v_invite_id,
      'expiresAt', public.gq_iso(v_expires_at),
      'rotatedAt', public.gq_iso(v_now)
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'rotateInvite', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_rotate_invite$;

CREATE FUNCTION public.gq_join_room(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_join_room$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_invite public.gq_invites%ROWTYPE;
  v_existing_member public.gq_members%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_rejoin boolean;
  v_member_count integer;
  v_phase text;
  v_decision_revision integer;
  v_has_public_candidate boolean;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR COALESCE(p_payload->>'inviteTokenHash', '') !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  -- Join is keyed by a bearer invite rather than roomId, so its operation is actor-global.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(concat_ws(
    chr(31), 'gq_join_room', p_actor_uid, p_payload->>'operationId')));
  v_request_hash := md5(concat_ws(chr(31), p_actor_uid, p_payload::text));
  SELECT request_hash, response INTO v_existing_hash, v_existing_response
  FROM public.gq_operations
  WHERE actor_uid = p_actor_uid AND action = 'joinRoom'
    AND operation_id = p_payload->>'operationId';
  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_invite FROM public.gq_invites
  WHERE token_hash = p_payload->>'inviteTokenHash';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVITE_NOT_FOUND'));
  END IF;
  v_room_id := v_invite.room_id;
  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_FOUND'));
  END IF;
  v_now := clock_timestamp();
  PERFORM public.gq_settle_room(v_room_id, v_now);
  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id;
  SELECT * INTO v_invite FROM public.gq_invites WHERE id = v_invite.id FOR UPDATE;

  IF v_invite.status = 'REVOKED' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVITE_REVOKED'));
  END IF;
  IF v_invite.status = 'CONSUMED' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVITE_CONSUMED'));
  END IF;
  IF v_invite.status = 'EXPIRED'
    OR (v_invite.status = 'ACTIVE' AND v_invite.expires_at <= v_now) THEN
    UPDATE public.gq_invites SET status = 'EXPIRED'
    WHERE id = v_invite.id AND status = 'ACTIVE';
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVITE_EXPIRED'));
  END IF;
  IF v_room.room_status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_ACTIVE'));
  END IF;

  SELECT * INTO v_existing_member FROM public.gq_members
  WHERE room_id = v_room_id AND uid = p_actor_uid FOR UPDATE;
  v_rejoin := FOUND;
  IF v_rejoin AND v_existing_member.status = 'JOINED' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ALREADY_MEMBER'));
  END IF;
  SELECT count(*) INTO v_member_count FROM public.gq_members m
  WHERE m.room_id = v_room_id AND m.status = 'JOINED';
  IF v_member_count >= 6 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_FULL'));
  END IF;

  IF v_room.current_evaluation_round_id IS NOT NULL THEN
    UPDATE public.gq_evaluation_rounds
    SET status = 'CANCELLED', closed_at = v_now, reveal_at = NULL, close_reason = NULL
    WHERE id = v_room.current_evaluation_round_id AND status = 'OPEN';
  END IF;
  IF v_room.current_proposal_id IS NOT NULL THEN
    UPDATE public.gq_proposals
    SET status = 'INVALIDATED', resolved_at = v_now
    WHERE id = v_room.current_proposal_id AND status = 'OPEN';
  END IF;
  UPDATE public.gq_reopen_requests
  SET status = 'CANCELLED', resolved_at = v_now
  WHERE cycle_id = v_room.current_cycle_id AND status = 'OPEN';

  IF v_rejoin THEN
    UPDATE public.gq_members
    SET status = 'JOINED', joined_at = v_now, roster_revision = v_room.roster_revision + 1
    WHERE room_id = v_room_id AND uid = p_actor_uid;
  ELSE
    INSERT INTO public.gq_members(room_id, uid, role, status, joined_at, roster_revision)
    VALUES (v_room_id, p_actor_uid, 'MEMBER', 'JOINED', v_now, v_room.roster_revision + 1);
  END IF;
  UPDATE public.gq_invites
  SET status = 'CONSUMED', consumed_by = p_actor_uid, consumed_at = v_now
  WHERE id = v_invite.id;

  SELECT EXISTS (
    SELECT 1 FROM public.gq_candidates c
    WHERE c.room_id = v_room_id AND c.withdrawn_at IS NULL
  ) INTO v_has_public_candidate;
  v_phase := CASE
    WHEN v_room.phase = 'COMPLETED' THEN 'COMPLETED'
    WHEN v_has_public_candidate THEN 'CANDIDATE_REVIEW'
    ELSE 'COLLECTING'
  END;
  UPDATE public.gq_rooms
  SET phase = v_phase,
      roster_revision = roster_revision + 1,
      decision_revision = decision_revision + 1,
      current_evaluation_round_id = NULL,
      current_proposal_id = NULL,
      snapshot_version = snapshot_version + 1,
      updated_at = v_now
  WHERE id = v_room_id
  RETURNING decision_revision INTO v_decision_revision;

  INSERT INTO public.gq_events(room_id, type, payload, created_at)
  VALUES (v_room_id, 'MEMBER_CHANGED',
    jsonb_build_object('uid', p_actor_uid, 'action', 'JOIN', 'status', 'JOINED',
      'rosterRevision', v_room.roster_revision + 1), v_now);

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied',
      'roomId', v_room_id,
      'cycleId', v_room.current_cycle_id,
      'uid', p_actor_uid,
      'memberStatus', 'JOINED',
      'phase', v_phase,
      'decisionRevision', v_decision_revision,
      'rosterRevision', v_room.roster_revision + 1,
      'joinedAt', public.gq_iso(v_now)
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'joinRoom', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_join_room$;

CREATE FUNCTION public.gq_submit_idea(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_submit_idea$
DECLARE
  v_room public.gq_rooms%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_response jsonb;
  v_idea_id text := p_payload->>'ideaId';
  v_text text := p_payload->>'text';
  v_visibility text := p_payload->>'visibility';
  v_submitted_at timestamptz;
  v_snapshot_version integer;
BEGIN
  SELECT * INTO v_room FROM public.gq_rooms WHERE id = p_payload->>'roomId' FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_FOUND'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.gq_members m
    WHERE m.room_id = v_room.id AND m.uid = p_actor_uid AND m.status = 'JOINED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_MEMBER'));
  END IF;

  PERFORM public.gq_settle_room(v_room.id, v_now);
  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room.id;
  v_request_hash := md5(p_payload::text);
  SELECT o.response INTO v_response
  FROM public.gq_operations o
  WHERE o.actor_uid = p_actor_uid AND o.room_id = v_room.id
    AND o.action = 'submitIdea' AND o.operation_id = p_payload->>'operationId';
  IF FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.gq_operations o
      WHERE o.actor_uid = p_actor_uid AND o.room_id = v_room.id
        AND o.action = 'submitIdea' AND o.operation_id = p_payload->>'operationId'
        AND o.request_hash = v_request_hash
    ) THEN
      RETURN v_response;
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
  END IF;

  IF v_idea_id IS NULL OR length(btrim(v_idea_id)) NOT BETWEEN 1 AND 128
    OR v_text IS NULL OR length(btrim(v_text)) NOT BETWEEN 1 AND 4000
    OR v_visibility NOT IN ('PUBLIC', 'PRIVATE')
    OR p_payload->>'operationId' IS NULL
    OR p_payload->>'expectedDecisionRevision' IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;
  IF v_room.room_status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_ACTIVE'));
  END IF;
  IF v_room.phase <> 'COLLECTING' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_PHASE'));
  END IF;
  IF v_room.decision_revision <> (p_payload->>'expectedDecisionRevision')::integer THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.gq_ideas i WHERE i.id = v_idea_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEA_ALREADY_EXISTS'));
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.gq_ideas i
    WHERE i.cycle_id = v_room.current_cycle_id AND i.author_uid = p_actor_uid AND i.skipped
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEA_ALREADY_SKIPPED'));
  END IF;

  INSERT INTO public.gq_ideas(id, cycle_id, author_uid, text, visibility, submitted_at, skipped)
  VALUES (v_idea_id, v_room.current_cycle_id, p_actor_uid, btrim(v_text), v_visibility, v_now, false)
  RETURNING submitted_at INTO v_submitted_at;
  UPDATE public.gq_rooms
  SET snapshot_version = snapshot_version + 1, updated_at = v_now
  WHERE id = v_room.id
  RETURNING snapshot_version INTO v_snapshot_version;

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied', 'roomId', v_room.id, 'ideaId', v_idea_id,
      'cycleId', v_room.current_cycle_id, 'visibility', v_visibility, 'skipped', false,
      'submittedAt', public.gq_iso(v_submitted_at), 'snapshotVersion', v_snapshot_version
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room.id, 'submitIdea', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_submit_idea$;

CREATE FUNCTION public.gq_submit_idea_skip(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_submit_idea_skip$
DECLARE
  v_room public.gq_rooms%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_response jsonb;
  v_idea_id text := p_payload->>'ideaId';
  v_submitted_at timestamptz;
  v_snapshot_version integer;
BEGIN
  SELECT * INTO v_room FROM public.gq_rooms WHERE id = p_payload->>'roomId' FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_FOUND'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.gq_members m
    WHERE m.room_id = v_room.id AND m.uid = p_actor_uid AND m.status = 'JOINED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_MEMBER'));
  END IF;

  PERFORM public.gq_settle_room(v_room.id, v_now);
  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room.id;
  v_request_hash := md5(p_payload::text);
  SELECT o.response INTO v_response
  FROM public.gq_operations o
  WHERE o.actor_uid = p_actor_uid AND o.room_id = v_room.id
    AND o.action = 'submitIdeaSkip' AND o.operation_id = p_payload->>'operationId';
  IF FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.gq_operations o
      WHERE o.actor_uid = p_actor_uid AND o.room_id = v_room.id
        AND o.action = 'submitIdeaSkip' AND o.operation_id = p_payload->>'operationId'
        AND o.request_hash = v_request_hash
    ) THEN
      RETURN v_response;
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
  END IF;

  IF v_idea_id IS NULL OR length(btrim(v_idea_id)) NOT BETWEEN 1 AND 128
    OR p_payload->>'operationId' IS NULL
    OR p_payload->>'expectedDecisionRevision' IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;
  IF v_room.room_status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_ACTIVE'));
  END IF;
  IF v_room.phase <> 'COLLECTING' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_PHASE'));
  END IF;
  IF v_room.decision_revision <> (p_payload->>'expectedDecisionRevision')::integer THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.gq_ideas i WHERE i.id = v_idea_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEA_ALREADY_EXISTS'));
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.gq_ideas i
    WHERE i.cycle_id = v_room.current_cycle_id AND i.author_uid = p_actor_uid
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEA_ALREADY_SUBMITTED'));
  END IF;

  INSERT INTO public.gq_ideas(id, cycle_id, author_uid, text, visibility, submitted_at, skipped)
  VALUES (v_idea_id, v_room.current_cycle_id, p_actor_uid, '', 'PRIVATE', v_now, true)
  RETURNING submitted_at INTO v_submitted_at;
  UPDATE public.gq_rooms
  SET snapshot_version = snapshot_version + 1, updated_at = v_now
  WHERE id = v_room.id
  RETURNING snapshot_version INTO v_snapshot_version;

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied', 'roomId', v_room.id, 'ideaId', v_idea_id,
      'cycleId', v_room.current_cycle_id, 'visibility', 'PRIVATE', 'skipped', true,
      'submittedAt', public.gq_iso(v_submitted_at), 'snapshotVersion', v_snapshot_version
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room.id, 'submitIdeaSkip', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_submit_idea_skip$;

CREATE FUNCTION public.gq_close_collection(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_close_collection$
DECLARE
  v_room public.gq_rooms%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_response jsonb;
  v_submitted_count integer;
  v_skipped_count integer;
  v_unsubmitted_count integer;
  v_snapshot_version integer;
BEGIN
  SELECT * INTO v_room FROM public.gq_rooms WHERE id = p_payload->>'roomId' FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_FOUND'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.gq_members m
    WHERE m.room_id = v_room.id AND m.uid = p_actor_uid AND m.status = 'JOINED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_MEMBER'));
  END IF;

  PERFORM public.gq_settle_room(v_room.id, v_now);
  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room.id;
  v_request_hash := md5(p_payload::text);
  SELECT o.response INTO v_response
  FROM public.gq_operations o
  WHERE o.actor_uid = p_actor_uid AND o.room_id = v_room.id
    AND o.action = 'closeCollection' AND o.operation_id = p_payload->>'operationId';
  IF FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.gq_operations o
      WHERE o.actor_uid = p_actor_uid AND o.room_id = v_room.id
        AND o.action = 'closeCollection' AND o.operation_id = p_payload->>'operationId'
        AND o.request_hash = v_request_hash
    ) THEN
      RETURN v_response;
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
  END IF;

  IF p_payload->>'operationId' IS NULL
    OR p_payload->>'expectedDecisionRevision' IS NULL
    OR p_payload->>'expectedRosterRevision' IS NULL
    OR p_payload->>'expectedUnsubmittedCount' IS NULL
    OR (p_payload->>'expectedUnsubmittedCount')::integer NOT BETWEEN 0 AND 6 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;
  IF v_room.room_status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_ACTIVE'));
  END IF;
  IF v_room.host_uid <> p_actor_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_HOST'));
  END IF;
  IF v_room.phase <> 'COLLECTING' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_PHASE'));
  END IF;
  IF v_room.decision_revision <> (p_payload->>'expectedDecisionRevision')::integer THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF v_room.roster_revision <> (p_payload->>'expectedRosterRevision')::integer THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROSTER_VERSION_CONFLICT'));
  END IF;

  SELECT count(DISTINCT i.author_uid) INTO v_submitted_count
  FROM public.gq_members m
  JOIN public.gq_ideas i ON i.author_uid = m.uid AND i.cycle_id = v_room.current_cycle_id
  WHERE m.room_id = v_room.id AND m.status = 'JOINED' AND NOT i.skipped;
  SELECT count(DISTINCT i.author_uid) INTO v_skipped_count
  FROM public.gq_members m
  JOIN public.gq_ideas i ON i.author_uid = m.uid AND i.cycle_id = v_room.current_cycle_id
  WHERE m.room_id = v_room.id AND m.status = 'JOINED' AND i.skipped;
  SELECT count(*) INTO v_unsubmitted_count
  FROM public.gq_members m
  WHERE m.room_id = v_room.id AND m.status = 'JOINED'
    AND NOT EXISTS (
      SELECT 1 FROM public.gq_ideas i
      WHERE i.cycle_id = v_room.current_cycle_id AND i.author_uid = m.uid
    );
  IF v_unsubmitted_count <> (p_payload->>'expectedUnsubmittedCount')::integer THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'COLLECTION_CONFIRMATION_CONFLICT'));
  END IF;

  UPDATE public.gq_rooms
  SET phase = 'CANDIDATE_REVIEW', snapshot_version = snapshot_version + 1, updated_at = v_now
  WHERE id = v_room.id
  RETURNING snapshot_version INTO v_snapshot_version;
  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied', 'roomId', v_room.id, 'cycleId', v_room.current_cycle_id,
      'phase', 'CANDIDATE_REVIEW', 'submittedCount', v_submitted_count,
      'skippedCount', v_skipped_count, 'unsubmittedCount', v_unsubmitted_count,
      'snapshotVersion', v_snapshot_version, 'decisionRevision', v_room.decision_revision,
      'rosterRevision', v_room.roster_revision, 'closedAt', public.gq_iso(v_now)
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room.id, 'closeCollection', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_close_collection$;

CREATE FUNCTION public.gq_open_evaluation(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_open_evaluation$
DECLARE
  v_room public.gq_rooms%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_decision numeric;
  v_expected_roster numeric;
  v_target_ids text[];
  v_roster text[];
  v_snapshot_version integer;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'roomId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'roundId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'expectedRosterRevision') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'targetRevisionIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_payload->'targetRevisionIds') NOT BETWEEN 1 AND 10 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_expected_decision := (p_payload->>'expectedDecisionRevision')::numeric;
  v_expected_roster := (p_payload->>'expectedRosterRevision')::numeric;
  IF v_expected_decision <= 0 OR v_expected_decision <> trunc(v_expected_decision)
    OR v_expected_roster <= 0 OR v_expected_roster <> trunc(v_expected_roster) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT array_agg(item.value #>> '{}' ORDER BY item.ordinality)
  INTO v_target_ids
  FROM jsonb_array_elements(p_payload->'targetRevisionIds') WITH ORDINALITY AS item(value, ordinality);
  IF EXISTS (SELECT 1 FROM unnest(v_target_ids) target(id) WHERE length(btrim(target.id)) = 0)
    OR (SELECT count(*) FROM unnest(v_target_ids)) <> (SELECT count(DISTINCT id) FROM unnest(v_target_ids) target(id)) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = p_payload->>'roomId' FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_FOUND'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.gq_members m
    WHERE m.room_id = v_room.id AND m.uid = p_actor_uid AND m.status = 'JOINED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_MEMBER'));
  END IF;

  PERFORM public.gq_settle_room(v_room.id, v_now);
  v_request_hash := md5(concat_ws(chr(31), p_actor_uid, p_payload::text));
  SELECT request_hash, response INTO v_existing_hash, v_existing_response
  FROM public.gq_operations
  WHERE actor_uid = p_actor_uid AND room_id = v_room.id
    AND action = 'openEvaluation' AND operation_id = p_payload->>'operationId';
  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room.id;
  IF v_room.room_status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_ACTIVE'));
  END IF;
  IF v_room.host_uid <> p_actor_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_HOST'));
  END IF;
  IF v_room.phase <> 'CANDIDATE_REVIEW' OR v_room.current_evaluation_round_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_PHASE'));
  END IF;
  IF v_expected_decision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF v_expected_roster <> v_room.roster_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROSTER_VERSION_CONFLICT'));
  END IF;

  SELECT array_agg(m.uid ORDER BY m.joined_at, m.uid) INTO v_roster
  FROM public.gq_members m
  WHERE m.room_id = v_room.id AND m.status = 'JOINED';
  IF cardinality(v_roster) NOT BETWEEN 2 AND 6 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROSTER_INVALID'));
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_target_ids) target(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.gq_candidates c
      JOIN public.gq_candidate_revisions cr ON cr.id = c.current_revision_id
      WHERE c.room_id = v_room.id AND c.withdrawn_at IS NULL AND cr.id = target.id
    )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_REVISION_MISMATCH'));
  END IF;

  INSERT INTO public.gq_evaluation_rounds(
    id, cycle_id, roster_uids, roster_revision, target_revision_ids, status, opened_at
  ) VALUES (
    p_payload->>'roundId', v_room.current_cycle_id, v_roster, v_room.roster_revision,
    v_target_ids, 'OPEN', v_now
  );
  UPDATE public.gq_rooms
  SET phase = 'EVALUATING', current_evaluation_round_id = p_payload->>'roundId',
      snapshot_version = snapshot_version + 1, updated_at = v_now
  WHERE id = v_room.id
  RETURNING snapshot_version INTO v_snapshot_version;

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied', 'roomId', v_room.id, 'roundId', p_payload->>'roundId',
      'phase', 'EVALUATING', 'rosterRevision', v_room.roster_revision,
      'targetRevisionIds', to_jsonb(v_target_ids), 'snapshotVersion', v_snapshot_version,
      'openedAt', public.gq_iso(v_now)
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room.id, 'openEvaluation', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_open_evaluation$;

CREATE FUNCTION public.gq_submit_evaluation(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_submit_evaluation$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_round public.gq_evaluation_rounds%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_revision numeric;
  v_score numeric;
  v_attitude text;
  v_reason text;
  v_submission_state text;
  v_updated_at timestamptz;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'roundId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'candidateRevisionId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_expected_revision := (p_payload->>'expectedDecisionRevision')::numeric;
  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT c.room_id INTO v_room_id
  FROM public.gq_evaluation_rounds er
  JOIN public.gq_cycles c ON c.id = er.cycle_id
  WHERE er.id = p_payload->>'roundId';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROUND_NOT_FOUND'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id FOR UPDATE;
  -- Sample the decision time only after the room lock is held. now() would stay pinned
  -- to the transaction start, so a command that waited across a deadline could be
  -- accepted with a stale, pre-deadline timestamp.
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
    AND action = 'submitEvaluation' AND operation_id = p_payload->>'operationId';

  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id;
  SELECT * INTO v_round FROM public.gq_evaluation_rounds WHERE id = p_payload->>'roundId';

  IF v_room.room_status <> 'ACTIVE' OR v_room.phase <> 'EVALUATING'
    OR v_room.current_evaluation_round_id IS DISTINCT FROM v_round.id
    OR v_round.status <> 'OPEN'
    OR (v_round.deadline_at IS NOT NULL AND v_round.deadline_at <= v_now) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROUND_CLOSED'));
  END IF;
  IF v_expected_revision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF NOT p_actor_uid = ANY(v_round.roster_uids) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_IN_ROSTER'));
  END IF;
  IF NOT p_payload->>'candidateRevisionId' = ANY(v_round.target_revision_ids)
    OR NOT EXISTS (
      SELECT 1
      FROM public.gq_candidate_revisions cr
      JOIN public.gq_candidates c ON c.id = cr.candidate_id
      WHERE cr.id = p_payload->>'candidateRevisionId' AND c.room_id = v_room_id
    ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_REVISION_MISMATCH'));
  END IF;

  v_attitude := p_payload->>'attitude';
  v_reason := p_payload->>'reason';
  v_submission_state := p_payload->>'submissionState';
  IF v_submission_state IS NULL OR v_submission_state NOT IN ('EVALUATED', 'SKIPPED')
    OR (v_attitude IS NOT NULL AND v_attitude NOT IN ('SUPPORT', 'OPPOSE', 'NEUTRAL'))
    OR length(v_reason) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_EVALUATION'));
  END IF;

  IF p_payload ? 'score' AND jsonb_typeof(p_payload->'score') = 'number' THEN
    v_score := (p_payload->>'score')::numeric;
    IF v_score < 1 OR v_score > 5 OR v_score <> trunc(v_score) THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_EVALUATION'));
    END IF;
  ELSIF p_payload ? 'score' AND jsonb_typeof(p_payload->'score') IS DISTINCT FROM 'null' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_EVALUATION'));
  END IF;

  IF (v_submission_state = 'SKIPPED' AND (
      p_payload ? 'attitude' OR p_payload ? 'score' OR p_payload ? 'reason'
    ))
    OR (v_submission_state = 'EVALUATED' AND v_attitude IS NULL AND v_score IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_EVALUATION'));
  END IF;

  INSERT INTO public.gq_evaluations(
    round_id, uid, candidate_revision_id, attitude, score, reason, submission_state, updated_at
  ) VALUES (
    p_payload->>'roundId', p_actor_uid, p_payload->>'candidateRevisionId',
    v_attitude, v_score::integer, v_reason, v_submission_state, v_now
  )
  ON CONFLICT (round_id, uid, candidate_revision_id) DO UPDATE
  SET attitude = EXCLUDED.attitude, score = EXCLUDED.score, reason = EXCLUDED.reason,
      submission_state = EXCLUDED.submission_state, updated_at = EXCLUDED.updated_at
  RETURNING updated_at INTO v_updated_at;

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied',
      'roundId', v_round.id,
      'candidateRevisionId', p_payload->>'candidateRevisionId',
      'submissionState', v_submission_state,
      'updatedAt', public.gq_iso(v_updated_at)
    )
  );

  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'submitEvaluation', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );

  UPDATE public.gq_rooms
  SET snapshot_version = snapshot_version + 1, updated_at = v_now
  WHERE id = v_room_id;
  RETURN v_response;
END;
$gq_submit_evaluation$;

CREATE FUNCTION public.gq_close_evaluation(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_close_evaluation$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_round public.gq_evaluation_rounds%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_decision numeric;
  v_expected_incomplete numeric;
  v_incomplete integer;
  v_snapshot_version integer;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'roundId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'expectedIncompleteCount') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;
  v_expected_decision := (p_payload->>'expectedDecisionRevision')::numeric;
  v_expected_incomplete := (p_payload->>'expectedIncompleteCount')::numeric;
  IF v_expected_decision <= 0 OR v_expected_decision <> trunc(v_expected_decision)
    OR v_expected_incomplete < 0 OR v_expected_incomplete > 6
    OR v_expected_incomplete <> trunc(v_expected_incomplete) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT c.room_id INTO v_room_id
  FROM public.gq_evaluation_rounds er
  JOIN public.gq_cycles c ON c.id = er.cycle_id
  WHERE er.id = p_payload->>'roundId';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROUND_NOT_FOUND'));
  END IF;
  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id FOR UPDATE;
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
    AND action = 'closeEvaluation' AND operation_id = p_payload->>'operationId';
  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id;
  SELECT * INTO v_round FROM public.gq_evaluation_rounds WHERE id = p_payload->>'roundId';
  IF v_room.room_status <> 'ACTIVE' OR v_room.phase <> 'EVALUATING'
    OR v_room.current_evaluation_round_id IS DISTINCT FROM v_round.id OR v_round.status <> 'OPEN' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROUND_CLOSED'));
  END IF;
  IF v_room.host_uid <> p_actor_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_HOST'));
  END IF;
  IF v_expected_decision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;

  SELECT count(*) INTO v_incomplete
  FROM unnest(v_round.roster_uids) roster(uid)
  WHERE (
    SELECT count(*) FROM public.gq_evaluations e
    WHERE e.round_id = v_round.id AND e.uid = roster.uid
  ) <> cardinality(v_round.target_revision_ids);
  IF v_incomplete <> v_expected_incomplete THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'EVALUATION_CONFIRMATION_CONFLICT'));
  END IF;

  v_snapshot_version := public.gq_close_round(v_room_id, v_round.id, v_now, 'HOST_END');

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied', 'roomId', v_room_id, 'roundId', v_round.id,
      'phase', 'DISCUSSING', 'closeReason', 'HOST_END', 'snapshotVersion', v_snapshot_version,
      'closedAt', public.gq_iso(v_now), 'revealAt', public.gq_iso(v_now)
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'closeEvaluation', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_close_evaluation$;

CREATE FUNCTION public.gq_vote_round_close(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_vote_round_close$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_round public.gq_evaluation_rounds%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_revision numeric;
  v_end_vote_count integer;
  v_majority_threshold integer;
  v_snapshot_version integer;
  v_round_status text := 'OPEN';
  v_close_reason text;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'roundId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;
  v_expected_revision := (p_payload->>'expectedDecisionRevision')::numeric;
  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT c.room_id INTO v_room_id
  FROM public.gq_evaluation_rounds er
  JOIN public.gq_cycles c ON c.id = er.cycle_id
  WHERE er.id = p_payload->>'roundId';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROUND_NOT_FOUND'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id FOR UPDATE;
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
    AND action = 'voteRoundClose' AND operation_id = p_payload->>'operationId';
  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id;
  SELECT * INTO v_round FROM public.gq_evaluation_rounds WHERE id = p_payload->>'roundId';
  IF v_room.room_status <> 'ACTIVE' OR v_room.phase <> 'EVALUATING'
    OR v_room.current_evaluation_round_id IS DISTINCT FROM v_round.id OR v_round.status <> 'OPEN' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROUND_CLOSED'));
  END IF;
  IF v_expected_revision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF NOT p_actor_uid = ANY(v_round.roster_uids) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_IN_ROSTER'));
  END IF;
  IF v_round.deadline_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROUND_CLOSE_VOTING_DISABLED'));
  END IF;

  INSERT INTO public.gq_close_votes(round_id, uid, choice, updated_at)
  VALUES (v_round.id, p_actor_uid, 'END', v_now)
  ON CONFLICT (round_id, uid) DO UPDATE SET choice = 'END', updated_at = EXCLUDED.updated_at;

  SELECT count(*) INTO v_end_vote_count
  FROM public.gq_close_votes cv
  WHERE cv.round_id = v_round.id AND cv.choice = 'END' AND cv.uid = ANY(v_round.roster_uids);
  v_majority_threshold := floor(cardinality(v_round.roster_uids) / 2.0) + 1;

  IF v_end_vote_count >= v_majority_threshold THEN
    v_snapshot_version := public.gq_close_round(v_room_id, v_round.id, v_now, 'MAJORITY_END');
    v_round_status := 'CLOSED';
    v_close_reason := 'MAJORITY_END';
  ELSE
    UPDATE public.gq_rooms
    SET snapshot_version = snapshot_version + 1, updated_at = v_now
    WHERE id = v_room_id
    RETURNING snapshot_version INTO v_snapshot_version;
  END IF;

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_strip_nulls(jsonb_build_object(
      'status', 'applied', 'roomId', v_room_id, 'roundId', v_round.id,
      'endVoteCount', v_end_vote_count, 'majorityThreshold', v_majority_threshold,
      'roundStatus', v_round_status, 'closeReason', v_close_reason,
      'snapshotVersion', v_snapshot_version, 'updatedAt', public.gq_iso(v_now)
    ))
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'voteRoundClose', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_vote_round_close$;

CREATE FUNCTION public.gq_retract_round_close_vote(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_retract_round_close_vote$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_round public.gq_evaluation_rounds%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_revision numeric;
  v_end_vote_count integer;
  v_majority_threshold integer;
  v_snapshot_version integer;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'roundId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;
  v_expected_revision := (p_payload->>'expectedDecisionRevision')::numeric;
  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT c.room_id INTO v_room_id
  FROM public.gq_evaluation_rounds er
  JOIN public.gq_cycles c ON c.id = er.cycle_id
  WHERE er.id = p_payload->>'roundId';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROUND_NOT_FOUND'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id FOR UPDATE;
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
    AND action = 'retractRoundCloseVote' AND operation_id = p_payload->>'operationId';
  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id;
  SELECT * INTO v_round FROM public.gq_evaluation_rounds WHERE id = p_payload->>'roundId';
  IF v_room.room_status <> 'ACTIVE' OR v_room.phase <> 'EVALUATING'
    OR v_room.current_evaluation_round_id IS DISTINCT FROM v_round.id OR v_round.status <> 'OPEN' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROUND_CLOSED'));
  END IF;
  IF v_expected_revision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF NOT p_actor_uid = ANY(v_round.roster_uids) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_IN_ROSTER'));
  END IF;

  DELETE FROM public.gq_close_votes
  WHERE round_id = v_round.id AND uid = p_actor_uid;
  SELECT count(*) INTO v_end_vote_count
  FROM public.gq_close_votes cv
  WHERE cv.round_id = v_round.id AND cv.choice = 'END' AND cv.uid = ANY(v_round.roster_uids);
  v_majority_threshold := floor(cardinality(v_round.roster_uids) / 2.0) + 1;

  UPDATE public.gq_rooms
  SET snapshot_version = snapshot_version + 1, updated_at = v_now
  WHERE id = v_room_id
  RETURNING snapshot_version INTO v_snapshot_version;

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied', 'roomId', v_room_id, 'roundId', v_round.id,
      'endVoteCount', v_end_vote_count, 'majorityThreshold', v_majority_threshold,
      'snapshotVersion', v_snapshot_version, 'updatedAt', public.gq_iso(v_now)
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'retractRoundCloseVote', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_retract_round_close_vote$;

CREATE FUNCTION public.gq_set_round_deadline(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_set_round_deadline$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_round public.gq_evaluation_rounds%ROWTYPE;
  v_now timestamptz;
  v_deadline timestamptz;
  v_reason text;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_revision numeric;
  v_snapshot_version integer;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'roundId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;
  v_expected_revision := (p_payload->>'expectedDecisionRevision')::numeric;
  v_reason := btrim(COALESCE(p_payload->>'reason', ''));
  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;
  IF length(v_reason) = 0 OR length(v_reason) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_REASON'));
  END IF;
  BEGIN
    v_deadline := (p_payload->>'deadlineAt')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_DEADLINE'));
  END;

  SELECT c.room_id INTO v_room_id
  FROM public.gq_evaluation_rounds er
  JOIN public.gq_cycles c ON c.id = er.cycle_id
  WHERE er.id = p_payload->>'roundId';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROUND_NOT_FOUND'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id FOR UPDATE;
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
    AND action = 'setRoundDeadline' AND operation_id = p_payload->>'operationId';
  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id;
  SELECT * INTO v_round FROM public.gq_evaluation_rounds WHERE id = p_payload->>'roundId';
  IF v_room.room_status <> 'ACTIVE' OR v_room.phase <> 'EVALUATING'
    OR v_room.current_evaluation_round_id IS DISTINCT FROM v_round.id OR v_round.status <> 'OPEN' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROUND_CLOSED'));
  END IF;
  IF v_room.host_uid <> p_actor_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_HOST'));
  END IF;
  IF v_expected_revision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF v_deadline <= v_now
    OR (v_round.deadline_at IS NOT NULL AND v_deadline <= v_round.deadline_at) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_DEADLINE'));
  END IF;

  UPDATE public.gq_evaluation_rounds
  SET deadline_at = v_deadline
  WHERE id = v_round.id;
  UPDATE public.gq_rooms
  SET snapshot_version = snapshot_version + 1, updated_at = v_now
  WHERE id = v_room_id
  RETURNING snapshot_version INTO v_snapshot_version;
  INSERT INTO public.gq_events(room_id, type, payload, created_at)
  VALUES (v_room_id, 'ROUND_DEADLINE_CHANGED', jsonb_build_object(
    'roundId', v_round.id, 'deadlineAt', public.gq_iso(v_deadline), 'reason', v_reason
  ), v_now);

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied', 'roomId', v_room_id, 'roundId', v_round.id,
      'deadlineAt', public.gq_iso(v_deadline), 'reason', v_reason,
      'snapshotVersion', v_snapshot_version, 'updatedAt', public.gq_iso(v_now)
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'setRoundDeadline', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_set_round_deadline$;

CREATE FUNCTION public.gq_propose_final(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_propose_final$
DECLARE
  v_room_id text := p_payload->>'roomId';
  v_room public.gq_rooms%ROWTYPE;
  v_revision public.gq_candidate_revisions%ROWTYPE;
  v_roster text[];
  v_now timestamptz;
  v_deadline timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_revision numeric;
  v_snapshot_version integer;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(v_room_id, ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'proposalId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'candidateRevisionId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;
  v_expected_revision := (p_payload->>'expectedDecisionRevision')::numeric;
  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;
  BEGIN
    v_deadline := (p_payload->>'deadlineAt')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_DEADLINE'));
  END;

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
    AND action = 'proposeFinal' AND operation_id = p_payload->>'operationId';
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
  IF v_room.room_status <> 'ACTIVE' OR v_room.phase <> 'DISCUSSING'
    OR v_room.current_proposal_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'PROPOSAL_PHASE_INVALID'));
  END IF;
  IF v_expected_revision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF v_deadline < v_now + interval '5 minutes' OR v_deadline > v_now + interval '7 days' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_DEADLINE'));
  END IF;

  SELECT cr.* INTO v_revision
  FROM public.gq_candidates c
  JOIN public.gq_candidate_revisions cr ON cr.id = c.current_revision_id
  WHERE c.room_id = v_room_id AND c.withdrawn_at IS NULL
    AND cr.id = p_payload->>'candidateRevisionId';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_REVISION_MISMATCH'));
  END IF;

  SELECT COALESCE(array_agg(m.uid ORDER BY m.joined_at, m.uid), ARRAY[]::text[])
  INTO v_roster
  FROM public.gq_members m
  WHERE m.room_id = v_room_id AND m.status = 'JOINED';
  IF cardinality(v_roster) NOT BETWEEN 2 AND 6 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROSTER_INVALID'));
  END IF;

  INSERT INTO public.gq_proposals(
    id, cycle_id, roster_uids, roster_revision, candidate_revision_id,
    candidate_revision_snapshot, decision_revision, deadline_at, status, created_at
  ) VALUES (
    p_payload->>'proposalId', v_room.current_cycle_id, v_roster, v_room.roster_revision,
    v_revision.id, jsonb_build_object(
      'schemaVersion', 2, 'id', v_revision.id, 'candidateId', v_revision.candidate_id,
      'revision', v_revision.revision, 'title', v_revision.title, 'body', v_revision.body,
      'templateId', v_revision.template_id, 'templatePayload', v_revision.template_payload,
      'sourceIdeaIds', to_jsonb(v_revision.source_idea_ids), 'createdBy', v_revision.created_by,
      'createdAt', public.gq_iso(v_revision.created_at)
    ), v_room.decision_revision, v_deadline, 'OPEN', v_now
  );

  UPDATE public.gq_rooms
  SET phase = 'CONFIRMING', current_proposal_id = p_payload->>'proposalId',
      snapshot_version = snapshot_version + 1, updated_at = v_now
  WHERE id = v_room_id
  RETURNING snapshot_version INTO v_snapshot_version;

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied', 'roomId', v_room_id, 'proposalId', p_payload->>'proposalId',
      'candidateRevisionId', v_revision.id, 'phase', 'CONFIRMING',
      'rosterUids', to_jsonb(v_roster), 'deadlineAt', public.gq_iso(v_deadline),
      'snapshotVersion', v_snapshot_version, 'createdAt', public.gq_iso(v_now)
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'proposeFinal', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_propose_final$;

CREATE FUNCTION public.gq_respond_final(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_respond_final$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_proposal public.gq_proposals%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_revision numeric;
  v_choice text;
  v_accepted integer;
  v_declined integer;
  v_abstained integer;
  v_pending integer;
  v_proposal_status text;
  v_updated_at timestamptz;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'proposalId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'candidateRevisionId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_expected_revision := (p_payload->>'expectedDecisionRevision')::numeric;
  v_choice := p_payload->>'choice';
  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision)
    OR v_choice IS NULL OR v_choice NOT IN ('ACCEPT', 'DECLINE', 'ABSTAIN') THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT c.room_id INTO v_room_id
  FROM public.gq_proposals p
  JOIN public.gq_cycles c ON c.id = p.cycle_id
  WHERE p.id = p_payload->>'proposalId';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'PROPOSAL_NOT_FOUND'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id FOR UPDATE;
  -- Sample the decision time only after the room lock is held. now() would stay pinned
  -- to the transaction start, so a command that waited across a deadline could be
  -- accepted with a stale, pre-deadline timestamp.
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
    AND action = 'respondFinal' AND operation_id = p_payload->>'operationId';

  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id;
  SELECT * INTO v_proposal FROM public.gq_proposals WHERE id = p_payload->>'proposalId';

  IF v_proposal.status <> 'OPEN' THEN
    IF v_proposal.status = 'UNRESOLVED' AND v_proposal.deadline_at <= v_now THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'PROPOSAL_EXPIRED'));
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'PROPOSAL_CLOSED'));
  END IF;
  IF v_room.room_status <> 'ACTIVE' OR v_room.phase <> 'CONFIRMING'
    OR v_room.current_proposal_id IS DISTINCT FROM v_proposal.id THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'PROPOSAL_CLOSED'));
  END IF;
  IF v_expected_revision <> v_room.decision_revision
    OR v_expected_revision <> v_proposal.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF p_payload->>'candidateRevisionId' IS DISTINCT FROM v_proposal.candidate_revision_id THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_REVISION_MISMATCH'));
  END IF;
  IF NOT p_actor_uid = ANY(v_proposal.roster_uids) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_IN_ROSTER'));
  END IF;

  INSERT INTO public.gq_final_responses(proposal_id, candidate_revision_id, uid, choice, updated_at)
  VALUES (v_proposal.id, v_proposal.candidate_revision_id, p_actor_uid, v_choice, v_now)
  ON CONFLICT (proposal_id, uid) DO UPDATE
  SET choice = EXCLUDED.choice, updated_at = EXCLUDED.updated_at
  RETURNING updated_at INTO v_updated_at;

  SELECT
    count(*) FILTER (WHERE fr.choice = 'ACCEPT'),
    count(*) FILTER (WHERE fr.choice = 'DECLINE'),
    count(*) FILTER (WHERE fr.choice = 'ABSTAIN')
  INTO v_accepted, v_declined, v_abstained
  FROM public.gq_final_responses fr
  WHERE fr.proposal_id = v_proposal.id AND fr.uid = ANY(v_proposal.roster_uids);
  v_pending := cardinality(v_proposal.roster_uids) - v_accepted - v_declined - v_abstained;
  v_proposal_status := 'OPEN';

  IF v_accepted = cardinality(v_proposal.roster_uids) THEN
    v_proposal_status := 'AGREED';
    UPDATE public.gq_proposals
    SET status = 'AGREED', resolved_at = v_now
    WHERE id = v_proposal.id;

    INSERT INTO public.gq_decision_records(
      id, cycle_id, proposal_id, outcome, candidate_revision_snapshot,
      roster_snapshot, accepted, declined, abstained, pending, created_at
    ) VALUES (
      v_proposal.id, v_proposal.cycle_id, v_proposal.id, 'AGREED',
      v_proposal.candidate_revision_snapshot, v_proposal.roster_uids,
      v_accepted, v_declined, v_abstained, v_pending, v_now
    );

    UPDATE public.gq_rooms
    SET phase = 'COMPLETED', current_proposal_id = NULL,
        snapshot_version = snapshot_version + 1, updated_at = v_now
    WHERE id = v_room_id;
  ELSE
    UPDATE public.gq_rooms
    SET snapshot_version = snapshot_version + 1, updated_at = v_now
    WHERE id = v_room_id;
  END IF;

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied',
      'proposalId', v_proposal.id,
      'candidateRevisionId', v_proposal.candidate_revision_id,
      'choice', v_choice,
      'updatedAt', public.gq_iso(v_updated_at),
      'proposalStatus', v_proposal_status
    )
  );

  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'respondFinal', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_respond_final$;

CREATE FUNCTION public.gq_close_unresolved(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_close_unresolved$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_proposal public.gq_proposals%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_revision numeric;
  v_accepted integer;
  v_declined integer;
  v_abstained integer;
  v_pending integer;
  v_snapshot_version integer;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'proposalId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;
  v_expected_revision := (p_payload->>'expectedDecisionRevision')::numeric;
  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT c.room_id INTO v_room_id
  FROM public.gq_proposals p
  JOIN public.gq_cycles c ON c.id = p.cycle_id
  WHERE p.id = p_payload->>'proposalId';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'PROPOSAL_NOT_FOUND'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id FOR UPDATE;
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
    AND action = 'closeUnresolved' AND operation_id = p_payload->>'operationId';
  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id;
  SELECT * INTO v_proposal FROM public.gq_proposals WHERE id = p_payload->>'proposalId';
  IF v_room.host_uid <> p_actor_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_HOST'));
  END IF;
  IF v_expected_revision <> v_room.decision_revision
    OR v_expected_revision <> v_proposal.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF v_room.room_status <> 'ACTIVE' OR v_room.phase <> 'CONFIRMING'
    OR v_room.current_proposal_id IS DISTINCT FROM v_proposal.id OR v_proposal.status <> 'OPEN' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'PROPOSAL_CLOSED'));
  END IF;

  SELECT
    count(*) FILTER (WHERE fr.choice = 'ACCEPT'),
    count(*) FILTER (WHERE fr.choice = 'DECLINE'),
    count(*) FILTER (WHERE fr.choice = 'ABSTAIN')
  INTO v_accepted, v_declined, v_abstained
  FROM public.gq_final_responses fr
  WHERE fr.proposal_id = v_proposal.id AND fr.uid = ANY(v_proposal.roster_uids);
  v_pending := cardinality(v_proposal.roster_uids) - v_accepted - v_declined - v_abstained;

  UPDATE public.gq_proposals
  SET status = 'UNRESOLVED', resolved_at = v_now
  WHERE id = v_proposal.id;
  INSERT INTO public.gq_decision_records(
    id, cycle_id, proposal_id, outcome, candidate_revision_snapshot,
    roster_snapshot, accepted, declined, abstained, pending, unresolved_summary, created_at
  ) VALUES (
    v_proposal.id, v_proposal.cycle_id, v_proposal.id, 'UNRESOLVED',
    v_proposal.candidate_revision_snapshot, v_proposal.roster_uids,
    v_accepted, v_declined, v_abstained, v_pending, '未全员明确接受', v_now
  );
  UPDATE public.gq_rooms
  SET phase = 'COMPLETED', current_proposal_id = NULL,
      snapshot_version = snapshot_version + 1, updated_at = v_now
  WHERE id = v_room_id
  RETURNING snapshot_version INTO v_snapshot_version;

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied', 'proposalId', v_proposal.id, 'outcome', 'UNRESOLVED',
      'phase', 'COMPLETED', 'responseSummary', jsonb_build_object(
        'accepted', v_accepted, 'declined', v_declined,
        'abstained', v_abstained, 'pending', v_pending
      ), 'snapshotVersion', v_snapshot_version, 'resolvedAt', public.gq_iso(v_now)
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'closeUnresolved', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_close_unresolved$;

CREATE FUNCTION public.gq_add_comment(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_add_comment$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_existing_comment public.gq_comments%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_revision numeric;
  v_publication_state text;
  v_candidate_room_id text;
  v_revision_candidate_id text;
  v_created_at timestamptz;
  v_published_at timestamptz;
  v_snapshot_version integer;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'roomId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'commentId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'body', ''))) NOT BETWEEN 1 AND 4000
    OR COALESCE(p_payload->>'visibility', '') NOT IN ('PUBLIC', 'PRIVATE')
    OR COALESCE(p_payload->>'publicationState', '') NOT IN ('DRAFT', 'PUBLISHED')
    OR (p_payload->>'candidateRevisionId' IS NOT NULL AND p_payload->>'candidateId' IS NULL)
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_expected_revision := (p_payload->>'expectedDecisionRevision')::numeric;
  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_room_id := p_payload->>'roomId';
  v_publication_state := p_payload->>'publicationState';
  -- Serialize a caller-supplied comment ID even when two rooms race to claim it.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(concat_ws(
    chr(31), 'gq_add_comment', p_payload->>'commentId')));
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
    AND action = 'addComment' AND operation_id = p_payload->>'operationId';
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
  IF v_expected_revision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF v_publication_state = 'PUBLISHED' AND v_room.phase NOT IN ('DISCUSSING', 'CONFIRMING') THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'COMMENT_PUBLICATION_NOT_ALLOWED'));
  END IF;
  IF v_publication_state = 'DRAFT' AND v_room.phase NOT IN ('EVALUATING', 'DISCUSSING', 'CONFIRMING') THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'COMMENT_PHASE_INVALID'));
  END IF;

  SELECT * INTO v_existing_comment FROM public.gq_comments
  WHERE id = p_payload->>'commentId' FOR UPDATE;
  IF v_existing_comment.id IS NOT NULL THEN
    IF v_existing_comment.author_uid <> p_actor_uid
      OR v_existing_comment.cycle_id IS DISTINCT FROM v_room.current_cycle_id THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'COMMENT_ID_CONFLICT'));
    END IF;
    IF v_existing_comment.publication_state = 'PUBLISHED' THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'COMMENT_ALREADY_PUBLISHED'));
    END IF;
  END IF;

  IF p_payload->>'candidateId' IS NOT NULL THEN
    SELECT c.room_id INTO v_candidate_room_id FROM public.gq_candidates c
    WHERE c.id = p_payload->>'candidateId';
    IF NOT FOUND OR v_candidate_room_id IS DISTINCT FROM v_room_id THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_NOT_FOUND'));
    END IF;
    IF p_payload->>'candidateRevisionId' IS NOT NULL THEN
      SELECT cr.candidate_id INTO v_revision_candidate_id FROM public.gq_candidate_revisions cr
      WHERE cr.id = p_payload->>'candidateRevisionId';
      IF NOT FOUND OR v_revision_candidate_id IS DISTINCT FROM p_payload->>'candidateId' THEN
        RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_REVISION_MISMATCH'));
      END IF;
    END IF;
  END IF;

  v_created_at := COALESCE(v_existing_comment.created_at, v_now);
  v_published_at := CASE WHEN v_publication_state = 'PUBLISHED' THEN v_now ELSE NULL END;
  IF v_existing_comment.id IS NULL THEN
    INSERT INTO public.gq_comments(
      id, cycle_id, candidate_id, candidate_revision_id, author_uid, body,
      visibility, publication_state, created_at, published_at
    ) VALUES (
      p_payload->>'commentId', v_room.current_cycle_id, p_payload->>'candidateId',
      p_payload->>'candidateRevisionId', p_actor_uid, btrim(p_payload->>'body'),
      p_payload->>'visibility', v_publication_state, v_created_at, v_published_at
    );
  ELSE
    UPDATE public.gq_comments
    SET candidate_id = p_payload->>'candidateId',
        candidate_revision_id = p_payload->>'candidateRevisionId',
        body = btrim(p_payload->>'body'),
        visibility = p_payload->>'visibility',
        publication_state = v_publication_state,
        published_at = v_published_at
    WHERE id = v_existing_comment.id;
  END IF;

  UPDATE public.gq_rooms
  SET snapshot_version = snapshot_version + 1, updated_at = v_now
  WHERE id = v_room_id
  RETURNING snapshot_version INTO v_snapshot_version;

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_strip_nulls(jsonb_build_object(
      'status', 'applied',
      'roomId', v_room_id,
      'commentId', p_payload->>'commentId',
      'publicationState', v_publication_state,
      'snapshotVersion', v_snapshot_version,
      'decisionRevision', v_room.decision_revision,
      'createdAt', public.gq_iso(v_created_at),
      'publishedAt', public.gq_iso(v_published_at),
      'updatedAt', public.gq_iso(v_now)
    ))
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'addComment', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_add_comment$;

CREATE FUNCTION public.gq_get_snapshot(p_actor_uid text, p_room_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_get_snapshot$
DECLARE
  v_room public.gq_rooms%ROWTYPE;
  v_now timestamptz;
  v_response jsonb;
BEGIN
  SELECT * INTO v_room FROM public.gq_rooms WHERE id = p_room_id FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_FOUND'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.gq_members m
    WHERE m.room_id = p_room_id AND m.uid = p_actor_uid AND m.status = 'JOINED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_MEMBER'));
  END IF;

  PERFORM public.gq_settle_room(p_room_id, v_now);
  SELECT * INTO v_room FROM public.gq_rooms WHERE id = p_room_id;

  WITH safe_events AS (
    SELECT id, type, payload, created_at
    FROM public.gq_events e
    WHERE e.room_id = p_room_id
    ORDER BY id DESC
    LIMIT 50
  )
  SELECT jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'schemaVersion', 2,
      'version', r.snapshot_version,
      'snapshotAt', public.gq_iso(v_now),
      'shared', jsonb_build_object(
        'roomId', r.id,
        'title', r.title,
        'purpose', r.purpose,
        'templateId', r.template_id,
        'hostUid', r.host_uid,
        'currentCycleId', r.current_cycle_id,
        'decisionRevision', r.decision_revision,
        'rosterRevision', r.roster_revision,
        'phase', r.phase,
        'roomStatus', r.room_status,
        'memberUids', (
          SELECT COALESCE(jsonb_agg(m.uid ORDER BY m.joined_at, m.uid), '[]'::jsonb)
          FROM public.gq_members m
          WHERE m.room_id = r.id AND m.status = 'JOINED'
        ),
        'candidates', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'schemaVersion', 2,
            'id', c.id,
            'roomId', c.room_id,
            'currentRevisionId', c.current_revision_id,
            'withdrawnAt', CASE WHEN c.withdrawn_at IS NULL THEN NULL ELSE public.gq_iso(c.withdrawn_at) END,
            'createdBy', c.created_by
          ) ORDER BY c.created_at, c.id), '[]'::jsonb)
          FROM public.gq_candidates c
          WHERE c.room_id = r.id
        ),
        'currentRevisions', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'schemaVersion', 2,
            'id', cr.id,
            'candidateId', cr.candidate_id,
            'revision', cr.revision,
            'title', cr.title,
            'body', cr.body,
            'templateId', cr.template_id,
            'templatePayload', cr.template_payload,
            'sourceIdeaIds', to_jsonb(cr.source_idea_ids),
            'createdBy', cr.created_by,
            'createdAt', public.gq_iso(cr.created_at)
          ) ORDER BY cr.created_at, cr.id), '[]'::jsonb)
          FROM public.gq_candidates c
          JOIN public.gq_candidate_revisions cr ON cr.id = c.current_revision_id
          WHERE c.room_id = r.id
        ),
        'publicIdeas', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'schemaVersion', 2,
            'id', i.id,
            'cycleId', i.cycle_id,
            'authorUid', i.author_uid,
            'text', i.text,
            'visibility', i.visibility,
            'submittedAt', public.gq_iso(i.submitted_at),
            'skipped', i.skipped
          ) ORDER BY i.submitted_at, i.id), '[]'::jsonb)
          FROM public.gq_ideas i
          WHERE i.cycle_id = r.current_cycle_id
            AND r.phase <> 'COLLECTING'
            AND i.visibility = 'PUBLIC'
            AND NOT i.skipped
        ),
        'comments', (
          SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'schemaVersion', 2,
            'id', cm.id,
            'cycleId', cm.cycle_id,
            'candidateId', cm.candidate_id,
            'candidateRevisionId', cm.candidate_revision_id,
            'authorUid', cm.author_uid,
            'body', cm.body,
            'visibility', cm.visibility,
            'publicationState', cm.publication_state,
            'createdAt', public.gq_iso(cm.created_at),
            'publishedAt', public.gq_iso(cm.published_at)
          )) ORDER BY cm.created_at, cm.id), '[]'::jsonb)
          FROM public.gq_comments cm
          WHERE cm.cycle_id = r.current_cycle_id
            AND cm.publication_state = 'PUBLISHED'
            AND cm.visibility = 'PUBLIC'
        ),
        'activeEvaluationRound', (
          SELECT jsonb_strip_nulls(jsonb_build_object(
            'schemaVersion', 2, 'id', er.id, 'cycleId', er.cycle_id,
            'rosterUids', to_jsonb(er.roster_uids), 'rosterRevision', er.roster_revision,
            'targetRevisionIds', to_jsonb(er.target_revision_ids), 'status', er.status,
            'openedAt', public.gq_iso(er.opened_at), 'deadlineAt', public.gq_iso(er.deadline_at),
            'closedAt', public.gq_iso(er.closed_at), 'revealAt', public.gq_iso(er.reveal_at),
            'closeReason', er.close_reason
          ))
          FROM public.gq_evaluation_rounds er
          WHERE er.id = r.current_evaluation_round_id
        ),
        'activeRoundClose', (
          SELECT jsonb_build_object(
            'roundId', er.id,
            'endVoteCount', (
              SELECT count(*) FROM public.gq_close_votes cv
              WHERE cv.round_id = er.id AND cv.choice = 'END' AND cv.uid = ANY(er.roster_uids)
            ),
            'majorityThreshold', floor(cardinality(er.roster_uids) / 2.0) + 1
          )
          FROM public.gq_evaluation_rounds er
          WHERE er.id = r.current_evaluation_round_id
        ),
        'activeReopen', (
          SELECT jsonb_build_object(
            'requestId', rr.id,
            'roundId', rr.round_id,
            'requestedBy', rr.requested_by,
            'targetRevisionIds', to_jsonb(rr.target_revision_ids),
            'reopenVoteCount', (
              SELECT count(*) FROM public.gq_reopen_votes rv
              WHERE rv.request_id = rr.id AND rv.choice = 'REOPEN' AND rv.uid = ANY(rr.roster_uids)
            ),
            'majorityThreshold', floor(cardinality(rr.roster_uids) / 2.0) + 1
          )
          FROM public.gq_reopen_requests rr
          WHERE rr.cycle_id = r.current_cycle_id AND rr.status = 'OPEN'
        ),
        'revealedEvaluationRoundIds', (
          SELECT COALESCE(jsonb_agg(er.id ORDER BY er.reveal_at, er.id), '[]'::jsonb)
          FROM public.gq_evaluation_rounds er
          WHERE er.cycle_id = r.current_cycle_id
            AND er.status = 'CLOSED' AND er.reveal_at IS NOT NULL
        ),
        'revealedEvaluations', (
          SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'schemaVersion', 2, 'roundId', e.round_id, 'uid', e.uid,
            'candidateRevisionId', e.candidate_revision_id, 'attitude', e.attitude,
            'score', e.score, 'reason', e.reason, 'submissionState', e.submission_state,
            'updatedAt', public.gq_iso(e.updated_at)
          )) ORDER BY e.updated_at, e.round_id, e.uid, e.candidate_revision_id), '[]'::jsonb)
          FROM public.gq_evaluations e
          JOIN public.gq_evaluation_rounds er ON er.id = e.round_id
          WHERE er.cycle_id = r.current_cycle_id
            AND er.status = 'CLOSED' AND er.reveal_at IS NOT NULL
        ),
        'finalResponseSummary', (
          SELECT jsonb_build_object(
            'accepted', (SELECT count(*) FROM public.gq_final_responses fr
              WHERE fr.proposal_id = p.id AND fr.choice = 'ACCEPT' AND fr.uid = ANY(p.roster_uids)),
            'declined', (SELECT count(*) FROM public.gq_final_responses fr
              WHERE fr.proposal_id = p.id AND fr.choice = 'DECLINE' AND fr.uid = ANY(p.roster_uids)),
            'abstained', (SELECT count(*) FROM public.gq_final_responses fr
              WHERE fr.proposal_id = p.id AND fr.choice = 'ABSTAIN' AND fr.uid = ANY(p.roster_uids)),
            'pending', cardinality(p.roster_uids) - (SELECT count(*) FROM public.gq_final_responses fr
              WHERE fr.proposal_id = p.id AND fr.uid = ANY(p.roster_uids))
          )
          FROM public.gq_proposals p
          WHERE p.id = r.current_proposal_id
        ),
        'decisionRecords', (
          SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'schemaVersion', 2, 'id', dr.id, 'cycleId', dr.cycle_id,
            'proposalId', dr.proposal_id, 'outcome', dr.outcome,
            'candidateRevisionSnapshot', dr.candidate_revision_snapshot,
            'rosterSnapshot', to_jsonb(dr.roster_snapshot),
            'responseSummary', jsonb_build_object(
              'accepted', dr.accepted, 'declined', dr.declined,
              'abstained', dr.abstained, 'pending', dr.pending
            ),
            'unresolvedSummary', dr.unresolved_summary,
            'createdAt', public.gq_iso(dr.created_at)
          )) ORDER BY dr.created_at, dr.id), '[]'::jsonb)
          FROM public.gq_decision_records dr
          WHERE dr.cycle_id = r.current_cycle_id
        ),
        'progress', jsonb_build_object(
          'ideaSubmittedCount', (
            SELECT count(DISTINCT i.author_uid) FROM public.gq_ideas i
            WHERE i.cycle_id = r.current_cycle_id AND NOT i.skipped
          ),
          'ideaSkippedCount', (
            SELECT count(*) FROM public.gq_ideas i
            WHERE i.cycle_id = r.current_cycle_id AND i.skipped
          ),
          'evaluationSubmittedCount', (
            SELECT count(DISTINCT e.uid) FROM public.gq_evaluations e
            WHERE e.round_id = r.current_evaluation_round_id
          ),
          'evaluationCompletedCount', (
            SELECT count(*)
            FROM public.gq_evaluation_rounds er
            JOIN unnest(er.roster_uids) roster(uid) ON true
            WHERE er.id = r.current_evaluation_round_id
              AND (SELECT count(*) FROM public.gq_evaluations e
                WHERE e.round_id = er.id AND e.uid = roster.uid) = cardinality(er.target_revision_ids)
          )
        ),
        'events', (
          SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'id', se.id::text,
            'type', se.type,
            'createdAt', public.gq_iso(se.created_at),
            'roundId', CASE WHEN se.type IN ('ROUND_CLOSED', 'ROUND_DEADLINE_CHANGED', 'REOPEN_OPENED')
              THEN se.payload->>'roundId' END,
            'requestId', CASE WHEN se.type IN ('REOPEN_REQUESTED', 'REOPEN_OPENED', 'REOPEN_CANCELLED')
              THEN se.payload->>'requestId' END,
            'closeReason', CASE WHEN se.type = 'ROUND_CLOSED' THEN se.payload->>'closeReason' END,
            'deadlineAt', CASE WHEN se.type = 'ROUND_DEADLINE_CHANGED' THEN se.payload->>'deadlineAt' END,
            'reason', CASE WHEN se.type = 'ROUND_DEADLINE_CHANGED' THEN se.payload->>'reason' END
          )) ORDER BY se.id), '[]'::jsonb)
          FROM safe_events se
        )
      ),
      'mine', jsonb_strip_nulls(jsonb_build_object(
        'uid', p_actor_uid,
        'ideas', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'schemaVersion', 2,
            'id', i.id,
            'cycleId', i.cycle_id,
            'authorUid', i.author_uid,
            'text', i.text,
            'visibility', i.visibility,
            'submittedAt', public.gq_iso(i.submitted_at),
            'skipped', i.skipped
          ) ORDER BY i.submitted_at, i.id), '[]'::jsonb)
          FROM public.gq_ideas i
          WHERE i.cycle_id = r.current_cycle_id AND i.author_uid = p_actor_uid
        ),
        'comments', (
          SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'schemaVersion', 2,
            'id', cm.id,
            'cycleId', cm.cycle_id,
            'candidateId', cm.candidate_id,
            'candidateRevisionId', cm.candidate_revision_id,
            'authorUid', cm.author_uid,
            'body', cm.body,
            'visibility', cm.visibility,
            'publicationState', cm.publication_state,
            'createdAt', public.gq_iso(cm.created_at),
            'publishedAt', public.gq_iso(cm.published_at)
          )) ORDER BY cm.created_at, cm.id), '[]'::jsonb)
          FROM public.gq_comments cm
          WHERE cm.cycle_id = r.current_cycle_id
            AND cm.author_uid = p_actor_uid
        ),
        'evaluations', (
          SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'schemaVersion', 2,
            'roundId', e.round_id,
            'uid', e.uid,
            'candidateRevisionId', e.candidate_revision_id,
            'attitude', e.attitude,
            'score', e.score,
            'reason', e.reason,
            'submissionState', e.submission_state,
            'updatedAt', public.gq_iso(e.updated_at)
          )) ORDER BY e.updated_at, e.round_id, e.candidate_revision_id), '[]'::jsonb)
          FROM public.gq_evaluations e
          JOIN public.gq_evaluation_rounds er ON er.id = e.round_id
          WHERE er.cycle_id = r.current_cycle_id AND e.uid = p_actor_uid
        ),
        'roundCloseVote', (
          SELECT jsonb_build_object('roundId', cv.round_id, 'choice', cv.choice)
          FROM public.gq_close_votes cv
          WHERE cv.round_id = r.current_evaluation_round_id
            AND cv.uid = p_actor_uid AND cv.choice = 'END'
        ),
        'reopenVote', (
          SELECT jsonb_build_object('requestId', rv.request_id, 'choice', rv.choice)
          FROM public.gq_reopen_votes rv
          JOIN public.gq_reopen_requests rr ON rr.id = rv.request_id
          WHERE rr.cycle_id = r.current_cycle_id AND rr.status = 'OPEN'
            AND rv.uid = p_actor_uid
        ),
        'finalResponses', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'schemaVersion', 2,
            'proposalId', fr.proposal_id,
            'candidateRevisionId', fr.candidate_revision_id,
            'uid', fr.uid,
            'choice', fr.choice,
            'updatedAt', public.gq_iso(fr.updated_at)
          ) ORDER BY fr.updated_at, fr.proposal_id), '[]'::jsonb)
          FROM public.gq_final_responses fr
          JOIN public.gq_proposals p ON p.id = fr.proposal_id
          WHERE p.cycle_id = r.current_cycle_id AND fr.uid = p_actor_uid
        ),
        'activeProposal', CASE WHEN r.current_proposal_id IS NULL THEN NULL ELSE (
          SELECT jsonb_build_object(
            'schemaVersion', 2,
            'id', p.id,
            'cycleId', p.cycle_id,
            'rosterUids', to_jsonb(p.roster_uids),
            'candidateRevisionSnapshot', p.candidate_revision_snapshot,
            'decisionRevision', p.decision_revision,
            'deadlineAt', public.gq_iso(p.deadline_at),
            'status', p.status
          )
          FROM public.gq_proposals p
          WHERE p.id = r.current_proposal_id
        ) END,
        'permissions', CASE r.phase
          WHEN 'COLLECTING' THEN jsonb_build_object(
            'phase', r.phase, 'canSubmitIdea', true, 'canManageRoom', r.host_uid = p_actor_uid)
          WHEN 'CANDIDATE_REVIEW' THEN jsonb_build_object(
            'phase', r.phase, 'canEditCandidates', true, 'canOpenEvaluation', r.host_uid = p_actor_uid)
          WHEN 'EVALUATING' THEN jsonb_build_object(
            'phase', r.phase,
            'canEvaluate', EXISTS (
              SELECT 1 FROM public.gq_evaluation_rounds er
              WHERE er.id = r.current_evaluation_round_id AND er.status = 'OPEN'
                AND p_actor_uid = ANY(er.roster_uids)),
            'canVoteRoundClose', EXISTS (
              SELECT 1 FROM public.gq_evaluation_rounds er
              WHERE er.id = r.current_evaluation_round_id AND er.status = 'OPEN'
                AND er.deadline_at IS NULL AND p_actor_uid = ANY(er.roster_uids)))
          WHEN 'DISCUSSING' THEN jsonb_build_object(
            'phase', r.phase, 'canEditCandidates', true, 'canProposeFinal', r.host_uid = p_actor_uid)
          WHEN 'CONFIRMING' THEN jsonb_build_object(
            'phase', r.phase,
            'canRespondFinal', EXISTS (
              SELECT 1 FROM public.gq_proposals p
              WHERE p.id = r.current_proposal_id AND p.status = 'OPEN'
                AND p_actor_uid = ANY(p.roster_uids)),
            'canManageRoom', r.host_uid = p_actor_uid)
          WHEN 'COMPLETED' THEN jsonb_build_object(
            'phase', r.phase, 'canStartNextCycle', r.host_uid = p_actor_uid)
        END
      ))
    )
  ) INTO v_response
  FROM public.gq_rooms r
  WHERE r.id = p_room_id;

  RETURN v_response;
END;
$gq_get_snapshot$;

CREATE FUNCTION public.gq_create_candidate(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_create_candidate$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_revision numeric;
  v_candidate_id text;
  v_revision_id text;
  v_title text;
  v_body text;
  v_template_id text;
  v_payload jsonb;
  v_source_idea_ids text[];
  v_source_count integer;
  v_decision_revision integer;
  v_snapshot_version integer;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'roomId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'candidateId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'revisionId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_expected_revision := (p_payload->>'expectedDecisionRevision')::numeric;
  v_room_id := p_payload->>'roomId';
  v_candidate_id := p_payload->>'candidateId';
  v_revision_id := p_payload->>'revisionId';
  v_title := p_payload->>'title';
  v_body := p_payload->>'body';
  v_template_id := p_payload->>'templateId';
  v_payload := COALESCE(p_payload->'templatePayload', '{}'::jsonb);

  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision)
    OR v_title IS NULL OR length(btrim(v_title)) NOT BETWEEN 1 AND 80
    OR v_body IS NULL OR length(btrim(v_body)) NOT BETWEEN 1 AND 4000
    OR v_template_id IS NULL OR v_template_id NOT IN ('general', 'activity')
    OR jsonb_typeof(v_payload) <> 'object'
    OR (v_template_id = 'general' AND v_payload <> '{}'::jsonb) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  IF p_payload ? 'sourceIdeaIds' THEN
    IF jsonb_typeof(p_payload->'sourceIdeaIds') <> 'array'
      OR jsonb_array_length(p_payload->'sourceIdeaIds') > 50 THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
    END IF;
    SELECT COALESCE(array_agg(DISTINCT value ORDER BY value), ARRAY[]::text[])
    INTO v_source_idea_ids
    FROM jsonb_array_elements_text(p_payload->'sourceIdeaIds') AS t(value);
    IF cardinality(v_source_idea_ids) <> jsonb_array_length(p_payload->'sourceIdeaIds')
      OR EXISTS (
        SELECT 1 FROM unnest(v_source_idea_ids) AS source_id(value)
        WHERE length(btrim(value)) = 0 OR length(value) > 128
      ) THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
    END IF;
  ELSE
    v_source_idea_ids := ARRAY[]::text[];
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
    AND action = 'createCandidate' AND operation_id = p_payload->>'operationId';

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
  IF v_room.phase NOT IN ('CANDIDATE_REVIEW', 'DISCUSSING') THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_STATE'));
  END IF;
  IF v_expected_revision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF v_template_id <> v_room.template_id THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'TEMPLATE_MISMATCH'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.gq_candidates c WHERE c.id = v_candidate_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_ALREADY_EXISTS'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.gq_candidate_revisions cr WHERE cr.id = v_revision_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'REVISION_ALREADY_EXISTS'));
  END IF;

  SELECT count(*) INTO v_source_count
  FROM public.gq_ideas i
  WHERE i.cycle_id = v_room.current_cycle_id
    AND i.visibility = 'PUBLIC' AND NOT i.skipped
    AND i.id = ANY(v_source_idea_ids);
  IF v_source_count <> COALESCE(cardinality(v_source_idea_ids), 0) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_SOURCE_IDEA'));
  END IF;

  IF (SELECT count(*) FROM public.gq_candidates c
      WHERE c.room_id = v_room_id AND c.withdrawn_at IS NULL) >= 10 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_LIMIT'));
  END IF;

  INSERT INTO public.gq_candidates(id, room_id, current_revision_id, created_by, created_at)
  VALUES (v_candidate_id, v_room_id, v_revision_id, p_actor_uid, v_now);
  INSERT INTO public.gq_candidate_revisions(
    id, candidate_id, revision, title, body, template_id, template_payload,
    source_idea_ids, created_by, created_at
  ) VALUES (
    v_revision_id, v_candidate_id, 1, v_title, v_body, v_template_id,
    v_payload, v_source_idea_ids, p_actor_uid, v_now
  );

  UPDATE public.gq_rooms
  SET decision_revision = decision_revision + 1,
      snapshot_version = snapshot_version + 1,
      updated_at = v_now
  WHERE id = v_room_id
  RETURNING decision_revision, snapshot_version INTO v_decision_revision, v_snapshot_version;

  INSERT INTO public.gq_events(room_id, type, payload, created_at)
  VALUES (v_room_id, 'CANDIDATE_REVISION_CREATED',
    jsonb_build_object('candidateId', v_candidate_id, 'revisionId', v_revision_id,
      'revision', 1, 'substantive', true), v_now);

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied',
      'roomId', v_room_id,
      'candidateId', v_candidate_id,
      'revisionId', v_revision_id,
      'revision', 1,
      'phase', v_room.phase,
      'snapshotVersion', v_snapshot_version,
      'decisionRevision', v_decision_revision,
      'createdAt', public.gq_iso(v_now)
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'createCandidate', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_create_candidate$;

CREATE FUNCTION public.gq_withdraw_candidate(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_withdraw_candidate$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_candidate public.gq_candidates%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_revision numeric;
  v_candidate_id text;
  v_phase text;
  v_decision_revision integer;
  v_snapshot_version integer;
  v_invalidated boolean := false;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'candidateId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_expected_revision := (p_payload->>'expectedDecisionRevision')::numeric;
  v_candidate_id := p_payload->>'candidateId';
  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT c.room_id INTO v_room_id
  FROM public.gq_candidates c
  WHERE c.id = v_candidate_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_NOT_FOUND'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id FOR UPDATE;
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
    AND action = 'withdrawCandidate' AND operation_id = p_payload->>'operationId';

  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id;
  SELECT * INTO v_candidate FROM public.gq_candidates WHERE id = v_candidate_id;
  IF v_room.room_status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_ACTIVE'));
  END IF;
  IF v_room.phase = 'EVALUATING' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_LOCKED'));
  END IF;
  IF v_room.phase NOT IN ('CANDIDATE_REVIEW', 'DISCUSSING', 'CONFIRMING') THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_STATE'));
  END IF;
  IF v_expected_revision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF v_candidate.created_by <> p_actor_uid AND v_room.host_uid <> p_actor_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_ALLOWED'));
  END IF;
  IF v_candidate.withdrawn_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_WITHDRAWN'));
  END IF;

  UPDATE public.gq_candidates
  SET withdrawn_at = v_now
  WHERE id = v_candidate_id;

  WITH cancelled AS (
    UPDATE public.gq_reopen_requests
    SET status = 'CANCELLED', resolved_at = v_now
    WHERE cycle_id = v_room.current_cycle_id AND status = 'OPEN'
    RETURNING id
  )
  INSERT INTO public.gq_events(room_id, type, payload, created_at)
  SELECT v_room_id, 'REOPEN_CANCELLED', jsonb_build_object('requestId', id), v_now
  FROM cancelled;

  -- decisionRevision is room-wide: withdrawing any candidate during confirmation
  -- invalidates the frozen proposal before a later response can create agreement.
  IF v_room.current_proposal_id IS NOT NULL THEN
    UPDATE public.gq_proposals
    SET status = 'INVALIDATED', resolved_at = v_now
    WHERE id = v_room.current_proposal_id AND status = 'OPEN';
    IF FOUND THEN
      v_invalidated := true;
      INSERT INTO public.gq_events(room_id, type, payload, created_at)
      VALUES (v_room_id, 'PROPOSAL_INVALIDATED',
        jsonb_build_object('proposalId', v_room.current_proposal_id), v_now);
    END IF;
  END IF;
  v_phase := CASE WHEN v_invalidated THEN 'DISCUSSING' ELSE v_room.phase END;

  UPDATE public.gq_rooms
  SET phase = v_phase,
      decision_revision = decision_revision + 1,
      current_proposal_id = CASE WHEN v_invalidated THEN NULL ELSE current_proposal_id END,
      snapshot_version = snapshot_version + 1,
      updated_at = v_now
  WHERE id = v_room_id
  RETURNING decision_revision, snapshot_version INTO v_decision_revision, v_snapshot_version;

  INSERT INTO public.gq_events(room_id, type, payload, created_at)
  VALUES (v_room_id, 'CANDIDATE_WITHDRAWN',
    jsonb_build_object('candidateId', v_candidate_id,
      'revisionId', v_candidate.current_revision_id), v_now);

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied',
      'roomId', v_room_id,
      'candidateId', v_candidate_id,
      'revisionId', v_candidate.current_revision_id,
      'proposalInvalidated', v_invalidated,
      'phase', v_phase,
      'snapshotVersion', v_snapshot_version,
      'decisionRevision', v_decision_revision,
      'withdrawnAt', public.gq_iso(v_now)
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'withdrawCandidate', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_withdraw_candidate$;

CREATE FUNCTION public.gq_revise_candidate(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_revise_candidate$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_revision numeric;
  v_candidate_id text;
  v_revision_id text;
  v_title text;
  v_body text;
  v_template_id text;
  v_payload jsonb;
  v_source_idea_ids text[];
  v_previous public.gq_candidate_revisions%ROWTYPE;
  v_next_revision integer;
  v_substantive boolean;
  v_proposal public.gq_proposals%ROWTYPE;
  v_invalidated boolean := false;
  v_phase text;
  v_decision_revision integer;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'candidateId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'revisionId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_expected_revision := (p_payload->>'expectedDecisionRevision')::numeric;
  v_candidate_id := p_payload->>'candidateId';
  v_revision_id := p_payload->>'revisionId';
  v_title := p_payload->>'title';
  v_body := p_payload->>'body';
  v_template_id := p_payload->>'templateId';
  v_payload := COALESCE(p_payload->'templatePayload', '{}'::jsonb);

  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision)
    OR v_title IS NULL OR length(btrim(v_title)) NOT BETWEEN 1 AND 80
    OR v_body IS NULL OR length(btrim(v_body)) NOT BETWEEN 1 AND 4000
    OR v_template_id IS NULL OR v_template_id NOT IN ('general', 'activity')
    OR jsonb_typeof(v_payload) <> 'object'
    OR (v_template_id = 'general' AND v_payload <> '{}'::jsonb) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  IF p_payload ? 'sourceIdeaIds' THEN
    IF jsonb_typeof(p_payload->'sourceIdeaIds') <> 'array'
      OR jsonb_array_length(p_payload->'sourceIdeaIds') > 50 THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
    END IF;
    SELECT COALESCE(array_agg(value ORDER BY value), ARRAY[]::text[])
    INTO v_source_idea_ids
    FROM jsonb_array_elements_text(p_payload->'sourceIdeaIds') AS t(value);
    IF cardinality(v_source_idea_ids) <> jsonb_array_length(p_payload->'sourceIdeaIds') THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
    END IF;
  ELSE
    v_source_idea_ids := ARRAY[]::text[];
  END IF;

  SELECT c.room_id INTO v_room_id
  FROM public.gq_candidates c
  WHERE c.id = v_candidate_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_NOT_FOUND'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id FOR UPDATE;
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
    AND action = 'reviseCandidate' AND operation_id = p_payload->>'operationId';

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
  -- EVALUATING locks substantive candidate fields; the edit must wait for DISCUSSING.
  IF v_room.phase = 'EVALUATING' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_LOCKED'));
  END IF;
  IF v_room.phase NOT IN ('CANDIDATE_REVIEW', 'DISCUSSING', 'CONFIRMING') THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_STATE'));
  END IF;
  IF v_expected_revision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;

  SELECT cr.* INTO v_previous
  FROM public.gq_candidate_revisions cr
  JOIN public.gq_candidates c ON c.current_revision_id = cr.id
  WHERE c.id = v_candidate_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_NOT_FOUND'));
  END IF;
  IF v_previous.created_by <> p_actor_uid AND v_room.host_uid <> p_actor_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_ALLOWED'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.gq_candidate_revisions cr WHERE cr.id = v_revision_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'REVISION_ALREADY_EXISTS'));
  END IF;

  SELECT COALESCE(max(cr.revision), 0) + 1 INTO v_next_revision
  FROM public.gq_candidate_revisions cr
  WHERE cr.candidate_id = v_candidate_id;

  -- Only whitespace normalisation is not substantive; any other title/body/template change is.
  v_substantive := v_previous.template_id IS DISTINCT FROM v_template_id
    OR v_previous.template_payload IS DISTINCT FROM v_payload
    OR btrim(regexp_replace(v_previous.title, '\s+', ' ', 'g')) IS DISTINCT FROM btrim(regexp_replace(v_title, '\s+', ' ', 'g'))
    OR btrim(regexp_replace(v_previous.body, '\s+', ' ', 'g')) IS DISTINCT FROM btrim(regexp_replace(v_body, '\s+', ' ', 'g'));

  INSERT INTO public.gq_candidate_revisions(
    id, candidate_id, revision, title, body, template_id, template_payload,
    source_idea_ids, created_by, created_at
  ) VALUES (
    v_revision_id, v_candidate_id, v_next_revision, v_title, v_body, v_template_id,
    v_payload, v_source_idea_ids, p_actor_uid, v_now
  );

  UPDATE public.gq_candidates
  SET current_revision_id = v_revision_id
  WHERE id = v_candidate_id;

  WITH cancelled AS (
    UPDATE public.gq_reopen_requests
    SET status = 'CANCELLED', resolved_at = v_now
    WHERE cycle_id = v_room.current_cycle_id AND status = 'OPEN'
    RETURNING id
  )
  INSERT INTO public.gq_events(room_id, type, payload, created_at)
  SELECT v_room_id, 'REOPEN_CANCELLED', jsonb_build_object('requestId', id), v_now
  FROM cancelled;

  INSERT INTO public.gq_events(room_id, type, payload, created_at)
  VALUES (v_room_id, 'CANDIDATE_REVISION_CREATED',
    jsonb_build_object('candidateId', v_candidate_id, 'revisionId', v_revision_id,
      'revision', v_next_revision, 'substantive', v_substantive), v_now);

  IF v_substantive THEN
    IF v_room.current_proposal_id IS NOT NULL THEN
      SELECT * INTO v_proposal FROM public.gq_proposals WHERE id = v_room.current_proposal_id;
      -- A proposal for a different candidate is unaffected: candidates do not clear each other.
      IF FOUND AND v_proposal.status = 'OPEN' AND EXISTS (
        SELECT 1 FROM public.gq_candidate_revisions cr
        WHERE cr.id = v_proposal.candidate_revision_id AND cr.candidate_id = v_candidate_id
      ) THEN
        UPDATE public.gq_proposals
        SET status = 'INVALIDATED', resolved_at = v_now
        WHERE id = v_proposal.id;
        v_invalidated := true;
        INSERT INTO public.gq_events(room_id, type, payload, created_at)
        VALUES (v_room_id, 'PROPOSAL_INVALIDATED',
          jsonb_build_object('proposalId', v_proposal.id), v_now);
      END IF;
    END IF;
  END IF;

  v_phase := CASE WHEN (v_invalidated OR v_room.phase = 'CONFIRMING') THEN 'DISCUSSING' ELSE v_room.phase END;

  UPDATE public.gq_rooms
  SET phase = v_phase,
      decision_revision = decision_revision + CASE WHEN v_substantive THEN 1 ELSE 0 END,
      current_proposal_id = CASE WHEN v_invalidated THEN NULL ELSE current_proposal_id END,
      snapshot_version = snapshot_version + 1,
      updated_at = v_now
  WHERE id = v_room_id
  RETURNING decision_revision INTO v_decision_revision;

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied',
      'candidateId', v_candidate_id,
      'revisionId', v_revision_id,
      'revision', v_next_revision,
      'substantive', v_substantive,
      'proposalInvalidated', v_invalidated,
      'phase', v_phase,
      'decisionRevision', v_decision_revision,
      'updatedAt', public.gq_iso(v_now)
    )
  );

  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'reviseCandidate', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_revise_candidate$;

CREATE FUNCTION public.gq_request_reopen(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_request_reopen$
DECLARE
  v_room public.gq_rooms%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_decision numeric;
  v_expected_roster numeric;
  v_target_ids text[];
  v_roster text[];
  v_snapshot_version integer;
  v_threshold integer;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'roomId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'requestId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'roundId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'expectedRosterRevision') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_payload->'targetRevisionIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_payload->'targetRevisionIds') NOT BETWEEN 1 AND 10 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  v_expected_decision := (p_payload->>'expectedDecisionRevision')::numeric;
  v_expected_roster := (p_payload->>'expectedRosterRevision')::numeric;
  IF v_expected_decision <= 0 OR v_expected_decision <> trunc(v_expected_decision)
    OR v_expected_roster <= 0 OR v_expected_roster <> trunc(v_expected_roster) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT array_agg(item.value #>> '{}' ORDER BY item.ordinality)
  INTO v_target_ids
  FROM jsonb_array_elements(p_payload->'targetRevisionIds') WITH ORDINALITY AS item(value, ordinality);
  IF EXISTS (SELECT 1 FROM unnest(v_target_ids) target(id) WHERE length(btrim(target.id)) = 0)
    OR (SELECT count(*) FROM unnest(v_target_ids)) <> (SELECT count(DISTINCT id) FROM unnest(v_target_ids) target(id)) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = p_payload->>'roomId' FOR UPDATE;
  v_now := clock_timestamp();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_FOUND'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.gq_members m
    WHERE m.room_id = v_room.id AND m.uid = p_actor_uid AND m.status = 'JOINED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_MEMBER'));
  END IF;

  PERFORM public.gq_settle_room(v_room.id, v_now);
  v_request_hash := md5(concat_ws(chr(31), p_actor_uid, p_payload::text));
  SELECT request_hash, response INTO v_existing_hash, v_existing_response
  FROM public.gq_operations
  WHERE actor_uid = p_actor_uid AND room_id = v_room.id
    AND action = 'requestReopen' AND operation_id = p_payload->>'operationId';
  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room.id;
  IF v_room.room_status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROOM_NOT_ACTIVE'));
  END IF;
  IF v_room.phase <> 'DISCUSSING' OR v_room.current_evaluation_round_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_PHASE'));
  END IF;
  IF v_expected_decision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF v_expected_roster <> v_room.roster_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROSTER_VERSION_CONFLICT'));
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.gq_reopen_requests rr
    WHERE rr.cycle_id = v_room.current_cycle_id AND rr.status = 'OPEN'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'REOPEN_ALREADY_OPEN'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.gq_reopen_requests rr WHERE rr.id = p_payload->>'requestId') THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'REQUEST_ALREADY_EXISTS'));
  END IF;
  IF EXISTS (SELECT 1 FROM public.gq_evaluation_rounds er WHERE er.id = p_payload->>'roundId')
    OR EXISTS (SELECT 1 FROM public.gq_reopen_requests rr WHERE rr.round_id = p_payload->>'roundId') THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROUND_ALREADY_EXISTS'));
  END IF;

  SELECT array_agg(m.uid ORDER BY m.joined_at, m.uid) INTO v_roster
  FROM public.gq_members m
  WHERE m.room_id = v_room.id AND m.status = 'JOINED';
  IF cardinality(v_roster) NOT BETWEEN 2 AND 6 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROSTER_INVALID'));
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_target_ids) target(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.gq_candidates c
      JOIN public.gq_candidate_revisions cr ON cr.id = c.current_revision_id
      WHERE c.room_id = v_room.id AND c.withdrawn_at IS NULL AND cr.id = target.id
    )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_REVISION_MISMATCH'));
  END IF;

  INSERT INTO public.gq_reopen_requests(
    id, cycle_id, roster_uids, roster_revision, target_revision_ids,
    requested_by, round_id, status, created_at
  ) VALUES (
    p_payload->>'requestId', v_room.current_cycle_id, v_roster, v_room.roster_revision,
    v_target_ids, p_actor_uid, p_payload->>'roundId', 'OPEN', v_now
  );
  INSERT INTO public.gq_reopen_votes(request_id, uid, choice, updated_at)
  VALUES (p_payload->>'requestId', p_actor_uid, 'REOPEN', v_now);

  v_threshold := floor(cardinality(v_roster) / 2.0) + 1;
  UPDATE public.gq_rooms
  SET snapshot_version = snapshot_version + 1, updated_at = v_now
  WHERE id = v_room.id
  RETURNING snapshot_version INTO v_snapshot_version;
  INSERT INTO public.gq_events(room_id, type, payload, created_at)
  VALUES (v_room.id, 'REOPEN_REQUESTED', jsonb_build_object(
    'requestId', p_payload->>'requestId', 'targetRevisionIds', to_jsonb(v_target_ids)), v_now);

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied', 'roomId', v_room.id, 'requestId', p_payload->>'requestId',
      'roundId', p_payload->>'roundId', 'phase', 'DISCUSSING', 'requestStatus', 'OPEN',
      'reopenVoteCount', 1, 'majorityThreshold', v_threshold,
      'snapshotVersion', v_snapshot_version, 'createdAt', public.gq_iso(v_now)
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room.id, 'requestReopen', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_request_reopen$;

CREATE FUNCTION public.gq_vote_reopen(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_vote_reopen$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_request public.gq_reopen_requests%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_decision numeric;
  v_choice text;
  v_roster text[];
  v_vote_count integer;
  v_threshold integer;
  v_snapshot_version integer;
  v_request_status text := 'OPEN';
  v_phase text := 'DISCUSSING';
  v_opened_round_id text;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'requestId', ''))) = 0
    OR p_payload->>'choice' NOT IN ('REOPEN', 'KEEP_DISCUSSING')
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;
  v_expected_decision := (p_payload->>'expectedDecisionRevision')::numeric;
  v_choice := p_payload->>'choice';
  IF v_expected_decision <= 0 OR v_expected_decision <> trunc(v_expected_decision) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT c.room_id INTO v_room_id
  FROM public.gq_reopen_requests rr
  JOIN public.gq_cycles c ON c.id = rr.cycle_id
  WHERE rr.id = p_payload->>'requestId';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'REOPEN_NOT_FOUND'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id FOR UPDATE;
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
    AND action = 'voteReopen' AND operation_id = p_payload->>'operationId';
  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id;
  SELECT * INTO v_request FROM public.gq_reopen_requests WHERE id = p_payload->>'requestId';
  IF v_room.room_status <> 'ACTIVE' OR v_room.phase <> 'DISCUSSING'
    OR v_room.current_evaluation_round_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_PHASE'));
  END IF;
  IF v_request.status <> 'OPEN' OR v_request.cycle_id <> v_room.current_cycle_id THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'REOPEN_CLOSED'));
  END IF;
  IF v_expected_decision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;

  SELECT array_agg(m.uid ORDER BY m.joined_at, m.uid) INTO v_roster
  FROM public.gq_members m
  WHERE m.room_id = v_room_id AND m.status = 'JOINED';
  IF v_request.roster_revision <> v_room.roster_revision
    OR v_request.roster_uids IS DISTINCT FROM v_roster THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ROSTER_CHANGED'));
  END IF;
  IF p_actor_uid <> ALL(v_request.roster_uids) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_IN_ROSTER'));
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_request.target_revision_ids) target(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.gq_candidates c
      JOIN public.gq_candidate_revisions cr ON cr.id = c.current_revision_id
      WHERE c.room_id = v_room_id AND c.withdrawn_at IS NULL AND cr.id = target.id
    )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'CANDIDATE_REVISION_MISMATCH'));
  END IF;

  INSERT INTO public.gq_reopen_votes(request_id, uid, choice, updated_at)
  VALUES (v_request.id, p_actor_uid, v_choice, v_now)
  ON CONFLICT (request_id, uid) DO UPDATE
  SET choice = EXCLUDED.choice, updated_at = EXCLUDED.updated_at;

  SELECT count(*) INTO v_vote_count
  FROM public.gq_reopen_votes rv
  WHERE rv.request_id = v_request.id AND rv.choice = 'REOPEN' AND rv.uid = ANY(v_request.roster_uids);
  v_threshold := floor(cardinality(v_request.roster_uids) / 2.0) + 1;

  IF v_vote_count >= v_threshold THEN
    v_request_status := 'APPROVED';
    v_phase := 'EVALUATING';
    v_opened_round_id := v_request.round_id;
    UPDATE public.gq_reopen_requests
    SET status = 'APPROVED', resolved_at = v_now
    WHERE id = v_request.id;
    INSERT INTO public.gq_evaluation_rounds(
      id, cycle_id, roster_uids, roster_revision, target_revision_ids, status, opened_at
    ) VALUES (
      v_request.round_id, v_request.cycle_id, v_request.roster_uids,
      v_request.roster_revision, v_request.target_revision_ids, 'OPEN', v_now
    );
    UPDATE public.gq_rooms
    SET phase = 'EVALUATING', current_evaluation_round_id = v_request.round_id,
        snapshot_version = snapshot_version + 1, updated_at = v_now
    WHERE id = v_room_id
    RETURNING snapshot_version INTO v_snapshot_version;
    INSERT INTO public.gq_events(room_id, type, payload, created_at)
    VALUES (v_room_id, 'REOPEN_OPENED', jsonb_build_object(
      'requestId', v_request.id, 'roundId', v_request.round_id), v_now);
  ELSE
    UPDATE public.gq_rooms
    SET snapshot_version = snapshot_version + 1, updated_at = v_now
    WHERE id = v_room_id
    RETURNING snapshot_version INTO v_snapshot_version;
  END IF;

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_strip_nulls(jsonb_build_object(
      'status', 'applied', 'roomId', v_room_id, 'requestId', v_request.id, 'choice', v_choice,
      'requestStatus', v_request_status, 'phase', v_phase, 'roundId', v_opened_round_id,
      'reopenVoteCount', v_vote_count, 'majorityThreshold', v_threshold,
      'snapshotVersion', v_snapshot_version, 'updatedAt', public.gq_iso(v_now)
    ))
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'voteReopen', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_vote_reopen$;

CREATE FUNCTION public.gq_cancel_reopen(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_cancel_reopen$
DECLARE
  v_room_id text;
  v_room public.gq_rooms%ROWTYPE;
  v_request public.gq_reopen_requests%ROWTYPE;
  v_now timestamptz;
  v_request_hash text;
  v_existing_hash text;
  v_existing_response jsonb;
  v_response jsonb;
  v_expected_decision numeric;
  v_snapshot_version integer;
BEGIN
  IF length(btrim(p_actor_uid)) = 0
    OR p_payload->>'schemaVersion' IS DISTINCT FROM '2'
    OR length(btrim(COALESCE(p_payload->>'operationId', ''))) = 0
    OR length(btrim(COALESCE(p_payload->>'requestId', ''))) = 0
    OR jsonb_typeof(p_payload->'expectedDecisionRevision') IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;
  v_expected_decision := (p_payload->>'expectedDecisionRevision')::numeric;
  IF v_expected_decision <= 0 OR v_expected_decision <> trunc(v_expected_decision) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_COMMAND'));
  END IF;

  SELECT c.room_id INTO v_room_id
  FROM public.gq_reopen_requests rr
  JOIN public.gq_cycles c ON c.id = rr.cycle_id
  WHERE rr.id = p_payload->>'requestId';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'REOPEN_NOT_FOUND'));
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id FOR UPDATE;
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
    AND action = 'cancelReopen' AND operation_id = p_payload->>'operationId';
  IF FOUND THEN
    IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'IDEMPOTENCY_CONFLICT'));
    END IF;
    RETURN v_existing_response;
  END IF;

  SELECT * INTO v_room FROM public.gq_rooms WHERE id = v_room_id;
  SELECT * INTO v_request FROM public.gq_reopen_requests WHERE id = p_payload->>'requestId';
  IF v_room.room_status <> 'ACTIVE' OR v_room.phase <> 'DISCUSSING' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_PHASE'));
  END IF;
  IF v_request.status <> 'OPEN' OR v_request.cycle_id <> v_room.current_cycle_id THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'REOPEN_CLOSED'));
  END IF;
  IF v_request.requested_by <> p_actor_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_REQUESTER'));
  END IF;
  IF v_expected_decision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;

  UPDATE public.gq_reopen_requests
  SET status = 'CANCELLED', resolved_at = v_now
  WHERE id = v_request.id;
  UPDATE public.gq_rooms
  SET snapshot_version = snapshot_version + 1, updated_at = v_now
  WHERE id = v_room_id
  RETURNING snapshot_version INTO v_snapshot_version;
  INSERT INTO public.gq_events(room_id, type, payload, created_at)
  VALUES (v_room_id, 'REOPEN_CANCELLED', jsonb_build_object('requestId', v_request.id), v_now);

  v_response := jsonb_build_object(
    'ok', true,
    'value', jsonb_build_object(
      'status', 'applied', 'roomId', v_room_id, 'requestId', v_request.id,
      'requestStatus', 'CANCELLED', 'phase', 'DISCUSSING',
      'snapshotVersion', v_snapshot_version, 'updatedAt', public.gq_iso(v_now)
    )
  );
  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'cancelReopen', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_cancel_reopen$;

CREATE FUNCTION public.gq_change_roster(p_actor_uid text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STRICT
AS $gq_change_roster$
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
  v_target_uid text;
  v_target public.gq_members%ROWTYPE;
  v_new_status text;
  v_phase text;
  v_decision_revision integer;
  v_has_public_candidate boolean;
  v_cancelled_round text;
  v_invalidated_proposal text;
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
  v_action := p_payload->>'action';
  v_target_uid := p_payload->>'targetUid';
  v_room_id := p_payload->>'roomId';

  IF v_expected_revision <= 0 OR v_expected_revision <> trunc(v_expected_revision)
    OR v_action IS NULL OR v_action NOT IN ('REMOVE', 'LEAVE') THEN
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
    AND action = 'changeRoster' AND operation_id = p_payload->>'operationId';

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
  IF v_expected_revision <> v_room.decision_revision THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'VERSION_CONFLICT'));
  END IF;
  IF v_action = 'REMOVE' THEN
    IF v_room.host_uid <> p_actor_uid THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_HOST'));
    END IF;
    v_new_status := 'REMOVED';
  ELSE
    IF v_target_uid <> p_actor_uid THEN
      RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN'));
    END IF;
    v_new_status := 'LEFT';
  END IF;
  -- The host must transfer ownership or close the room instead of dropping the only host.
  IF v_room.host_uid = v_target_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'HOST_MUST_TRANSFER'));
  END IF;

  SELECT * INTO v_target
  FROM public.gq_members
  WHERE room_id = v_room_id AND uid = v_target_uid
  FOR UPDATE;
  IF NOT FOUND OR v_target.status <> 'JOINED' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'MEMBER_NOT_FOUND'));
  END IF;

  UPDATE public.gq_members
  SET status = v_new_status, roster_revision = v_room.roster_revision + 1
  WHERE room_id = v_room_id AND uid = v_target_uid;

  -- An open round on a changed roster is cancelled, never revealed.
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

  SELECT EXISTS (
    SELECT 1 FROM public.gq_candidates c
    WHERE c.room_id = v_room_id AND c.withdrawn_at IS NULL
  ) INTO v_has_public_candidate;

  v_phase := CASE
    WHEN v_room.phase = 'COMPLETED' THEN 'COMPLETED'
    WHEN v_has_public_candidate THEN 'CANDIDATE_REVIEW'
    ELSE 'COLLECTING'
  END;

  UPDATE public.gq_rooms
  SET phase = v_phase,
      roster_revision = roster_revision + 1,
      decision_revision = decision_revision + 1,
      current_evaluation_round_id = NULL,
      current_proposal_id = NULL,
      snapshot_version = snapshot_version + 1,
      updated_at = v_now
  WHERE id = v_room_id
  RETURNING decision_revision INTO v_decision_revision;

  INSERT INTO public.gq_events(room_id, type, payload, created_at)
  VALUES (v_room_id, 'MEMBER_CHANGED',
    jsonb_build_object('uid', v_target_uid, 'action', v_action, 'status', v_new_status,
      'rosterRevision', v_room.roster_revision + 1), v_now);

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
      'uid', v_target_uid,
      'action', v_action,
      'memberStatus', v_new_status,
      'phase', v_phase,
      'decisionRevision', v_decision_revision,
      'rosterRevision', v_room.roster_revision + 1,
      'cancelledRoundId', v_cancelled_round,
      'invalidatedProposalId', v_invalidated_proposal,
      'updatedAt', public.gq_iso(v_now)
    ))
  );

  INSERT INTO public.gq_operations(
    actor_uid, room_id, action, operation_id, request_hash, response, created_at
  ) VALUES (
    p_actor_uid, v_room_id, 'changeRoster', p_payload->>'operationId',
    v_request_hash, v_response, v_now
  );
  RETURN v_response;
END;
$gq_change_roster$;

DO $gq_acl$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'gq_rooms', 'gq_members', 'gq_cycles', 'gq_ideas', 'gq_candidates',
    'gq_candidate_revisions', 'gq_evaluation_rounds', 'gq_evaluations',
    'gq_close_votes', 'gq_reopen_requests', 'gq_reopen_votes', 'gq_comments',
    'gq_proposals', 'gq_final_responses', 'gq_decision_records', 'gq_operations',
    'gq_events', 'gq_invites'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', v_table);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', v_table);
  END LOOP;
END;
$gq_acl$;

GRANT USAGE, SELECT ON SEQUENCE public.gq_events_id_seq TO service_role;

REVOKE ALL ON FUNCTION public.gq_iso(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_prevent_immutable_mutation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_close_round(text, text, timestamptz, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_settle_room(text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_create_room(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_rotate_invite(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_join_room(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_submit_idea(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_submit_idea_skip(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_close_collection(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_create_candidate(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_withdraw_candidate(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_open_evaluation(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_submit_evaluation(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_close_evaluation(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_vote_round_close(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_retract_round_close_vote(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_set_round_deadline(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_propose_final(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_respond_final(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_close_unresolved(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_add_comment(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_get_snapshot(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_revise_candidate(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_request_reopen(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_vote_reopen(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_cancel_reopen(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.gq_change_roster(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gq_create_room(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_rotate_invite(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_join_room(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_submit_idea(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_submit_idea_skip(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_close_collection(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_create_candidate(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_withdraw_candidate(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_open_evaluation(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_submit_evaluation(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_close_evaluation(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_vote_round_close(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_retract_round_close_vote(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_set_round_deadline(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_propose_final(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_respond_final(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_close_unresolved(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_add_comment(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_get_snapshot(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_revise_candidate(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_request_reopen(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_vote_reopen(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_cancel_reopen(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.gq_change_roster(text, jsonb) TO service_role;

COMMIT;

-- Reviewed rollback plan (manual, only for an environment where this migration has been applied):
-- 1. Stop gateway writers and confirm no dependent later migration exists.
-- 2. DROP FUNCTION public.gq_withdraw_candidate(text, jsonb);
-- 3. DROP FUNCTION public.gq_create_candidate(text, jsonb);
-- 4. DROP FUNCTION public.gq_close_collection(text, jsonb);
-- 5. DROP FUNCTION public.gq_submit_idea_skip(text, jsonb);
-- 6. DROP FUNCTION public.gq_submit_idea(text, jsonb);
-- 7. DROP FUNCTION public.gq_join_room(text, jsonb);
-- 8. DROP FUNCTION public.gq_rotate_invite(text, jsonb);
-- 9. DROP FUNCTION public.gq_create_room(text, jsonb);
-- 10. DROP FUNCTION public.gq_change_roster(text, jsonb);
-- 11. DROP FUNCTION public.gq_cancel_reopen(text, jsonb);
-- 12. DROP FUNCTION public.gq_vote_reopen(text, jsonb);
-- 13. DROP FUNCTION public.gq_request_reopen(text, jsonb);
-- 14. DROP FUNCTION public.gq_revise_candidate(text, jsonb);
-- 15. DROP FUNCTION public.gq_get_snapshot(text, text);
-- 16. DROP FUNCTION public.gq_add_comment(text, jsonb);
-- 17. DROP FUNCTION public.gq_set_round_deadline(text, jsonb);
-- 18. DROP FUNCTION public.gq_retract_round_close_vote(text, jsonb);
-- 19. DROP FUNCTION public.gq_vote_round_close(text, jsonb);
-- 20. DROP FUNCTION public.gq_close_unresolved(text, jsonb);
-- 21. DROP FUNCTION public.gq_respond_final(text, jsonb);
-- 22. DROP FUNCTION public.gq_propose_final(text, jsonb);
-- 23. DROP FUNCTION public.gq_close_evaluation(text, jsonb);
-- 24. DROP FUNCTION public.gq_submit_evaluation(text, jsonb);
-- 25. DROP FUNCTION public.gq_open_evaluation(text, jsonb);
-- 26. DROP FUNCTION public.gq_settle_room(text, timestamptz);
-- 27. DROP FUNCTION public.gq_close_round(text, text, timestamptz, text);
-- 28. DROP FUNCTION public.gq_iso(timestamptz);
-- 29. DROP FUNCTION public.gq_prevent_immutable_mutation();
-- 30. DROP TABLE public.gq_invites, public.gq_events, public.gq_operations,
--    public.gq_decision_records, public.gq_final_responses, public.gq_proposals,
--    public.gq_comments, public.gq_reopen_votes, public.gq_reopen_requests,
--    public.gq_close_votes, public.gq_evaluations, public.gq_evaluation_rounds,
--    public.gq_candidate_revisions, public.gq_candidates, public.gq_ideas,
--    public.gq_cycles, public.gq_members, public.gq_rooms;
-- 26. Re-read migration history and object inventory. Never drop or alter either M0 probe object.
