/* 合并引擎规则验证（node 运行，不参与前端构建）：
 * node --experimental-vm-modules 不需要，先由 esbuild 打成 cjs：
 *   npx esbuild src/utils/sync.ts --bundle --format=cjs --outfile=/tmp/sync.cjs
 *   node scripts/verify-merge.cjs
 */
const assert = require('assert');
const { reconcile, applySyncPackage, buildSyncPackage, projectSessions, hasFact } = require('/tmp/sync.cjs');

const SCHEMA = 3;
let seq = 0;
function makeSession(over = {}) {
  seq += 1;
  return {
    id: over.id ?? `s-${seq}`,
    nightId: 'night-001',
    targetId: 'target-001',
    startTime: '20:00',
    endTime: '21:00',
    telescopeId: 'tel-001',
    instrumentId: 'ins-001',
    filterSlot: 'L',
    plannedFrames: 30,
    status: '待执行',
    schemaVersion: SCHEMA,
    ...over,
  };
}
function triple(session) {
  const base = makeSession({ ...session });
  return { id: base.id, base, main: { ...base }, field: { ...base } };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/* 规则 5：旧数据三份同源 → unchanged，不产生冲突 */
check('旧数据（历史计划）不产生新冲突', () => {
  const row = triple(makeSession());
  const r = reconcile([row]);
  assert.strictEqual(r.outcomes[0].kind, 'unchanged');
  const view = projectSessions(Object.values(r.replicas), 'main');
  assert.strictEqual(view[0].pendingConflict, false);
});

/* 规则 3：未开始段主控单侧改设备/时段 → plan-single，现场接受 */
check('未开始段单侧改设备/时段被采纳', () => {
  const row = triple(makeSession());
  row.main = { ...row.main, telescopeId: 'tel-002', startTime: '21:00', endTime: '22:00' };
  const r = reconcile([row]);
  assert.strictEqual(r.outcomes[0].kind, 'plan-single');
  const merged = r.replicas[row.id];
  assert.strictEqual(merged.field.telescopeId, 'tel-002');
  assert.strictEqual(merged.base.startTime, '21:00');
});

/* 规则 2：现场已完成执行事实，主控草案改时段 → fact-wins，草案不覆盖且留痕 */
check('已完成执行事实不被排程草案覆盖（草案拦截留痕）', () => {
  const row = triple(makeSession({ status: '待执行' }));
  row.field = {
    ...row.field,
    status: '已完成',
    actualFrames: 42,
    executedAt: '2026-10-02T01:00:00.000Z',
    factRole: 'field',
  };
  row.main = { ...row.main, telescopeId: 'tel-009', startTime: '23:00', endTime: '23:30' };
  const r = reconcile([row]);
  assert.strictEqual(r.outcomes[0].kind, 'fact-wins');
  const merged = r.replicas[row.id];
  assert.strictEqual(merged.main.status, '已完成', '执行事实必须收敛到主控副本');
  assert.strictEqual(merged.main.telescopeId, 'tel-001', '排程草案的设备改动不得覆盖');
  assert.strictEqual(merged.field.actualFrames, 42);
  assert.ok(r.outcomes[0].blockedDraft, '被拦草案必须留痕');
  assert.strictEqual(r.outcomes[0].blockedDraft.role, 'main');
});

/* 规则 2b：进行中事实同样优先 */
check('进行中执行事实同样不被覆盖', () => {
  const row = triple(makeSession());
  row.main = { ...row.main, status: '进行中', executedAt: '2026-10-02T00:30:00.000Z', factRole: 'main' };
  row.field = { ...row.field, filterSlot: 'Ha' };
  const r = reconcile([row]);
  assert.strictEqual(r.outcomes[0].kind, 'fact-wins');
  assert.strictEqual(r.replicas[row.id].field.status, '进行中');
  assert.strictEqual(r.replicas[row.id].field.filterSlot, 'L');
});

/* 规则 4：两边都改未开始段且不一致 → conflict，保留两份草案与来源 */
check('两边都改未开始段且不一致 → 保留两份草案进入冲突区', () => {
  const row = triple(makeSession());
  row.main = { ...row.main, telescopeId: 'tel-002' };
  row.field = { ...row.field, telescopeId: 'tel-001', startTime: '22:00' };
  const r = reconcile([row]);
  assert.strictEqual(r.outcomes[0].kind, 'conflict');
  assert.deepStrictEqual(r.outcomes[0].heldDrafts.map((d) => d.role), ['main', 'field']);
  const viewMain = projectSessions(Object.values(r.replicas), 'main')[0];
  assert.strictEqual(viewMain.pendingConflict, true);
  assert.ok(viewMain.mainDraft && viewMain.fieldDraft);
  assert.strictEqual(viewMain.mainDraft.telescopeId, 'tel-002');
  assert.strictEqual(viewMain.fieldDraft.startTime, '22:00');
});

/* 规则 4b：两边都改但结果一致 → plan-agree 自动收敛 */
check('两边独立改成一致 → 自动合并不冲突', () => {
  const row = triple(makeSession());
  row.main = { ...row.main, filterSlot: 'Ha' };
  row.field = { ...row.field, filterSlot: 'Ha' };
  const r = reconcile([row]);
  assert.strictEqual(r.outcomes[0].kind, 'plan-agree');
});

/* 规则 6：遗留冲突在再次合并时维持，不自动选择 */
check('未处置冲突再次合并仍然保持', () => {
  const row = triple(makeSession());
  row.main = { ...row.main, telescopeId: 'tel-002' };
  row.field = { ...row.field, telescopeId: 'tel-003' };
  const once = reconcile([row]);
  const twice = reconcile(Object.values(once.replicas));
  assert.strictEqual(twice.outcomes[0].kind, 'conflict');
});

/* 规则 1：单侧离线新增 → 接受；交换包导入对侧新增同理 */
check('单侧离线新增的排程段被接受', () => {
  const s = makeSession({ id: 's-new' });
  const localOnly = { id: s.id, main: s };
  const r = reconcile([localOnly]);
  assert.strictEqual(r.outcomes[0].kind, 'local-added');
  assert.strictEqual(r.replicas[s.id].field.id, s.id, '缺边收敛后对侧也持有');
});

check('通过交换包导入对侧离线新增并合并', () => {
  const localTriples = [triple(makeSession({ id: 's-old' }))];
  const created = makeSession({ id: 's-field-new', telescopeId: 'tel-004' });
  const pkg = buildSyncPackage('field', [created]);
  const r = applySyncPackage(localTriples, pkg);
  assert.ok(r.replicas['s-field-new']);
  assert.strictEqual(r.outcomes.find((o) => o.sessionId === 's-field-new').kind, 'remote-added');
  assert.strictEqual(r.replicas['s-field-new'].main.telescopeId, 'tel-004');
});

/* 导出闸门：投影中仅冲突段 pendingConflict=true */
check('仅未处置冲突段被标记 pendingConflict（导出闸门）', () => {
  const conflictRow = triple(makeSession({ id: 's-c' }));
  conflictRow.main = { ...conflictRow.main, telescopeId: 'tel-002' };
  conflictRow.field = { ...conflictRow.field, telescopeId: 'tel-003' };
  const cleanRow = triple(makeSession({ id: 's-ok' }));
  const r = reconcile([conflictRow, cleanRow]);
  const view = projectSessions(Object.values(r.replicas), 'field');
  const byId = Object.fromEntries(view.map((s) => [s.id, s]));
  assert.strictEqual(byId['s-c'].pendingConflict, true);
  assert.strictEqual(byId['s-ok'].pendingConflict, false);
});

/* 两边都有执行事实：登记更晚者胜 */
check('两边都有执行事实时以更晚登记为准', () => {
  const row = triple(makeSession());
  row.main = { ...row.main, status: '已完成', actualFrames: 10, executedAt: '2026-10-02T00:00:00.000Z' };
  row.field = { ...row.field, status: '进行中', actualFrames: 20, executedAt: '2026-10-02T02:00:00.000Z' };
  const r = reconcile([row]);
  assert.strictEqual(r.replicas[row.id].base.actualFrames, 20);
});

/* tombstone：已删除段不被旧交换包复活 */
check('已删除排程段不被对侧快照复活', () => {
  const row = triple(makeSession({ id: 's-del' }));
  const pkg = buildSyncPackage('field', [makeSession({ id: 's-del', plannedFrames: 99 })]);
  const r = applySyncPackage([row], pkg, { tombstones: ['s-del'] });
  assert.ok(!r.replicas['s-del']);
});

/* hasFact 基本判定 */
check('hasFact 仅对进行中/已完成为真', () => {
  assert.strictEqual(hasFact(makeSession({ status: '待执行' })), false);
  assert.strictEqual(hasFact(makeSession({ status: '进行中' })), true);
  assert.strictEqual(hasFact(makeSession({ status: '已完成' })), true);
  assert.strictEqual(hasFact(makeSession({ status: '因云取消' })), false);
});

/* 合并后普通段状态为 unified，仅冲突/事实锁定带特殊标记 */
check('合并收敛后视图状态为 unified', () => {
  const row = triple(makeSession({ id: 's-u' }));
  row.main = { ...row.main, telescopeId: 'tel-002' };
  const r = reconcile([row]);
  const view = projectSessions(Object.values(r.replicas), 'field')[0];
  assert.strictEqual(view.pendingConflict, false);
  assert.strictEqual(view.syncState, 'unified');
  assert.strictEqual(view.telescopeId, 'tel-002');
});

/* 冲突段主体保持历史（base）计划，不偏向任一侧 */
check('冲突段视图主体保持历史计划', () => {
  const row = triple(makeSession({ id: 's-hist', telescopeId: 'tel-001', startTime: '20:00' }));
  row.main = { ...row.main, telescopeId: 'tel-002' };
  row.field = { ...row.field, telescopeId: 'tel-003' };
  const r = reconcile([row]);
  const view = projectSessions(Object.values(r.replicas), 'main')[0];
  assert.strictEqual(view.telescopeId, 'tel-001');
  assert.strictEqual(view.startTime, '20:00');
});

/* 模拟人工处置：采纳某一侧后三份副本收敛、冲突解除 */
check('人工采纳一侧草案后冲突解除并收敛', () => {
  const row = triple(makeSession({ id: 's-resolve' }));
  row.main = { ...row.main, telescopeId: 'tel-002' };
  row.field = { ...row.field, telescopeId: 'tel-003' };
  let r = reconcile([row]);
  const conflictRow = r.replicas['s-resolve'];
  // resolveConflict 采纳现场：三份统一为 field
  const winner = { ...conflictRow.field };
  conflictRow.base = { ...winner };
  conflictRow.main = { ...winner };
  conflictRow.field = { ...winner };
  r = reconcile([conflictRow]);
  assert.strictEqual(r.outcomes[0].kind, 'unchanged');
  const view = projectSessions(Object.values(r.replicas), 'main')[0];
  assert.strictEqual(view.pendingConflict, false);
  assert.strictEqual(view.telescopeId, 'tel-003');
});

/* 未合并的单侧离线草案：本窗口 local-draft，对侧视角 remote 来源数据尚不可见 */
check('未合并的离线新增在本窗口显示 local-draft', () => {
  const s = makeSession({ id: 's-local-draft' });
  const view = projectSessions([{ id: s.id, main: s }], 'main');
  assert.strictEqual(view[0].syncState, 'local-draft');
});

console.log(`\n全部 ${passed} 项合并规则验证通过`);
