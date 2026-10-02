import type { ObsSession } from './session';

/** 值班窗口：主控（编排排程草案）/ 现场（记录执行事实） */
export type DutyRole = 'main' | 'field';

export const DUTY_ROLE_LABEL: Record<DutyRole, string> = {
  main: '主控窗口',
  field: '现场窗口',
};

/**
 * 参与「排程草案」合并的计划字段（设备与时段等）。
 * 执行状态与实际帧数等属于执行事实，不在此列。
 */
export const PLAN_FIELDS = [
  'nightId',
  'targetId',
  'startTime',
  'endTime',
  'telescopeId',
  'instrumentId',
  'filterSlot',
  'plannedFrames',
] as const;

export type PlanField = (typeof PLAN_FIELDS)[number];
export type PlanValues = Pick<ObsSession, PlanField>;

/** 同步后单个排程段在当前窗口视图下的处置状态 */
export type SyncState =
  | 'unified' // 两边一致 / 已合并无分歧
  | 'local-draft' // 本窗口有离线草案，尚未与对侧合并
  | 'remote-draft' // 对侧草案已到达，本窗口未改（未开始段，已接受新设备与时段）
  | 'fact-locked' // 存在进行中/已完成执行事实，对侧排程草案被拦截、未覆盖
  | 'conflict'; // 两边都改且未开始、内容不一致，等待人工处置

export const SYNC_STATE_LABEL: Record<SyncState, string> = {
  unified: '两边一致',
  'local-draft': '本窗口离线草案',
  'remote-draft': '已接受对侧草案',
  'fact-locked': '执行事实优先',
  conflict: '待处置冲突',
};

/** 合并时每段的处置结论（规则编号对应合并器实现） */
export type MergeOutcomeKind =
  | 'unchanged' // 两边均未改动
  | 'local-added' // 本窗口离线新增，已接受
  | 'remote-added' // 对侧离线新增，已接受
  | 'plan-single' // 未开始段单侧改计划，已采纳
  | 'plan-agree' // 两边都改但结果一致，自动收敛
  | 'fact-wins' // 执行事实优先，对侧排程草案被拦截留痕
  | 'conflict' // 两边都改未开始段且不一致，保留两份草案待处置
  | 'pending'; // 上一轮遗留、仍待人工处置

/** 被拦截 / 待处置的草案留痕 */
export interface HeldDraft {
  /** 草案来源窗口 */
  role: DutyRole;
  /** 被拦截或对侧草案的计划字段 */
  plan: PlanValues;
  /** 留痕时间 ISO */
  at: string;
  /** 留痕原因 */
  reason: string;
}

/**
 * 排程段三副本：base 为最近一次两边一致的基线，main/field 为两个窗口各自的离线工作副本。
 * 同一 id 的三份记录共享 id，缺边（离线新增）时对应角色副本为 undefined。
 */
export interface SessionReplicas {
  id: string;
  base?: ObsSession;
  main?: ObsSession;
  field?: ObsSession;
}

/** 单个排程段的合并结论 */
export interface MergeOutcome {
  sessionId: string;
  kind: MergeOutcomeKind;
  merged: SessionReplicas;
  /** kind=conflict 时两份草案的来源与内容 */
  heldDrafts?: HeldDraft[];
  /** kind=fact-wins 时被拦截的草案 */
  blockedDraft?: HeldDraft;
  /** 人类可读说明 */
  detail: string;
}

/** 合并器整体输出 */
export interface MergeResult {
  /** 合并后的全部三副本（按 id 索引） */
  replicas: Record<string, SessionReplicas>;
  outcomes: MergeOutcome[];
  mergedAt: string;
}

/**
 * 投影给各页面消费的排程段：在观测排程段之上附带同步处置信息。
 * 冲突段以 base（历史计划）作为可见主体，两份草案见 mainDraft/fieldDraft。
 */
export interface SyncSession extends ObsSession {
  syncState: SyncState;
  /** 是否处于未确认处置的冲突区（导出闸门依据） */
  pendingConflict: boolean;
  /** 本窗口视角的对侧草案（仅冲突时存在） */
  otherDraft?: PlanValues;
  otherDraftRole?: DutyRole;
  /** 冲突两边的草案（冲突处置页使用） */
  mainDraft?: PlanValues;
  fieldDraft?: PlanValues;
  /** 执行事实优先时被拦截的草案留痕 */
  blockedDraft?: HeldDraft;
}

/** 窗口离线同步包（两窗口之间手工 / 联网交换） */
export interface SyncPackage {
  format: 'gbobsplan-sync';
  version: 3;
  /** 导出该包的窗口 */
  role: DutyRole;
  exportedAt: string;
  /** 该窗口当前全部排程段副本（全量快照，对侧缺边也能安全合并） */
  sessions: ObsSession[];
}

/** 执行事实相关字段（现场登记，独立于排程草案） */
export const FACT_STATUSES = ['进行中', '已完成'] as const;
