import { create } from 'zustand';
import { db, META_KEYS } from '../hooks/usePersistentStore';
import { SCHEMA_VERSION } from '../hooks/schemaVersion';
import { uid } from '../utils/id';
import {
  applySyncPackage,
  buildSyncPackage,
  factBlockedPair,
  hasFact,
  isConflictTriple,
  planOf,
  projectSessions,
  reconcile,
} from '../utils/sync';
import type {
  DutyRole,
  HeldDraft,
  MergeOutcome,
  ObsSession,
  SessionReplicas,
  SessionStatus,
  SyncPackage,
  SyncSession,
} from '../types';
import type { SessionInput } from '../types';

/** 最近一次合并审计（被拦截草案留痕按排程段保留，供视图长期展示） */
export interface SyncAudit {
  mergedAt: string;
  outcomes: MergeOutcome[];
  blocked: Map<string, HeldDraft>;
}

interface SessionState {
  /** 合并后的三副本（事实来源） */
  replicas: SessionReplicas[];
  /** 当前窗口视角的投影（页面消费） */
  sessions: SyncSession[];
  hydrated: boolean;
  role: DutyRole;
  online: boolean;
  lastMergedAt: string;
  audit: SyncAudit | null;

  hydrate: () => Promise<void>;
  setRole: (role: DutyRole) => Promise<void>;
  setOnline: (online: boolean) => Promise<void>;

  addSession: (input: SessionInput) => Promise<ObsSession>;
  updateSession: (id: string, patch: Partial<SessionInput>) => Promise<void>;
  /** 删除本窗口排程段；含执行事实或处于待处置冲突时禁止删除 */
  removeSession: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 批量改期到备用观测夜并填写改期原因（仅作用于本窗口草案，冲突段不处理） */
  rescheduleToBackup: (ids: string[], backupNightId: string, reason: string) => Promise<number>;
  /** 现场执行登记：推进状态并记录执行事实（不改动计划字段） */
  recordFact: (
    id: string,
    fact: {
      status: SessionStatus;
      actualFrames?: number;
      actualStartTime?: string;
      actualEndTime?: string;
      executedBy?: string;
      executionNote?: string;
    },
  ) => Promise<void>;

  /** 网络恢复：合并两边当前副本 */
  mergeNow: () => Promise<MergeOutcome[]>;
  /** 导入对侧交换包并合并（网络恢复/手工交换） */
  importPackage: (pkg: SyncPackage) => Promise<{ outcomes: MergeOutcome[]; from: DutyRole }>;
  /** 导出本窗口交换包 */
  exportPackage: () => SyncPackage;
  /** 人工处置冲突：选择采纳某一侧草案，收敛三份副本 */
  resolveConflict: (id: string, choose: DutyRole) => Promise<void>;
}

type SetState = (partial: Partial<SessionState>) => void;
type GetState = () => SessionState;

async function getMeta(key: string): Promise<string | undefined> {
  return (await db.meta.get(key))?.value;
}

async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}

async function getTombstones(): Promise<Set<string>> {
  const raw = await getMeta(META_KEYS.tombstones);
  if (!raw) return new Set();
  try {
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

/** 事实来源 → 按当前窗口重新投影 */
function project(rows: SessionReplicas[], role: DutyRole, blocked?: Map<string, HeldDraft>): SyncSession[] {
  return projectSessions(rows, role, blocked).sort(
    (a, b) => a.nightId.localeCompare(b.nightId) || a.startTime.localeCompare(b.startTime),
  );
}

/** 写回三副本表并更新内存态与投影 */
async function commit(get: GetState, set: SetState, rows: SessionReplicas[], extra: Partial<SessionState> = {}): Promise<void> {
  await db.sessionReplicas.bulkPut(rows);
  set({ replicas: rows, sessions: project(rows, get().role, get().audit?.blocked), ...extra });
}

/** 仅更新本窗口角色副本 */
async function mutateOwnCopy(get: GetState, set: SetState, id: string, fn: (copy: ObsSession) => ObsSession): Promise<void> {
  const rows = get().replicas.map((row) => ({ ...row }));
  const row = rows.find((item) => item.id === id);
  if (!row) return;
  const role = get().role;
  const own = role === 'main' ? row.main : row.field;
  const base = own ?? row.base ?? (role === 'main' ? row.field : row.main);
  if (!base) return;
  const next = fn({ ...base });
  if (role === 'main') row.main = next;
  else row.field = next;
  await commit(get, set, rows);
}

/** 落库合并结果、写入审计留痕、记录合并时刻 */
async function finishMerge(
  result: ReturnType<typeof reconcile>,
  get: GetState,
  set: SetState,
): Promise<MergeOutcome[]> {
  const rows = Object.values(result.replicas);
  const blocked = new Map(get().audit?.blocked ?? []);
  result.outcomes.forEach((outcome) => {
    if (outcome.blockedDraft) blocked.set(outcome.sessionId, outcome.blockedDraft);
  });
  // 已收敛 / 冲突已解除 / 已无事实锁定的段，清理历史拦截留痕
  rows.forEach((row) => {
    if (blocked.has(row.id) && !factBlockedPair(row)) blocked.delete(row.id);
  });
  const audit: SyncAudit = { mergedAt: result.mergedAt, outcomes: result.outcomes, blocked };
  await setMeta(META_KEYS.lastMergedAt, result.mergedAt);
  await setMeta('sync.blocked', JSON.stringify(Object.fromEntries(blocked)));
  await commit(get, set, rows, { lastMergedAt: result.mergedAt, audit });
  return result.outcomes;
}

/** 排程段（含主控排程草案与现场执行事实），双窗口离线协同 */
export const useSessionStore = create<SessionState>()((set: SetState, get: GetState) => ({
  replicas: [],
  sessions: [],
  hydrated: false,
  role: 'main',
  online: true,
  lastMergedAt: '',
  audit: null,

  hydrate: async () => {
    const [roleRaw, onlineRaw, lastMergedAt, rows, blockedRaw] = await Promise.all([
      getMeta(META_KEYS.role),
      getMeta(META_KEYS.online),
      getMeta(META_KEYS.lastMergedAt),
      db.sessionReplicas.toArray(),
      getMeta('sync.blocked'),
    ]);
    const role: DutyRole = roleRaw === 'field' ? 'field' : 'main';
    let blocked: Map<string, HeldDraft> | undefined;
    if (blockedRaw) {
      try {
        blocked = new Map(Object.entries(JSON.parse(blockedRaw) as Record<string, HeldDraft>));
      } catch {
        blocked = undefined;
      }
    }
    set({
      replicas: rows,
      sessions: project(rows, role, blocked),
      role,
      online: onlineRaw === 'false' ? false : true,
      lastMergedAt: lastMergedAt ?? '',
      audit: blocked ? { mergedAt: lastMergedAt ?? '', outcomes: [], blocked } : null,
      hydrated: true,
    });
  },

  setRole: async (role) => {
    await setMeta(META_KEYS.role, role);
    set({ role, sessions: project(get().replicas, role, get().audit?.blocked) });
  },

  setOnline: async (online) => {
    await setMeta(META_KEYS.online, String(online));
    set({ online });
  },

  addSession: async (input) => {
    const role = get().role;
    const session: ObsSession = {
      id: uid('s'),
      nightId: input.nightId,
      targetId: input.targetId,
      startTime: input.startTime,
      endTime: input.endTime,
      telescopeId: input.telescopeId,
      instrumentId: input.instrumentId,
      filterSlot: input.filterSlot,
      plannedFrames: Number(input.plannedFrames) || 0,
      status: input.status,
      rescheduleReason: input.rescheduleReason?.trim() || undefined,
      backupNightId: input.backupNightId,
      schemaVersion: SCHEMA_VERSION,
    };
    // 离线新增：仅本窗口持有副本，对侧缺边，待合并时按「单侧新增」接受
    const row: SessionReplicas = {
      id: session.id,
      main: role === 'main' ? session : undefined,
      field: role === 'field' ? session : undefined,
    };
    await commit(get, set, [...get().replicas, row]);
    return session;
  },

  updateSession: async (id, patch) => {
    await mutateOwnCopy(get, set, id, (copy) => ({
      ...copy,
      ...patch,
      rescheduleReason: patch.rescheduleReason !== undefined ? patch.rescheduleReason.trim() || undefined : copy.rescheduleReason,
      schemaVersion: SCHEMA_VERSION,
    }));
  },

  removeSession: async (id) => {
    const projected = get().sessions.find((session) => session.id === id);
    if (projected?.pendingConflict) {
      return { ok: false, reason: '该排程段处于待处置冲突区，请先在值班同步页处置后再删除' };
    }
    const role = get().role;
    const row = get().replicas.find((item) => item.id === id);
    const own = role === 'main' ? row?.main : row?.field;
    if (own && hasFact(own)) {
      return { ok: false, reason: '该排程段已登记进行中 / 已完成执行事实，不能删除' };
    }
    // 离线删除只摘除本窗口副本并记录墓碑；对侧仍持有的数据到达时，墓碑在合并阶段过滤、不复活
    const rows = get().replicas.map((item) =>
      item.id === id ? (role === 'main' ? { ...item, main: undefined } : { ...item, field: undefined }) : item,
    );
    const tombstones = await getTombstones();
    tombstones.add(id);
    await db.meta.put({ key: META_KEYS.tombstones, value: JSON.stringify([...tombstones]) });
    // 本窗口视角下该段已不存在
    const visibleRows = rows.filter((item) => (role === 'main' ? item.main : item.field));
    await db.sessionReplicas.bulkPut(visibleRows);
    set({ replicas: visibleRows, sessions: project(visibleRows, role, get().audit?.blocked) });
    return { ok: true };
  },

  rescheduleToBackup: async (ids, backupNightId, reason) => {
    const blocked = new Set(get().sessions.filter((session) => session.pendingConflict).map((session) => session.id));
    const targets = ids.filter((id) => !blocked.has(id));
    if (targets.length === 0) return 0;
    const targetSet = new Set(targets);
    const role = get().role;
    const rows = get().replicas.map((row) => {
      if (!targetSet.has(row.id)) return row;
      const own = (role === 'main' ? row.main : row.field) ?? row.base;
      if (!own || hasFact(own)) return row;
      const next: ObsSession = {
        ...own,
        backupNightId,
        status: '因云取消',
        rescheduleReason: reason.trim() || '改期至备用观测夜',
        schemaVersion: SCHEMA_VERSION,
      };
      return role === 'main' ? { ...row, main: next } : { ...row, field: next };
    });
    await commit(get, set, rows);
    return targets.length;
  },

  recordFact: async (id, fact) => {
    const role = get().role;
    await mutateOwnCopy(get, set, id, (copy) => ({
      ...copy,
      status: fact.status,
      actualFrames: fact.actualFrames ?? copy.actualFrames,
      actualStartTime: fact.actualStartTime || copy.actualStartTime,
      actualEndTime: fact.actualEndTime || copy.actualEndTime,
      executedBy: fact.executedBy?.trim() || copy.executedBy,
      executionNote: fact.executionNote?.trim() || copy.executionNote,
      executedAt: new Date().toISOString(),
      factRole: role,
      schemaVersion: SCHEMA_VERSION,
    }));
  },

  mergeNow: async () => {
    const tombstones = await getTombstones();
    const result = reconcile(get().replicas, { tombstones: [...tombstones] });
    return finishMerge(result, get, set);
  },

  importPackage: async (pkg) => {
    if (pkg.format !== 'gbobsplan-sync' || pkg.version !== 3) {
      throw new Error('交换包格式或版本不被支持');
    }
    const tombstones = await getTombstones();
    const result = applySyncPackage(get().replicas, pkg, { tombstones: [...tombstones] });
    const outcomes = await finishMerge(result, get, set);
    return { outcomes, from: pkg.role };
  },

  exportPackage: () => {
    const role = get().role;
    const ownSessions = get()
      .replicas.map((row) => (role === 'main' ? row.main : row.field))
      .filter((session): session is ObsSession => Boolean(session));
    return buildSyncPackage(role, ownSessions);
  },

  resolveConflict: async (id, choose) => {
    const rows = get().replicas.map((row) => ({ ...row }));
    const row = rows.find((item) => item.id === id);
    if (!row || !isConflictTriple(row)) return;
    const chosen = choose === 'main' ? row.main : row.field;
    if (!chosen) return;
    const winner: ObsSession = { ...chosen, schemaVersion: SCHEMA_VERSION };
    row.base = { ...winner };
    row.main = { ...winner };
    row.field = { ...winner };
    const blocked = new Map(get().audit?.blocked ?? []);
    blocked.delete(id);
    await setMeta('sync.blocked', JSON.stringify(Object.fromEntries(blocked)));
    await commit(get, set, rows, { audit: { ...(get().audit ?? { mergedAt: get().lastMergedAt, outcomes: [] }), blocked } });
  },
}));

/** 供外部读取某排程段计划草案（冲突处置/详情使用） */
export function draftPlan(session: ObsSession): import('../types').PlanValues {
  return planOf(session);
}
