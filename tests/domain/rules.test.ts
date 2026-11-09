import { describe, expect, it } from 'vitest';
import { candidateSchema, conditionsSchema, yuanToFen } from '@gongqi/contracts';
import { canPropose, evaluateCandidate, rankCandidates } from '@gongqi/domain';

const candidate = {
  id: 'a', roomId: 'room', roundId: 'round', title: '桌游',
  time: { startAt: '2026-11-07T06:00:00Z', endAt: '2026-11-07T08:00:00Z' },
  estimatedCostFen: 5000, location: '活动室', venue: 'indoor' as const,
  activityType: 'boardgame' as const, note: '', sourceUrl: null,
  createdBy: 'alice', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
  contentRevision: 1, destinationRevision: 1, withdrawn: false,
};
const none = { kind: 'none' as const };
const conditions = {
  budgetFen: none, available: none, travelMinutes: none, venue: none,
  preferredTypes: [] as ('boardgame'|'dining')[],
};
const members = [{ uid: 'alice', submitted: true }, { uid: 'bob', submitted: true }];
const all = { alice: conditions, bob: conditions };
const budget = (value: number) => ({ kind:'value' as const, value, visibility:'computeOnly' as const });

describe('input contracts', () => {
  it('distinguishes explicit no-limit conditions from missing fields', () => {
    expect(conditionsSchema.safeParse(conditions).success).toBe(true);
    expect(conditionsSchema.safeParse({}).success).toBe(false);
  });
  it('rejects negative, fractional and non-finite stored money', () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(conditionsSchema.safeParse({ ...conditions, budgetFen: budget(value) }).success).toBe(false);
    }
  });
  it('rejects inverted time and unsafe source URLs', () => {
    expect(candidateSchema.safeParse({ ...candidate, time: { startAt:candidate.time.endAt, endAt:candidate.time.startAt } }).success).toBe(false);
    expect(candidateSchema.safeParse({ ...candidate, sourceUrl:'javascript:alert(1)' }).success).toBe(false);
  });
  it('rejects duplicate preferences instead of counting them twice', () => {
    expect(conditionsSchema.safeParse({ ...conditions, preferredTypes:['boardgame','boardgame'] }).success).toBe(false);
  });
  it('converts yuan strings without floating-point rounding or silent empty-to-zero', () => {
    expect(yuanToFen('0.29')).toBe(29);
    expect(yuanToFen(' 50.5 ')).toBe(5050);
    expect(yuanToFen('0')).toBe(0);
    for (const input of ['', '-1', '1.001', '1e3', 'Infinity', '1000000.01']) {
      expect(() => yuanToFen(input)).toThrow();
    }
  });
});

describe('three-valued candidate evaluation', () => {
  it('accepts an exact budget boundary and rejects one fen above it', () => {
    expect(evaluateCandidate(candidate,members,{...all,alice:{...conditions,budgetFen:budget(5000)}},{}).status).toBe('PASS');
    expect(evaluateCandidate(candidate,members,{...all,alice:{...conditions,budgetFen:budget(4999)}},{}).status).toBe('FAIL');
  });
  it('does not turn missing candidate cost into zero', () => {
    expect(evaluateCandidate({...candidate,estimatedCostFen:null},members,{...all,alice:{...conditions,budgetFen:budget(5000)}},{}).status).toBe('UNKNOWN');
  });
  it('treats incomplete critical candidate fields as unknown even without limits', () => {
    expect(evaluateCandidate({...candidate,location:null},members,all,{}).status).toBe('UNKNOWN');
  });
  it('requires each members own current destination travel estimate', () => {
    const constraints={alice:{...conditions,travelMinutes:budget(30)},bob:{...conditions,travelMinutes:budget(10)}};
    const travel={alice:{a:{uid:'alice',candidateId:'a',destinationRevision:1,minutes:20,updatedAt:candidate.updatedAt}}};
    expect(evaluateCandidate(candidate,members,constraints,travel).status).toBe('UNKNOWN');
    const both={...travel,bob:{a:{uid:'bob',candidateId:'a',destinationRevision:1,minutes:15,updatedAt:candidate.updatedAt}}};
    expect(evaluateCandidate(candidate,members,constraints,both).status).toBe('FAIL');
    expect(evaluateCandidate({...candidate,destinationRevision:2},members,constraints,travel).status).toBe('UNKNOWN');
  });
  it('does not require a travel estimate when a member has no travel limit', () => {
    expect(evaluateCandidate(candidate,members,all,{}).status).toBe('PASS');
  });
  it('does not reuse an estimate belonging to a different member', () => {
    const constraints={...all,alice:{...conditions,travelMinutes:budget(30)}};
    const wrong={alice:{a:{uid:'bob',candidateId:'a',destinationRevision:1,minutes:5,updatedAt:candidate.updatedAt}}};
    expect(evaluateCandidate(candidate,members,constraints,wrong).status).toBe('UNKNOWN');
  });
  it('merges adjacent availability intervals and checks full containment', () => {
    const available={kind:'value' as const,visibility:'public' as const,value:[
      {startAt:'2026-11-07T07:00:00Z',endAt:'2026-11-07T08:00:00Z'},
      {startAt:'2026-11-07T06:00:00Z',endAt:'2026-11-07T07:00:00Z'},
    ]};
    expect(evaluateCandidate(candidate,members,{...all,alice:{...conditions,available}},{}).status).toBe('PASS');
    const gap={...available,value:[available.value[0]!,{startAt:'2026-11-07T06:00:00Z',endAt:'2026-11-07T06:59:00Z'}]};
    expect(evaluateCandidate(candidate,members,{...all,alice:{...conditions,available:gap}},{}).status).toBe('FAIL');
  });
  it('normalizes explicit offsets rather than treating them as local wall-clock time', () => {
    const available={kind:'value' as const,visibility:'public' as const,value:[{startAt:'2026-11-07T14:00:00+08:00',endAt:'2026-11-07T16:00:00+08:00'}]};
    expect(evaluateCandidate(candidate,members,{...all,alice:{...conditions,available}},{}).status).toBe('PASS');
  });
  it('keeps incomplete submissions provisional and known failures as failures', () => {
    const pending=[members[0]!,{uid:'bob',submitted:false}];
    const result=evaluateCandidate(candidate,pending,all,{});
    expect(result.provisional).toBe(true);
    expect(result.status).toBe('UNKNOWN');
    expect(evaluateCandidate(candidate,pending,{...all,alice:{...conditions,budgetFen:budget(1)}},{}).status).toBe('FAIL');
  });
  it('lets known failure dominate missing travel information', () => {
    const constraints={alice:{...conditions,budgetFen:budget(1),travelMinutes:budget(30)},bob:conditions};
    expect(evaluateCandidate(candidate,members,constraints,{}).status).toBe('FAIL');
  });
  it('counts a matching member at most once and never makes preferences necessary', () => {
    const result=evaluateCandidate(candidate,members,{alice:{...conditions,preferredTypes:['boardgame','dining']},bob:conditions},{});
    expect(result.preferenceMatches).toBe(1);
    expect(result.status).toBe('PASS');
  });
  it('applies venue as a necessary constraint', () => {
    expect(evaluateCandidate(candidate,members,{...all,alice:{...conditions,venue:{kind:'value',value:'outdoor',visibility:'public'}}},{}).status).toBe('FAIL');
  });
});

describe('ranking and proposal guards', () => {
  const state={roomId:'room',roundId:'round',status:'ACTIVE' as const,phase:'OPEN' as const,
    hostUid:'alice',actorUid:'alice',decisionRevision:4,expectedDecisionRevision:4,
    rosterRevision:2,rosterConfirmedRevision:2,confirmedRoster:['alice','bob'],members,candidate,
    conditionsByUid:all,travelByUid:{}};
  it('sorts by status, then type matches, then server time/id without mutating input', () => {
    const good=evaluateCandidate(candidate,members,all,{});
    const unknown={...good,candidateId:'u',status:'UNKNOWN' as const,preferenceMatches:6};
    const fail={...good,candidateId:'f',status:'FAIL' as const,preferenceMatches:6};
    const other={...good,candidateId:'b'};
    const source=[fail,unknown,other,good];
    expect(rankCandidates(source).map(x=>x.candidateId)).toEqual(['a','b','u','f']);
    expect(source[0]).toBe(fail);
  });
  it('permits a complete feasible proposal with the same confirmed roster', () => {
    expect(canPropose(state)).toEqual({ok:true});
  });
  it('blocks a stale business version', () => {
    expect(canPropose({...state,expectedDecisionRevision:3})).toEqual({ok:false,code:'VERSION_CONFLICT'});
  });
  it('blocks a changed member set even if roster revision was incorrectly copied', () => {
    expect(canPropose({...state,confirmedRoster:['alice','charlie']})).toEqual({ok:false,code:'ROSTER_NOT_READY'});
  });
  it('blocks a stale roster revision', () => {
    expect(canPropose({...state,rosterConfirmedRevision:1})).toEqual({ok:false,code:'ROSTER_NOT_READY'});
  });
  it('does not treat an offline member as absent or already accepting', () => {
    expect(canPropose({...state,members:[{uid:'alice',submitted:true,online:true},{uid:'bob',submitted:true,online:false}]})).toEqual({ok:true});
  });
  it('blocks missing submissions, non-host callers and incomplete candidates', () => {
    expect(canPropose({...state,members:[members[0]!,{uid:'bob',submitted:false}]})).toEqual({ok:false,code:'MEMBERS_NOT_READY'});
    expect(canPropose({...state,actorUid:'bob'})).toEqual({ok:false,code:'FORBIDDEN'});
    expect(canPropose({...state,candidate:{...candidate,time:null}})).toEqual({ok:false,code:'CANDIDATE_INCOMPLETE'});
  });
  it('blocks already agreed or archived rooms, withdrawn or cross-room candidates', () => {
    expect(canPropose({...state,phase:'AGREED'})).toEqual({ok:false,code:'INVALID_STATE'});
    expect(canPropose({...state,status:'ARCHIVED'})).toEqual({ok:false,code:'INVALID_STATE'});
    expect(canPropose({...state,candidate:{...candidate,withdrawn:true}})).toEqual({ok:false,code:'CANDIDATE_INCOMPLETE'});
    expect(canPropose({...state,candidate:{...candidate,roomId:'other'}})).toEqual({ok:false,code:'CANDIDATE_INCOMPLETE'});
  });
});
