// 合并引擎规则验证（node 环境直接跑 ts 源码，用 esbuild 转译）
// 运行：node --experimental-strip-types src/utils/__tests__/merge.rules.ts （node 22+）
import assert from 'node:assert';
import { mergeOfflineChanges, guardMasterFact, pendingConflictIds, filterExportable } from '../merge';
import type { DutyRole, MergeConflict, ObsSession, OfflineChange, SessionSnapshot } from '../../types';

let seq = 0;
function now(): string {
  return new Date(Date.UTC(2025, 9, 11, 12, seq++, 0)).toISOString();
}

function makeSession(partial: Partial<ObsSession> & { id: string }): SessionSnapshot {
  return {
    nightId: 'night-001',
    targetId: 'target-001',
    startTime: '20:00',
    endTime: '21:00',
    telescopeId: 'tel-001',
    instrumentId: 'ins-001',
    filterSlot: 'L',
    plannedFrames: 30,
    status: '待执行',
    schemaVersion: 3,
    provenance: '初始计划',
    ...partial,
  } as SessionSnapshot;
}

function change(side: DutyRole, id: string, snapshot: SessionSnapshot | null, base: SessionSnapshot | null, kind: 'edit' | 'delete' = 'edit', blockedByFact = false): OfflineChange {
  const ts = now();
  return { key: `${side}:${id}`, side, sessionId: id, kind, snapshot, base, createdAt: ts, updatedAt: ts, blockedByFact };
}

function run(heads: ObsSession[], changes: OfflineChange[], existing: MergeConflict[] = []) {
  const baseMap = new Map(heads.map((h) => [h.id, makeSession(h)]));
  return mergeOfflineChanges({
    heads,
    bases: baseMap,
    changes,
    existingConflicts: new Map(existing.map((c) => [c.id, c])),
    now: now(),
  });
}

// 规则 1：已完成 / 进行中的执行事实不能被主控排程草案覆盖（主控草案被拦截保留，现场不变）
{
  const fact = makeSession({ id: 's-01', status: '已完成', actualFrames: 40, provenance: '现场执行' });
  const masterDraft = makeSession({ id: 's-01', startTime: '22:00', endTime: '23:00', provenance: '主控草案' });
  const output = run([fact], [change('master', 's-01', masterDraft, fact, 'edit', true)]);
  const merged = output.heads.find((h) => h.id === 's-01')!;
  assert.strictEqual(merged.status, '已完成', '执行事实状态保留');
  assert.strictEqual(merged.startTime, '20:00', '执行事实时段不被草案覆盖');
  assert.ok(output.blockedKeys.includes('master:s-01'), '主控草案被保留在离线侧（blocked）');
  assert.strictEqual(output.report.blocked, 1);
  console.log('✓ 规则1：执行事实不被主控草案覆盖，草案拦截保留');
}

// 规则 1b：guardMasterFact 拒绝主控把待执行段改成进行中
{
  const base = makeSession({ id: 's-02', status: '待执行' });
  const draft = makeSession({ id: 's-02', status: '进行中', provenance: '主控草案' });
  const guard = guardMasterFact('master', base, draft);
  assert.strictEqual(guard.blocked, true, '主控不能自行登记进行中');
  const fieldGuard = guardMasterFact('field', base, draft);
  assert.strictEqual(fieldGuard.blocked, false, '现场可以登记进行中');
  console.log('✓ 规则1b：进行中/已完成只能由现场登记');
}

// 规则 2：未开始段，仅主控改设备与时段 → 自动接纳
{
  const base = makeSession({ id: 's-03', telescopeId: 'tel-001', startTime: '20:00' });
  const masterDraft = makeSession({ id: 's-03', telescopeId: 'tel-002', startTime: '21:00', endTime: '22:00', provenance: '主控草案' });
  const output = run([base], [change('master', 's-03', masterDraft, base)]);
  const merged = output.heads.find((h) => h.id === 's-03')!;
  assert.strictEqual(merged.telescopeId, 'tel-002');
  assert.strictEqual(merged.startTime, '21:00');
  assert.strictEqual(output.report.autoApplied, 1);
  assert.strictEqual(output.report.conflicts, 0);
  console.log('✓ 规则2：未开始段单边排程草案（新设备/时段）自动接纳');
}

// 规则 2b：仅现场登记执行记录 → 自动接纳为执行事实
{
  const base = makeSession({ id: 's-04', status: '待执行' });
  const fieldRec = makeSession({ id: 's-04', status: '已完成', actualFrames: 33, executionNote: '少云', provenance: '现场执行' });
  const output = run([base], [change('field', 's-04', fieldRec, base)]);
  const merged = output.heads.find((h) => h.id === 's-04')!;
  assert.strictEqual(merged.status, '已完成');
  assert.strictEqual(merged.actualFrames, 33);
  assert.strictEqual(output.report.autoApplied, 1);
  console.log('✓ 规则2b：现场单边执行记录自动接纳');
}

// 规则 3：同一排程段两边都改过 → 两份草案与来源都保留，进冲突区，不自动改主表（事实段除外）
{
  const base = makeSession({ id: 's-05', status: '待执行' });
  const masterDraft = makeSession({ id: 's-05', telescopeId: 'tel-002', provenance: '主控草案' });
  const fieldRec = makeSession({ id: 's-05', status: '因云取消', executionNote: '转多云', provenance: '现场执行' });
  const output = run([base], [change('master', 's-05', masterDraft, base), change('field', 's-05', fieldRec, base)]);
  assert.strictEqual(output.report.conflicts, 1);
  const conflict = output.conflicts.find((c) => c.id === 's-05');
  assert.ok(conflict, '冲突区有条目');
  assert.strictEqual(conflict.status, 'pending');
  assert.strictEqual(conflict.masterDraft!.telescopeId, 'tel-002', '主控草案保留');
  assert.strictEqual(conflict.fieldDraft!.status, '因云取消', '现场草案保留');
  console.log('✓ 规则3：两边都改 → 两份草案与来源保留，进入冲突区待处置');
}

// 规则 3b：两边都改、现场含新执行事实 → 事实先生效，但冲突仍保留主控草案等人处置
{
  const base = makeSession({ id: 's-06', status: '待执行' });
  const masterDraft = makeSession({ id: 's-06', telescopeId: 'tel-002', startTime: '21:00', provenance: '主控草案' });
  const fieldRec = makeSession({ id: 's-06', status: '已完成', actualFrames: 30, provenance: '现场执行' });
  const output = run([base], [change('master', 's-06', masterDraft, base), change('field', 's-06', fieldRec, base)]);
  assert.strictEqual(output.report.factWins, 1);
  const merged = output.heads.find((h) => h.id === 's-06')!;
  assert.strictEqual(merged.status, '已完成', '现场事实先行生效');
  const conflict = output.conflicts.find((c) => c.id === 's-06');
  assert.ok(conflict && conflict.fieldHasFact, '冲突保留且标记 fieldHasFact');
  console.log('✓ 规则3b：事实优先生效，主控草案随冲突保留');
}

// 规则 4：旧数据按历史计划迁移（仅作为基线存在，不是任何一侧变更）→ 不产生冲突
{
  const migrated = makeSession({ id: 's-07', status: '待执行', provenance: '历史迁移' });
  const output = run([migrated], []);
  assert.strictEqual(output.report.conflicts, 0);
  assert.strictEqual(output.heads.length, 1);
  assert.strictEqual(output.bases.find((b) => b.id === 's-07')?.provenance, '历史迁移');
  console.log('✓ 规则4：历史迁移数据只作基线，不产生新冲突');
}

// 规则 5：未确认处置的排程段不能进入导出清单
{
  const sessions = [makeSession({ id: 's-08' }), makeSession({ id: 's-09' })];
  const conflict: MergeConflict = {
    id: 's-09',
    sessionId: 's-09',
    status: 'pending',
    masterDraft: makeSession({ id: 's-09', telescopeId: 'tel-002' }),
    fieldDraft: makeSession({ id: 's-09' }),
    base: makeSession({ id: 's-09' }),
    masterKind: 'edit',
    fieldKind: 'edit',
    fieldHasFact: false,
    reason: '两边都改',
    createdAt: now(),
    updatedAt: now(),
  };
  const exportable = filterExportable(sessions, [conflict]);
  assert.deepStrictEqual(exportable.map((s) => s.id), ['s-08']);
  assert.ok(pendingConflictIds([conflict]).has('s-09'));
  console.log('✓ 规则5：待处置冲突段被排除在导出清单之外');
}

// 附加：离线新增的段（base=null）两边各加一条不同 id → 各自接纳，不误判冲突
{
  const masterNew = makeSession({ id: 's-m1', provenance: '主控草案' });
  const fieldNew = makeSession({ id: 's-f1', status: '进行中', provenance: '现场执行' });
  const output = run([], [change('master', 's-m1', masterNew, null), change('field', 's-f1', fieldNew, null)]);
  assert.strictEqual(output.report.conflicts, 0);
  assert.strictEqual(output.report.autoApplied, 2);
  assert.strictEqual(output.heads.length, 2);
  console.log('✓ 附加：离线各自新增的段自动接纳');
}

// 附加：主控删除 + 现场登记 → 冲突区保留两份来源
{
  const base = makeSession({ id: 's-10', status: '待执行' });
  const fieldRec = makeSession({ id: 's-10', status: '已完成', actualFrames: 10, provenance: '现场执行' });
  const output = run([base], [change('master', 's-10', null, base, 'delete'), change('field', 's-10', fieldRec, base)]);
  const conflict = output.conflicts.find((c) => c.id === 's-10');
  assert.ok(conflict, '删除+登记进入冲突区');
  assert.strictEqual(conflict.masterKind, 'delete');
  assert.strictEqual(conflict.fieldDraft!.status, '已完成');
  console.log('✓ 附加：主控删除与现场记录冲突，保留两份来源');
}

console.log('\n全部合并规则验证通过');

// 附加：主控事实段草案被拦截 + 现场离线再登记 → 两份草案进冲突区，现场先生效
{
  const fact = makeSession({ id: 's-11', status: '已完成', actualFrames: 20, provenance: '现场执行' });
  const masterDraft = makeSession({ id: 's-11', startTime: '03:00', endTime: '04:00', provenance: '主控草案' });
  const fieldRec = makeSession({ id: 's-11', status: '已完成', actualFrames: 24, executionNote: '追加 4 帧', provenance: '现场执行' });
  const output = run([fact], [change('master', 's-11', masterDraft, fact, 'edit', true), change('field', 's-11', fieldRec, fact)]);
  const conflict = output.conflicts.find((c) => c.id === 's-11');
  assert.ok(conflict && conflict.status === 'pending' && conflict.fieldHasFact, '进冲突区且标记事实');
  assert.strictEqual(conflict.masterDraft!.startTime, '03:00', '主控草案保留在冲突区');
  assert.strictEqual(output.heads.find((h) => h.id === 's-11')!.actualFrames, 24, '现场最新事实生效');
  assert.strictEqual(output.report.conflicts, 1);
  console.log('✓ 附加：被拦截主控草案 + 现场再登记 → 冲突区保留两份，事实生效');
}
