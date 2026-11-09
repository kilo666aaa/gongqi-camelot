import { describe, expect, it } from 'vitest';
import {
  activityTemplatePayloadSchema,
  addCommentCommandSchema,
  addCommentResultSchema,
  archiveRoomCommandSchema,
  cancelReopenCommandSchema,
  candidateRevisionForCandidateSchema,
  candidateRevisionSchema,
  candidateSchema,
  changeRosterCommandSchema,
  changeRosterResultSchema,
  closeCollectionCommandSchema,
  closeEvaluationCommandSchema,
  closeRoomCommandSchema,
  closeUnresolvedCommandSchema,
  closeUnresolvedResultSchema,
  commentSchema,
  confirmationProposalSchema,
  createCandidateCommandSchema,
  createRoomCommandSchema,
  decisionRecordSchema,
  deleteRoomCommandSchema,
  evaluationForRoundSchema,
  evaluationRoundSchema,
  evaluationSchema,
  finalResponseForProposalSchema,
  finalResponseSchema,
  generalTemplatePayloadSchema,
  ideaSchema,
  joinRoomCommandSchema,
  openEvaluationCommandSchema,
  proposeFinalCommandSchema,
  proposeFinalResultSchema,
  requestReopenCommandSchema,
  respondFinalCommandSchema,
  respondFinalResultSchema,
  retractRoundCloseVoteCommandSchema,
  reviseCandidateCommandSchema,
  roomMemberForRoomSchema,
  roomLifecycleResultSchema,
  roomMemberSchema,
  roomSchema,
  roomSnapshotForMemberSchema,
  roomSnapshotSchema,
  rosterUidsSchema,
  rotateInviteCommandSchema,
  suggestCandidatesInputSchema,
  suggestCandidatesResultSchema,
  setRoundDeadlineCommandSchema,
  startNextCycleCommandSchema,
  startNextCycleResultSchema,
  submitEvaluationCommandSchema,
  submitIdeaCommandSchema,
  submitIdeaSkipCommandSchema,
  transferHostCommandSchema,
  transferHostResultSchema,
  voteReopenCommandSchema,
  voteRoundCloseCommandSchema,
  withdrawCandidateCommandSchema,
} from '@gongqi/contracts/v2';

const now = '2026-11-03T06:00:00Z';
const later = '2026-11-04T06:00:00Z';
const room = {
  schemaVersion: 2,
  id: 'room-1',
  title: '选择团队方案',
  purpose: '形成明确决定',
  templateId: 'general',
  phase: 'COLLECTING',
  roomStatus: 'ACTIVE',
  hostUid: 'alice',
  snapshotVersion: 1,
  decisionRevision: 1,
  rosterRevision: 1,
  currentCycleId: 'cycle-1',
};
const member = {
  schemaVersion: 2,
  roomId: room.id,
  uid: 'alice',
  role: 'HOST',
  status: 'JOINED',
  joinedAt: now,
  rosterRevision: 1,
};
const idea = {
  schemaVersion: 2,
  id: 'idea-1',
  cycleId: 'cycle-1',
  authorUid: 'alice',
  text: '原始观点',
  visibility: 'PUBLIC',
  submittedAt: now,
  skipped: false,
};
const comment = {
  schemaVersion: 2,
  id: 'comment-1',
  cycleId: 'cycle-1',
  candidateId: 'candidate-1',
  candidateRevisionId: 'revision-1',
  authorUid: 'alice',
  body: '讨论草稿',
  visibility: 'PRIVATE',
  publicationState: 'DRAFT',
  createdAt: now,
};
const generalRevision = {
  schemaVersion: 2,
  id: 'revision-1',
  candidateId: 'candidate-1',
  revision: 1,
  title: '方案 A',
  body: '不依赖活动字段的完整方案内容',
  templateId: 'general',
  templatePayload: {},
  sourceIdeaIds: [idea.id],
  createdBy: 'alice',
  createdAt: now,
};
const candidate = {
  schemaVersion: 2,
  id: 'candidate-1',
  roomId: room.id,
  currentRevisionId: generalRevision.id,
  withdrawnAt: null,
  createdBy: 'alice',
};
const round = {
  schemaVersion: 2,
  id: 'round-1',
  cycleId: 'cycle-1',
  rosterUids: ['alice', 'bob'],
  rosterRevision: 1,
  targetRevisionIds: [generalRevision.id],
  status: 'OPEN',
  openedAt: now,
};
const evaluation = {
  schemaVersion: 2,
  roundId: round.id,
  uid: 'alice',
  candidateRevisionId: generalRevision.id,
  attitude: 'SUPPORT',
  score: null,
  reason: '可选理由',
  submissionState: 'EVALUATED',
  updatedAt: now,
};
const proposal = {
  schemaVersion: 2,
  id: 'proposal-1',
  cycleId: 'cycle-1',
  rosterUids: ['alice', 'bob'],
  candidateRevisionSnapshot: generalRevision,
  decisionRevision: 1,
  deadlineAt: later,
  status: 'OPEN',
};
const finalResponse = {
  schemaVersion: 2,
  proposalId: proposal.id,
  candidateRevisionId: generalRevision.id,
  uid: 'alice',
  choice: 'ACCEPT',
  updatedAt: now,
};
const snapshot = {
  schemaVersion: 2,
  version: 1,
  snapshotAt: now,
  shared: {
    roomId: room.id,
    title: room.title,
    purpose: room.purpose,
    templateId: room.templateId,
    hostUid: room.hostUid,
    currentCycleId: room.currentCycleId,
    decisionRevision: room.decisionRevision,
    rosterRevision: room.rosterRevision,
    phase: 'DISCUSSING',
    roomStatus: 'ACTIVE',
    memberUids: ['alice', 'bob'],
    candidates: [candidate],
    currentRevisions: [generalRevision],
    publicIdeas: [idea],
    comments: [],
    revealedEvaluationRoundIds: [round.id],
    revealedEvaluations: [],
    progress: { ideaSubmittedCount: 2, ideaSkippedCount: 0, evaluationSubmittedCount: 2, evaluationCompletedCount: 2 },
    events: [],
  },
  mine: {
    uid: 'alice',
    ideas: [idea],
    comments: [],
    evaluations: [evaluation],
    finalResponses: [finalResponse],
    permissions: {
      phase: 'DISCUSSING',
      canEditCandidates: true,
      canProposeFinal: true,
    },
  },
};

describe('v2 room and member contracts', () => {
  it('accepts all six business phases and rejects other schema versions', () => {
    for (const phase of ['COLLECTING', 'CANDIDATE_REVIEW', 'EVALUATING', 'DISCUSSING', 'CONFIRMING', 'COMPLETED']) {
      expect(roomSchema.safeParse({ ...room, phase }).success).toBe(true);
    }
    expect(roomSchema.safeParse({ ...room, schemaVersion: 1 }).success).toBe(false);
    expect(roomSchema.safeParse({ ...room, phase: 'OPEN' }).success).toBe(false);
  });

  it('keeps membership separate and enforces a unique 2-6 person frozen roster', () => {
    expect(roomMemberSchema.safeParse(member).success).toBe(true);
    const memberInRoom = roomMemberForRoomSchema(roomSchema.parse(room));
    expect(memberInRoom.safeParse(member).success).toBe(true);
    expect(memberInRoom.safeParse({ ...member, roomId: 'another-room' }).success).toBe(false);
    expect(rosterUidsSchema.safeParse(['alice']).success).toBe(false);
    expect(rosterUidsSchema.safeParse(['alice', 'alice']).success).toBe(false);
    expect(rosterUidsSchema.safeParse(['a', 'b', 'c', 'd', 'e', 'f', 'g']).success).toBe(false);
    expect(rosterUidsSchema.safeParse(['alice', 'bob']).success).toBe(true);
    expect(evaluationRoundSchema.safeParse({ ...round, rosterUids: ['alice'] }).success).toBe(false);
    expect(confirmationProposalSchema.safeParse({ ...proposal, rosterUids: ['alice'] }).success).toBe(false);
  });
});

describe('v2 ideas and candidate revisions', () => {
  it('accepts a general proposal without location, time or cost fields', () => {
    expect(generalTemplatePayloadSchema.safeParse({}).success).toBe(true);
    expect(candidateRevisionSchema.safeParse(generalRevision).success).toBe(true);
  });

  it('uses an explicit activity payload instead of leaking activity requirements into general', () => {
    const activityPayload = {
      budgetFen: 5000,
      time: { startAt: now, endAt: later },
      travelMinutes: 30,
      location: '活动室',
      venue: 'indoor',
      activityType: 'boardgame',
    };
    expect(activityTemplatePayloadSchema.safeParse(activityPayload).success).toBe(true);
    expect(candidateRevisionSchema.safeParse({
      ...generalRevision,
      templateId: 'activity',
      templatePayload: activityPayload,
    }).success).toBe(true);
    expect(candidateRevisionSchema.safeParse({
      ...generalRevision,
      templatePayload: { location: '不应出现在通用模板' },
    }).success).toBe(false);
  });

  it('rejects invalid activity values and inverted activity time', () => {
    expect(activityTemplatePayloadSchema.safeParse({ budgetFen: -1 }).success).toBe(false);
    expect(activityTemplatePayloadSchema.safeParse({ budgetFen: 1.5 }).success).toBe(false);
    expect(activityTemplatePayloadSchema.safeParse({ time: { startAt: later, endAt: now } }).success).toBe(false);
  });

  it('validates immutable revision numbers and unique source ideas', () => {
    expect(candidateSchema.safeParse(candidate).success).toBe(true);
    const currentRevision = candidateRevisionForCandidateSchema(candidateSchema.parse(candidate));
    expect(currentRevision.safeParse(generalRevision).success).toBe(true);
    expect(currentRevision.safeParse({ ...generalRevision, candidateId: 'another-candidate' }).success).toBe(false);
    expect(candidateRevisionSchema.safeParse({ ...generalRevision, revision: 0 }).success).toBe(false);
    expect(candidateRevisionSchema.safeParse({ ...generalRevision, sourceIdeaIds: [idea.id, idea.id] }).success).toBe(false);
    expect(ideaSchema.safeParse(idea).success).toBe(true);
  });

  it('keeps skipped ideas empty and rejects blank submitted text', () => {
    expect(ideaSchema.safeParse({ ...idea, text: '', skipped: true }).success).toBe(true);
    expect(ideaSchema.safeParse({ ...idea, text: '隐藏文本', skipped: true }).success).toBe(false);
    expect(ideaSchema.safeParse({ ...idea, text: '   ', skipped: false }).success).toBe(false);
  });
});

describe('v2 independent evaluations', () => {
  it('accepts attitude-only, score-only and explicit skipped records with distinct semantics', () => {
    expect(evaluationSchema.safeParse({ ...evaluation, score: null }).success).toBe(true);
    expect(evaluationSchema.safeParse({ ...evaluation, attitude: undefined, score: 0 }).success).toBe(false);
    expect(evaluationSchema.safeParse({ ...evaluation, attitude: undefined, score: 4 }).success).toBe(true);
    expect(evaluationSchema.safeParse({
      ...evaluation,
      attitude: undefined,
      score: undefined,
      reason: undefined,
      submissionState: 'SKIPPED',
    }).success).toBe(true);
  });

  it('rejects out-of-range scores and empty or reason-only EVALUATED records', () => {
    for (const score of [-1, 0, 6, 1.5, Number.NaN]) {
      expect(evaluationSchema.safeParse({ ...evaluation, score }).success).toBe(false);
    }
    expect(evaluationSchema.safeParse({
      ...evaluation,
      attitude: undefined,
      score: null,
      reason: undefined,
    }).success).toBe(false);
    expect(evaluationSchema.safeParse({ ...evaluation, attitude: undefined, score: null }).success).toBe(false);
  });

  it('does not allow hidden evaluation data on SKIPPED records', () => {
    for (const hidden of [{ attitude: 'NEUTRAL' }, { score: 3 }, { reason: '隐藏理由' }]) {
      expect(evaluationSchema.safeParse({
        ...evaluation,
        attitude: undefined,
        score: undefined,
        reason: undefined,
        submissionState: 'SKIPPED',
        ...hidden,
      }).success).toBe(false);
    }
  });

  it('binds an evaluation to its round and targeted candidate revision', () => {
    const scoped = evaluationForRoundSchema(evaluationRoundSchema.parse(round));
    expect(scoped.safeParse(evaluation).success).toBe(true);
    expect(scoped.safeParse({ ...evaluation, roundId: 'another-round' }).success).toBe(false);
    expect(scoped.safeParse({ ...evaluation, candidateRevisionId: 'another-revision' }).success).toBe(false);
    expect(scoped.safeParse({ ...evaluation, uid: 'outsider' }).success).toBe(false);
  });
});

describe('v2 final confirmation contracts', () => {
  it('keeps the final response separate from ordinary evaluation attitudes', () => {
    expect(confirmationProposalSchema.safeParse(proposal).success).toBe(true);
    expect(finalResponseSchema.safeParse(finalResponse).success).toBe(true);
    expect(finalResponseSchema.safeParse({ ...finalResponse, choice: 'SUPPORT' }).success).toBe(false);
  });

  it('limits final responses to the exact proposal and frozen roster', () => {
    const scoped = finalResponseForProposalSchema(confirmationProposalSchema.parse(proposal));
    expect(scoped.safeParse(finalResponse).success).toBe(true);
    expect(scoped.safeParse({ ...finalResponse, proposalId: 'another-proposal' }).success).toBe(false);
    expect(scoped.safeParse({ ...finalResponse, candidateRevisionId: 'old-revision' }).success).toBe(false);
    expect(scoped.safeParse({ ...finalResponse, candidateRevisionId: 'other-candidate-revision' }).success).toBe(false);
    expect(scoped.safeParse({ ...finalResponse, candidateRevisionId: undefined }).success).toBe(false);
    expect(scoped.safeParse({ ...finalResponse, uid: 'outsider' }).success).toBe(false);
  });

  it('rejects an AGREED record whose frozen members did not all accept', () => {
    const record = {
      schemaVersion: 2,
      id: 'decision-review',
      cycleId: 'cycle-1',
      proposalId: proposal.id,
      outcome: 'AGREED',
      candidateRevisionSnapshot: generalRevision,
      rosterSnapshot: ['alice', 'bob'],
      responseSummary: { accepted: 1, declined: 1, abstained: 0, pending: 0 },
      createdAt: now,
    };
    expect(decisionRecordSchema.safeParse(record).success).toBe(false);
    expect(decisionRecordSchema.safeParse({
      ...record,
      responseSummary: { accepted: 2, declined: 0, abstained: 0, pending: 0 },
    }).success).toBe(true);
  });
});

describe('v2 command and snapshot trust boundaries', () => {
  it('scopes room creation, invite rotation and joining to strict trusted-actor commands', () => {
    const create = {
      schemaVersion: 2,
      operationId: 'create-operation',
      templateId: 'general',
      title: '选择团队方案',
      purpose: '形成明确决定',
    };
    const inviteToken = 'invite-token-1234567890-abcdefghijklmnop';
    const rotate = {
      schemaVersion: 2,
      operationId: 'rotate-operation',
      expectedDecisionRevision: 1,
      roomId: room.id,
      inviteToken,
    };
    const join = { schemaVersion: 2, operationId: 'join-operation', inviteToken };

    expect(createRoomCommandSchema.safeParse(create).success).toBe(true);
    expect(createRoomCommandSchema.safeParse({ ...create, templateId: 'activity' }).success).toBe(true);
    expect(createRoomCommandSchema.safeParse({ ...create, title: '   ' }).success).toBe(false);
    expect(createRoomCommandSchema.safeParse({ ...create, actorUid: 'alice' }).success).toBe(false);
    expect(rotateInviteCommandSchema.safeParse(rotate).success).toBe(true);
    expect(rotateInviteCommandSchema.safeParse({ ...rotate, inviteToken: 'too-short' }).success).toBe(false);
    expect(rotateInviteCommandSchema.safeParse({ ...rotate, actorUid: 'alice' }).success).toBe(false);
    expect(joinRoomCommandSchema.safeParse(join).success).toBe(true);
    expect(joinRoomCommandSchema.safeParse({ ...join, inviteToken: 'contains spaces 1234567890' }).success).toBe(false);
    expect(joinRoomCommandSchema.safeParse({ ...join, uid: 'bob' }).success).toBe(false);
  });

  it('scopes idea submission, skipping and collection confirmation to strict trusted inputs', () => {
    const submit = {
      schemaVersion: 2,
      operationId: 'idea-operation',
      expectedDecisionRevision: 1,
      roomId: room.id,
      ideaId: idea.id,
      text: '  可核对的原始观点  ',
      visibility: 'PUBLIC',
    };
    const skip = {
      schemaVersion: 2,
      operationId: 'skip-operation',
      expectedDecisionRevision: 1,
      roomId: room.id,
      ideaId: 'skip-1',
    };
    const close = {
      schemaVersion: 2,
      operationId: 'close-collection-operation',
      expectedDecisionRevision: 1,
      roomId: room.id,
      expectedRosterRevision: 1,
      expectedUnsubmittedCount: 0,
    };
    expect(submitIdeaCommandSchema.parse(submit).text).toBe('可核对的原始观点');
    expect(submitIdeaCommandSchema.safeParse({ ...submit, text: '   ' }).success).toBe(false);
    expect(submitIdeaCommandSchema.safeParse({ ...submit, authorUid: 'bob' }).success).toBe(false);
    expect(submitIdeaSkipCommandSchema.safeParse(skip).success).toBe(true);
    expect(submitIdeaSkipCommandSchema.safeParse({ ...skip, text: '不应夹带' }).success).toBe(false);
    expect(closeCollectionCommandSchema.safeParse(close).success).toBe(true);
    expect(closeCollectionCommandSchema.safeParse({ ...close, expectedUnsubmittedCount: 7 }).success).toBe(false);
    expect(closeCollectionCommandSchema.safeParse({ ...close, expectedRosterRevision: 0 }).success).toBe(false);
    expect(closeCollectionCommandSchema.safeParse({ ...close, actorUid: 'alice' }).success).toBe(false);
  });

  it('binds evaluation opening and closing to explicit targets, roster and incomplete count', () => {
    const open = {
      schemaVersion: 2,
      operationId: 'open-evaluation-operation',
      expectedDecisionRevision: 1,
      expectedRosterRevision: 1,
      roomId: room.id,
      roundId: round.id,
      targetRevisionIds: [generalRevision.id],
    };
    const close = {
      schemaVersion: 2,
      operationId: 'close-evaluation-operation',
      expectedDecisionRevision: 1,
      roundId: round.id,
      expectedIncompleteCount: 1,
    };
    expect(openEvaluationCommandSchema.safeParse(open).success).toBe(true);
    expect(openEvaluationCommandSchema.safeParse({ ...open, targetRevisionIds: [] }).success).toBe(false);
    expect(openEvaluationCommandSchema.safeParse({ ...open, targetRevisionIds: [generalRevision.id, generalRevision.id] }).success).toBe(false);
    expect(openEvaluationCommandSchema.safeParse({ ...open, actorUid: 'alice' }).success).toBe(false);
    expect(closeEvaluationCommandSchema.safeParse(close).success).toBe(true);
    expect(closeEvaluationCommandSchema.safeParse({ ...close, expectedIncompleteCount: 7 }).success).toBe(false);
    expect(closeEvaluationCommandSchema.safeParse({ ...close, closeReason: 'TIMEOUT' }).success).toBe(false);
  });

  it('scopes round close votes, retraction and deadlines to strict trusted-actor commands', () => {
    const vote = {
      schemaVersion: 2,
      operationId: 'round-close-operation',
      expectedDecisionRevision: 1,
      roundId: round.id,
    };
    expect(voteRoundCloseCommandSchema.safeParse(vote).success).toBe(true);
    expect(voteRoundCloseCommandSchema.safeParse({ ...vote, actorUid: 'alice' }).success).toBe(false);
    expect(voteRoundCloseCommandSchema.safeParse({ ...vote, choice: 'END' }).success).toBe(false);
    expect(voteRoundCloseCommandSchema.safeParse({ ...vote, roundId: '' }).success).toBe(false);
    expect(retractRoundCloseVoteCommandSchema.safeParse({
      ...vote,
      operationId: 'round-close-retract-operation',
    }).success).toBe(true);
    expect(retractRoundCloseVoteCommandSchema.safeParse({ ...vote, uid: 'alice' }).success).toBe(false);

    const deadline = {
      ...vote,
      operationId: 'round-deadline-operation',
      deadlineAt: later,
      reason: '  需要更多时间核对候选  ',
    };
    expect(setRoundDeadlineCommandSchema.parse(deadline).reason).toBe('需要更多时间核对候选');
    expect(setRoundDeadlineCommandSchema.safeParse({ ...deadline, reason: '   ' }).success).toBe(false);
    expect(setRoundDeadlineCommandSchema.safeParse({ ...deadline, reason: 'x'.repeat(501) }).success).toBe(false);
    expect(setRoundDeadlineCommandSchema.safeParse({ ...deadline, deadlineAt: 'not-a-date' }).success).toBe(false);
    expect(setRoundDeadlineCommandSchema.safeParse({ ...deadline, actorUid: 'alice' }).success).toBe(false);
  });

  it('validates explicit comment drafts and publication without trusted actor fields', () => {
    const command = {
      schemaVersion: 2,
      operationId: 'comment-operation',
      expectedDecisionRevision: 1,
      roomId: room.id,
      commentId: comment.id,
      candidateId: candidate.id,
      candidateRevisionId: generalRevision.id,
      body: '  先保存本人草稿  ',
      visibility: 'PRIVATE',
      publicationState: 'DRAFT',
    };
    expect(addCommentCommandSchema.parse(command).body).toBe('先保存本人草稿');
    expect(addCommentCommandSchema.safeParse({ ...command, actorUid: 'alice' }).success).toBe(false);
    expect(addCommentCommandSchema.safeParse({ ...command, candidateId: undefined }).success).toBe(false);
    expect(addCommentCommandSchema.safeParse({ ...command, body: '   ' }).success).toBe(false);
    expect(addCommentCommandSchema.safeParse({ ...command, publicationState: 'AUTO_PUBLISH' }).success).toBe(false);
    expect(commentSchema.safeParse(comment).success).toBe(true);
    expect(commentSchema.safeParse({ ...comment, publishedAt: now }).success).toBe(false);
    expect(commentSchema.safeParse({ ...comment, publicationState: 'PUBLISHED' }).success).toBe(false);
    expect(commentSchema.safeParse({ ...comment, privateDatabaseField: true }).success).toBe(false);
    expect(addCommentResultSchema.safeParse({
      status: 'applied', roomId: room.id, commentId: comment.id, publicationState: 'DRAFT',
      snapshotVersion: 2, decisionRevision: 1, createdAt: now, updatedAt: now,
    }).success).toBe(true);
    expect(addCommentResultSchema.safeParse({
      status: 'applied', roomId: room.id, commentId: comment.id, publicationState: 'PUBLISHED',
      snapshotVersion: 2, decisionRevision: 1, createdAt: now, updatedAt: now,
    }).success).toBe(true);
  });

  it('does not accept a client-supplied actor UID in write commands', () => {
    const command = {
      schemaVersion: 2,
      operationId: 'operation-1',
      expectedDecisionRevision: 1,
      roundId: round.id,
      candidateRevisionId: generalRevision.id,
      submissionState: 'EVALUATED',
      attitude: 'SUPPORT',
      score: null,
    };
    expect(submitEvaluationCommandSchema.safeParse(command).success).toBe(true);
    expect(submitEvaluationCommandSchema.safeParse({ ...command, uid: 'bob' }).success).toBe(false);
    expect(respondFinalCommandSchema.safeParse({
      schemaVersion: 2,
      operationId: 'operation-2',
      expectedDecisionRevision: 1,
      proposalId: proposal.id,
      candidateRevisionId: generalRevision.id,
      choice: 'ACCEPT',
      uid: 'bob',
    }).success).toBe(false);
  });

  it('scopes candidate creation and withdrawal to strict trusted-actor commands', () => {
    const create = {
      schemaVersion: 2,
      operationId: 'candidate-create-operation',
      expectedDecisionRevision: 1,
      roomId: room.id,
      candidateId: 'candidate-new',
      revisionId: 'revision-new',
      title: '  新候选标题  ',
      body: '新候选内容',
      templateId: 'general',
      templatePayload: {},
      sourceIdeaIds: [idea.id],
    };
    expect(createCandidateCommandSchema.parse(create)).toMatchObject({
      title: '新候选标题',
      sourceIdeaIds: [idea.id],
    });
    expect(createCandidateCommandSchema.parse({ ...create, sourceIdeaIds: undefined }).sourceIdeaIds).toEqual([]);
    expect(createCandidateCommandSchema.safeParse({ ...create, actorUid: 'alice' }).success).toBe(false);
    expect(createCandidateCommandSchema.safeParse({ ...create, sourceIdeaIds: [idea.id, idea.id] }).success).toBe(false);
    expect(createCandidateCommandSchema.safeParse({ ...create, templatePayload: { location: '非法通用字段' } }).success).toBe(false);
    expect(createCandidateCommandSchema.safeParse({
      ...create,
      templateId: 'activity',
      templatePayload: { budgetFen: 100, location: '活动室' },
    }).success).toBe(true);

    const withdraw = {
      schemaVersion: 2,
      operationId: 'candidate-withdraw-operation',
      expectedDecisionRevision: 1,
      candidateId: candidate.id,
    };
    expect(withdrawCandidateCommandSchema.safeParse(withdraw).success).toBe(true);
    expect(withdrawCandidateCommandSchema.safeParse({ ...withdraw, actorUid: 'alice' }).success).toBe(false);
    expect(withdrawCandidateCommandSchema.safeParse({ ...withdraw, revisionId: '不可变版本不应夹带' }).success).toBe(false);
  });

  it('scopes the candidate-revision and roster commands to trusted inputs', () => {
    const revise = {
      schemaVersion: 2,
      operationId: 'operation-4',
      expectedDecisionRevision: 1,
      candidateId: candidate.id,
      revisionId: 'revision-2',
      title: '修订后的方案标题',
      body: '修订后的方案内容',
      templateId: 'general',
      templatePayload: {},
    };
    expect(reviseCandidateCommandSchema.safeParse(revise).success).toBe(true);
    expect(reviseCandidateCommandSchema.safeParse({ ...revise, uid: 'bob' }).success).toBe(false);
    expect(reviseCandidateCommandSchema.safeParse({ ...revise, revisionId: '' }).success).toBe(false);
    expect(reviseCandidateCommandSchema.safeParse({ ...revise, sourceIdeaIds: [idea.id, idea.id] }).success).toBe(false);
    expect(reviseCandidateCommandSchema.safeParse({ ...revise, templatePayload: { location: '不应出现在通用模板' } }).success).toBe(false);
    expect(reviseCandidateCommandSchema.safeParse({ ...revise, title: '   ' }).success).toBe(false);
    expect(reviseCandidateCommandSchema.safeParse({
      ...revise,
      templateId: 'activity',
      templatePayload: { budgetFen: 100, location: '活动室' },
    }).success).toBe(true);

    const roster = {
      schemaVersion: 2,
      operationId: 'operation-5',
      expectedDecisionRevision: 1,
      roomId: room.id,
      targetUid: 'bob',
      action: 'REMOVE',
    };
    expect(changeRosterCommandSchema.safeParse(roster).success).toBe(true);
    expect(changeRosterCommandSchema.safeParse({ ...roster, action: 'KICK' }).success).toBe(false);
    expect(changeRosterCommandSchema.safeParse({ ...roster, actorUid: 'bob' }).success).toBe(false);
    expect(changeRosterCommandSchema.safeParse({ ...roster, targetUid: '' }).success).toBe(false);

    const removed = {
      status: 'applied',
      roomId: room.id,
      uid: 'bob',
      action: 'REMOVE',
      memberStatus: 'REMOVED',
      phase: 'CANDIDATE_REVIEW',
      decisionRevision: 2,
      rosterRevision: 2,
      updatedAt: '2026-11-07T10:00:00Z',
    };
    expect(changeRosterResultSchema.safeParse(removed).success).toBe(true);
    expect(changeRosterResultSchema.safeParse({
      ...removed,
      cancelledRoundId: 'round-1',
      invalidatedProposalId: 'proposal-1',
    }).success).toBe(true);
    expect(changeRosterResultSchema.safeParse({ ...removed, memberStatus: 'JOINED' }).success).toBe(false);
    expect(changeRosterResultSchema.safeParse({ ...removed, targetUid: 'bob' }).success).toBe(false);
  });

  it('keeps archive, close and delete as separate host-only lifecycle commands', () => {
    const lifecycle = {
      schemaVersion: 2,
      operationId: 'lifecycle-operation-1',
      expectedDecisionRevision: 1,
      roomId: room.id,
    };
    for (const schema of [archiveRoomCommandSchema, closeRoomCommandSchema, deleteRoomCommandSchema]) {
      expect(schema.safeParse(lifecycle).success).toBe(true);
      expect(schema.safeParse({ ...lifecycle, actorUid: 'alice' }).success).toBe(false);
      expect(schema.safeParse({ ...lifecycle, expectedDecisionRevision: 0 }).success).toBe(false);
      expect(schema.safeParse({ ...lifecycle, roomId: '' }).success).toBe(false);
    }

    const closed = {
      status: 'applied',
      roomId: room.id,
      action: 'CLOSE',
      roomStatus: 'CLOSED',
      phase: 'COLLECTING',
      decisionRevision: 2,
      rosterRevision: 2,
      snapshotVersion: 3,
      revokedMemberCount: 1,
      updatedAt: '2026-11-07T10:00:00Z',
    };
    expect(roomLifecycleResultSchema.safeParse(closed).success).toBe(true);
    expect(roomLifecycleResultSchema.safeParse({ ...closed, action: 'ARCHIVE' }).success).toBe(true);
    expect(roomLifecycleResultSchema.safeParse({ ...closed, roomStatus: 'ACTIVE' }).success).toBe(false);
    expect(roomLifecycleResultSchema.safeParse({ ...closed, revokedMemberCount: 6 }).success).toBe(false);
    expect(roomLifecycleResultSchema.safeParse({ ...closed, hostUid: 'alice' }).success).toBe(false);
  });

  it('keeps the next cycle and host transfer as strict host commands with explicit results', () => {
    const nextCycle = {
      schemaVersion: 2,
      operationId: 'next-cycle-operation-1',
      expectedDecisionRevision: 3,
      roomId: room.id,
      nextCycleId: 'cycle-2',
    };
    expect(startNextCycleCommandSchema.safeParse(nextCycle).success).toBe(true);
    expect(startNextCycleCommandSchema.safeParse({ ...nextCycle, actorUid: 'alice' }).success).toBe(false);
    expect(startNextCycleCommandSchema.safeParse({ ...nextCycle, nextCycleId: '' }).success).toBe(false);
    expect(startNextCycleCommandSchema.safeParse({ ...nextCycle, expectedDecisionRevision: 0 }).success).toBe(false);

    const started = {
      status: 'applied',
      roomId: room.id,
      previousCycleId: 'cycle-1',
      cycleId: 'cycle-2',
      cycleNumber: 2,
      phase: 'COLLECTING',
      decisionRevision: 4,
      rosterRevision: 1,
      snapshotVersion: 8,
      updatedAt: '2026-11-07T10:00:00Z',
    };
    expect(startNextCycleResultSchema.safeParse(started).success).toBe(true);
    expect(startNextCycleResultSchema.safeParse({ ...started, phase: 'COMPLETED' }).success).toBe(false);
    expect(startNextCycleResultSchema.safeParse({ ...started, cycleNumber: 0 }).success).toBe(false);
    expect(startNextCycleResultSchema.safeParse({ ...started, actorUid: 'alice' }).success).toBe(false);

    const transfer = {
      schemaVersion: 2,
      operationId: 'transfer-host-operation-1',
      expectedDecisionRevision: 1,
      roomId: room.id,
      targetUid: 'bob',
    };
    expect(transferHostCommandSchema.safeParse(transfer).success).toBe(true);
    expect(transferHostCommandSchema.safeParse({ ...transfer, targetUid: '' }).success).toBe(false);
    expect(transferHostCommandSchema.safeParse({ ...transfer, actorUid: 'bob' }).success).toBe(false);

    const transferred = {
      status: 'applied',
      roomId: room.id,
      hostUid: 'bob',
      previousHostUid: 'alice',
      phase: 'DISCUSSING',
      decisionRevision: 1,
      rosterRevision: 2,
      snapshotVersion: 5,
      updatedAt: '2026-11-07T10:00:00Z',
    };
    expect(transferHostResultSchema.safeParse(transferred).success).toBe(true);
    expect(transferHostResultSchema.safeParse({ ...transferred, hostUid: 'alice' }).success).toBe(false);
    expect(transferHostResultSchema.safeParse({ ...transferred, actorUid: 'alice' }).success).toBe(false);
    expect(transferHostResultSchema.safeParse({ ...transferred, rosterRevision: 0 }).success).toBe(false);
  });

  it('scopes reopen requests, vote changes and cancellation to strict trusted inputs', () => {
    const request = {
      schemaVersion: 2,
      operationId: 'reopen-request-operation',
      expectedDecisionRevision: 1,
      expectedRosterRevision: 1,
      roomId: room.id,
      requestId: 'reopen-request-1',
      roundId: 'reopen-round-1',
      targetRevisionIds: [generalRevision.id],
    };
    expect(requestReopenCommandSchema.safeParse(request).success).toBe(true);
    expect(requestReopenCommandSchema.safeParse({ ...request, actorUid: 'alice' }).success).toBe(false);
    expect(requestReopenCommandSchema.safeParse({ ...request, targetRevisionIds: [] }).success).toBe(false);
    expect(requestReopenCommandSchema.safeParse({
      ...request,
      targetRevisionIds: [generalRevision.id, generalRevision.id],
    }).success).toBe(false);
    expect(requestReopenCommandSchema.safeParse({ ...request, expectedRosterRevision: 0 }).success).toBe(false);

    const vote = {
      schemaVersion: 2,
      operationId: 'reopen-vote-operation',
      expectedDecisionRevision: 1,
      requestId: request.requestId,
      choice: 'KEEP_DISCUSSING',
    };
    expect(voteReopenCommandSchema.safeParse(vote).success).toBe(true);
    expect(voteReopenCommandSchema.safeParse({ ...vote, choice: 'REOPEN' }).success).toBe(true);
    expect(voteReopenCommandSchema.safeParse({ ...vote, choice: 'END' }).success).toBe(false);
    expect(voteReopenCommandSchema.safeParse({ ...vote, actorUid: 'bob' }).success).toBe(false);

    const cancel = {
      schemaVersion: 2,
      operationId: 'reopen-cancel-operation',
      expectedDecisionRevision: 1,
      requestId: request.requestId,
    };
    expect(cancelReopenCommandSchema.safeParse(cancel).success).toBe(true);
    expect(cancelReopenCommandSchema.safeParse({ ...cancel, choice: 'REOPEN' }).success).toBe(false);
    expect(cancelReopenCommandSchema.safeParse({ ...cancel, actorUid: 'alice' }).success).toBe(false);
  });

  it('projects only reopen aggregates into shared and the member choice into mine', () => {
    const activeReopen = {
      requestId: 'reopen-request-1',
      roundId: 'reopen-round-1',
      requestedBy: 'bob',
      targetRevisionIds: [generalRevision.id],
      reopenVoteCount: 1,
      majorityThreshold: 2,
    };
    expect(roomSnapshotForMemberSchema('alice').safeParse({
      ...snapshot,
      shared: { ...snapshot.shared, activeReopen },
      mine: { ...snapshot.mine, reopenVote: { requestId: activeReopen.requestId, choice: 'KEEP_DISCUSSING' } },
    }).success).toBe(true);
    expect(roomSnapshotSchema.safeParse({
      ...snapshot,
      shared: { ...snapshot.shared, activeReopen: { ...activeReopen, reopenVoteCount: 3 } },
    }).success).toBe(false);
    expect(roomSnapshotSchema.safeParse({
      ...snapshot,
      shared: { ...snapshot.shared, activeReopen, reopenVotes: [{ uid: 'bob', choice: 'REOPEN' }] },
    }).success).toBe(false);
  });

  it('requires an explicit candidate revision on final-response commands', () => {
    const command = {
      schemaVersion: 2,
      operationId: 'operation-3',
      expectedDecisionRevision: 1,
      proposalId: proposal.id,
      candidateRevisionId: generalRevision.id,
      choice: 'ACCEPT',
    };
    expect(respondFinalCommandSchema.safeParse(command).success).toBe(true);
    expect(respondFinalCommandSchema.safeParse({ ...command, candidateRevisionId: undefined }).success).toBe(false);
  });

  it('keeps final proposal, unresolved closure and their results strict', () => {
    const propose = {
      schemaVersion: 2,
      operationId: 'propose-final-operation',
      expectedDecisionRevision: 1,
      roomId: room.id,
      proposalId: proposal.id,
      candidateRevisionId: generalRevision.id,
      deadlineAt: later,
    };
    const close = {
      schemaVersion: 2,
      operationId: 'close-unresolved-operation',
      expectedDecisionRevision: 1,
      proposalId: proposal.id,
    };
    expect(proposeFinalCommandSchema.safeParse(propose).success).toBe(true);
    expect(proposeFinalCommandSchema.safeParse({ ...propose, actorUid: 'alice' }).success).toBe(false);
    expect(proposeFinalCommandSchema.safeParse({ ...propose, candidateRevisionId: undefined }).success).toBe(false);
    expect(proposeFinalCommandSchema.safeParse({ ...propose, deadlineAt: 'not-a-date' }).success).toBe(false);
    expect(closeUnresolvedCommandSchema.safeParse(close).success).toBe(true);
    expect(closeUnresolvedCommandSchema.safeParse({ ...close, outcome: 'UNRESOLVED' }).success).toBe(false);
    expect(proposeFinalResultSchema.safeParse({
      status: 'applied', roomId: room.id, proposalId: proposal.id,
      candidateRevisionId: generalRevision.id, phase: 'CONFIRMING', rosterUids: ['alice', 'bob'],
      deadlineAt: later, snapshotVersion: 2, createdAt: now,
    }).success).toBe(true);
    expect(respondFinalResultSchema.safeParse({
      status: 'applied', proposalId: proposal.id, candidateRevisionId: generalRevision.id,
      choice: 'ACCEPT', updatedAt: now, proposalStatus: 'AGREED',
    }).success).toBe(true);
    expect(closeUnresolvedResultSchema.safeParse({
      status: 'applied', proposalId: proposal.id, outcome: 'UNRESOLVED', phase: 'COMPLETED',
      responseSummary: { accepted: 1, declined: 0, abstained: 0, pending: 1 },
      snapshotVersion: 3, resolvedAt: later,
    }).success).toBe(true);
    expect(closeUnresolvedResultSchema.safeParse({
      status: 'applied', proposalId: proposal.id, outcome: 'UNRESOLVED', phase: 'COMPLETED',
      responseSummary: { accepted: 1, declined: 0, abstained: 0, pending: 1 },
      snapshotVersion: 3, resolvedAt: later, rawResponses: [finalResponse],
    }).success).toBe(false);
  });

  it('restores immutable decision records without exposing other members responses', () => {
    const record = {
      schemaVersion: 2,
      id: proposal.id,
      cycleId: proposal.cycleId,
      proposalId: proposal.id,
      outcome: 'AGREED',
      candidateRevisionSnapshot: generalRevision,
      rosterSnapshot: ['alice', 'bob'],
      responseSummary: { accepted: 2, declined: 0, abstained: 0, pending: 0 },
      createdAt: later,
    };
    expect(roomSnapshotForMemberSchema('alice').safeParse({
      ...snapshot,
      shared: { ...snapshot.shared, phase: 'COMPLETED', decisionRecords: [record] },
      mine: { ...snapshot.mine, permissions: { phase: 'COMPLETED', canStartNextCycle: true } },
    }).success).toBe(true);
    expect(roomSnapshotSchema.safeParse({
      ...snapshot,
      shared: { ...snapshot.shared, decisionRecords: [record], finalResponses: [finalResponse] },
    }).success).toBe(false);
  });

  it('allows only public non-skipped ideas in shared after collection ends', () => {
    expect(roomSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(roomSnapshotSchema.safeParse({
      ...snapshot,
      shared: { ...snapshot.shared, publicIdeas: [{ ...idea, visibility: 'PRIVATE' }] },
    }).success).toBe(false);
    expect(roomSnapshotSchema.safeParse({
      ...snapshot,
      shared: { ...snapshot.shared, publicIdeas: [{ ...idea, text: '', skipped: true }] },
    }).success).toBe(false);
    expect(roomSnapshotSchema.safeParse({
      ...snapshot,
      shared: { ...snapshot.shared, phase: 'COLLECTING' },
    }).success).toBe(false);
  });

  it('projects only published public comments into shared and only own comments into mine', () => {
    const published = { ...comment, visibility: 'PUBLIC', publicationState: 'PUBLISHED', publishedAt: later };
    expect(roomSnapshotForMemberSchema('alice').safeParse({
      ...snapshot,
      shared: { ...snapshot.shared, comments: [published] },
      mine: { ...snapshot.mine, comments: [comment] },
    }).success).toBe(true);
    expect(roomSnapshotSchema.safeParse({
      ...snapshot,
      shared: { ...snapshot.shared, comments: [comment] },
    }).success).toBe(false);
    expect(roomSnapshotSchema.safeParse({
      ...snapshot,
      shared: { ...snapshot.shared, comments: [{ ...published, visibility: 'PRIVATE' }] },
    }).success).toBe(false);
    expect(roomSnapshotForMemberSchema('alice').safeParse({
      ...snapshot,
      mine: { ...snapshot.mine, comments: [{ ...comment, authorUid: 'bob' }] },
    }).success).toBe(false);
  });

  it('allows one visible room member without weakening frozen multiplayer rosters', () => {
    const singleMemberSnapshot = {
      ...snapshot,
      shared: {
        ...snapshot.shared,
        phase: 'COLLECTING',
        memberUids: ['alice'],
        candidates: [],
        currentRevisions: [],
        publicIdeas: [],
        revealedEvaluationRoundIds: [],
        revealedEvaluations: [],
        progress: { ideaSubmittedCount: 0, ideaSkippedCount: 0, evaluationSubmittedCount: 0, evaluationCompletedCount: 0 },
      },
      mine: {
        ...snapshot.mine,
        ideas: [],
        evaluations: [],
        finalResponses: [],
        permissions: { phase: 'COLLECTING', canSubmitIdea: true, canManageRoom: true },
      },
    };
    expect(roomSnapshotForMemberSchema('alice').safeParse(singleMemberSnapshot).success).toBe(true);
    expect(roomSnapshotSchema.safeParse({
      ...singleMemberSnapshot,
      shared: { ...singleMemberSnapshot.shared, roomStatus: 'CLOSED' },
    }).success).toBe(true);
  });

  it('rejects unknown fields instead of silently passing private database values', () => {
    const cases = [
      [roomSchema, room],
      [roomMemberSchema, member],
      [ideaSchema, idea],
      [commentSchema, comment],
      [candidateSchema, candidate],
      [candidateRevisionSchema, generalRevision],
      [evaluationRoundSchema, round],
      [evaluationSchema, evaluation],
      [confirmationProposalSchema, proposal],
      [finalResponseSchema, finalResponse],
      [roomSnapshotSchema, snapshot],
    ] as const;
    for (const [schema, value] of cases) {
      expect(schema.safeParse({ ...value, privateDatabaseField: 'must-not-pass' }).success).toBe(false);
    }
  });

  it('reveals evaluations only for explicitly revealed rounds', () => {
    expect(roomSnapshotSchema.safeParse({
      ...snapshot,
      shared: { ...snapshot.shared, revealedEvaluations: [evaluation] },
    }).success).toBe(true);
    expect(roomSnapshotSchema.safeParse({
      ...snapshot,
      shared: { ...snapshot.shared, revealedEvaluationRoundIds: [], revealedEvaluations: [evaluation] },
    }).success).toBe(false);
    expect(roomSnapshotSchema.safeParse({
      ...snapshot,
      shared: {
        ...snapshot.shared,
        phase: 'EVALUATING',
        revealedEvaluationRoundIds: [],
        revealedEvaluations: [],
        activeEvaluationRound: round,
      },
      mine: {
        ...snapshot.mine,
        permissions: { phase: 'EVALUATING', canEvaluate: true, canVoteRoundClose: true },
      },
    }).success).toBe(true);
  });

  it('rejects blind-evaluation fields in shared and other members records in mine', () => {
    expect(roomSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(roomSnapshotSchema.safeParse({
      ...snapshot,
      shared: { ...snapshot.shared, blindEvaluations: [evaluation] },
    }).success).toBe(false);
    const aliceSnapshot = roomSnapshotForMemberSchema('alice');
    expect(aliceSnapshot.safeParse(snapshot).success).toBe(true);
    expect(aliceSnapshot.safeParse({
      ...snapshot,
      mine: { ...snapshot.mine, evaluations: [{ ...evaluation, uid: 'bob' }] },
    }).success).toBe(false);
    expect(aliceSnapshot.safeParse({
      ...snapshot,
      mine: { ...snapshot.mine, ideas: [{ ...idea, authorUid: 'bob', visibility: 'PRIVATE' }] },
    }).success).toBe(false);
  });

  it('validates AI candidate suggestions as public, traceable drafts only', () => {
    const result = {
      status: 'suggested',
      roomId: 'room-1',
      snapshotVersion: 3,
      scope: 'PUBLIC',
      generatedAt: now,
      suggestions: [{ title: '候选草案', body: '具体安排', sourceIdeaIds: ['idea-1'] }],
    };
    expect(suggestCandidatesInputSchema.safeParse({ roomId: 'room-1' }).success).toBe(true);
    expect(suggestCandidatesInputSchema.safeParse({ roomId: 'room-1', actorUid: 'alice' }).success).toBe(false);
    expect(suggestCandidatesResultSchema.safeParse(result).success).toBe(true);
    expect(suggestCandidatesResultSchema.safeParse({
      ...result,
      suggestions: [{ ...result.suggestions[0], sourceIdeaIds: [] }],
    }).success).toBe(false);
    expect(suggestCandidatesResultSchema.safeParse({
      ...result,
      suggestions: [{ ...result.suggestions[0], status: 'accepted' }],
    }).success).toBe(false);
    expect(suggestCandidatesResultSchema.safeParse({
      ...result,
      suggestions: Array.from({ length: 6 }, (_, index) => ({
        ...result.suggestions[0],
        title: `候选 ${index}`,
      })),
    }).success).toBe(false);
  });
});
