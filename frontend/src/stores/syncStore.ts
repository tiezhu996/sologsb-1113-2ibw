import { create } from 'zustand';
import { db, stripTransient } from '../hooks/usePersistentStore';
import type {
  DutyRole,
  MergeConflict,
  MergeReport,
  ObsSession,
  OfflineChange,
  SessionProvenance,
  SessionSnapshot,
} from '../types';
import { mergeOfflineChanges, guardMasterFact, pendingConflictIds, resolveSnapshot } from '../utils/merge';

const META_ROLE_KEY = 'dutyRole';
const META_ONLINE_KEY = 'networkOnline';

function changeKey(side: DutyRole, sessionId: string): string {
  return `${side}:${sessionId}`;
}

/** 去掉内存标记的快照 */
function snapshotOf(session: ObsSession): SessionSnapshot {
  return stripTransient(session);
}

/** 重新注入 sessionStore（角色 / 网络 / 合并 / 草案变化后调用） */
async function rehydrateSessions() {
  const { useSessionStore } = await import('./sessionStore');
  await useSessionStore.getState().hydrate();
}

interface SyncState {
  role: DutyRole;
  online: boolean;
  hydrated: boolean;
  offlineChanges: OfflineChange[];
  conflicts: MergeConflict[];
  /** 最近一次合并报告 */
  lastReport: MergeReport | null;
  /** v2→v3 历史迁移时间（旧数据迁移提示） */
  migratedAt: string;

  hydrate: () => Promise<void>;
  setRole: (role: DutyRole) => Promise<void>;
  setOnline: (online: boolean) => Promise<void>;

  /** 当前视角下生效的排程段：主表 + 本侧离线草案（对侧草案不可见） */
  effectiveSessions: (heads: ObsSession[]) => ObsSession[];
  /** 本侧是否存在该段的离线草案 */
  draftOf: (side: DutyRole, sessionId: string) => OfflineChange | undefined;
  /** 待处置冲突 id 集合 */
  pendingIds: () => Set<string>;

  /**
   * 记录一次排程段写入（新增 / 编辑 / 改期 / 状态登记）。
   * 在线：直接返回 null（调用方写主表）；离线：写入 / 更新本侧草案。
   * 返回被执行事实保护拦截的原因文案（未拦截返回 null）。
   */
  recordSessionWrite: (input: { id: string; next: ObsSession; side?: DutyRole; kind?: 'edit' }) => Promise<string | null>;
  /** 记录一次删除（离线时作为草案保留）；返回拦截原因或 null */
  recordSessionDelete: (input: { id: string; side?: DutyRole }) => Promise<string | null>;
  /** 丢弃一条被拦截 / 不再需要的离线草案 */
  discardChange: (key: string) => Promise<void>;

  /** 网络恢复后合并两侧离线草案 */
  mergeWhenRecovered: () => Promise<MergeReport>;
  /** 人工处置冲突 */
  resolveConflict: (sessionId: string, resolution: 'master' | 'field', note: string, by: string) => Promise<void>;

  /** 在线直接写主表后调用：同步基线（已触达的段） */
  touchBasesForHeads: (ids: string[]) => Promise<void>;

  /** 拉取最新离线变更与冲突（合并 / 处置后内部调用） */
  refresh: () => Promise<void>;
}

export const useSyncStore = create<SyncState>()((set, get) => ({
  role: 'master',
  online: true,
  hydrated: false,
  offlineChanges: [],
  conflicts: [],
  lastReport: null,
  migratedAt: '',

  hydrate: async () => {
    const [roleRow, onlineRow, migratedRow, offlineChanges, conflicts] = await Promise.all([
      db.meta.get(META_ROLE_KEY),
      db.meta.get(META_ONLINE_KEY),
      db.meta.get('v3MigratedAt'),
      db.offlineChanges.toArray(),
      db.mergeConflicts.toArray(),
    ]);
    set({
      role: (roleRow?.value as DutyRole) ?? 'master',
      online: onlineRow ? onlineRow.value === 'true' : true,
      offlineChanges,
      conflicts,
      migratedAt: migratedRow?.value ?? '',
      hydrated: true,
    });
  },

  setRole: async (role) => {
    await db.meta.put({ key: META_ROLE_KEY, value: role });
    set({ role });
    await rehydrateSessions();
  },

  setOnline: async (online) => {
    await db.meta.put({ key: META_ONLINE_KEY, value: String(online) });
    set({ online });
    // 网络恢复时自动尝试合并两侧离线草案
    if (online) {
      const { offlineChanges } = get();
      if (offlineChanges.length > 0) {
        await get().mergeWhenRecovered();
        return;
      }
    }
    await rehydrateSessions();
  },

  effectiveSessions: (heads) => {
    const { offlineChanges, role, conflicts } = get();
    const pending = pendingConflictIds(conflicts);
    const mine = new Map(
      offlineChanges.filter((change) => change.side === role).map((change) => [change.sessionId, change]),
    );
    const result: ObsSession[] = [];
    for (const head of heads) {
      const change = mine.get(head.id);
      if (change) {
        if (change.kind === 'delete' || !change.snapshot) continue;
        result.push({ ...change.snapshot, __offlineSide: role, __offlineDeleted: false });
      } else {
        result.push(head);
      }
    }
    // 离线新增（基线不存在的段）
    for (const change of mine.values()) {
      if (change.base === null && change.snapshot && !heads.some((head) => head.id === change.sessionId)) {
        result.push({ ...change.snapshot, __offlineSide: role });
      }
    }
    // 待处置冲突段：保留主表现值（通常为现场执行事实），页面与导出负责拦截编辑 / 导出
    void pending;
    return result;
  },

  draftOf: (side, sessionId) =>
    get().offlineChanges.find((change) => change.side === side && change.sessionId === sessionId),

  pendingIds: () => pendingConflictIds(get().conflicts),

  recordSessionWrite: async ({ id, next, side, kind: _kind }) => {
    const state = get();
    const useSide = side ?? state.role;
    const snapshot = snapshotOf(next);

    // 基线优先级：该侧已有草案的 base（首次离线修改前）→ 共同基线 → 主表当前值 → null（离线新增）
    const existing = state.offlineChanges.find((change) => change.side === useSide && change.sessionId === id);
    const base: SessionSnapshot | null = existing?.base ?? (await db.syncBases.get(id)) ?? (await db.sessions.get(id)) ?? null;

    // 执行事实保护（仅主控受约束；现场登记的就是事实本身）
    const guard = guardMasterFact(useSide, base, snapshot);
    if (state.online) {
      if (guard.blocked) return guard.reason;
      return null;
    }

    const nowIso = new Date().toISOString();
    const change: OfflineChange = {
      key: changeKey(useSide, id),
      side: useSide,
      sessionId: id,
      kind: 'edit',
      snapshot: guard.blocked ? snapshot : { ...snapshot, provenance: useSide === 'master' ? '主控草案' : '现场执行' },
      base,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      blockedByFact: guard.blocked || existing?.blockedByFact,
      blockedReason: guard.blocked ? guard.reason : existing?.blockedReason,
    };
    await db.offlineChanges.put(change);
    await state.refresh();
    return guard.blocked ? guard.reason : null;
  },

  recordSessionDelete: async ({ id, side }) => {
    const state = get();
    const useSide = side ?? state.role;
    const base: SessionSnapshot | null =
      state.offlineChanges.find((change) => change.side === useSide && change.sessionId === id)?.base ??
      (await db.syncBases.get(id)) ??
      (await db.sessions.get(id)) ??
      null;

    const guard = guardMasterFact(useSide, base, null);
    if (state.online) {
      return guard.blocked ? guard.reason : null;
    }

    const nowIso = new Date().toISOString();
    const existing = state.offlineChanges.find((change) => change.side === useSide && change.sessionId === id);
    const change: OfflineChange = {
      key: changeKey(useSide, id),
      side: useSide,
      sessionId: id,
      kind: 'delete',
      snapshot: null,
      base,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      blockedByFact: guard.blocked,
      blockedReason: guard.blocked ? guard.reason : undefined,
    };
    await db.offlineChanges.put(change);
    await state.refresh();
    return guard.blocked ? guard.reason : null;
  },

  discardChange: async (key) => {
    await db.offlineChanges.delete(key);
    await get().refresh();
    await rehydrateSessions();
  },

  mergeWhenRecovered: async () => {
    const state = get();
    const [heads, baseRows, changes, conflictRows] = await Promise.all([
      db.sessions.toArray(),
      db.syncBases.toArray(),
      db.offlineChanges.toArray(),
      db.mergeConflicts.toArray(),
    ]);
    const nowIso = new Date().toISOString();
    const output = mergeOfflineChanges({
      heads,
      bases: new Map(baseRows.map((base) => [base.id, base])),
      changes,
      existingConflicts: new Map(conflictRows.map((conflict) => [conflict.id, conflict])),
      now: nowIso,
    });

    // 写主表 / 基线 / 冲突区，删除已消费的草案（被拦截的保留）
    await db.transaction('rw', db.sessions, db.syncBases, db.mergeConflicts, db.offlineChanges, async () => {
      await db.sessions.bulkPut(output.heads);
      // 删除已不存在的段（删除类合并）
      const liveIds = new Set(output.heads.map((session) => session.id));
      const staleIds = heads.map((session) => session.id).filter((id) => !liveIds.has(id));
      if (staleIds.length > 0) await db.sessions.bulkDelete(staleIds);
      await db.syncBases.clear();
      await db.syncBases.bulkPut(output.bases);
      await db.mergeConflicts.clear();
      await db.mergeConflicts.bulkPut(output.conflicts);
      if (output.consumedKeys.length > 0) await db.offlineChanges.bulkDelete(output.consumedKeys);
    });

    // 把主表数据重新灌回 sessionStore
    const { useSessionStore } = await import('./sessionStore');
    await useSessionStore.getState().hydrate();

    set({ lastReport: output.report });
    await state.refresh();
    return output.report;
  },

  resolveConflict: async (sessionId, resolution, note, by) => {
    const state = get();
    const conflict = state.conflicts.find((item) => item.id === sessionId);
    if (!conflict || conflict.status === 'resolved') return;

    const snapshot = resolveSnapshot(conflict, resolution);
    const nowIso = new Date().toISOString();
    const provenance: SessionProvenance = resolution === 'master' ? '主控草案' : '现场执行';
    const resolvedSnapshot: SessionSnapshot | null = snapshot
      ? { ...snapshot, schemaVersion: 3, provenance }
      : null;

    const nextConflict: MergeConflict = {
      ...conflict,
      status: 'resolved',
      resolution,
      resolvedSnapshot,
      resolvedBy: by || (state.role === 'master' ? '主控值班人' : '现场值班人'),
      resolvedAt: nowIso,
      resolutionNote: note.trim() || undefined,
    };

    await db.transaction('rw', db.sessions, db.syncBases, db.mergeConflicts, async () => {
      await db.mergeConflicts.put(nextConflict);
      if (resolvedSnapshot) {
        await db.sessions.put(resolvedSnapshot);
        await db.syncBases.put(resolvedSnapshot);
      } else {
        await db.sessions.delete(sessionId);
        await db.syncBases.delete(sessionId);
      }
    });

    const { useSessionStore } = await import('./sessionStore');
    await useSessionStore.getState().hydrate();
    await state.refresh();
  },

  touchBasesForHeads: async (ids) => {
    if (ids.length === 0) return;
    const sessions = await db.sessions.where('id').anyOf(ids).toArray();
    await db.syncBases.bulkPut(sessions.map(snapshotOf));
  },

  refresh: async () => {
    const [offlineChanges, conflicts] = await Promise.all([db.offlineChanges.toArray(), db.mergeConflicts.toArray()]);
    set({ offlineChanges, conflicts });
  },
}));

/** 在线写入时给排程段打的来源标记 */
export function provenanceForRole(role: DutyRole): SessionProvenance {
  return role === 'master' ? '主控草案' : '现场执行';
}
