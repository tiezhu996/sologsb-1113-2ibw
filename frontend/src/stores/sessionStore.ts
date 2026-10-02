import { create } from 'zustand';
import { db, deleteRow, persistRow, SCHEMA_VERSION, stripTransient } from '../hooks/usePersistentStore';
import { uid } from '../utils/id';
import type { DutyRole, ObsSession, SessionProvenance, SessionStatus } from '../types';
import { isExecutionFact } from '../types';
import { provenanceForRole, useSyncStore } from './syncStore';

export interface SessionInput {
  nightId: string;
  targetId: string;
  startTime: string;
  endTime: string;
  telescopeId: string;
  instrumentId: string;
  filterSlot: string;
  plannedFrames: number;
  status: SessionStatus;
  rescheduleReason?: string;
  backupNightId?: string;
  actualStartTime?: string;
  actualEndTime?: string;
  actualFrames?: number;
  executionNote?: string;
  recordedBy?: string;
}

/** 主控草案受保护：对已是执行事实（进行中 / 已完成）的段，主控不能改动排程字段 */
export class FactProtectedError extends Error {}

/** 待人工处置的冲突段：任何一侧都不能继续改写，必须先在冲突区处置 */
export class ConflictLockedError extends Error {
  constructor(id: string) {
    super(`排程段 ${id} 在冲突区等待人工处置，处置完成前不能修改，请先到「值班窗口与合并」页处理`);
    this.name = 'ConflictLockedError';
  }
}

interface SessionState {
  sessions: ObsSession[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addSession: (input: SessionInput) => Promise<ObsSession>;
  updateSession: (id: string, patch: Partial<SessionInput>) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  /** 批量改期到备用观测夜并填写改期原因 */
  rescheduleToBackup: (ids: string[], backupNightId: string, reason: string) => Promise<number>;
  updateStatus: (id: string, status: SessionStatus) => Promise<void>;
  /** 现场登记执行记录（状态 / 实际时刻 / 帧数 / 备注） */
  recordExecution: (
    id: string,
    input: Pick<SessionInput, 'status' | 'actualStartTime' | 'actualEndTime' | 'actualFrames' | 'executionNote' | 'recordedBy'>,
  ) => Promise<void>;
}

/** 当前窗口是否离线 */
function offline(): boolean {
  return !useSyncStore.getState().online;
}

/** 当前值班角色 */
function role(): DutyRole {
  return useSyncStore.getState().role;
}

/** 用当前视角（含本侧离线草案）刷新 store 列表 */
async function refreshEffective(set: (partial: Partial<SessionState>) => void) {
  const heads = await db.sessions.orderBy('startTime').toArray();
  const sessions = useSyncStore.getState().effectiveSessions(heads);
  sessions.sort((a, b) => a.nightId.localeCompare(b.nightId) || a.startTime.localeCompare(b.startTime));
  set({ sessions });
}

/** 排程段与冲突检测所需数据 */
export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  hydrated: false,

  hydrate: async () => {
    const heads = await db.sessions.orderBy('startTime').toArray();
    const sessions = useSyncStore.getState().hydrated ? useSyncStore.getState().effectiveSessions(heads) : heads;
    sessions.sort((a, b) => a.nightId.localeCompare(b.nightId) || a.startTime.localeCompare(b.startTime));
    set({ sessions, hydrated: true });
  },

  addSession: async (input) => {
    const provenance: SessionProvenance = provenanceForRole(role());
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
      provenance,
      actualStartTime: input.actualStartTime,
      actualEndTime: input.actualEndTime,
      actualFrames: input.actualFrames,
      executionNote: input.executionNote?.trim() || undefined,
      recordedBy: input.recordedBy?.trim() || undefined,
      recordedAt: offline() || !isExecutionFact(input.status) ? undefined : new Date().toISOString(),
    };

    if (offline()) {
      const blockedReason = await useSyncStore.getState().recordSessionWrite({ id: session.id, next: session });
      if (blockedReason) throw new FactProtectedError(blockedReason);
    } else {
      await persistRow('sessions', session);
      await useSyncStore.getState().touchBasesForHeads([session.id]);
    }
    await refreshEffective(set);
    return session;
  },

  updateSession: async (id, patch) => {
    if (useSyncStore.getState().pendingIds().has(id)) {
      throw new ConflictLockedError(id);
    }
    const current =
      get().sessions.find((session) => session.id === id) ??
      (await db.sessions.get(id));
    if (!current) return;

    if (role() === 'master' && isExecutionFact(current.status)) {
      throw new FactProtectedError(
        `该段现场已登记为「${current.status}」（执行事实），主控排程草案不能覆盖；如需调整请联系现场或在网络恢复后于冲突区处置`,
      );
    }

    const next: ObsSession = {
      ...stripTransient(current),
      ...patch,
      schemaVersion: SCHEMA_VERSION,
      provenance: current.provenance ?? provenanceForRole(role()),
    };

    if (offline()) {
      const blockedReason = await useSyncStore.getState().recordSessionWrite({ id, next });
      if (blockedReason) throw new FactProtectedError(blockedReason);
    } else {
      await persistRow('sessions', next);
      await useSyncStore.getState().touchBasesForHeads([id]);
    }
    await refreshEffective(set);
  },

  removeSession: async (id) => {
    if (useSyncStore.getState().pendingIds().has(id)) {
      throw new ConflictLockedError(id);
    }
    const current = get().sessions.find((session) => session.id === id) ?? (await db.sessions.get(id));
    if (offline()) {
      const blockedReason = await useSyncStore.getState().recordSessionDelete({ id });
      if (blockedReason) throw new FactProtectedError(blockedReason);
    } else {
      if (current && role() === 'master' && isExecutionFact(current.status)) {
        throw new FactProtectedError('该段为现场已登记的执行事实，主控不能删除');
      }
      await deleteRow('sessions', id);
      await db.syncBases.delete(id);
    }
    await refreshEffective(set);
  },

  rescheduleToBackup: async (ids, backupNightId, reason) => {
    const sync = useSyncStore.getState();
    const pending = sync.pendingIds();
    const targets = get().sessions.filter((session) => ids.includes(session.id));
    const blocked: ObsSession[] = [];
    const updated: ObsSession[] = [];
    for (const session of targets) {
      // 待处置冲突段锁定；已在执行 / 已完成的事实段不允许被主控批量改期覆盖
      if (pending.has(session.id)) {
        blocked.push(session);
        continue;
      }
      if (role() === 'master' && isExecutionFact(session.status)) {
        blocked.push(session);
        continue;
      }
      updated.push({
        ...stripTransient(session),
        backupNightId,
        status: '因云取消' as SessionStatus,
        rescheduleReason: reason.trim() || '改期至备用观测夜',
        schemaVersion: SCHEMA_VERSION,
        provenance: offline() ? (role() === 'master' ? '主控草案' : '现场执行') : session.provenance,
      });
    }
    if (offline()) {
      for (const session of updated) {
        const blockedReason = await sync.recordSessionWrite({ id: session.id, next: session });
        if (blockedReason) blocked.push(session);
      }
    } else {
      for (const session of updated) {
        await persistRow('sessions', session);
      }
      await sync.touchBasesForHeads(updated.map((session) => session.id));
    }
    await refreshEffective(set);
    if (blocked.length > 0) {
      throw new FactProtectedError(`${blocked.length} 个排程段已是进行中 / 已完成的执行事实，未被改期覆盖：${blocked.map((s) => s.id).join('、')}`);
    }
    return updated.length;
  },

  updateStatus: async (id, status) => {
    await get().updateSession(id, { status });
  },

  recordExecution: async (id, input) => {
    if (useSyncStore.getState().pendingIds().has(id)) {
      throw new ConflictLockedError(id);
    }
    const current =
      get().sessions.find((session) => session.id === id) ?? (await db.sessions.get(id));
    if (!current) return;
    const patch: Partial<SessionInput> = {
      status: input.status,
      actualStartTime: input.actualStartTime || undefined,
      actualEndTime: input.actualEndTime || undefined,
      actualFrames: input.actualFrames === undefined || Number.isNaN(input.actualFrames) ? undefined : Number(input.actualFrames),
      executionNote: input.executionNote,
      recordedBy: input.recordedBy,
    };
    const next: ObsSession = {
      ...stripTransient(current),
      ...patch,
      schemaVersion: SCHEMA_VERSION,
      provenance: '现场执行',
      recordedAt: new Date().toISOString(),
    };

    if (offline()) {
      await useSyncStore.getState().recordSessionWrite({ id, next });
    } else {
      await persistRow('sessions', next);
      await useSyncStore.getState().touchBasesForHeads([id]);
    }
    await refreshEffective(set);
  },
}));
