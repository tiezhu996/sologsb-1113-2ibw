/** 排程段状态 */
export type SessionStatus = '待执行' | '进行中' | '已完成' | '因云取消';

/** 记录来源：主控排程草案 / 现场执行记录 / 初始示例 / 旧版本历史计划迁移 */
export type SessionProvenance = '主控草案' | '现场执行' | '初始计划' | '历史迁移';

/** 值班窗口（同一台机器上用角色切换模拟主控窗口与现场窗口） */
export type DutyRole = 'master' | 'field';

export const DUTY_ROLE_LABEL: Record<DutyRole, string> = {
  master: '主控窗口',
  field: '现场窗口',
};

/** 排程段 */
export interface ObsSession {
  id: string;
  /** 观测夜 ID */
  nightId: string;
  /** 观测目标 ID */
  targetId: string;
  /** 开始时刻 HH:mm */
  startTime: string;
  /** 结束时刻 HH:mm（可跨零点） */
  endTime: string;
  /** 望远镜 ID */
  telescopeId: string;
  /** 终端 ID */
  instrumentId: string;
  /** 滤镜轮位 */
  filterSlot: string;
  /** 计划帧数 */
  plannedFrames: number;
  /** 状态 */
  status: SessionStatus;
  /** 改期原因 */
  rescheduleReason?: string;
  /** 替补夜 ID（迁移时补齐） */
  backupNightId?: string;
  /** 数据结构版本 */
  schemaVersion: number;

  /* ----------------------- v3：来源与现场执行事实 ----------------------- */
  /** 该段记录来源（草案 / 执行 / 初始 / 历史迁移） */
  provenance?: SessionProvenance;
  /** 实际开始时刻 HH:mm（现场记录） */
  actualStartTime?: string;
  /** 实际结束时刻 HH:mm（现场记录） */
  actualEndTime?: string;
  /** 实际拍摄帧数（现场记录） */
  actualFrames?: number;
  /** 现场执行备注（天气、异常等） */
  executionNote?: string;
  /** 现场记录人 */
  recordedBy?: string;
  /** 现场记录时间 ISO */
  recordedAt?: string;

  /* ---------------- 仅用于内存：离线草案标记（不写入主表） ---------------- */
  /** 离线草案归属侧 */
  __offlineSide?: DutyRole;
  /** 离线草案是否为删除操作 */
  __offlineDeleted?: boolean;
}

/** 冲突项 */
export interface ConflictItem {
  /** 当前排程段 */
  sessionId: string;
  /** 与之冲突的排程段 */
  otherId: string;
  nightId: string;
  telescopeId: string;
  /** 重叠分钟数 */
  overlapMinutes: number;
  /** 重叠区间文案 */
  overlapText: string;
}

export const SESSION_STATUSES: SessionStatus[] = ['待执行', '进行中', '已完成', '因云取消'];

/** 现场可登记的执行状态（进行中 / 已完成 属于执行事实） */
export const FIELD_STATUSES: SessionStatus[] = ['进行中', '已完成', '因云取消'];

/** 4 种状态配色（MUI Chip color） */
export const STATUS_CHIP_COLOR: Record<SessionStatus, 'default' | 'primary' | 'success' | 'error'> = {
  待执行: 'default',
  进行中: 'primary',
  已完成: 'success',
  因云取消: 'error',
};

/** 状态是否属于已发生的执行事实（不能被排程草案覆盖） */
export function isExecutionFact(status: SessionStatus): boolean {
  return status === '进行中' || status === '已完成';
}

/** 来源配色（MUI Chip color） */
export const PROVENANCE_COLOR: Record<SessionProvenance, 'default' | 'primary' | 'success' | 'warning'> = {
  主控草案: 'primary',
  现场执行: 'success',
  初始计划: 'default',
  历史迁移: 'warning',
};

/* --------------------------- 离线合并相关类型 --------------------------- */

/** 离线草案 / 基线快照（sessions 的完整副本） */
export type SessionSnapshot = Omit<ObsSession, '__offlineSide' | '__offlineDeleted'>;

/** 一侧的离线变更 */
export interface OfflineChange {
  /** 主键：side + ':' + sessionId */
  key: string;
  side: DutyRole;
  sessionId: string;
  /** edit / delete（草案本体放在 snapshot，删除时 snapshot 为删除前最后版本） */
  kind: 'edit' | 'delete';
  /** 离线时该侧看到的完整草案；删除时为 null */
  snapshot: SessionSnapshot | null;
  /** 离线操作前的共同基线快照（合并时用于三方比对） */
  base: SessionSnapshot | null;
  /** 首次离线修改时间 ISO */
  createdAt: string;
  /** 最近一次离线修改时间 ISO */
  updatedAt: string;
  /** 是否因执行事实保护而被拦截（保留草案不参与自动合并，等人处置） */
  blockedByFact?: boolean;
  /** 被拦截原因文案 */
  blockedReason?: string;
}

/** 合并冲突处理状态 */
export type MergeConflictStatus = 'pending' | 'resolved';
/** 人工处置选择：采用主控草案 / 采用现场记录（执行事实受保护时只能选现场） */
export type MergeResolution = 'master' | 'field';

/** 合并冲突区条目：同一排程段两边都改过时，两份草案与来源都保留 */
export interface MergeConflict {
  /** 主键：sessionId（同一段在处置前只保留一条冲突，再次合并时刷新两份草案） */
  id: string;
  sessionId: string;
  status: MergeConflictStatus;
  /** 主控侧草案（删除时为 null） */
  masterDraft: SessionSnapshot | null;
  /** 现场侧草案（删除时为 null） */
  fieldDraft: SessionSnapshot | null;
  /** 合并时的共同基线 */
  base: SessionSnapshot | null;
  /** 主控侧操作类型 */
  masterKind: 'edit' | 'delete';
  /** 现场侧操作类型 */
  fieldKind: 'edit' | 'delete';
  /** 现场侧是否含进行中 / 已完成执行事实（为 true 时处置只能保留现场） */
  fieldHasFact: boolean;
  /** 冲突说明 */
  reason: string;
  createdAt: string;
  updatedAt: string;
  /** 处置结果 */
  resolution?: MergeResolution;
  /** 处置后生效的快照（冲突解决后写入主表的版本，两份原始草案仍保留） */
  resolvedSnapshot?: SessionSnapshot | null;
  resolvedBy?: string;
  resolvedAt?: string;
  resolutionNote?: string;
}

/** 一次合并的结果统计 */
export interface MergeReport {
  mergedAt: string;
  /** 自动接纳：单边变更 */
  autoApplied: number;
  /** 未开始段两边互不相干字段合并接纳（保留计数展示） */
  combined: number;
  /** 进入冲突区（两边都改） */
  conflicts: number;
  /** 被执行事实保护拦截的草案数 */
  blocked: number;
  /** 现场执行事实优先、主控草案被搁置（进冲突区）数 */
  factWins: number;
  /** 合并后仍待人工处置的冲突总数 */
  pending: number;
}
