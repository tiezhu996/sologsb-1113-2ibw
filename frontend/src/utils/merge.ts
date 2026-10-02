import type {
  DutyRole,
  MergeConflict,
  MergeReport,
  ObsSession,
  OfflineChange,
  SessionSnapshot,
} from '../types';
import { isExecutionFact } from '../types';

/** 参与三方比对的排程字段：基线快照、主控草案、现场记录逐字段比较用 */
const COMPARE_FIELDS = [
  'nightId',
  'targetId',
  'startTime',
  'endTime',
  'telescopeId',
  'instrumentId',
  'filterSlot',
  'plannedFrames',
  'status',
  'rescheduleReason',
  'backupNightId',
  'actualStartTime',
  'actualEndTime',
  'actualFrames',
  'executionNote',
  'recordedBy',
] as const;

type CompareField = (typeof COMPARE_FIELDS)[number];

function fieldsChanged(a: SessionSnapshot | null, b: SessionSnapshot | null): Set<CompareField> {
  const changed = new Set<CompareField>();
  for (const field of COMPARE_FIELDS) {
    if ((a?.[field] ?? undefined) !== (b?.[field] ?? undefined)) {
      changed.add(field);
    }
  }
  return changed;
}

/** 仅排程草案关心的字段（设备与时段）：未开始段单边改这些可直接接纳 */
const PLAN_FIELDS: CompareField[] = [
  'nightId',
  'startTime',
  'endTime',
  'telescopeId',
  'instrumentId',
  'filterSlot',
  'plannedFrames',
];

/** 现场执行事实字段 */
const FACT_FIELDS: CompareField[] = ['status', 'actualStartTime', 'actualEndTime', 'actualFrames', 'executionNote', 'recordedBy'];

export interface MergeInput {
  /** 当前主表排程段 */
  heads: ObsSession[];
  /** 共同基线（id -> 快照） */
  bases: Map<string, SessionSnapshot>;
  /** 两侧离线变更（已含 blockedByFact 标记） */
  changes: OfflineChange[];
  /** 已存在的冲突区条目（id -> 冲突） */
  existingConflicts: Map<string, MergeConflict>;
  now: string;
}

export interface MergeOutput {
  /** 合并后写入主表的完整排程段集合 */
  heads: SessionSnapshot[];
  /** 合并后的共同基线（与 heads 一致） */
  bases: SessionSnapshot[];
  /** 冲突区（新增 / 刷新，已解决的保持原状） */
  conflicts: MergeConflict[];
  /** 已被合并消费、应从 offlineChanges 删除的 key */
  consumedKeys: string[];
  /** 仍被执行事实保护拦截、保留在离线侧的 key */
  blockedKeys: string[];
  report: MergeReport;
}

function toSnapshot(session: ObsSession): SessionSnapshot {
  const { __offlineSide, __offlineDeleted, ...snapshot } = session;
  return snapshot;
}

function describeChangedFields(fields: Set<CompareField>): string {
  const labels: Record<CompareField, string> = {
    nightId: '观测夜',
    targetId: '目标',
    startTime: '开始时刻',
    endTime: '结束时刻',
    telescopeId: '望远镜',
    instrumentId: '终端',
    filterSlot: '滤镜',
    plannedFrames: '计划帧数',
    status: '执行状态',
    rescheduleReason: '改期原因',
    backupNightId: '替补夜',
    actualStartTime: '实际开始',
    actualEndTime: '实际结束',
    actualFrames: '实际帧数',
    executionNote: '执行备注',
    recordedBy: '记录人',
  };
  return COMPARE_FIELDS.filter((field) => fields.has(field))
    .map((field) => labels[field])
    .join('、');
}

/**
 * 三方合并：基线 base + 主控离线草案 + 现场离线记录。
 *
 * 规则：
 * 1. 已完成 / 进行中的执行事实不能被排程草案覆盖（主控改事实段直接拦截，保留草案）。
 * 2. 只有一侧改：未开始段的排程草案、现场执行记录均自动接纳。
 * 3. 两边都改同一排程段：两份草案与来源都保留，进入冲突区等人处置，不自动合并。
 * 4. 旧数据只作为基线存在（历史迁移），不作为任一侧变更，不产生新冲突。
 */
export function mergeOfflineChanges(input: MergeInput): MergeOutput {
  const { heads, bases, changes, existingConflicts, now } = input;

  const headMap = new Map<string, SessionSnapshot>(heads.map((session) => [session.id, toSnapshot(session)]));
  const bySide = new Map<DutyRole, Map<string, OfflineChange>>();
  for (const change of changes) {
    const sideMap = bySide.get(change.side) ?? new Map<string, OfflineChange>();
    // 同一段在一侧离线期内可能多次修改，offlineChanges 按 key 唯一，这里仍做兜底
    sideMap.set(change.sessionId, change);
    bySide.set(change.side, sideMap);
  }
  const masterChanges = bySide.get('master') ?? new Map<string, OfflineChange>();
  const fieldChanges = bySide.get('field') ?? new Map<string, OfflineChange>();

  const consumedKeys: string[] = [];
  const blockedKeys: string[] = [];
  const touched = new Set<string>();
  const report: MergeReport = {
    mergedAt: now,
    autoApplied: 0,
    combined: 0,
    conflicts: 0,
    blocked: 0,
    factWins: 0,
    pending: 0,
  };

  const applySnapshot = (id: string, snapshot: SessionSnapshot | null) => {
    if (snapshot === null) {
      headMap.delete(id);
    } else {
      headMap.set(id, { ...snapshot, schemaVersion: 3 });
    }
    touched.add(id);
  };

  const allIds = new Set<string>([...masterChanges.keys(), ...fieldChanges.keys()]);

  for (const id of allIds) {
    const master = masterChanges.get(id);
    const field = fieldChanges.get(id);
    const base = master?.base ?? field?.base ?? bases.get(id) ?? null;

    // 执行事实保护：主控草案试图改动 / 删除已是「进行中 / 已完成」的段 → 拦截不覆盖事实
    if (master?.blockedByFact) {
      if (field) {
        // 两边离线期都碰过同一段：现场事实先生效，两份草案进冲突区等人处置
        const previous = existingConflicts.get(id);
        const reason = `主控试图调整已为「${base?.status ?? '执行中'}」的执行事实（已被保护拦截），现场离线又登记了新执行记录；执行事实不被草案覆盖`;
        const conflict: MergeConflict = {
          id,
          sessionId: id,
          status: 'pending',
          masterDraft: master.kind === 'delete' ? null : master.snapshot,
          fieldDraft: field.kind === 'delete' ? null : field.snapshot,
          base,
          masterKind: master.kind,
          fieldKind: field.kind,
          fieldHasFact: true,
          reason,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        };
        existingConflicts.set(id, conflict);
        applySnapshot(id, field.snapshot);
        consumedKeys.push(master.key, field.key);
        report.conflicts += 1;
      } else {
        // 只有主控这一份草案：保留在离线侧，不覆盖事实，等人处理
        blockedKeys.push(master.key);
        report.blocked += 1;
      }
      continue;
    }

    if (master && field) {
      // —— 两边都改过同一段：保留两份草案与来源，进冲突区 ——
      const masterEdited = fieldsChanged(base, master.snapshot);
      const fieldEdited = fieldsChanged(base, field.snapshot);
      const fieldHasFact =
        field.kind === 'edit' && !!field.snapshot && isExecutionFact(field.snapshot.status) && !(base && isExecutionFact(base.status));

      let reason: string;
      if (fieldHasFact) {
        reason = `主控调整了${describeChangedFields(masterEdited) || '排程'}，现场已登记执行事实（${field.snapshot?.status}），执行事实不被草案覆盖`;
        report.factWins += 1;
        // 执行事实先行生效；主控草案随冲突保留，等人在冲突区处置
        applySnapshot(id, field.snapshot);
      } else if (master.kind === 'delete' || field.kind === 'delete') {
        reason = `主控${master.kind === 'delete' ? '删除' : `修改了${describeChangedFields(masterEdited) || '排程'}`}，现场${
          field.kind === 'delete' ? '删除' : `登记了${describeChangedFields(fieldEdited) || '执行'}`
        }，两边都改过该段`;
      } else {
        reason = `主控改了${describeChangedFields(masterEdited) || '排程'}，现场改了${describeChangedFields(fieldEdited) || '执行记录'}，两边都改过该段`;
      }

      const previous = existingConflicts.get(id);
      const conflict: MergeConflict = {
        id,
        sessionId: id,
        status: previous?.status === 'resolved' ? 'pending' : 'pending',
        masterDraft: master.kind === 'delete' ? null : master.snapshot,
        fieldDraft: field.kind === 'delete' ? null : field.snapshot,
        base,
        masterKind: master.kind,
        fieldKind: field.kind,
        fieldHasFact,
        reason,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      existingConflicts.set(id, conflict);
      report.conflicts += 1;
      consumedKeys.push(master.key, field.key);
      touched.add(id);
      continue;
    }

    // —— 只有一侧改 ——
    const only = master ?? field;
    if (!only) continue;

    if (only.blockedByFact) {
      // 理论上前面已处理（仅主控会被拦），双保险
      blockedKeys.push(only.key);
      continue;
    }

    if (only.side === 'master') {
      // 主控单边草案：基线必须是未开始段，且改的是排程字段（拦截逻辑在录入侧已保证，这里再校验一次）
      const baseline = base;
      if (baseline && isExecutionFact(baseline.status)) {
        blockedKeys.push(only.key);
        report.blocked += 1;
        continue;
      }
      applySnapshot(id, only.snapshot);
      consumedKeys.push(only.key);
      report.autoApplied += 1;
    } else {
      // 现场单边执行记录：执行事实优先，直接接纳
      applySnapshot(id, only.snapshot);
      consumedKeys.push(only.key);
      report.autoApplied += 1;
    }
  }

  // 基线对齐合并结果（只更新本次触达的段，未触达段基线保持不动 —— 历史迁移数据沿用）
  const nextBases: SessionSnapshot[] = [];
  for (const [id, snapshot] of headMap) {
    const existingBase = bases.get(id);
    if (touched.has(id) || !existingBase) {
      nextBases.push(snapshot);
    } else {
      nextBases.push(existingBase);
    }
  }

  const nextHeads = [...headMap.values()];

  // 仍待处置的冲突计数（含本次未涉及、之前遗留的 pending）
  report.pending = [...existingConflicts.values()].filter((conflict) => conflict.status === 'pending').length;

  return {
    heads: nextHeads,
    bases: nextBases,
    conflicts: [...existingConflicts.values()],
    consumedKeys,
    blockedKeys,
    report,
  };
}

/**
 * 录入离线草案时的执行事实保护判定。
 * 主控侧试图改动 / 删除基线中已「进行中 / 已完成」的段时，标记 blockedByFact：
 * 草案保留在离线侧，不参与自动覆盖，等人在冲突区处置。
 */
export function guardMasterFact(
  side: DutyRole,
  base: SessionSnapshot | null,
  snapshot: SessionSnapshot | null,
): { blocked: boolean; reason: string } {
  if (side !== 'master') return { blocked: false, reason: '' };
  if (base && isExecutionFact(base.status)) {
    return {
      blocked: true,
      reason: `该段现场已登记为「${base.status}」（执行事实），主控排程草案不能覆盖；草案已保留，待网络恢复后在冲突区人工处置`,
    };
  }
  // 主控不能把段自行改成进行中 / 已完成（那是现场执行事实）
  if (snapshot && isExecutionFact(snapshot.status)) {
    return {
      blocked: true,
      reason: '「进行中 / 已完成」属于现场执行事实，只能由现场窗口登记，主控不能在排程草案中改写',
    };
  }
  return { blocked: false, reason: '' };
}

/** 未解决冲突涉及的排程段 id 集合：这些段不能进入导出清单 */
export function pendingConflictIds(conflicts: MergeConflict[]): Set<string> {
  return new Set(conflicts.filter((conflict) => conflict.status === 'pending').map((conflict) => conflict.sessionId));
}

/** 导出过滤：剔除未确认处置的冲突段（现场当前生效版本也不导出，必须等冲突区处置完） */
export function filterExportable<T extends { id: string }>(rows: T[], conflicts: MergeConflict[]): T[] {
  const blocked = pendingConflictIds(conflicts);
  return rows.filter((row) => !blocked.has(row.id));
}

/** 解决冲突时是否允许选择主控草案：现场草案含执行事实时禁止 */
export function canChooseMaster(conflict: MergeConflict): boolean {
  return !conflict.fieldHasFact;
}

/** 按处置选择生成生效快照（删除选择时返回 null） */
export function resolveSnapshot(conflict: MergeConflict, resolution: 'master' | 'field'): SessionSnapshot | null {
  if (resolution === 'master') {
    if (!canChooseMaster(conflict)) return conflict.fieldDraft;
    return conflict.masterDraft;
  }
  return conflict.fieldDraft;
}

/** 计划字段集合对外导出（页面判定「未开始段接受新设备与时段」用） */
export function isPlanOnlyChange(base: SessionSnapshot | null, next: SessionSnapshot | null): boolean {
  const changed = fieldsChanged(base, next);
  return [...changed].every((field) => (PLAN_FIELDS as readonly CompareField[]).includes(field));
}

export { PLAN_FIELDS, FACT_FIELDS };
