import type {
  DutyRole,
  HeldDraft,
  MergeOutcome,
  MergeResult,
  ObsSession,
  PlanField,
  PlanValues,
  SessionReplicas,
  SyncPackage,
  SyncSession,
  SyncState,
} from '../types';
import { FACT_STATUSES, PLAN_FIELDS } from '../types';

const OTHER_ROLE: Record<DutyRole, DutyRole> = { main: 'field', field: 'main' };

/** 取出排程段的计划字段（设备与时段等草案内容） */
export function planOf(session: ObsSession): PlanValues {
  const result: Record<PlanField, string | number> = {
    nightId: '',
    targetId: '',
    startTime: '',
    endTime: '',
    telescopeId: '',
    instrumentId: '',
    filterSlot: '',
    plannedFrames: 0,
  };
  PLAN_FIELDS.forEach((field) => {
    result[field] = session[field] as string | number;
  });
  return result as PlanValues;
}

/** 两份计划字段是否一致 */
export function plansEqual(a: ObsSession | undefined, b: ObsSession | undefined): boolean {
  if (!a || !b) return false;
  return PLAN_FIELDS.every((field) => a[field] === b[field]);
}

/** 相对基线是否改动了计划字段（缺边视为未改动） */
function planChanged(base: ObsSession | undefined, copy: ObsSession | undefined): boolean {
  if (!base || !copy) return false;
  return !plansEqual(base, copy);
}

/** 是否含不可覆盖的执行事实（进行中 / 已完成） */
export function hasFact(session: ObsSession | undefined): boolean {
  return Boolean(session && (FACT_STATUSES as readonly string[]).includes(session.status));
}

function heldDraft(role: DutyRole, session: ObsSession, reason: string, at: string): HeldDraft {
  return { role, plan: planOf(session), at, reason };
}

function clone(session: ObsSession): ObsSession {
  return { ...session };
}

/** 把三份副本统一为同一版本（合并收敛后写回） */
function unify(replicas: SessionReplicas, winner: ObsSession): SessionReplicas {
  const base = clone(winner);
  return {
    id: replicas.id,
    base,
    main: replicas.main ? clone(winner) : replicas.main,
    field: replicas.field ? clone(winner) : replicas.field,
  };
}

interface RowContext {
  id: string;
  base?: ObsSession;
  main?: ObsSession;
  field?: ObsSession;
  at: string;
}

/**
 * 单个排程段的三方合并。规则：
 * 1. 离线新增：仅一边存在 → 直接接受并收敛；两边同 id 新增（极端情况）按计划比对。
 * 2. 执行事实优先：任一副本为「进行中 / 已完成」→ 执行版本胜出，对侧排程草案不覆盖，留痕拦截。
 * 3. 未开始段单侧改计划 → 接受新设备与时段。
 * 4. 两边都改：改成一致自动收敛；不一致且仍未开始 → 保留两份草案与来源，进入冲突区等人处置。
 * 5. 旧数据三份同源（base 即历史计划），没有任何一侧改动 → 不产生冲突。
 * 6. 上一轮遗留冲突且没有新的执行事实 → 维持冲突，不自动选择。
 */
function mergeRow(ctx: RowContext): Pick<MergeOutcome, 'kind' | 'merged' | 'heldDrafts' | 'blockedDraft' | 'detail'> {
  const { id, base, main, field, at } = ctx;
  const replicas: SessionReplicas = { id, base, main, field };

  /* ---------- 规则 1：缺基线（离线新增） ---------- */
  if (!base) {
    if (main && field) {
      if (plansEqual(main, field)) {
        return { kind: 'local-added', merged: unify(replicas, main), detail: '两边离线新增且内容一致，已合并' };
      }
      if (hasFact(main) || hasFact(field)) {
        return resolveByFact(replicas, at);
      }
      return {
        kind: 'conflict',
        merged: replicas,
        heldDrafts: [heldDraft('main', main, '主控窗口离线新增', at), heldDraft('field', field, '现场窗口离线新增', at)],
        detail: '两边各自离线新增了同号排程段且计划不一致，保留两份草案',
      };
    }
    if (main) {
      return { kind: 'local-added', merged: unify({ ...replicas, field: clone(main) }, main), detail: '主控窗口离线新增，已接受' };
    }
    if (field) {
      return { kind: 'remote-added', merged: unify({ ...replicas, main: clone(field) }, field), detail: '现场窗口离线新增，已接受' };
    }
    return { kind: 'unchanged', merged: replicas, detail: '' };
  }

  const local = main ?? base;
  const remote = field ?? base;
  const mainChanged = planChanged(base, main);
  const fieldChanged = planChanged(base, field);

  /* ---------- 规则 2：执行事实优先 ---------- */
  if (local && remote && (hasFact(local) || hasFact(remote))) {
    return resolveByFact(replicas, at);
  }

  /* ---------- 规则 6：两边计划仍分歧（上一轮冲突未处置），维持冲突 ---------- */
  if (mainChanged && fieldChanged && !plansEqual(main, field)) {
    return {
      kind: 'conflict',
      merged: replicas,
      heldDrafts: [heldDraft('main', main!, '主控窗口草案', at), heldDraft('field', remote, '现场窗口草案', at)],
      detail: '两边都改动了该未开始排程段且计划不一致，保留两份草案待人工处置',
    };
  }

  /* ---------- 规则 3：单侧改计划（未开始段接受新设备与时段） ---------- */
  if (mainChanged && !fieldChanged) {
    return { kind: 'plan-single', merged: unify(replicas, local), detail: '主控窗口调整了设备 / 时段，现场未改，已采纳主控草案' };
  }
  if (!mainChanged && fieldChanged) {
    return { kind: 'plan-single', merged: unify(replicas, remote), detail: '现场窗口调整了设备 / 时段，主控未改，已采纳现场草案' };
  }

  /* ---------- 规则 4：两边都改但一致 → 自动收敛 ---------- */
  if (mainChanged && fieldChanged && plansEqual(main, field)) {
    return { kind: 'plan-agree', merged: unify(replicas, local), detail: '两边独立改动结果一致，已自动合并' };
  }

  /* ---------- 规则 5：无人改动（历史计划 / 旧数据） ---------- */
  return { kind: 'unchanged', merged: replicas, detail: '两边均未改动，沿用历史计划' };
}

/** 执行事实优先：选出含执行事实的一侧为胜方，对侧不同计划作为被拦截草案留痕 */
function resolveByFact(
  replicas: SessionReplicas,
  at: string,
): Pick<MergeOutcome, 'kind' | 'merged' | 'heldDrafts' | 'blockedDraft' | 'detail'> {
  const { id, base, main, field } = replicas;
  const local = main ?? base!;
  const remote = field ?? base!;

  // 两边都有执行事实时，登记时间更晚的一方为准
  let winnerRole: DutyRole;
  if (hasFact(local) && hasFact(remote)) {
    winnerRole = (local.executedAt ?? '') >= (remote.executedAt ?? '') ? 'main' : 'field';
  } else {
    winnerRole = hasFact(local) ? 'main' : 'field';
  }
  const winner = winnerRole === 'main' ? local : remote;
  const loserRole: DutyRole = OTHER_ROLE[winnerRole];
  const loser = loserRole === 'main' ? local : remote;

  // 仅当对侧排程草案与执行版本计划不同，才算「草案被拦截」；计划相同则事实直接收敛
  if (plansEqual(winner, loser)) {
    return {
      kind: 'unchanged',
      merged: unify({ id, base, main, field }, winner),
      detail: `执行事实（${winner.status}）与对侧计划一致，已收敛`,
    };
  }

  const blocked = heldDraft(loserRole, loser, `排程草案与${winnerRole === 'main' ? '主控' : '现场'}执行事实冲突，未覆盖`, at);
  return {
    kind: 'fact-wins',
    merged: unify({ id, base, main, field }, winner),
    blockedDraft: blocked,
    detail: `${winnerRole === 'main' ? '主控' : '现场'}已登记「${winner.status}」执行事实，${loserRole === 'main' ? '主控' : '现场'}草案未覆盖，已拦截留痕`,
  };
}

/**
 * 对当前全部三副本执行一次三方合并（纯函数）。
 * 网络恢复后直接调用；导入交换包时先把对侧快照写入对应副本再调用。
 */
export function reconcile(
  triples: SessionReplicas[],
  options: { tombstones?: string[]; now?: () => Date } = {},
): MergeResult {
  const at = (options.now ?? (() => new Date()))().toISOString();
  const tombstones = new Set(options.tombstones ?? []);
  const result: Record<string, SessionReplicas> = {};
  const outcomes: MergeOutcome[] = [];

  triples
    .filter((row) => !tombstones.has(row.id))
    .forEach((row) => {
      const out = mergeRow({ id: row.id, base: row.base, main: row.main, field: row.field, at });
      result[row.id] = out.merged;
      outcomes.push({ sessionId: row.id, ...out });
    });

  return { replicas: result, outcomes, mergedAt: at };
}

/**
 * 应用对侧窗口的离线交换包：用快照更新对侧角色副本（含新增），再执行三方合并。
 * 已删除（tombstone）的排程段不允许被旧快照复活。
 */
export function applySyncPackage(
  triples: SessionReplicas[],
  pkg: SyncPackage,
  options: { tombstones?: string[]; now?: () => Date } = {},
): MergeResult {
  const remoteRole = pkg.role;
  const incomingById = new Map(pkg.sessions.map((session) => [session.id, session]));

  const mergedTriples: SessionReplicas[] = triples.map((row) => {
    const incoming = incomingById.get(row.id);
    if (!incoming) return row;
    incomingById.delete(row.id);
    return remoteRole === 'main'
      ? { ...row, main: clone(incoming) }
      : { ...row, field: clone(incoming) };
  });

  // 对侧离线新增（本地完全没有的 id）
  incomingById.forEach((session, id) => {
    mergedTriples.push(
      remoteRole === 'main' ? { id, main: clone(session) } : { id, field: clone(session) },
    );
  });

  return reconcile(mergedTriples, options);
}

/** 构造本窗口的离线交换包 */
export function buildSyncPackage(role: DutyRole, sessions: ObsSession[], now: Date = new Date()): SyncPackage {
  return {
    format: 'gbobsplan-sync',
    version: 3,
    role,
    exportedAt: now.toISOString(),
    sessions: sessions.map(clone),
  };
}

/** 两边草案是否仍分歧（冲突区判定） */
export function isConflictTriple(row: SessionReplicas): boolean {
  if (!row.base || !row.main || !row.field) return false;
  if (hasFact(row.main) || hasFact(row.field)) return false;
  return planChanged(row.base, row.main) && planChanged(row.base, row.field) && !plansEqual(row.main, row.field);
}

/** 执行事实优先但对侧草案计划不一致（拦截留痕展示） */
export function factBlockedPair(row: SessionReplicas): { fact: ObsSession; draft: ObsSession; factRole: DutyRole; draftRole: DutyRole } | null {
  if (!row.main || !row.field) return null;
  const mainFact = hasFact(row.main);
  const fieldFact = hasFact(row.field);
  if (!mainFact && !fieldFact) return null;
  if (mainFact && fieldFact) return null; // 两边都是执行事实，不展示草案拦截
  if (plansEqual(row.main, row.field)) return null;
  return mainFact
    ? { fact: row.main, draft: row.field, factRole: 'main', draftRole: 'field' }
    : { fact: row.field, draft: row.main, factRole: 'field', draftRole: 'main' };
}

/**
 * 把合并后的三副本投影为某窗口视角的排程段列表。
 * - 冲突段以 base（历史计划）作为可见主体，两份草案挂在 mainDraft/fieldDraft；
 * - 执行事实优先段以执行版本作为可见主体，被拦草案挂在 blockedDraft；
 * - 其余段以本窗口副本（缺边回退到对侧/base）作为可见主体。
 */
export function projectSessions(triples: SessionReplicas[], role: DutyRole, blockedBySession?: Map<string, HeldDraft>): SyncSession[] {
  return triples.map((row) => {
    const own = role === 'main' ? row.main : row.field;
    const other = role === 'main' ? row.field : row.main;
    const subject = own ?? other ?? row.base!;

    if (isConflictTriple(row)) {
      // 主体保持历史（base）计划，两份草案分别挂在 mainDraft/fieldDraft 等人处置
      return {
        ...row.base!,
        syncState: 'conflict' as SyncState,
        pendingConflict: true,
        mainDraft: row.main ? planOf(row.main) : undefined,
        fieldDraft: row.field ? planOf(row.field) : undefined,
      };
    }

    const blocked = factBlockedPair(row);
    if (blocked) {
      // 视图主体始终是执行事实版本
      const fact = blocked.fact;
      const held = blockedBySession?.get(row.id) ?? {
        role: blocked.draftRole,
        plan: planOf(blocked.draft),
        at: fact.executedAt ?? '',
        reason: '排程草案与执行事实冲突，未覆盖',
      };
      return {
        ...fact,
        syncState: 'fact-locked' as SyncState,
        pendingConflict: false,
        blockedDraft: held,
      };
    }

    // 已收敛：base 与两边一致；否则按改动来自本窗口 / 对侧标记草案
    const sameAsBase = row.base ? plansEqual(row.base, subject) : false;
    let syncState: SyncState;
    if (!row.base) {
      // 尚未合并的离线新增：本窗口持有的是本地草案，仅对侧持有则是对侧草案
      syncState = own ? 'local-draft' : 'remote-draft';
    } else if (sameAsBase && (!other || plansEqual(row.base, other))) {
      syncState = 'unified';
    } else if (own && !plansEqual(own, row.base)) {
      syncState = 'local-draft';
    } else {
      syncState = 'remote-draft';
    }

    return {
      ...subject,
      syncState,
      pendingConflict: false,
      otherDraft: other && !plansEqual(other, subject) ? planOf(other) : undefined,
      otherDraftRole: other && !plansEqual(other, subject) ? (role === 'main' ? 'field' : 'main') : undefined,
    };
  });
}
