import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  Candidate,
  CandidateRevision,
  CandidateSuggestion,
  Evaluation,
  RoomAssistantAction,
  RoomAssistantMessage,
  RoomSnapshot,
} from '@gongqi/contracts/v2';
import { RoomGatewayError, type RoomGateway } from './data/RoomGateway';
import { SpotlightCard } from './components/SpotlightCard';
import { VoiceField } from './components/VoiceField';
import { AssistantDock } from './components/AssistantDock';
import { CamelotEntrance, camelotAsset } from './components/CamelotEntrance';
import { CamelotSeat, type EntryCard } from './components/CamelotSeat';
import { getDevIdentity, setDevIdentity, type DevIdentity } from './data/webRoomGateway';
import { homePath, inviteTokenFromInput, inviteUrl, joinPath, readWebRoute, roomPath, type WebRoute } from './roomRoute';

const RoundTable = lazy(() => import('./scene/RoundTable'));

const PHASE_LABELS: Record<RoomSnapshot['shared']['phase'], string> = {
  COLLECTING: '独立输入中',
  CANDIDATE_REVIEW: '候选核对中',
  EVALUATING: '独立评价中',
  DISCUSSING: '共同讨论中',
  CONFIRMING: '最终确认中',
  COMPLETED: '已完成',
};

const GUIDE_STEPS = ['写下想法', '邀请伙伴', '结束收集', '整理候选', '独立评价', '共同讨论', '最终确认', '查看结果'];

const ELDER_LINES = [
  '把心里的想法写在契约上。此刻无人能窥见，只有你自己知道。',
  '契约需要至少两位缔约者。把邀请交给你愿意相信的人。',
  '等所有人落笔，我会封存这些想法，再让它们显形。',
  '把相似的念头收拢成候选吧。契约会记住每一笔的出处。',
  '闭眼评分吧。你的判断在统一揭示之前，不会泄露给任何人。',
  '打开讨论。分歧不是障碍，是还没被说清的理由。',
  '最终版本已经拟好。每个人的回应，都会被记进契约。',
  '契约已定。这是你们一起写下的结果。',
];

const FLOW_HINTS: Record<RoomSnapshot['shared']['phase'], string> = {
  COLLECTING: '提交前彼此看不到。',
  CANDIDATE_REVIEW: '确认后开始独立评价。',
  EVALUATING: '统一揭示后公开。',
  DISCUSSING: '只重评有变化的候选。',
  CONFIRMING: '全员接受才达成。',
  COMPLETED: '可复制结果或开始下一轮。',
};

interface EvaluationDraft {
  attitude: 'SUPPORT' | 'OPPOSE' | 'NEUTRAL' | '';
  score: string;
  reason: string;
}

interface RevisionDraft {
  title: string;
  body: string;
}

const EMPTY_EVALUATION_DRAFT: EvaluationDraft = { attitude: '', score: '', reason: '' };

function readEvaluationDrafts(key: string): Record<string, EvaluationDraft> {
  const stored = readLocal(key);
  if (!stored) return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, EvaluationDraft>
      : {};
  } catch {
    return {};
  }
}

const ATTITUDE_LABELS = {
  SUPPORT: '支持',
  OPPOSE: '反对',
  NEUTRAL: '中立',
} as const;

function evaluationDraftKey(roomId: string, owner: string, roundId: string): string {
  return `gongqi.draft.v1.evaluations.${roomId}.${owner}.${roundId}`;
}

function savedEvaluationDraft(evaluation: Evaluation | undefined): EvaluationDraft {
  if (!evaluation || evaluation.submissionState === 'SKIPPED') return EMPTY_EVALUATION_DRAFT;
  return {
    attitude: evaluation.attitude ?? '',
    score: typeof evaluation.score === 'number' ? String(evaluation.score) : '',
    reason: evaluation.reason ?? '',
  };
}

function dateTimeLocalValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function summarizeRevealedEvaluations(shared: RoomSnapshot['shared'], candidateRevisionId: string) {
  const latestByUid = new Map<string, Evaluation>();
  for (const evaluation of shared.revealedEvaluations) {
    if (evaluation.candidateRevisionId !== candidateRevisionId || !shared.memberUids.includes(evaluation.uid)) continue;
    const previous = latestByUid.get(evaluation.uid);
    if (!previous || Date.parse(evaluation.updatedAt) > Date.parse(previous.updatedAt)
      || (evaluation.updatedAt === previous.updatedAt && evaluation.roundId > previous.roundId)) {
      latestByUid.set(evaluation.uid, evaluation);
    }
  }
  const counts = { support: 0, oppose: 0, neutral: 0, skipped: 0, missing: 0 };
  let scoreSum = 0;
  let scoreCount = 0;
  const entries = shared.memberUids.map(uid => {
    const evaluation = latestByUid.get(uid);
    if (!evaluation) counts.missing += 1;
    else if (evaluation.submissionState === 'SKIPPED') counts.skipped += 1;
    else {
      if (evaluation.attitude === 'SUPPORT') counts.support += 1;
      if (evaluation.attitude === 'OPPOSE') counts.oppose += 1;
      if (evaluation.attitude === 'NEUTRAL') counts.neutral += 1;
      if (typeof evaluation.score === 'number') {
        scoreSum += evaluation.score;
        scoreCount += 1;
      }
    }
    return { uid, evaluation };
  });
  return { entries, counts, scoreSum, scoreCount };
}

const ERROR_LABELS: Record<string, string> = {
  NETWORK_ERROR: '网络连接失败，操作结果尚未确认。草稿已保留，请检查网络后刷新快照再重试。',
  INVALID_RESPONSE: '服务返回了无法识别的数据，本次操作未确认。',
  UNAUTHENTICATED: '当前登录状态无效，请重新进入页面。',
  FORBIDDEN: '当前身份没有访问这个房间的权限。',
  ROOM_NOT_FOUND: '没有找到这个房间，或当前身份不可见。',
  VERSION_CONFLICT: '房间刚刚有新变化。草稿已保留，请核对最新内容后重试。',
  ROSTER_CONFLICT: '成员名单刚刚发生变化。请刷新后重试。',
  INVITE_INVALID: '邀请链接无效或已被轮换，请向房主获取新链接。',
  INVITE_EXPIRED: '邀请链接已过期，请向房主获取新链接。',
  ROOM_FULL: '房间人数已满，暂时无法加入。',
  IDEA_ALREADY_SUBMITTED: '本阶段已经提交过输入，请刷新查看。',
  CANDIDATE_LIMIT_REACHED: '有效候选已达到 10 个，不能再新增。',
  NOT_HOST: '只有房主可以执行这个操作。',
  ROSTER_VERSION_CONFLICT: '成员名单已变化，请核对最新名单后重试。',
  ROSTER_INVALID: '需要 2—6 位已加入成员才能开始评价。',
  CANDIDATE_REVISION_MISMATCH: '候选版本已变化，请核对当前候选后重试。',
  ROUND_CLOSED: '本轮评价已结束，未保存的内容仍保留在草稿中。',
  ROUND_CLOSE_VOTING_DISABLED: '已设置截止时间，不能再投新的结束票；仍可按页面提示撤回本人已投的票。',
  INVALID_DEADLINE: '截止时间必须晚于当前时间；已有截止时间时，只能严格延长。',
  EVALUATION_CONFIRMATION_CONFLICT: '未完成评价的人数已变化，请根据最新进度重新确认。',
  COMMENT_PUBLICATION_NOT_ALLOWED: '盲评阶段不能发布评论；请先保存本人草稿，统一揭示后再显式发布。',
  COMMENT_PHASE_INVALID: '当前阶段不能保存评论草稿，正文仍保留在本机。',
  COMMENT_ID_CONFLICT: '评论标识已被占用，请刷新后重试；正文仍保留在本机。',
  COMMENT_ALREADY_PUBLISHED: '这条评论已经发布，不能覆盖修改。',
  REOPEN_ALREADY_OPEN: '已有一个进行中的重开申请，请先完成或取消该申请。',
  REOPEN_NOT_FOUND: '重开申请已变化，请刷新后核对。',
  REOPEN_CLOSED: '重开申请已结束或取消，请刷新后核对。',
  NOT_REQUESTER: '只有重开申请的发起者可以取消该申请。',
  REQUEST_ALREADY_EXISTS: '该重开申请标识已被占用，请刷新后重试。',
  AI_UNAVAILABLE: 'AI 服务暂未配置或暂时不可用。请继续手动整理候选。',
  AI_TIMEOUT: 'AI 响应超时，本次没有生成建议。请继续手动整理或稍后重试。',
  AI_RATE_LIMITED: 'AI 调用过于频繁，请稍后再试；当前仍可手动整理。',
  AI_INVALID_OUTPUT: 'AI 返回的建议不符合要求，已全部丢弃。请手动整理候选。',
  AI_PHASE_NOT_ELIGIBLE: '当前阶段不能生成候选建议；请在候选核对或共同讨论阶段使用。',
  AI_NO_PUBLIC_INPUT: '还没有可公开整理的输入，请先收集公开想法或手动创建候选。',
  AI_STALE_CONTEXT: '房间内容已变化，本次 AI 建议已过期。请刷新后重新生成。',
  NOT_MEMBER: '你已不是这个房间的当前成员，无法读取或提交房间内容。',
  HOST_MUST_TRANSFER: '房主不能直接退出；请先移交房主或关闭房间。',
  MEMBER_NOT_FOUND: '目标成员已不在房间中，请刷新名单后核对。',
  ROOM_NOT_ACTIVE: '房间已关闭、归档或删除中，不能再执行这个操作。',
  INVALID_PHASE: '当前阶段不能执行这个操作，请刷新后核对。',
  CYCLE_EXISTS: '下一轮周期标识已被占用，请刷新后重试。',
  ASSISTANT_REQUEST_NOT_FOUND: '助手请求已失效，请重新提交。',
};

const ASSISTANT_ACTION_LABELS: Record<RoomAssistantAction, string> = {
  SYNTHESIZE_DISAGREEMENT: '梳理分歧',
  SUGGEST_ALTERNATIVES: '提出替代方案',
  FIND_OPEN_QUESTIONS: '找出待确认问题',
  ASK: '自由提问',
};

function errorMessage(error: unknown): string {
  if (error instanceof RoomGatewayError) {
    return ERROR_LABELS[error.code] ?? `操作未完成（${error.code}）。草稿已保留，请刷新后核对。`;
  }
  return '操作未完成，草稿已保留。请稍后刷新重试。';
}

function newId(): string {
  return crypto.randomUUID();
}

function readLocal(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeLocal(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // The in-memory draft remains usable when browser storage is unavailable.
  }
}

function readSession(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeSession(key: string, value: string): void {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // A newly rotated link still remains visible until the current page is refreshed.
  }
}

function draftKey(kind: 'idea' | 'candidate-title' | 'candidate-body' | 'comment', roomId: string, owner: string): string {
  return `gongqi.draft.v1.${kind}.${roomId}.${owner}`;
}

function revisionDraftKey(kind: 'title' | 'body', roomId: string, owner: string, candidateId: string): string {
  return `gongqi.draft.v1.revision-${kind}.${roomId}.${owner}.${candidateId}`;
}

function revealedEvaluationSource(shared: RoomSnapshot['shared'], candidateRevisionId: string) {
  const evaluations = shared.revealedEvaluations
    .filter(evaluation => evaluation.candidateRevisionId === candidateRevisionId)
    .sort((left, right) => {
      const roundDifference = shared.revealedEvaluationRoundIds.indexOf(left.roundId)
        - shared.revealedEvaluationRoundIds.indexOf(right.roundId);
      return roundDifference || Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
        || left.roundId.localeCompare(right.roundId) || left.uid.localeCompare(right.uid);
    });
  const latest = evaluations.at(-1);
  if (!latest) return undefined;
  return {
    sourceRoundId: latest.roundId,
    sourceRevisionId: latest.candidateRevisionId,
    carried: latest.roundId !== shared.revealedEvaluationRoundIds.at(-1),
  };
}

function currentRoute(): WebRoute {
  return readWebRoute(window.location.pathname, window.location.hash, undefined, window.location.search);
}

type RoomComment = RoomSnapshot['mine']['comments'][number];

interface AppProps {
  gateway: RoomGateway | undefined;
  configurationError: string;
}

export default function App({ gateway, configurationError }: AppProps) {
  const [entryCard, setEntryCard] = useState<EntryCard | null>(null);
  const [route, setRoute] = useState<WebRoute>(currentRoute);
  const [snapshot, setSnapshot] = useState<RoomSnapshot>();
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [joinToken, setJoinToken] = useState(route.name === 'join' ? route.inviteToken : '');
  const [ideaText, setIdeaText] = useState('');
  const [justSealedIdeaId, setJustSealedIdeaId] = useState<string>();
  const [visibility, setVisibility] = useState<'PUBLIC' | 'PRIVATE'>('PUBLIC');
  const [candidateTitle, setCandidateTitle] = useState('');
  const [candidateBody, setCandidateBody] = useState('');
  const [aiSuggestions, setAiSuggestions] = useState<CandidateSuggestion[]>([]);
  const [assistantMessages, setAssistantMessages] = useState<RoomAssistantMessage[]>([]);
  const [assistantQuestion, setAssistantQuestion] = useState('');
  const [assistantError, setAssistantError] = useState('');
  const [revisionDrafts, setRevisionDrafts] = useState<Record<string, RevisionDraft>>({});
  const [reopenTargetRevisionIds, setReopenTargetRevisionIds] = useState<string[]>([]);
  const [commentBody, setCommentBody] = useState('');
  const [commentVisibility, setCommentVisibility] = useState<'PUBLIC' | 'PRIVATE'>('PUBLIC');
  const [commentCandidateId, setCommentCandidateId] = useState('');
  const [sourceIdeaIds, setSourceIdeaIds] = useState<string[]>([]);
  const [evaluationDrafts, setEvaluationDrafts] = useState<Record<string, EvaluationDraft>>({});
  const [roundDeadlineInput, setRoundDeadlineInput] = useState('');
  const [roundDeadlineReason, setRoundDeadlineReason] = useState('');
  const [finalCandidateRevisionId, setFinalCandidateRevisionId] = useState('');
  const [finalDeadlineInput, setFinalDeadlineInput] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(configurationError);
  const [notice, setNotice] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  // 演示 / 投影模式：录屏或现场路演时把画面让给当前操作与结果。
  const [presentMode, setPresentMode] = useState(false);
  const [stale, setStale] = useState(false);
  const [stopPolling, setStopPolling] = useState(false);
  const [membershipLost, setMembershipLost] = useState(false);
  const requestSequence = useRef(0);

  const roomId = route.name === 'room' ? route.roomId : undefined;
  const isHost = snapshot !== undefined && snapshot.shared.hostUid === snapshot.mine.uid;
  const permissions = snapshot?.mine.permissions;
  const canManageRoom = permissions !== undefined && 'canManageRoom' in permissions && permissions.canManageRoom;
  const canSubmitIdea = permissions !== undefined && 'canSubmitIdea' in permissions && permissions.canSubmitIdea;
  const canEditCandidates = permissions !== undefined && 'canEditCandidates' in permissions && permissions.canEditCandidates;
  const canOpenEvaluation = permissions !== undefined && 'canOpenEvaluation' in permissions && permissions.canOpenEvaluation;
  const canEvaluate = permissions !== undefined && 'canEvaluate' in permissions && permissions.canEvaluate;
  const canVoteRoundClose = permissions !== undefined && 'canVoteRoundClose' in permissions && permissions.canVoteRoundClose;
  const canProposeFinal = permissions !== undefined && 'canProposeFinal' in permissions && permissions.canProposeFinal;
  const canRespondFinal = permissions !== undefined && 'canRespondFinal' in permissions && permissions.canRespondFinal;
  const activeRoundId = snapshot?.shared.activeEvaluationRound?.id;
  const ownerKey = snapshot?.mine.uid ?? (__GQ_DEV_FIXTURE__ ? getDevIdentity() : 'anonymous-session');

  useEffect(() => {
    const onHistory = () => setRoute(currentRoute());
    window.addEventListener('popstate', onHistory);
    window.addEventListener('hashchange', onHistory);
    return () => {
      window.removeEventListener('popstate', onHistory);
      window.removeEventListener('hashchange', onHistory);
    };
  }, []);

  useEffect(() => {
    if (route.name === 'join') setJoinToken(route.inviteToken);
  }, [route]);

  useEffect(() => {
    setSnapshot(undefined);
    setInviteLink(roomId ? readSession(`gongqi.invite.${roomId}`) : '');
    setError(configurationError);
    setNotice('');
    setStale(false);
    setStopPolling(false);
    setMembershipLost(false);
    setSourceIdeaIds([]);
    setAiSuggestions([]);
    setAssistantMessages([]);
    setAssistantQuestion('');
    setAssistantError('');
    setFinalCandidateRevisionId('');
    setFinalDeadlineInput(dateTimeLocalValue(new Date(Date.now() + 24 * 60 * 60 * 1000)));
  }, [roomId, configurationError]);

  const loadSnapshot = useCallback(async (targetRoomId: string) => {
    if (!gateway) return;
    const sequence = ++requestSequence.current;
    try {
      const next = await gateway.request('getSnapshot', { roomId: targetRoomId });
      if (sequence !== requestSequence.current) return;
      setSnapshot(current => current && current.version > next.version ? current : next);
      setStale(false);
      setError('');
      setMembershipLost(false);
      if (next.shared.hostUid !== next.mine.uid) {
        setInviteLink('');
        writeSession(`gongqi.invite.${targetRoomId}`, '');
      }
      if (next.shared.roomStatus !== 'ACTIVE') setStopPolling(true);
    } catch (loadError) {
      if (sequence !== requestSequence.current) return;
      setStale(true);
      setError(errorMessage(loadError));
      if (loadError instanceof RoomGatewayError && loadError.code === 'NOT_MEMBER') {
        setMembershipLost(true);
        setStopPolling(true);
        setSnapshot(undefined);
      } else if (loadError instanceof RoomGatewayError
        && ['FORBIDDEN', 'ROOM_NOT_FOUND', 'UNAUTHENTICATED'].includes(loadError.code)) {
        setStopPolling(true);
      }
    }
  }, [gateway]);

  useEffect(() => {
    if (!roomId || !gateway || stopPolling) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await loadSnapshot(roomId);
      if (active) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      requestSequence.current += 1;
    };
  }, [roomId, gateway, loadSnapshot, stopPolling]);

  const loadAssistantMessages = useCallback(async (targetRoomId: string) => {
    if (!gateway) return;
    try {
      const result = await gateway.request('getRoomAssistantMessages', { roomId: targetRoomId });
      setAssistantMessages(result.messages);
    } catch (loadError) {
      if (loadError instanceof RoomGatewayError
        && ['NOT_MEMBER', 'FORBIDDEN', 'ROOM_NOT_FOUND', 'UNAUTHENTICATED'].includes(loadError.code)) {
        setAssistantMessages([]);
      }
    }
  }, [gateway]);

  useEffect(() => {
    if (!roomId || !gateway || stopPolling) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await loadAssistantMessages(roomId);
      if (active) timer = setTimeout(poll, 10000);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [roomId, gateway, stopPolling, loadAssistantMessages]);

  useEffect(() => {
    if (!roomId || !snapshot) return;
    setIdeaText(readLocal(draftKey('idea', roomId, ownerKey)));
    setCandidateTitle(readLocal(draftKey('candidate-title', roomId, ownerKey)));
    setCandidateBody(readLocal(draftKey('candidate-body', roomId, ownerKey)));
    setCommentBody(readLocal(draftKey('comment', roomId, ownerKey)));
    setCommentCandidateId('');
    const restoredRevisionDrafts: Record<string, RevisionDraft> = {};
    for (const candidate of snapshot.shared.candidates) {
      const revision = snapshot.shared.currentRevisions.find(item => item.id === candidate.currentRevisionId);
      if (!revision) continue;
      restoredRevisionDrafts[candidate.id] = {
        title: readLocal(revisionDraftKey('title', roomId, ownerKey, candidate.id)) || revision.title,
        body: readLocal(revisionDraftKey('body', roomId, ownerKey, candidate.id)) || revision.body,
      };
    }
    setRevisionDrafts(restoredRevisionDrafts);
    setReopenTargetRevisionIds([]);
  }, [roomId, ownerKey, snapshot === undefined]);

  useEffect(() => {
    setRoundDeadlineInput('');
    setRoundDeadlineReason('');
    const round = snapshot?.shared.activeEvaluationRound;
    if (!roomId || !snapshot || !round) {
      setEvaluationDrafts({});
      return;
    }
    const saved = Object.fromEntries(snapshot.mine.evaluations
      .filter(evaluation => evaluation.roundId === round.id)
      .map(evaluation => [evaluation.candidateRevisionId, savedEvaluationDraft(evaluation)]));
    const stored = readEvaluationDrafts(evaluationDraftKey(roomId, ownerKey, round.id));
    setEvaluationDrafts({ ...saved, ...stored });
  }, [roomId, ownerKey, activeRoundId]);

  function goToRoom(targetRoomId: string): void {
    window.history.pushState({}, '', roomPath(targetRoomId));
    setRoute({ name: 'room', roomId: targetRoomId });
  }

  async function perform(
    label: string,
    action: () => Promise<void>,
    onError?: (message: string) => void,
  ): Promise<void> {
    if (!gateway || busy) return;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (actionError) {
      const message = errorMessage(actionError);
      if (onError) onError(message); else setError(message);
    } finally {
      setBusy('');
    }
  }

  function saveInvite(room: string, token: string): void {
    const link = inviteUrl(window.location.origin, token);
    writeSession(`gongqi.invite.${room}`, token);
    setInviteLink(link);
  }

  function handleCreate(event: FormEvent): void {
    event.preventDefault();
    void perform('create', async () => {
      if (!gateway) return;
      const created = await gateway.request('createRoom', {
        schemaVersion: 2,
        operationId: newId(),
        templateId: 'general',
        title,
        purpose,
      });
      goToRoom(created.roomId);
      const rotated = await gateway.request('rotateInvite', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: created.decisionRevision,
        roomId: created.roomId,
        inviteToken: newId(),
      });
      saveInvite(created.roomId, rotated.inviteToken);
      setTitle('');
      setPurpose('');
      setNotice('房间已创建，邀请链接已生成。');
      await loadSnapshot(created.roomId);
    });
  }

  function handleRotateInvite(): void {
    if (!snapshot || !roomId) return;
    const targetRoomId = roomId;
    void perform('invite', async () => {
      if (!gateway) return;
      const rotated = await gateway.request('rotateInvite', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roomId: targetRoomId,
        inviteToken: newId(),
      });
      saveInvite(targetRoomId, rotated.inviteToken);
      setNotice('新邀请链接已生成，旧链接已失效。');
      await loadSnapshot(targetRoomId);
    });
  }

  function handleChangeMember(targetUid: string, action: 'REMOVE' | 'LEAVE'): void {
    if (!snapshot || !roomId) return;
    const leaving = action === 'LEAVE';
    const confirmed = window.confirm(leaving
      ? '退出后你将立即失去这个房间的访问权限，确定退出吗？'
      : '移除后该成员将立即失去访问权限；未结束的盲评会被取消，进行中的最终确认会失效。确定移除吗？');
    if (!confirmed) return;
    const targetRoomId = roomId;
    void perform(leaving ? 'leave' : 'remove', async () => {
      if (!gateway) return;
      await gateway.request('changeRoster', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roomId: targetRoomId,
        targetUid,
        action,
      });
      if (leaving) {
        setStopPolling(true);
        setSnapshot(undefined);
        window.history.pushState({}, '', homePath());
        setRoute({ name: 'home' });
        setNotice('你已退出这个房间，访问权限已立即收回。');
        return;
      }
      setNotice('成员已移除，名单变化已同步。');
      await loadSnapshot(targetRoomId);
    });
  }

  function handleRoomLifecycle(action: 'ARCHIVE' | 'CLOSE' | 'DELETE'): void {
    if (!snapshot || !roomId) return;
    const confirmed = window.confirm({
      ARCHIVE: '归档后房间变为只读，成员不能再提交任何变更；历史内容仍保留。确定归档吗？',
      CLOSE: '关闭后其他成员将立即失去访问权限；未结束的盲评会被取消，进行中的最终确认会失效。你将保留只读历史。确定关闭吗？',
      DELETE: '删除会先执行软关闭：其他成员立即失去访问权限，房间标记为待清理。业务历史不会被本操作直接物理删除。确定删除吗？',
    }[action]);
    if (!confirmed) return;
    const targetRoomId = roomId;
    void perform(`lifecycle-${action}`, async () => {
      if (!gateway) return;
      const command = {
        schemaVersion: 2 as const,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roomId: targetRoomId,
      };
      if (action === 'ARCHIVE') await gateway.request('archiveRoom', command);
      else if (action === 'CLOSE') await gateway.request('closeRoom', command);
      else await gateway.request('deleteRoom', command);
      setNotice({
        ARCHIVE: '房间已归档，历史内容保留且不再接受变更。',
        CLOSE: '房间已关闭，其他成员的访问权限已立即收回。',
        DELETE: '房间已标记删除，软关闭完成，其他成员已失去访问权限。',
      }[action]);
      await loadSnapshot(targetRoomId);
    });
  }

  function handleStartNextCycle(): void {
    if (!snapshot || !roomId) return;
    const confirmed = window.confirm(
      '开始下一轮会保留本周期结果与全部历史，回到收集阶段；现有候选沿用，评价与最终确认需要重新进行。确定开始下一轮吗？',
    );
    if (!confirmed) return;
    const targetRoomId = roomId;
    void perform('next-cycle', async () => {
      if (!gateway) return;
      await gateway.request('startNextCycle', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roomId: targetRoomId,
        nextCycleId: newId(),
      });
      setNotice('下一轮已开始，房间回到收集阶段。');
      await loadSnapshot(targetRoomId);
    });
  }

  function handleTransferHost(targetUid: string): void {
    if (!snapshot || !roomId) return;
    const confirmed = window.confirm('移交后你会变为普通成员，对方获得房主权限。确定移交房主吗？');
    if (!confirmed) return;
    const targetRoomId = roomId;
    void perform(`transfer-${targetUid}`, async () => {
      if (!gateway) return;
      await gateway.request('transferHost', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roomId: targetRoomId,
        targetUid,
      });
      setNotice('房主已移交，你的权限已同步更新。');
      await loadSnapshot(targetRoomId);
    });
  }

  function handleJoin(event: FormEvent): void {
    event.preventDefault();
    const token = joinToken;
    void perform('join', async () => {
      if (!gateway) return;
      window.history.replaceState({}, '', joinPath());
      const joined = await gateway.request('joinRoom', {
        schemaVersion: 2,
        operationId: newId(),
        inviteToken: token,
      });
      setJoinToken('');
      goToRoom(joined.roomId);
      setNotice('已加入房间，现在可以独立输入。');
      await loadSnapshot(joined.roomId);
    });
  }

  function handleSubmitIdea(event: FormEvent): void {
    event.preventDefault();
    if (!snapshot || !roomId) return;
    const targetRoomId = roomId;
    void perform('idea', async () => {
      if (!gateway) return;
      const ideaId = newId();
      await gateway.request('submitIdea', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roomId: targetRoomId,
        ideaId,
        text: ideaText,
        visibility,
      });
      setJustSealedIdeaId(ideaId);
      writeLocal(draftKey('idea', targetRoomId, ownerKey), '');
      setIdeaText('');
      setNotice('你的输入已保存，其他成员在收集结束前看不到原文。');
      await loadSnapshot(targetRoomId);
    });
  }

  function handleSkipIdea(): void {
    if (!snapshot || !roomId) return;
    const targetRoomId = roomId;
    void perform('skip', async () => {
      if (!gateway) return;
      await gateway.request('submitIdeaSkip', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roomId: targetRoomId,
        ideaId: newId(),
      });
      writeLocal(draftKey('idea', targetRoomId, ownerKey), '');
      setIdeaText('');
      setNotice('已记录为本阶段跳过。');
      await loadSnapshot(targetRoomId);
    });
  }

  function handleCloseCollection(): void {
    if (!snapshot || !roomId) return;
    const targetRoomId = roomId;
    const unsubmittedCount = Math.max(0,
      snapshot.shared.memberUids.length
      - snapshot.shared.progress.ideaSubmittedCount
      - snapshot.shared.progress.ideaSkippedCount);
    if (unsubmittedCount > 0 && !window.confirm(`还有 ${unsubmittedCount} 人未提交或跳过，确定结束收集吗？`)) return;
    void perform('close', async () => {
      if (!gateway) return;
      await gateway.request('closeCollection', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        expectedRosterRevision: snapshot.shared.rosterRevision,
        expectedUnsubmittedCount: unsubmittedCount,
        roomId: targetRoomId,
      });
      setNotice('收集已结束，现在可以共同核对候选。');
      await loadSnapshot(targetRoomId);
    });
  }

  function handleCreateCandidate(event: FormEvent): void {
    event.preventDefault();
    if (!snapshot || !roomId) return;
    const targetRoomId = roomId;
    void perform('candidate', async () => {
      if (!gateway) return;
      await gateway.request('createCandidate', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roomId: targetRoomId,
        candidateId: newId(),
        revisionId: newId(),
        title: candidateTitle,
        body: candidateBody,
        sourceIdeaIds,
        templateId: 'general',
        templatePayload: {},
      });
      writeLocal(draftKey('candidate-title', targetRoomId, ownerKey), '');
      writeLocal(draftKey('candidate-body', targetRoomId, ownerKey), '');
      setCandidateTitle('');
      setCandidateBody('');
      setSourceIdeaIds([]);
      setNotice('候选方案已保存。');
      await loadSnapshot(targetRoomId);
    });
  }

  function handleSuggestCandidates(): void {
    if (!snapshot || !roomId) return;
    const targetRoomId = roomId;
    void perform('ai-suggest', async () => {
      if (!gateway) return;
      const result = await gateway.request('suggestCandidates', { roomId: targetRoomId });
      setAiSuggestions(result.suggestions);
      setNotice('AI 建议已生成，仅供核对，尚未写入任何候选。');
    });
  }

  function applySuggestion(suggestion: CandidateSuggestion): void {
    if (!canEditCandidates) return;
    updateCandidateTitle(suggestion.title);
    updateCandidateBody(suggestion.body);
    setSourceIdeaIds(suggestion.sourceIdeaIds);
    setNotice('已填入新增候选表单，尚未创建；请核对来源和内容后手动提交。');
  }

  function handleAskAssistant(action: RoomAssistantAction): void {
    if (!snapshot || !roomId) return;
    const question = action === 'ASK' ? assistantQuestion.trim() : undefined;
    if (action === 'ASK' && !question) return;
    if (!window.confirm('提问和 AI 回答会作为房间消息对所有当前成员可见，确定提交吗？')) return;
    const targetRoomId = roomId;
    setAssistantError('');
    void perform(`assistant-${action}`, async () => {
      if (!gateway) return;
      const result = await gateway.request('askRoomAssistant', {
        schemaVersion: 2,
        roomId: targetRoomId,
        requestId: newId(),
        action,
        ...(question !== undefined ? { question } : {}),
        expectedSnapshotVersion: snapshot.version,
      });
      setAssistantMessages(current => [
        result.message,
        ...current.filter(item => item.id !== result.message.id),
      ]);
      if (action === 'ASK') setAssistantQuestion('');
      setNotice(result.message.stale || result.message.status === 'STALE'
        ? 'AI 回答已生成，但房间内容已变化，已标记过期；请刷新后核对。'
        : 'AI 回答已生成，仅供核对；不会写入候选、票或最终结果。');
    }, setAssistantError);
  }

  function assistantSourceLabel(sourceId: string): string {
    if (!snapshot) return '来源';
    const idea = snapshot.shared.publicIdeas.find(item => item.id === sourceId);
    if (idea) return `公开想法「${idea.text.slice(0, 18)}」`;
    const revision = snapshot.shared.currentRevisions.find(item => item.id === sourceId);
    if (revision) return `候选「${revision.title}」`;
    const comment = snapshot.shared.comments.find(item => item.id === sourceId);
    if (comment) return `公开评论「${comment.body.slice(0, 18)}」`;
    const record = snapshot.shared.decisionRecords.find(item => item.id === sourceId);
    if (record) return `历史结果 ${record.outcome}`;
    if (sourceId.startsWith('eval_')) return '已揭示评价';
    return '来源';
  }

  function handleWithdrawCandidate(candidateId: string): void {
    if (!snapshot || !roomId || !window.confirm('确定撤回这个候选吗？此操作会保留历史记录。')) return;
    const targetRoomId = roomId;
    void perform(`withdraw-${candidateId}`, async () => {
      if (!gateway) return;
      await gateway.request('withdrawCandidate', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        candidateId,
      });
      setNotice('候选已撤回。');
      await loadSnapshot(targetRoomId);
    });
  }

  function handleReviseCandidate(event: FormEvent, candidate: Candidate, revision: CandidateRevision): void {
    event.preventDefault();
    if (!snapshot || !roomId) return;
    const targetRoomId = roomId;
    const draft = revisionDrafts[candidate.id] ?? { title: revision.title, body: revision.body };
    void perform(`revise-${candidate.id}`, async () => {
      if (!gateway) return;
      const template = revision.templateId === 'activity'
        ? { templateId: 'activity' as const, templatePayload: revision.templatePayload }
        : { templateId: 'general' as const, templatePayload: {} };
      const result = await gateway.request('reviseCandidate', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        candidateId: candidate.id,
        revisionId: newId(),
        title: draft.title,
        body: draft.body,
        sourceIdeaIds: revision.sourceIdeaIds,
        ...template,
      });
      writeLocal(revisionDraftKey('title', targetRoomId, ownerKey, candidate.id), '');
      writeLocal(revisionDraftKey('body', targetRoomId, ownerKey, candidate.id), '');
      setRevisionDrafts(current => {
        const next = { ...current };
        delete next[candidate.id];
        return next;
      });
      setReopenTargetRevisionIds([]);
      setNotice(result.substantive
        ? `候选已保存为版本 ${result.revision}，可仅选择这个版本申请局部重评。`
        : '候选内容已核对，没有产生需要重评的实质变化。');
      await loadSnapshot(targetRoomId);
    });
  }

  function handleRequestReopen(event: FormEvent): void {
    event.preventDefault();
    if (!snapshot || !roomId || reopenTargetRevisionIds.length === 0) return;
    const targetRoomId = roomId;
    void perform('request-reopen', async () => {
      if (!gateway) return;
      await gateway.request('requestReopen', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roomId: targetRoomId,
        requestId: newId(),
        roundId: newId(),
        expectedRosterRevision: snapshot.shared.rosterRevision,
        targetRevisionIds: reopenTargetRevisionIds,
      });
      setReopenTargetRevisionIds([]);
      setNotice('重开申请已发起，并已记入你的支持票；达到多数后才会开始局部重评。');
      await loadSnapshot(targetRoomId);
    });
  }

  function handleVoteReopen(choice: 'REOPEN' | 'KEEP_DISCUSSING'): void {
    const request = snapshot?.shared.activeReopen;
    if (!snapshot || !request) return;
    void perform(`vote-reopen-${choice}`, async () => {
      if (!gateway) return;
      const result = await gateway.request('voteReopen', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        requestId: request.requestId,
        choice,
      });
      setNotice(result.phase === 'EVALUATING'
        ? '重开支持已达到多数，仅所选候选版本进入新一轮独立评价。'
        : choice === 'REOPEN'
          ? `已支持局部重评，当前 ${result.reopenVoteCount} / ${result.majorityThreshold} 票。`
          : `已撤回本人的重开支持，当前 ${result.reopenVoteCount} / ${result.majorityThreshold} 票。`);
      if (roomId) await loadSnapshot(roomId);
    });
  }

  function handleCancelReopen(): void {
    const request = snapshot?.shared.activeReopen;
    if (!snapshot || !request || !window.confirm('确定取消这次重开申请吗？已投支持不会开启新轮。')) return;
    void perform('cancel-reopen', async () => {
      if (!gateway) return;
      await gateway.request('cancelReopen', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        requestId: request.requestId,
      });
      setNotice('重开申请已取消，当前已揭示评价仍然保留。');
      if (roomId) await loadSnapshot(roomId);
    });
  }

  function handleProposeFinal(event: FormEvent): void {
    event.preventDefault();
    if (!snapshot || !roomId) return;
    const targetRoomId = roomId;
    const candidateRevisionId = finalCandidateRevisionId
      || snapshot.shared.candidates.find(candidate => candidate.withdrawnAt === null)?.currentRevisionId;
    const revision = snapshot.shared.currentRevisions.find(item => item.id === candidateRevisionId);
    const deadline = new Date(finalDeadlineInput);
    if (!revision || !candidateRevisionId) {
      setError('请选择一个有效候选的当前版本。');
      return;
    }
    if (!finalDeadlineInput || Number.isNaN(deadline.getTime())
      || deadline.getTime() < Date.now() + 5 * 60_000
      || deadline.getTime() > Date.now() + 7 * 24 * 60 * 60_000) {
      setError('最终确认截止时间必须在当前时间的 5 分钟至 7 天之间。');
      return;
    }
    if (!window.confirm(`确定对“${revision.title}”版本 ${revision.revision} 发起最终确认吗？名单、版本和截止时间发起后不可修改。`)) return;
    void perform('propose-final', async () => {
      if (!gateway) return;
      await gateway.request('proposeFinal', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roomId: targetRoomId,
        proposalId: newId(),
        candidateRevisionId,
        deadlineAt: deadline.toISOString(),
      });
      setNotice('最终确认已发起；只有冻结名单全员明确接受，才会形成已达成共识的结果。');
      await loadSnapshot(targetRoomId);
    });
  }

  function handleRespondFinal(choice: 'ACCEPT' | 'DECLINE' | 'ABSTAIN'): void {
    const proposal = snapshot?.mine.activeProposal;
    if (!snapshot || !proposal || !roomId) return;
    const targetRoomId = roomId;
    void perform(`respond-final-${choice}`, async () => {
      if (!gateway) return;
      const result = await gateway.request('respondFinal', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        proposalId: proposal.id,
        candidateRevisionId: proposal.candidateRevisionSnapshot.id,
        choice,
      });
      setNotice(result.proposalStatus === 'AGREED'
        ? '冻结名单已全员明确接受，共识结果已原子保存。'
        : `本人最终响应已保存为${choice === 'ACCEPT' ? '明确接受' : choice === 'DECLINE' ? '明确拒绝' : '弃权'}；截止前可改票。`);
      await loadSnapshot(targetRoomId);
    });
  }

  function handleCloseUnresolved(): void {
    const proposal = snapshot?.mine.activeProposal;
    if (!snapshot || !proposal || !roomId) return;
    if (!window.confirm('确定结束为未达成共识吗？系统会保存当前四项聚合计数，不会把候选标记为已采用。')) return;
    const targetRoomId = roomId;
    void perform('close-unresolved', async () => {
      if (!gateway) return;
      await gateway.request('closeUnresolved', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        proposalId: proposal.id,
      });
      setNotice('本次确认已结束为未达成共识，结果记录已保存。');
      await loadSnapshot(targetRoomId);
    });
  }

  async function copyDecisionRecord(record: RoomSnapshot['shared']['decisionRecords'][number]): Promise<void> {
    if (!snapshot) return;
    const revision = record.candidateRevisionSnapshot;
    const text = [
      `房间：${snapshot.shared.title}`,
      `结果：${record.outcome === 'AGREED' ? '已达成共识' : '未达成共识（未采用候选）'}`,
      `确认候选：${revision ? `${revision.title}（版本 ${revision.revision}，${revision.id}）` : '无'}`,
      `冻结名单：${record.rosterSnapshot.length} 人`,
      `明确接受 ${record.responseSummary.accepted}；明确拒绝 ${record.responseSummary.declined}；弃权 ${record.responseSummary.abstained}；未响应 ${record.responseSummary.pending}`,
      `结果时间：${record.createdAt}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setNotice('公开结果已复制，不包含私密输入、草稿或私密评论。');
    } catch {
      setError('复制失败，请稍后重试。');
    }
  }

  function handleOpenEvaluation(): void {
    if (!snapshot || !roomId) return;
    const targetRoomId = roomId;
    const targetRevisionIds = snapshot.shared.candidates
      .filter(candidate => candidate.withdrawnAt === null)
      .map(candidate => candidate.currentRevisionId);
    if (targetRevisionIds.length === 0) {
      setError('请至少保留一个有效候选，再开始评价。');
      return;
    }
    void perform('open-evaluation', async () => {
      if (!gateway) return;
      await gateway.request('openEvaluation', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        expectedRosterRevision: snapshot.shared.rosterRevision,
        roomId: targetRoomId,
        roundId: newId(),
        targetRevisionIds,
      });
      setNotice('独立评价已开始；统一揭示前，其他成员看不到你的评价内容。');
      await loadSnapshot(targetRoomId);
    });
  }

  function handleSubmitEvaluation(event: FormEvent, candidateRevisionId: string): void {
    event.preventDefault();
    const round = snapshot?.shared.activeEvaluationRound;
    if (!snapshot || !round || !roomId) return;
    const targetRoomId = roomId;
    const draft = evaluationDrafts[candidateRevisionId] ?? EMPTY_EVALUATION_DRAFT;
    if (!draft.attitude && !draft.score) {
      setError('请至少选择态度或评分；也可以明确跳过这个候选。');
      return;
    }
    void perform(`evaluation-${candidateRevisionId}`, async () => {
      if (!gateway) return;
      await gateway.request('submitEvaluation', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roundId: round.id,
        candidateRevisionId,
        submissionState: 'EVALUATED',
        ...(draft.attitude ? { attitude: draft.attitude } : {}),
        score: draft.score ? Number(draft.score) : null,
        reason: draft.reason.trim(),
      });
      removeStoredEvaluationDraft(round.id, candidateRevisionId);
      setNotice('评价已保存；其他成员仍只能看到安全进度，结束后才会统一揭示。');
      await loadSnapshot(targetRoomId);
    });
  }

  function handleSkipEvaluation(candidateRevisionId: string): void {
    const round = snapshot?.shared.activeEvaluationRound;
    if (!snapshot || !round || !window.confirm('确定跳过这个候选吗？已保存的评价会被替换为跳过。')) return;
    void perform(`skip-evaluation-${candidateRevisionId}`, async () => {
      if (!gateway) return;
      await gateway.request('submitEvaluation', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roundId: round.id,
        candidateRevisionId,
        submissionState: 'SKIPPED',
      });
      removeStoredEvaluationDraft(round.id, candidateRevisionId);
      setEvaluationDrafts(current => ({ ...current, [candidateRevisionId]: EMPTY_EVALUATION_DRAFT }));
      setNotice('已明确跳过这个候选，统一揭示时会显示为“跳过”。');
      if (roomId) await loadSnapshot(roomId);
    });
  }

  function handleCloseEvaluation(): void {
    const round = snapshot?.shared.activeEvaluationRound;
    if (!snapshot || !round || !roomId) return;
    const targetRoomId = roomId;
    const incompleteCount = Math.max(0, round.rosterUids.length - snapshot.shared.progress.evaluationCompletedCount);
    if (!window.confirm(`还有 ${incompleteCount} 人未完成全部候选评价，确定结束并统一揭示吗？`)) return;
    void perform('close-evaluation', async () => {
      if (!gateway) return;
      await gateway.request('closeEvaluation', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roundId: round.id,
        expectedIncompleteCount: incompleteCount,
      });
      setNotice('本轮评价已结束，现在所有成员看到同一批已揭示评价。');
      await loadSnapshot(targetRoomId);
    });
  }

  function handleVoteRoundClose(): void {
    const round = snapshot?.shared.activeEvaluationRound;
    if (!snapshot || !round || !roomId) return;
    const targetRoomId = roomId;
    void perform('vote-round-close', async () => {
      if (!gateway) return;
      const result = await gateway.request('voteRoundClose', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roundId: round.id,
      });
      setNotice(result.roundStatus === 'CLOSED'
        ? '结束票已达到多数，本轮评价已结束并统一揭示。'
        : `已投出结束票，当前 ${result.endVoteCount} / ${result.majorityThreshold} 票。`);
      await loadSnapshot(targetRoomId);
    });
  }

  function handleRetractRoundCloseVote(): void {
    const round = snapshot?.shared.activeEvaluationRound;
    if (!snapshot || !round || !roomId) return;
    const targetRoomId = roomId;
    void perform('retract-round-close', async () => {
      if (!gateway) return;
      const result = await gateway.request('retractRoundCloseVote', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roundId: round.id,
      });
      setNotice(`已撤回本人的结束票，当前 ${result.endVoteCount} / ${result.majorityThreshold} 票。`);
      await loadSnapshot(targetRoomId);
    });
  }

  function handleSetRoundDeadline(event: FormEvent): void {
    event.preventDefault();
    const round = snapshot?.shared.activeEvaluationRound;
    if (!snapshot || !round || !roomId) return;
    const targetRoomId = roomId;
    const deadline = new Date(roundDeadlineInput);
    if (!roundDeadlineInput || Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()
      || (round.deadlineAt !== undefined && deadline.getTime() <= Date.parse(round.deadlineAt))) {
      setError('截止时间必须晚于当前时间；已有截止时间时，只能严格延长。');
      return;
    }
    if (!roundDeadlineReason.trim()) {
      setError('请填写设置或延长截止时间的原因。');
      return;
    }
    const extending = round.deadlineAt !== undefined;
    void perform('round-deadline', async () => {
      if (!gateway) return;
      await gateway.request('setRoundDeadline', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roundId: round.id,
        deadlineAt: deadline.toISOString(),
        reason: roundDeadlineReason,
      });
      setRoundDeadlineInput('');
      setRoundDeadlineReason('');
      setNotice(extending ? '截止时间已延长，原因已同步给房间成员。' : '截止时间已设置，不再接受新的结束票。');
      await loadSnapshot(targetRoomId);
    });
  }

  function saveComposerComment(publicationState: 'DRAFT' | 'PUBLISHED'): void {
    if (!snapshot || !roomId) return;
    const candidate = commentCandidateId
      ? snapshot.shared.candidates.find(item => item.id === commentCandidateId)
      : undefined;
    submitComment({
      commentId: newId(),
      body: commentBody,
      visibility: commentVisibility,
      ...(candidate ? {
        candidateId: candidate.id,
        candidateRevisionId: candidate.currentRevisionId,
      } : {}),
    }, publicationState, true);
  }

  function handleComment(event: FormEvent): void {
    event.preventDefault();
    saveComposerComment(snapshot?.shared.phase === 'EVALUATING' ? 'DRAFT' : 'PUBLISHED');
  }

  function publishSavedComment(comment: RoomComment): void {
    submitComment({
      commentId: comment.id,
      body: comment.body,
      visibility: comment.visibility,
      ...(comment.candidateId && comment.candidateRevisionId ? {
        candidateId: comment.candidateId,
        candidateRevisionId: comment.candidateRevisionId,
      } : {}),
    }, 'PUBLISHED');
  }

  function submitComment(
    comment: {
      commentId: string;
      body: string;
      visibility: 'PUBLIC' | 'PRIVATE';
      candidateId?: string;
      candidateRevisionId?: string;
    },
    publicationState: 'DRAFT' | 'PUBLISHED',
    clearComposer = false,
  ): void {
    if (!snapshot || !roomId) return;
    const targetRoomId = roomId;
    const busyLabel = `comment-${publicationState}-${comment.commentId}`;
    void perform(busyLabel, async () => {
      if (!gateway) return;
      await gateway.request('addComment', {
        schemaVersion: 2,
        operationId: newId(),
        expectedDecisionRevision: snapshot.shared.decisionRevision,
        roomId: targetRoomId,
        commentId: comment.commentId,
        ...(comment.candidateId && comment.candidateRevisionId ? {
          candidateId: comment.candidateId,
          candidateRevisionId: comment.candidateRevisionId,
        } : {}),
        body: comment.body,
        visibility: comment.visibility,
        publicationState,
      });
      if (clearComposer) {
        writeLocal(draftKey('comment', targetRoomId, ownerKey), '');
        setCommentBody('');
        setCommentCandidateId('');
      }
      setNotice(publicationState === 'DRAFT'
        ? '评论草稿已保存，仅自己可见；不会随统一揭示自动公开。'
        : comment.visibility === 'PUBLIC'
          ? '评论已显式发布，房间成员现在可以看到。'
          : '私密评论已发布，仍然仅自己可见。');
      await loadSnapshot(targetRoomId);
    });
  }

  function updateCommentDraft(value: string): void {
    setCommentBody(value);
    if (roomId && snapshot) writeLocal(draftKey('comment', roomId, ownerKey), value);
  }

  function updateEvaluationDraft(candidateRevisionId: string, patch: Partial<EvaluationDraft>): void {
    const round = snapshot?.shared.activeEvaluationRound;
    if (!round || !roomId) return;
    setEvaluationDrafts(current => {
      const nextDraft = { ...EMPTY_EVALUATION_DRAFT, ...current[candidateRevisionId], ...patch };
      const stored = readEvaluationDrafts(evaluationDraftKey(roomId, ownerKey, round.id));
      stored[candidateRevisionId] = nextDraft;
      writeLocal(evaluationDraftKey(roomId, ownerKey, round.id), JSON.stringify(stored));
      return { ...current, [candidateRevisionId]: nextDraft };
    });
  }

  function removeStoredEvaluationDraft(roundId: string, candidateRevisionId: string): void {
    if (!roomId) return;
    const key = evaluationDraftKey(roomId, ownerKey, roundId);
    const stored = readEvaluationDrafts(key);
    delete stored[candidateRevisionId];
    writeLocal(key, Object.keys(stored).length > 0 ? JSON.stringify(stored) : '');
  }

  function changeIdentity(identity: DevIdentity): void {
    setDevIdentity(identity);
    window.location.reload();
  }

  function updateIdeaDraft(value: string): void {
    setIdeaText(value);
    if (roomId && snapshot) writeLocal(draftKey('idea', roomId, ownerKey), value);
  }

  function updateCandidateTitle(value: string): void {
    setCandidateTitle(value);
    if (roomId && snapshot) writeLocal(draftKey('candidate-title', roomId, ownerKey), value);
  }

  function updateCandidateBody(value: string): void {
    setCandidateBody(value);
    if (roomId && snapshot) writeLocal(draftKey('candidate-body', roomId, ownerKey), value);
  }

  function updateRevisionDraft(candidate: Candidate, revision: CandidateRevision, patch: Partial<RevisionDraft>): void {
    if (!roomId || !snapshot) return;
    setRevisionDrafts(current => {
      const nextDraft = {
        title: revision.title,
        body: revision.body,
        ...current[candidate.id],
        ...patch,
      };
      if (patch.title !== undefined) {
        writeLocal(revisionDraftKey('title', roomId, ownerKey, candidate.id), patch.title);
      }
      if (patch.body !== undefined) {
        writeLocal(revisionDraftKey('body', roomId, ownerKey, candidate.id), patch.body);
      }
      return { ...current, [candidate.id]: nextDraft };
    });
  }

  const shared = snapshot?.shared;
  const ownIdea = snapshot?.mine.ideas.find(idea => idea.cycleId === snapshot.shared.currentCycleId);
  const activeCandidates = shared?.candidates.filter(candidate => candidate.withdrawnAt === null) ?? [];
  const activeRound = shared?.activeEvaluationRound;
  const incompleteEvaluationCount = shared && activeRound
    ? Math.max(0, activeRound.rosterUids.length - shared.progress.evaluationCompletedCount)
    : 0;
  const activeRoundClose = shared?.activeRoundClose && shared.activeRoundClose.roundId === activeRound?.id
    ? shared.activeRoundClose
    : undefined;
  const ownRoundCloseVote = snapshot?.mine.roundCloseVote?.roundId === activeRound?.id;
  const activeReopen = shared?.phase === 'DISCUSSING' ? shared.activeReopen : undefined;
  const ownReopenVote = activeReopen && snapshot?.mine.reopenVote?.requestId === activeReopen.requestId
    ? snapshot.mine.reopenVote
    : undefined;
  const activeProposal = shared?.phase === 'CONFIRMING' ? snapshot?.mine.activeProposal : undefined;
  const ownFinalResponse = activeProposal
    ? snapshot?.mine.finalResponses.find(response => response.proposalId === activeProposal.id)
    : undefined;
  const selectedFinalCandidateRevisionId = finalCandidateRevisionId || activeCandidates[0]?.currentRevisionId || '';
  const activeDeadlineEvent = shared?.events.filter(event =>
    event.type === 'ROUND_DEADLINE_CHANGED' && event.roundId === activeRound?.id).at(-1);
  const revealedRevisions = shared?.currentRevisions.filter(revision =>
    activeCandidates.some(candidate => candidate.currentRevisionId === revision.id)
    || shared.revealedEvaluations.some(evaluation => evaluation.candidateRevisionId === revision.id)) ?? [];
  const unsubmittedCount = shared ? Math.max(0,
    shared.memberUids.length - shared.progress.ideaSubmittedCount - shared.progress.ideaSkippedCount) : 0;
  const guide = (() => {
    if (!shared) return { index: 0, title: '', hint: '' };
    if (shared.phase === 'COLLECTING') {
      if (!ownIdea) return {
        index: 0,
        title: '先写下你的想法',
        hint: isHost ? '也可以先生成邀请链接。' : '提交前彼此看不到。',
      };
      if (shared.memberUids.length < 2) {
        return {
          index: 1,
          title: isHost ? '邀请另一位伙伴加入' : '等待房主邀请伙伴',
          hint: isHost ? '至少需要 2 名成员。' : '等待伙伴加入。',
        };
      }
      return {
        index: 2,
        title: isHost ? '确认进度并结束收集' : '等待房主结束收集',
        hint: isHost ? '未提交会按实际缺失保留。' : '等待房主结束收集。',
      };
    }
    if (shared.phase === 'CANDIDATE_REVIEW') return { index: 3, title: '整理候选方案', hint: FLOW_HINTS.CANDIDATE_REVIEW };
    if (shared.phase === 'EVALUATING') return { index: 4, title: '独立评价候选', hint: FLOW_HINTS.EVALUATING };
    if (shared.phase === 'DISCUSSING') return { index: 5, title: '讨论并决定下一步', hint: FLOW_HINTS.DISCUSSING };
    if (shared.phase === 'CONFIRMING') return { index: 6, title: '对最终版本作出回应', hint: FLOW_HINTS.CONFIRMING };
    return { index: 7, title: '查看结果', hint: FLOW_HINTS.COMPLETED };
  })();
  const previousStepRef = useRef(guide.index);
  const stepDirection = guide.index >= previousStepRef.current ? 'forward' : 'back';
  useEffect(() => {
    previousStepRef.current = guide.index;
  }, [guide.index]);

  const roomLoading = route.name === 'room' && !snapshot;
  const seated = roomLoading || route.name === 'join' || (route.name === 'home' && entryCard !== null);
  const camelotCollection = shared?.roomStatus === 'ACTIVE' && shared.phase === 'COLLECTING' && !presentMode;
  const camelotReveal = shared?.roomStatus === 'ACTIVE' && shared.phase === 'CANDIDATE_REVIEW' && !presentMode;
  const cycleKey = shared ? `${shared.roomId}/${shared.currentCycleId}` : undefined;
  const collectedCycle = useRef<string | undefined>(undefined);
  const [revealCycle, setRevealCycle] = useState<string>();
  useEffect(() => {
    if (shared?.phase === 'COLLECTING') collectedCycle.current = cycleKey;
    if (shared?.phase === 'CANDIDATE_REVIEW' && cycleKey && collectedCycle.current === cycleKey) {
      collectedCycle.current = undefined;
      setRevealCycle(cycleKey);
    }
  }, [cycleKey, shared?.phase]);
  const roomScene = shared && snapshot && shared.roomStatus === 'ACTIVE' ? (
    <div className="scene-stage">
      <Suspense fallback={null}>
        <RoundTable memberCount={shared.memberUids.length}
          myIndex={Math.max(0, shared.memberUids.indexOf(snapshot.mine.uid))}
          stepKey={guide.index} />
      </Suspense>
    </div>
  ) : null;

  return (
    <div className={route.name === 'room' && !roomLoading ? 'app-shell' : `app-shell camelot-shell${seated ? ' camelot-seated' : ''}`}>
      {(route.name !== 'room' || roomLoading) && (
        <>
          <img className="camelot-backdrop" src={camelotAsset('council.png')} alt="" />
          <img className="camelot-backdrop camelot-seat-backdrop"
            src={camelotAsset('seat.png')} alt="" decoding="async" />
        </>
      )}
      {route.name === 'home' && new URLSearchParams(window.location.search).get('entrance') === '1' && (
        <CamelotEntrance />
      )}
      <header className="topbar">
        <a className="brand" href={homePath()} aria-label="共契首页">
          <img className="brand-mark" src={camelotAsset('gongqi-seal.svg')} width="42" height="42" alt="" />
          <strong>共契</strong>
        </a>
        {__GQ_DEV_FIXTURE__ && (
          <label className="identity-picker">本地测试身份
            <select value={getDevIdentity()} onChange={event => changeIdentity(event.target.value as DevIdentity)}>
              <option value="host">身份一</option>
              <option value="member">身份二</option>
            </select>
          </label>
        )}
      </header>

      <main>
        {!shared && error && <div className="message error" role="alert">{error}</div>}
        {!shared && notice && <div className="message success" role="status">{notice}</div>}

        {route.name !== 'room' && (
          <section className="hero">
            {!seated && <p className="eyebrow">共契 · CAMELOT</p>}
            <h1>圆桌议事厅</h1>
          </section>
        )}

        {route.name === 'home' && (
          <CamelotSeat card={entryCard} onChoose={setEntryCard}>
            {entryCard === 'create' && (
            <section className="panel">
              <p className="step">01 · 创建房间</p>
              <h2 tabIndex={-1}>发起一次共同决策</h2>
              <form onSubmit={handleCreate}>
                <label htmlFor="room-title">要决定什么</label>
                <VoiceField id="room-title" value={title} onValueChange={value => setTitle(value)}
                  maxLength={80} required placeholder="例如：周末两天怎么安排" />
                <label htmlFor="room-purpose">希望达成什么</label>
                <VoiceField multiline id="room-purpose" value={purpose} onValueChange={value => setPurpose(value)}
                  maxLength={500} required placeholder="例如：找到两个人都愿意参加的安排" />
                <button type="submit" disabled={!gateway || Boolean(busy)}>{busy === 'create' ? '正在创建…' : '创建并生成邀请'}</button>
              </form>
            </section>
            )}
            {entryCard === 'join' && (
            <JoinPanel token={joinToken} setToken={setJoinToken} onSubmit={handleJoin}
              disabled={!gateway || Boolean(busy)} busy={busy === 'join'} />
            )}
          </CamelotSeat>
        )}

        {route.name === 'join' && (
          <CamelotSeat card="join">
            <JoinPanel token={joinToken} setToken={setJoinToken} onSubmit={handleJoin}
              disabled={!gateway || Boolean(busy)} busy={busy === 'join'} />
          </CamelotSeat>
        )}

        {route.name === 'room' && !snapshot && (
          <section className="panel loading-panel camelot-loading-panel" aria-live="polite">
            <p className="eyebrow">卡美洛 · 圆桌议事厅</p>
            {membershipLost ? (
              <>
                <h1>你已不在这个房间</h1>
                <p>房主已将你移出、房间已关闭，或成员名单已更新。你不能再读取或提交房间内容。</p>
                <div className="button-row">
                  <a className="button" href={homePath()}>返回首页</a>
                </div>
              </>
            ) : (
              <>
                <h1>{stopPolling ? '暂时无法打开房间' : '正在入席…'}</h1>
                <p>{stopPolling ? '可以重新读取房间，或返回议事厅首页。' : '正在准备你的圆桌席位。'}</p>
                <div className="button-row">
                  <button type="button" onClick={() => roomId && void loadSnapshot(roomId)} disabled={!gateway}>重新读取</button>
                  <a className="button secondary" href={homePath()}>返回首页</a>
                </div>
              </>
            )}
          </section>
        )}

        {snapshot && shared && roomId && (
          <div className={`room-layout camelot-room${shared.roomStatus === 'ACTIVE' ? ' wizard' : ''}${presentMode ? ' present' : ''}`}
            style={presentMode ? undefined : { backgroundImage: `linear-gradient(#160d22a6, #160d2259 45%, #160d22d9), url("${camelotAsset('seat.png')}")` }}>
            <section className="room-heading">
              <div>
                <p className="eyebrow">{presentMode && '演示模式 · '}<span>{PHASE_LABELS[shared.phase]}</span> · <span>{shared.memberUids.length} 位成员</span></p>
                <h1>{shared.title}</h1>
                <p>{shared.purpose}</p>
              </div>
              <div className="room-meta" aria-label="房间操作">
                {shared.roomStatus === 'ACTIVE' && (
                  <>
                    {presentMode && <button className="text-button" type="button" aria-pressed="true"
                      onClick={() => setPresentMode(false)}>
                      退出演示
                    </button>}
                    <button className="text-button" type="button" onClick={() => setToolsOpen(true)}>房间信息</button>
                  </>
                )}
              </div>
            </section>

            {shared.roomStatus !== 'ACTIVE' && (
              <div className="message warning" role="status">
                {shared.roomStatus === 'ARCHIVED'
                  ? '房间已归档，仅供查看历史内容，不再接受任何变更。'
                  : shared.roomStatus === 'CLOSED'
                    ? '房间已关闭，其他成员的访问权限已收回；当前仅保留只读历史。'
                    : '房间已标记删除，软关闭完成；当前仅保留只读历史。'}
              </div>
            )}

            {shared.roomStatus === 'ACTIVE' && (
              <div className="elder-line">
                <span className="elder-mark">长老</span>
                <p>{ELDER_LINES[guide.index]}</p>
              </div>
            )}

            <div className={`wizard-step ${stepDirection}`} key={guide.index}>
            <section className="flow-bar" aria-label="当前步骤">
              <p className="flow-count">第 {guide.index + 1} 步 · 共 {GUIDE_STEPS.length} 步</p>
              <h2 className="flow-title">{guide.title}</h2>
              <p className="flow-hint">{guide.hint}</p>
              <ol className="flow-dots" aria-hidden="true">
                {GUIDE_STEPS.map((step, index) => (
                  <li key={step}
                    className={index < guide.index ? 'done' : index === guide.index ? 'current' : 'todo'} />
                ))}
              </ol>
            </section>
            {(error || notice || stale) && (
              <div className="camelot-room-feedback">
                {error && <div className="message error" role="alert">{error}</div>}
                {notice && <div className="message success" role="status">{notice}</div>}
                {stale && <div className="message warning" role="status">当前显示上次成功的快照；连接恢复后会自动补拉。</div>}
              </div>
            )}
            {camelotCollection && isHost && !ownIdea && shared.memberUids.length < 2 && (
              <div className="camelot-room-invite">
                <span>对面的席位还空着</span>
                <button type="button" className="text-button" onClick={() => setToolsOpen(true)}>邀请伙伴</button>
              </div>
            )}

            {isHost && ownIdea && shared.roomStatus === 'ACTIVE' && shared.phase === 'COLLECTING' && shared.memberUids.length < 2 && (
              <section className="panel invite-panel compact">
                <div>
                  <p className="step">邀请成员</p>
                  <h2>让另一个人加入</h2>
                  <p>加入后地址中的 token 会立即清除。</p>
                </div>
                {inviteLink && (
                  <div className="invite-link">
                    <label htmlFor="invite-link">本次邀请链接</label>
                    <div className="copy-row">
                      <input id="invite-link" readOnly value={inviteLink} onFocus={event => event.target.select()} />
                      <button type="button" className="secondary" onClick={() => void navigator.clipboard.writeText(inviteLink)
                        .then(() => setNotice('邀请链接已复制。'))
                        .catch(() => setError('复制失败，请手动选中邀请链接复制。'))}>复制</button>
                    </div>
                  </div>
                )}
                <button type="button" className="secondary" onClick={handleRotateInvite} disabled={Boolean(busy)}>
                  {busy === 'invite' ? '正在轮换…' : inviteLink ? '轮换邀请链接' : '生成邀请链接'}
                </button>
              </section>
            )}

            {(shared.roomStatus === 'ACTIVE' || shared.roomStatus === 'ARCHIVED') && (
              <>
              {shared.roomStatus === 'ACTIVE' && toolsOpen && (
                <button type="button" className="drawer-backdrop" aria-label="关闭房间信息" onClick={() => setToolsOpen(false)} />
              )}
              <aside className={`wizard-drawer${shared.roomStatus !== 'ACTIVE' || toolsOpen ? ' open' : ''}`}
                aria-hidden={shared.roomStatus === 'ACTIVE' && !toolsOpen}>
                <div className="drawer-head">
                  <h2>房间信息</h2>
                  {shared.roomStatus === 'ACTIVE' && (
                    <button type="button" className="text-button" onClick={() => setToolsOpen(false)}>关闭</button>
                  )}
                </div>
              {shared.roomStatus === 'ACTIVE' && (
                <div className="camelot-room-tools">
                  <button className="text-button" type="button" onClick={() => void loadSnapshot(roomId)}>刷新房间</button>
                  {!presentMode && <button className="text-button" type="button" onClick={() => { setToolsOpen(false); setPresentMode(true); }}>演示模式</button>}
                </div>
              )}
              {isHost && shared.roomStatus === 'ACTIVE' && shared.memberUids.length < 6
                && guide.index !== 1 && (
                <section className="panel invite-panel">
                  <div>
                    <p className="step">邀请成员</p>
                    <h2>邀请伙伴加入</h2>
                    <p>生成链接发给对方；加入后地址中的 token 会立即清除。</p>
                  </div>
                  <button type="button" className="secondary" onClick={handleRotateInvite} disabled={Boolean(busy)}>
                    {busy === 'invite' ? '正在生成…' : '生成新的邀请链接'}
                  </button>
                  {inviteLink && (
                    <div className="invite-link">
                      <label htmlFor="invite-link-more">本次邀请链接</label>
                      <div className="copy-row">
                        <input id="invite-link-more" readOnly value={inviteLink} onFocus={event => event.target.select()} />
                        <button type="button" className="secondary" onClick={() => void navigator.clipboard.writeText(inviteLink)
                          .then(() => setNotice('邀请链接已复制。'))
                          .catch(() => setError('复制失败，请手动选中邀请链接复制。'))}>复制</button>
                      </div>
                    </div>
                  )}
                </section>
              )}
              {shared.roomStatus === 'ACTIVE' && (
              <section className="panel member-panel">
                <div className="section-heading">
                  <div><p className="step">房间成员</p><h2>当前名单</h2></div>
                  {!isHost && (
                    <button type="button" className="secondary" onClick={() => handleChangeMember(snapshot.mine.uid, 'LEAVE')}
                      disabled={Boolean(busy)}>
                      {busy === 'leave' ? '正在退出…' : '退出房间'}
                    </button>
                  )}
                </div>
                <ul className="member-list">
                  {shared.memberUids.map((uid, index) => (
                    <li key={uid}>
                      <span>
                        {uid === shared.hostUid ? '房主' : `成员 ${index + 1}`}
                        {uid === snapshot.mine.uid ? '（我）' : ''}
                        <code>{uid}</code>
                      </span>
                      {isHost && uid !== snapshot.mine.uid && (
                        <>
                          <button type="button" className="text-button" onClick={() => handleTransferHost(uid)}
                            disabled={Boolean(busy)}>
                            {busy === `transfer-${uid}` ? '正在移交…' : '移交房主'}
                          </button>
                          <button type="button" className="text-button" onClick={() => handleChangeMember(uid, 'REMOVE')}
                            disabled={Boolean(busy)}>
                            {busy === 'remove' ? '正在移除…' : '移除'}
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {isHost && (shared.roomStatus === 'ACTIVE' || shared.roomStatus === 'ARCHIVED') && (
              <section className="panel lifecycle-panel">
                <div className="section-heading">
                  <div><p className="step">房间生命周期</p><h2>归档、关闭或删除</h2></div>
                </div>
                <div className="button-row">
                  <button type="button" className="secondary" onClick={() => handleRoomLifecycle('ARCHIVE')}
                    disabled={Boolean(busy) || shared.roomStatus === 'ARCHIVED'}>
                    {busy === 'lifecycle-ARCHIVE' ? '正在归档…' : '归档房间'}
                  </button>
                  <button type="button" className="secondary" onClick={() => handleRoomLifecycle('CLOSE')}
                    disabled={Boolean(busy)}>
                    {busy === 'lifecycle-CLOSE' ? '正在关闭…' : '关闭房间'}
                  </button>
                  <button type="button" className="danger" onClick={() => handleRoomLifecycle('DELETE')}
                    disabled={Boolean(busy)}>
                    {busy === 'lifecycle-DELETE' ? '正在标记删除…' : '删除房间'}
                  </button>
                </div>
              </section>
            )}
              {!presentMode && roomScene && toolsOpen && <details className="camelot-room-miniature">
                <summary>查看 3D 席位模型</summary>
                {roomScene}
              </details>}
              </aside>
              </>
            )}

            {shared.roomStatus === 'ACTIVE' ? (
              <>
            {shared.phase === 'COLLECTING' && (camelotCollection || !ownIdea || shared.memberUids.length >= 2) && (
            <section className="panel camelot-opinion-card">
              <div className="section-heading">
                <div><p className="step">01 · 独立输入</p><h2>{camelotCollection ? (ownIdea ? '等待揭示' : '写下你的想法') : '先保留每个人的真实想法'}</h2></div>
                <span className="status-pill">{shared.phase === 'COLLECTING' ? '原文尚未公开' : '公开输入已揭示'}</span>
              </div>
              <div className="progress-grid" aria-label="收集进度">
                <div><strong>{shared.progress.ideaSubmittedCount}</strong><span>已提交</span></div>
                <div><strong>{shared.progress.ideaSkippedCount}</strong><span>已跳过</span></div>
                <div><strong>{unsubmittedCount}</strong><span>待完成</span></div>
              </div>

              {ownIdea && camelotCollection && (
                <article className="own-idea camelot-seal-row">
                  <div className={`camelot-sealed-card${ownIdea.skipped ? ' skipped' : ''}${ownIdea.id === justSealedIdeaId ? ' newly-sealed' : ''}`}>
                    <span aria-hidden="true">{ownIdea.skipped ? '—' : '♠'}</span>
                    <strong>{ownIdea.skipped ? '已跳过' : '你的意见已封印'}</strong>
                  </div>
                  {!ownIdea.skipped && <details className="camelot-own-copy">
                    <summary>查看我的输入 · {ownIdea.visibility === 'PUBLIC' ? '收集结束后公开' : '始终仅自己可见'}</summary>
                    <p>{ownIdea.text}</p>
                  </details>}
                </article>
              )}
              {ownIdea && !camelotCollection && (
                <article className="own-idea">
                  <div className="section-heading"><h3>我的输入</h3><span>{ownIdea.skipped ? '已跳过' : ownIdea.visibility === 'PUBLIC' ? '公开' : '仅自己可见'}</span></div>
                  {!ownIdea.skipped && <p>{ownIdea.text}</p>}
                </article>
              )}

              {shared.phase === 'COLLECTING' && !ownIdea && canSubmitIdea && (
                <form onSubmit={handleSubmitIdea} className="idea-form">
                  <label htmlFor="idea-text">我的方案或想法</label>
                  <VoiceField multiline id="idea-text" value={ideaText} onValueChange={value => updateIdeaDraft(value)}
                    maxLength={4000} required placeholder="例如：我倾向于先缩小范围，保证周末能完成" />
                  <fieldset>
                    <legend>收集结束后的可见范围</legend>
                    <label className="radio-label"><input type="radio" name="visibility" value="PUBLIC"
                      checked={visibility === 'PUBLIC'} onChange={() => setVisibility('PUBLIC')} />公开给房间成员</label>
                    <label className="radio-label"><input type="radio" name="visibility" value="PRIVATE"
                      checked={visibility === 'PRIVATE'} onChange={() => setVisibility('PRIVATE')} />始终仅自己可见</label>
                  </fieldset>
                  <div className="button-row">
                    <button type="submit" disabled={Boolean(busy) || !ideaText.trim()}>{busy === 'idea' ? '正在保存…' : '提交我的输入'}</button>
                    <button type="button" className="secondary" onClick={handleSkipIdea}
                      disabled={Boolean(busy) || Boolean(ideaText.trim())}>本阶段跳过</button>
                  </div>
                </form>
              )}

              {isHost && shared.phase === 'COLLECTING' && canManageRoom && (!ownIdea || shared.memberUids.length >= 2) && (
                <div className="host-action">
                  <button type="button" onClick={handleCloseCollection} disabled={Boolean(busy)}>
                    {busy === 'close' ? '正在结束…' : '结束收集并揭示公开输入'}
                  </button>
                </div>
              )}
            </section>
            )}

            {!camelotCollection && shared.phase === 'COLLECTING' && ownIdea && shared.memberUids.length < 2 && !isHost && (
              <section className="panel">
                <div className="section-heading">
                  <div><p className="step">01 · 独立输入</p><h2>你已提交，等待房主邀请伙伴</h2></div>
                  <span className="status-pill">已提交</span>
                </div>
              </section>
            )}

            {['CANDIDATE_REVIEW', 'DISCUSSING'].includes(shared.phase) && (
              <section className="panel">
                <div className="section-heading">
                  <div><p className="step">02 · 候选核对</p><h2>把公开想法整理成可选方案</h2></div>
                  <span className="status-pill">{activeCandidates.length} / 10 个有效候选</span>
                </div>

                {shared.publicIdeas.length > 0 && (
                  <div className="public-ideas">
                    <h3>已公开的输入</h3>
                    {camelotReveal ? (
                      <div className={`camelot-reveal-grid${revealCycle === cycleKey ? ' opening' : ''}`}>
                        {shared.publicIdeas.filter(idea => idea.visibility === 'PUBLIC' && !idea.skipped).map(idea => (
                          <article className="camelot-reveal-card" key={idea.id}>
                            <span aria-hidden="true">♦</span>
                            <blockquote>{idea.text}</blockquote>
                          </article>
                        ))}
                      </div>
                    ) : shared.publicIdeas.map(idea => <blockquote key={idea.id}>{idea.text}</blockquote>)}
                  </div>
                )}
                {camelotReveal && shared.publicIdeas.length === 0 && <p>本轮没有公开意见。你仍可手动创建候选。</p>}
                {camelotReveal && ownIdea?.visibility === 'PRIVATE' && !ownIdea.skipped && (
                  <details className="own-idea">
                    <summary>我的私密想法 · 仅自己可见</summary>
                    <p>{ownIdea.text}</p>
                  </details>
                )}

                {(shared.phase === 'CANDIDATE_REVIEW' || shared.phase === 'DISCUSSING')
                  && shared.publicIdeas.length > 0 && (
                  <div className="ai-suggestions" aria-label="AI 候选建议">
                    <div className="section-heading">
                      <div><p className="step">AI 辅助</p><h3>候选建议</h3></div>
                      <button type="button" onClick={handleSuggestCandidates} disabled={Boolean(busy)}>
                        {busy === 'ai-suggest' ? '正在生成…' : '生成候选建议'}
                      </button>
                    </div>
                    <p className="field-hint">AI 只读已公开输入；建议不自动写入候选。</p>
                    {aiSuggestions.length > 0 && (
                      <div className="candidate-list">
                        {aiSuggestions.map((suggestion, index) => (
                          <SpotlightCard key={`${suggestion.title}-${index}`}>
                            <p className="step">AI 建议，尚未提交</p>
                            <h3>{suggestion.title}</h3>
                            <p>{suggestion.body}</p>
                            <small>
                              来源：{suggestion.sourceIdeaIds
                                .map(id => shared.publicIdeas.find(idea => idea.id === id)?.text ?? id)
                                .join('；')}
                            </small>
                            {canEditCandidates && (
                              <div className="button-row">
                                <button type="button" onClick={() => applySuggestion(suggestion)}
                                  disabled={Boolean(busy)}>填入新增候选表单</button>
                              </div>
                            )}
                          </SpotlightCard>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {canEditCandidates && activeCandidates.length < 10 && (
                  <form className="candidate-form" onSubmit={handleCreateCandidate}>
                    <h3>新增候选</h3>
                    <label htmlFor="candidate-title">候选标题</label>
                    <VoiceField id="candidate-title" value={candidateTitle} maxLength={80} required
                      onValueChange={value => updateCandidateTitle(value)} placeholder="例如：先小范围试点" />
                    <label htmlFor="candidate-body">具体安排</label>
                    <VoiceField multiline id="candidate-body" value={candidateBody} maxLength={4000} required
                      onValueChange={value => updateCandidateBody(value)} placeholder="例如：周六上午集中完成，下午留给展示" />
                    {shared.publicIdeas.length > 0 && (
                      <fieldset>
                        <legend>关联公开来源（可选）</legend>
                        {shared.publicIdeas.map(idea => (
                          <label className="checkbox-label" key={idea.id}>
                            <input type="checkbox" checked={sourceIdeaIds.includes(idea.id)} onChange={event => {
                              setSourceIdeaIds(current => event.target.checked
                                ? [...current, idea.id]
                                : current.filter(id => id !== idea.id));
                            }} />
                            <span>{idea.text}</span>
                          </label>
                        ))}
                      </fieldset>
                    )}
                    <button type="submit" disabled={Boolean(busy)}>{busy === 'candidate' ? '正在保存…' : '创建候选'}</button>
                  </form>
                )}

                <div className="candidate-list">
                  {shared.candidates.length === 0 && <p className="empty-state">还没有候选。</p>}
                  {shared.candidates.map(candidate => {
                    const revision = shared.currentRevisions.find(item => item.id === candidate.currentRevisionId);
                    if (!revision) return null;
                    const mayWithdraw = canEditCandidates && candidate.withdrawnAt === null
                      && (candidate.createdBy === snapshot.mine.uid || isHost);
                    const revisionDraft = revisionDrafts[candidate.id] ?? { title: revision.title, body: revision.body };
                    return (
                      <SpotlightCard className={candidate.withdrawnAt ? 'withdrawn' : undefined} key={candidate.id}>
                        <div className="section-heading">
                          <div><p className="step">版本 {revision.revision}</p><h3>{revision.title}</h3></div>
                          {candidate.withdrawnAt && <span className="status-pill">已撤回</span>}
                        </div>
                        <p>{revision.body}</p>
                        {revision.sourceIdeaIds.length > 0 && <small>关联 {revision.sourceIdeaIds.length} 条公开输入</small>}
                        {mayWithdraw && (
                          <details className="revision-editor">
                            <summary>修订候选</summary>
                            <form aria-label={`修订候选：${revision.title}`}
                              onSubmit={event => handleReviseCandidate(event, candidate, revision)}>
                              <label htmlFor={`revision-title-${candidate.id}`}>修订标题</label>
                              <VoiceField id={`revision-title-${candidate.id}`} value={revisionDraft.title} maxLength={80} required
                                onValueChange={value => updateRevisionDraft(candidate, revision, { title: value })} />
                              <label htmlFor={`revision-body-${candidate.id}`}>修订具体安排</label>
                              <VoiceField multiline id={`revision-body-${candidate.id}`} value={revisionDraft.body} maxLength={4000} required
                                onValueChange={value => updateRevisionDraft(candidate, revision, { body: value })} />
                              <p className="field-hint">实质修改生成新版本，已有评价保留。</p>
                              <button type="submit" disabled={Boolean(busy)}>
                                {busy === `revise-${candidate.id}` ? '正在保存…' : '保存修订版本'}
                              </button>
                            </form>
                          </details>
                        )}
                        {mayWithdraw && (
                          <button type="button" className="danger-button" onClick={() => handleWithdrawCandidate(candidate.id)}
                            disabled={Boolean(busy)}>{busy === `withdraw-${candidate.id}` ? '正在撤回…' : '撤回候选'}</button>
                        )}
                      </SpotlightCard>
                    );
                  })}
                </div>

                {isHost && shared.phase === 'CANDIDATE_REVIEW' && canOpenEvaluation && (
                  <div className="host-action">
                    <p>开始后冻结成员名单 · {activeCandidates.length} 个候选</p>
                    <button type="button" onClick={handleOpenEvaluation} disabled={Boolean(busy) || activeCandidates.length === 0}>
                      {busy === 'open-evaluation' ? '正在开始…' : '开始独立评价'}
                    </button>
                  </div>
                )}
              </section>
            )}

            {shared.phase === 'EVALUATING' && activeRound && (
              <section className="panel evaluation-panel" aria-label="独立评价">
                <div className="section-heading">
                  <div><p className="step">03 · 独立评价</p><h2>先独立判断，再一起查看结果</h2></div>
                  <span className="status-pill">盲评中</span>
                </div>
                <p>其他成员在统一揭示前看不到你的态度、评分或理由；这里只共享安全进度。</p>
                <div className="progress-grid" aria-label="评价进度">
                  <div><strong>{shared.progress.evaluationCompletedCount}</strong><span>已完成全部</span></div>
                  <div><strong>{shared.progress.evaluationSubmittedCount}</strong><span>已开始评价</span></div>
                  <div><strong>{incompleteEvaluationCount}</strong><span>未完成全部</span></div>
                </div>

                <div className="evaluation-list">
                  {activeRound.targetRevisionIds.map(revisionId => {
                    const revision = shared.currentRevisions.find(item => item.id === revisionId);
                    if (!revision) return null;
                    const ownEvaluation = snapshot.mine.evaluations.find(evaluation =>
                      evaluation.roundId === activeRound.id && evaluation.candidateRevisionId === revisionId);
                    const draft = evaluationDrafts[revisionId] ?? savedEvaluationDraft(ownEvaluation);
                    const status = ownEvaluation?.submissionState === 'SKIPPED'
                      ? '已跳过'
                      : ownEvaluation ? '已保存' : '未提交';
                    return (
                      <article className="evaluation-card" key={revisionId}>
                        <div className="section-heading">
                          <div><p className="step">版本 {revision.revision}</p><h3>{revision.title}</h3></div>
                          <span className="status-pill">{status}</span>
                        </div>
                        <p>{revision.body}</p>
                        {canEvaluate ? (
                          <form aria-label={`评价：${revision.title}`}
                            onSubmit={event => handleSubmitEvaluation(event, revisionId)}>
                            <fieldset>
                              <legend>我的态度（可与评分只选一项）</legend>
                              {(['SUPPORT', 'OPPOSE', 'NEUTRAL'] as const).map(attitude => (
                                <label className="radio-label" key={attitude}>
                                  <input type="radio" name={`attitude-${revisionId}`} value={attitude}
                                    checked={draft.attitude === attitude}
                                    onChange={() => updateEvaluationDraft(revisionId, { attitude })} />
                                  {ATTITUDE_LABELS[attitude]}
                                </label>
                              ))}
                            </fieldset>
                            <label htmlFor={`score-${revisionId}`}>评分（1—5，可选）</label>
                            <select id={`score-${revisionId}`} value={draft.score}
                              onChange={event => updateEvaluationDraft(revisionId, { score: event.target.value })}>
                              <option value="">不评分</option>
                              {[1, 2, 3, 4, 5].map(score => <option value={score} key={score}>{score} 分</option>)}
                            </select>
                            <label htmlFor={`reason-${revisionId}`}>理由（可选，结束后公开）</label>
                            <VoiceField multiline id={`reason-${revisionId}`} value={draft.reason} maxLength={500}
                              onValueChange={value => updateEvaluationDraft(revisionId, { reason: value })}
                              placeholder="例如：时间紧，先保证能落地" />
                            <div className="button-row">
                              <button type="submit" disabled={Boolean(busy) || (!draft.attitude && !draft.score)}>
                                {busy === `evaluation-${revisionId}` ? '正在保存…' : ownEvaluation ? '更新评价' : '保存评价'}
                              </button>
                              <button type="button" className="secondary" onClick={() => handleSkipEvaluation(revisionId)}
                                disabled={Boolean(busy)}>明确跳过</button>
                            </div>
                          </form>
                        ) : <p className="empty-state">当前身份不在本轮冻结名单中。</p>}
                      </article>
                    );
                  })}
                </div>

                {activeRoundClose && (
                  <div className="round-close-panel">
                    <div className="section-heading">
                      <div><h3>共同结束本轮</h3><p>达到多数即结束并揭示。</p></div>
                      <span className="status-pill" aria-label="结束票进度">
                        {activeRoundClose.endVoteCount} / {activeRoundClose.majorityThreshold} 票
                      </span>
                    </div>
                    {activeRound.deadlineAt ? (
                      <p className="field-hint">
                        当前截止时间：<time aria-label="当前截止时间" dateTime={activeRound.deadlineAt}>
                          {new Date(activeRound.deadlineAt).toLocaleString('zh-CN')}
                        </time>
                      </p>
                    ) : (
                      <p className="field-hint">只公开总票数。</p>
                    )}
                    {activeDeadlineEvent?.reason && (
                      <p className="field-hint">最近调整原因：{activeDeadlineEvent.reason}</p>
                    )}
                    {ownRoundCloseVote && (
                      <div className="button-row">
                        <button type="button" className="secondary" onClick={handleRetractRoundCloseVote} disabled={Boolean(busy)}>
                          {busy === 'retract-round-close' ? '正在撤回…' : '撤回我的结束票'}
                        </button>
                      </div>
                    )}
                    {canVoteRoundClose && !ownRoundCloseVote && !activeRound.deadlineAt && (
                      <div className="button-row">
                        <button type="button" onClick={handleVoteRoundClose} disabled={Boolean(busy)}>
                          {busy === 'vote-round-close' ? '正在投票…' : '投票结束本轮'}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {isHost && (
                  <div className="host-action round-deadline-form">
                    <h3>{activeRound.deadlineAt ? '延长评价时间' : '设置评价截止时间'}</h3>
                    <form onSubmit={handleSetRoundDeadline}>
                      <div className="button-row" role="group" aria-label="快捷选择评价截止时间">
                        {[15, 30, 60].map(minutes => (
                          <button key={minutes} type="button" className="secondary" disabled={Boolean(busy)}
                            onClick={() => {
                              const start = Math.max(Date.now(), activeRound.deadlineAt ? Date.parse(activeRound.deadlineAt) : 0);
                              setRoundDeadlineInput(dateTimeLocalValue(new Date(start + minutes * 60_000)));
                            }}>
                            {activeRound.deadlineAt ? `延长 ${minutes} 分钟` : `${minutes} 分钟后`}
                          </button>
                        ))}
                      </div>
                      <label htmlFor="round-deadline">评价截止时间</label>
                      <input id="round-deadline" type="datetime-local" value={roundDeadlineInput} required
                        min={dateTimeLocalValue(new Date(Math.max(
                          Date.now(),
                          activeRound.deadlineAt ? Date.parse(activeRound.deadlineAt) : 0,
                        ) + 60_000))}
                        onChange={event => setRoundDeadlineInput(event.target.value)} />
                      <label htmlFor="round-deadline-reason">设置或延长原因 <span className="field-hint">（必填）</span></label>
                      <VoiceField multiline id="round-deadline-reason" value={roundDeadlineReason} maxLength={500} required
                        onValueChange={value => setRoundDeadlineReason(value)}
                        placeholder="例如：还有成员需要核对候选，需要更多独立评价时间。" />
                      <button type="submit" disabled={Boolean(busy)}>
                        {busy === 'round-deadline' ? '正在保存…' : activeRound.deadlineAt ? '延长截止时间' : '设置截止时间'}
                      </button>
                    </form>
                  </div>
                )}

                {isHost && (
                  <div className="host-action">
                    <p>还有 {incompleteEvaluationCount} 人未完成评价</p>
                    <button type="button" onClick={handleCloseEvaluation} disabled={Boolean(busy)}>
                      {busy === 'close-evaluation' ? '正在结束…' : '结束评价并统一揭示'}
                    </button>
                  </div>
                )}
              </section>
            )}

            {shared.phase === 'DISCUSSING' && shared.revealedEvaluationRoundIds.length > 0 && (
              <section className="panel reveal-panel" aria-label="已揭示评价">
                <div className="section-heading">
                  <div><p className="step">03 · 统一揭示</p><h2>现在查看同一批评价</h2></div>
                  <span className="status-pill">评价已公开</span>
                </div>
                <p>态度、评分与理由来自已结束并揭示的轮次；未提交与明确跳过分别显示。</p>
                <div className="revealed-list">
                  {revealedRevisions.map(revision => {
                    const summary = summarizeRevealedEvaluations(shared, revision.id);
                    const source = revealedEvaluationSource(shared, revision.id);
                    return (
                      <article className="revealed-card" key={revision.id}>
                        <div className="section-heading">
                          <div><p className="step">版本 {revision.revision}</p><h3>{revision.title}</h3></div>
                          {source?.carried && <span className="status-pill">沿用评价</span>}
                        </div>
                        <div className="distribution-grid" aria-label={`${revision.title}评价分布`}>
                          <div><strong>{summary.counts.support}</strong><span>支持</span></div>
                          <div><strong>{summary.counts.oppose}</strong><span>反对</span></div>
                          <div><strong>{summary.counts.neutral}</strong><span>中立</span></div>
                          <div><strong>{summary.counts.skipped}</strong><span>跳过</span></div>
                          <div><strong>{summary.counts.missing}</strong><span>未提交</span></div>
                        </div>
                        <p className="score-summary">
                          {summary.scoreCount > 0
                            ? `平均评分 ${(summary.scoreSum / summary.scoreCount).toFixed(1)} / 5 · ${summary.scoreCount} 人评分`
                            : '暂无评分'}
                        </p>
                        <div className="evaluation-reasons">
                          {summary.entries.map(({ uid, evaluation }) => (
                            <article className="reason-card" key={uid}>
                              <div className="section-heading">
                                <strong>{uid === shared.hostUid ? '房主' : `成员 ${shared.memberUids.indexOf(uid) + 1}`}</strong>
                                <span>
                                  {!evaluation ? '未提交'
                                    : evaluation.submissionState === 'SKIPPED' ? '已跳过'
                                      : `${evaluation.attitude ? ATTITUDE_LABELS[evaluation.attitude] : '已评价'}${typeof evaluation.score === 'number' ? ` · ${evaluation.score} 分` : ''}`}
                                </span>
                              </div>
                              {evaluation?.submissionState === 'EVALUATED' && evaluation.reason?.trim() && <p>{evaluation.reason}</p>}
                            </article>
                          ))}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            {shared.phase === 'DISCUSSING' && (
              <details className="fold-panel">
                <summary>需要重新评价？发起局部重评（可选）</summary>
              <section className="panel reopen-panel" aria-label="局部重评">
                <div className="section-heading">
                  <div><p className="step">04 · 局部重评</p><h2>只重评需要重新判断的候选</h2></div>
                  <span className="status-pill">{activeReopen ? '重开投票中' : '评论不会自动重开'}</span>
                </div>
                {activeReopen ? (
                  <div className="reopen-request" aria-label="进行中的重开申请">
                    <p>申请目标：{activeReopen.targetRevisionIds.map(revisionId => {
                      const revision = shared.currentRevisions.find(item => item.id === revisionId);
                      return revision ? `${revision.title}（版本 ${revision.revision}）` : revisionId;
                    }).join('、')}</p>
                    <p className="field-hint">由{activeReopen.requestedBy === shared.hostUid ? '房主' : '房间成员'}发起 · 只公开支持总数</p>
                    <div className="progress-grid" aria-label="重开支持进度">
                      <div><strong>{activeReopen.reopenVoteCount}</strong><span>支持重开</span></div>
                      <div><strong>{activeReopen.majorityThreshold}</strong><span>通过所需</span></div>
                      <div><strong>{shared.memberUids.length}</strong><span>当前成员</span></div>
                    </div>
                    {ownReopenVote && <p className="field-hint">我的选择：{ownReopenVote.choice === 'REOPEN' ? '支持重开' : '继续讨论'}</p>}
                    {canEditCandidates && (
                      <div className="button-row">
                        {ownReopenVote?.choice === 'REOPEN' ? (
                          <button type="button" className="secondary" onClick={() => handleVoteReopen('KEEP_DISCUSSING')} disabled={Boolean(busy)}>
                            {busy === 'vote-reopen-KEEP_DISCUSSING' ? '正在撤回…' : '撤回我的重开支持'}
                          </button>
                        ) : (
                          <button type="button" onClick={() => handleVoteReopen('REOPEN')} disabled={Boolean(busy)}>
                            {busy === 'vote-reopen-REOPEN' ? '正在投票…' : '支持局部重评'}
                          </button>
                        )}
                        {activeReopen.requestedBy === snapshot.mine.uid && (
                          <button type="button" className="secondary" onClick={handleCancelReopen} disabled={Boolean(busy)}>
                            {busy === 'cancel-reopen' ? '正在取消…' : '取消重开申请'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <form className="reopen-form" onSubmit={handleRequestReopen}>
                    <p>选择需要重新独立评价的当前版本；未选候选保留已揭示评价，并明确标注历史来源。</p>
                    <fieldset>
                      <legend>局部重评目标</legend>
                      {activeCandidates.map(candidate => {
                        const revision = shared.currentRevisions.find(item => item.id === candidate.currentRevisionId);
                        if (!revision) return null;
                        return (
                          <label className="checkbox-label" key={candidate.id}>
                            <input type="checkbox" checked={reopenTargetRevisionIds.includes(revision.id)}
                              onChange={event => setReopenTargetRevisionIds(current => event.target.checked
                                ? [...current, revision.id]
                                : current.filter(id => id !== revision.id))} />
                            <span>{revision.title} · 版本 {revision.revision}</span>
                          </label>
                        );
                      })}
                    </fieldset>
                    <button type="submit" disabled={Boolean(busy) || reopenTargetRevisionIds.length === 0 || !canEditCandidates}>
                      {busy === 'request-reopen' ? '正在发起…' : '发起局部重评申请'}
                    </button>
                  </form>
                )}
              </section>
              </details>
            )}

            {shared.phase === 'DISCUSSING' && (
              <section className="panel final-panel" aria-label="最终确认">
                <div className="section-heading">
                  <div><p className="step">05 · 最终确认</p><h2>对同一版本作出明确回应</h2></div>
                  <span className="status-pill">全员明确接受才达成共识</span>
                </div>
                {canProposeFinal ? (
                  activeCandidates.length > 0 ? (
                    <form className="final-proposal-form" onSubmit={handleProposeFinal}>
                      <p>发起后冻结当前成员名单、候选版本和截止时间。拒绝、弃权或未响应都不会被算作接受。</p>
                      <label htmlFor="final-candidate">确认候选及版本</label>
                      <select id="final-candidate" value={selectedFinalCandidateRevisionId} required
                        onChange={event => setFinalCandidateRevisionId(event.target.value)}>
                        {activeCandidates.map(candidate => {
                          const revision = shared.currentRevisions.find(item => item.id === candidate.currentRevisionId);
                          return revision && <option value={revision.id} key={revision.id}>{revision.title} · 版本 {revision.revision}</option>;
                        })}
                      </select>
                      <label htmlFor="final-deadline">最终确认截止时间</label>
                      <input id="final-deadline" type="datetime-local" value={finalDeadlineInput} required
                        min={dateTimeLocalValue(new Date(Date.now() + 5 * 60_000))}
                        max={dateTimeLocalValue(new Date(Date.now() + 7 * 24 * 60 * 60_000))}
                        onChange={event => setFinalDeadlineInput(event.target.value)} />
                      <p className="field-hint">5 分钟至 7 天</p>
                      <button type="submit" disabled={Boolean(busy) || stale || !selectedFinalCandidateRevisionId}>
                        {busy === 'propose-final' ? '正在发起…' : '发起最终确认'}
                      </button>
                    </form>
                  ) : <p>至少保留一个有效候选后才能发起最终确认。</p>
                ) : <p>等待房主选择具体候选版本并发起最终确认；发起后你可以明确接受、拒绝或弃权。</p>}
              </section>
            )}

            {shared.phase === 'CONFIRMING' && activeProposal && (
              <section className="panel final-panel" aria-label="最终确认">
                <div className="section-heading">
                  <div><p className="step">05 · 最终确认</p><h2>只有全员明确接受才达成共识</h2></div>
                  <span className="status-pill">截止前可改本人响应</span>
                </div>
                <article className="final-candidate">
                  <div className="section-heading">
                    <h3>{activeProposal.candidateRevisionSnapshot.title}</h3>
                    <span>版本 {activeProposal.candidateRevisionSnapshot.revision}</span>
                  </div>
                  <p>{activeProposal.candidateRevisionSnapshot.body}</p>
                </article>
                <p>截止时间 {new Date(activeProposal.deadlineAt).toLocaleString()}</p>
                <div className="response-grid" aria-label="最终响应聚合">
                  <div><strong>{shared.finalResponseSummary?.accepted ?? 0}</strong><span>明确接受</span></div>
                  <div><strong>{shared.finalResponseSummary?.declined ?? 0}</strong><span>明确拒绝</span></div>
                  <div><strong>{shared.finalResponseSummary?.abstained ?? 0}</strong><span>弃权</span></div>
                  <div><strong>{shared.finalResponseSummary?.pending ?? activeProposal.rosterUids.length}</strong><span>未响应</span></div>
                </div>
                <p className="field-hint">只公开聚合计数。</p>
                {ownFinalResponse && <p>我的最终响应：{ownFinalResponse.choice === 'ACCEPT' ? '明确接受' : ownFinalResponse.choice === 'DECLINE' ? '明确拒绝' : '弃权'}</p>}
                {canRespondFinal && (
                  <div className="button-row" aria-label="我的最终响应操作">
                    <button type="button" onClick={() => handleRespondFinal('ACCEPT')} disabled={Boolean(busy) || stale}>
                      {busy === 'respond-final-ACCEPT' ? '正在保存…' : '明确接受'}
                    </button>
                    <button type="button" className="secondary" onClick={() => handleRespondFinal('DECLINE')} disabled={Boolean(busy) || stale}>
                      {busy === 'respond-final-DECLINE' ? '正在保存…' : '明确拒绝'}
                    </button>
                    <button type="button" className="secondary" onClick={() => handleRespondFinal('ABSTAIN')} disabled={Boolean(busy) || stale}>
                      {busy === 'respond-final-ABSTAIN' ? '正在保存…' : '弃权'}
                    </button>
                  </div>
                )}
                {isHost && canManageRoom && (
                  <div className="host-action">
                    <button type="button" className="secondary" onClick={handleCloseUnresolved} disabled={Boolean(busy) || stale}>
                      {busy === 'close-unresolved' ? '正在结束…' : '结束为未达成共识'}
                    </button>
                  </div>
                )}
              </section>
            )}

            {shared.phase === 'COMPLETED' && (
              <section className="panel final-panel" aria-label="结果记录">
                <div className="section-heading">
                  <div><p className="step">05 · 结果记录</p><h2>保存明确版本与真实响应计数</h2></div>
                  <span className="status-pill">不可变结果</span>
                </div>
                {shared.decisionRecords.length === 0 && <p>当前周期没有结果记录。</p>}
                {shared.decisionRecords.map(record => (
                  <article className="decision-record" key={record.id} aria-label={record.outcome === 'AGREED' ? '已达成共识' : '未达成共识'}>
                    <div className="section-heading">
                      <h3>{record.outcome === 'AGREED' ? '已达成共识' : '未达成共识'}</h3>
                      <span>{new Date(record.createdAt).toLocaleString()}</span>
                    </div>
                    {record.candidateRevisionSnapshot && (
                      <div>
                        <strong>{record.candidateRevisionSnapshot.title} · 版本 {record.candidateRevisionSnapshot.revision}</strong>
                        <p>{record.candidateRevisionSnapshot.body}</p>
                      </div>
                    )}
                    {record.outcome === 'UNRESOLVED' && <p>{record.unresolvedSummary ?? '未全员明确接受'}；候选未被采用。</p>}
                    <div className="response-grid" aria-label="结果响应计数">
                      <div><strong>{record.responseSummary.accepted}</strong><span>明确接受</span></div>
                      <div><strong>{record.responseSummary.declined}</strong><span>明确拒绝</span></div>
                      <div><strong>{record.responseSummary.abstained}</strong><span>弃权</span></div>
                      <div><strong>{record.responseSummary.pending}</strong><span>未响应</span></div>
                    </div>
                    <button type="button" className="secondary" onClick={() => void copyDecisionRecord(record)}>复制结果</button>
                  </article>
                ))}
                {isHost && shared.roomStatus === 'ACTIVE' && (
                  <>
                    <div className="button-row">
                      <button type="button" className="secondary" onClick={handleStartNextCycle}
                        disabled={Boolean(busy)}>
                        {busy === 'next-cycle' ? '正在开始下一轮…' : '开始下一轮'}
                      </button>
                    </div>
                  </>
                )}
              </section>
            )}

            {['EVALUATING', 'DISCUSSING', 'CONFIRMING'].includes(shared.phase) && (
              <details className="fold-panel">
                <summary>讨论评论（可选）· 先保存，再决定是否公开</summary>
              <section className="panel comments-panel" aria-label="讨论评论">
                <div className="section-heading">
                  <div><p className="step">06 · 讨论评论</p><h2>先保存，再决定是否公开</h2></div>
                  <span className="status-pill">{shared.phase === 'EVALUATING' ? '仅本人草稿' : '显式发布'}</span>
                </div>
                <p>{shared.phase === 'EVALUATING'
                  ? '盲评阶段只能保存本人草稿；统一揭示后仍需你再次显式发布。'
                  : '公开评论发布后全员可见；私密评论即使发布也只保留在本人快照。'}</p>

                <form className="comment-composer" onSubmit={handleComment}>
                  <label htmlFor="comment-body">我的评论</label>
                  <VoiceField multiline id="comment-body" value={commentBody} maxLength={4000} required
                    onValueChange={value => updateCommentDraft(value)}
                    placeholder="例如：这两条候选的差别是什么？" />
                  <label htmlFor="comment-candidate">关联候选（可选）</label>
                  <select id="comment-candidate" value={commentCandidateId}
                    onChange={event => setCommentCandidateId(event.target.value)}>
                    <option value="">不关联候选</option>
                    {activeCandidates.map(candidate => {
                      const revision = shared.currentRevisions.find(item => item.id === candidate.currentRevisionId);
                      return <option value={candidate.id} key={candidate.id}>{revision?.title ?? candidate.id} · 当前版本</option>;
                    })}
                  </select>
                  <fieldset>
                    <legend>评论可见范围</legend>
                    <label className="radio-label"><input type="radio" name="comment-visibility" value="PUBLIC"
                      checked={commentVisibility === 'PUBLIC'} onChange={() => setCommentVisibility('PUBLIC')} />公开评论（发布后全员可见）</label>
                    <label className="radio-label"><input type="radio" name="comment-visibility" value="PRIVATE"
                      checked={commentVisibility === 'PRIVATE'} onChange={() => setCommentVisibility('PRIVATE')} />私密评论（仅自己可见）</label>
                  </fieldset>
                  <div className="button-row">
                    {shared.phase !== 'EVALUATING' && (
                      <button type="button" className="secondary" onClick={() => saveComposerComment('DRAFT')}
                        disabled={Boolean(busy) || !commentBody.trim()}>保存评论草稿</button>
                    )}
                    <button type="submit" disabled={Boolean(busy) || !commentBody.trim()}>
                      {shared.phase === 'EVALUATING' ? '保存评论草稿' : '显式发布评论'}
                    </button>
                  </div>
                </form>

                <div className="comment-list public-comments" aria-label="已公开评论">
                  <h3>已公开评论</h3>
                  {shared.comments.length === 0 && <p className="empty-state">还没有公开评论。</p>}
                  {shared.comments.map(comment => (
                    <article className="comment-card public-comment" key={comment.id}>
                      <div className="section-heading">
                        <strong>{comment.authorUid === shared.hostUid ? '房主' : `成员 ${shared.memberUids.indexOf(comment.authorUid) + 1}`}</strong>
                        <span>已发布 · 公开</span>
                      </div>
                      <p>{comment.body}</p>
                      {comment.candidateId && <small>关联候选：{shared.currentRevisions.find(item => item.id === comment.candidateRevisionId)?.title ?? '候选历史版本'}</small>}
                    </article>
                  ))}
                </div>

                <div className="comment-list own-comments" aria-label="我的私密评论与草稿">
                  <h3>我的私密评论与草稿</h3>
                  {snapshot.mine.comments.filter(comment => comment.publicationState === 'DRAFT' || comment.visibility === 'PRIVATE').length === 0
                    && <p className="empty-state">没有本人私密评论或草稿。</p>}
                  {snapshot.mine.comments
                    .filter(comment => comment.publicationState === 'DRAFT' || comment.visibility === 'PRIVATE')
                    .map(comment => (
                      <article className="comment-card own-comment" key={comment.id}>
                        <div className="section-heading">
                          <strong>{comment.publicationState === 'DRAFT' ? '本人草稿' : '本人私密评论'}</strong>
                          <span>{comment.publicationState === 'DRAFT' ? '草稿 · 仅自己可见' : '已发布 · 仅自己可见'}</span>
                        </div>
                        <p>{comment.body}</p>
                        {comment.candidateId && <small>关联候选：{shared.currentRevisions.find(item => item.id === comment.candidateRevisionId)?.title ?? '候选历史版本'}</small>}
                        {comment.publicationState === 'DRAFT' && shared.phase !== 'EVALUATING' && (
                          <button type="button" onClick={() => publishSavedComment(comment)} disabled={Boolean(busy)}>
                            {busy === `comment-PUBLISHED-${comment.id}` ? '正在发布…' : '发布这条评论'}
                          </button>
                        )}
                      </article>
                    ))}
                </div>
              </section>
              </details>
            )}

              </>
            ) : (
              <section className="panel" aria-label="只读历史">
                <div className="section-heading">
                  <div><p className="step">只读历史</p><h2>房间当前不可变更</h2></div>
                  <span className="status-pill">{shared.roomStatus}</span>
                </div>
                <p>房间已归档、关闭或进入删除流程，输入、评价、讨论与最终确认均已停止；以下仅为已保存的公开内容。</p>
                <div className="progress-grid" aria-label="历史概况">
                  <div><strong>{shared.currentRevisions.length}</strong><span>候选版本</span></div>
                  <div><strong>{shared.publicIdeas.length}</strong><span>公开输入</span></div>
                  <div><strong>{shared.revealedEvaluations.length}</strong><span>已揭示评价</span></div>
                </div>
                {shared.currentRevisions.length > 0 && (
                  <>
                    <h3>候选版本</h3>
                    <ul className="member-list">
                      {shared.currentRevisions.map(revision => (
                        <li key={revision.id}>
                          <span><strong>{revision.title}</strong><small>{revision.body}</small></span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            )}
            </div>

            {shared.roomStatus === 'ACTIVE' && (
              <AssistantDock key={shared.roomId}>
                <section className="panel" aria-label="房间共议助手">
                  {shared.phase === 'COLLECTING' ? (
                    <p>公开意见揭示后，就可以和骑士讨论了。</p>
                  ) : (
                    <>
                      <div className="comment-list assistant-messages" aria-label="房间助手消息">
                        <h3>圆桌对话</h3>
                        {assistantMessages.length === 0 && <p className="empty-state">向圆桌骑士提问，或选一个快捷动作。</p>}
                        {assistantMessages.map(message => (
                          <article className="assistant-turn" key={message.id}>
                            <div className="assistant-question-bubble">
                              <strong>
                                {message.actorUid === snapshot.mine.uid
                                  ? '我'
                                  : `成员 ${shared.memberUids.indexOf(message.actorUid) + 1}`}
                              </strong>
                              <p>{message.question || ASSISTANT_ACTION_LABELS[message.action]}</p>
                            </div>
                            <div className="assistant-deal">
                              <img className="assistant-knight" src={camelotAsset('card-knight.svg')}
                                width="128" height="142" alt="" loading="lazy" />
                              <div className="assistant-hand">
                                <div className="assistant-answer-card">
                                  <div className="section-heading">
                                    <strong>圆桌骑士</strong>
                                    <span>{message.status === 'PENDING'
                                      ? '生成中…'
                                      : message.status === 'FAILED'
                                        ? '生成失败'
                                        : message.stale || message.status === 'STALE' ? '已过期 · AI 建议' : 'AI 建议'}</span>
                                  </div>
                                  {message.answer && <p>{message.answer}</p>}
                                  {message.status === 'FAILED' && (
                                    <p>{message.errorCode ? (ERROR_LABELS[message.errorCode] ?? `生成失败（${message.errorCode}）`) : '生成失败，可稍后重试或继续手动讨论。'}</p>
                                  )}
                                  {(message.stale || message.status === 'STALE') && (
                                    <p className="assistant-stale">房间内容已变化，可以重新问我。</p>
                                  )}
                                  {message.answer && message.sourceIds.length > 0 && (
                                    <details className="assistant-sources">
                                      <summary>查看引用（{message.sourceIds.length}）</summary>
                                      <small>引用：{message.sourceIds.map(sourceId => assistantSourceLabel(sourceId)).join('；')}</small>
                                    </details>
                                  )}
                                </div>
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>

                      <div className="button-row assistant-quick-actions">
                        {(['SYNTHESIZE_DISAGREEMENT', 'SUGGEST_ALTERNATIVES', 'FIND_OPEN_QUESTIONS'] as const).map(action => (
                          <button type="button" className="secondary" key={action} disabled={Boolean(busy)}
                            onClick={() => handleAskAssistant(action)}>
                            {busy === `assistant-${action}` ? '正在整理…' : ASSISTANT_ACTION_LABELS[action]}
                          </button>
                        ))}
                      </div>

                      <form className="assistant-composer" onSubmit={event => { event.preventDefault(); handleAskAssistant('ASK'); }}>
                        <label htmlFor="assistant-question">自由提问</label>
                        <VoiceField multiline id="assistant-question" value={assistantQuestion} maxLength={500}
                          onValueChange={value => setAssistantQuestion(value)}
                          placeholder="问问圆桌骑士…" />
                        <button type="submit" disabled={Boolean(busy) || !assistantQuestion.trim()}>
                          {busy === 'assistant-ASK' ? '正在生成…' : '提交提问'}
                        </button>
                      </form>

                      {assistantError && <div className="message error" role="alert">{assistantError}</div>}
                    </>
                  )}
                </section>
              </AssistantDock>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function JoinPanel(props: {
  token: string;
  setToken: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  disabled: boolean;
  busy: boolean;
}) {
  return (
    <section className="panel join-panel">
      <p className="step">02 · 加入房间</p>
      <h2 tabIndex={-1}>用邀请链接加入</h2>
      <form onSubmit={props.onSubmit}>
        <label htmlFor="invite-token">邀请 token</label>
        <textarea id="invite-token" className="token-input" value={props.token}
          onChange={event => props.setToken(inviteTokenFromInput(event.target.value))} minLength={32} maxLength={1024}
          required autoComplete="off" />
        {!props.token && <p className="field-hint">如果邀请栏为空，请从聊天里复制房主发来的完整链接，粘贴到这里。</p>}
        <button type="submit" disabled={props.disabled}>{props.busy ? '正在加入…' : '加入房间'}</button>
      </form>
    </section>
  );
}
