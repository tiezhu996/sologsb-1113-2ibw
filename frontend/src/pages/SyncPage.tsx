import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { usePersistentStore } from '../hooks/usePersistentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useNightStore } from '../stores/nightStore';
import { useTargetStore } from '../stores/targetStore';
import { useEquipmentStore } from '../stores/equipmentStore';
import { downloadText } from '../utils/export';
import { DUTY_ROLE_LABEL, type DutyRole, type MergeOutcome, type SyncPackage, type SyncSession } from '../types';

const PLAN_LABEL: Record<string, string> = {
  nightId: '观测夜',
  targetId: '目标',
  startTime: '开始',
  endTime: '结束',
  telescopeId: '望远镜',
  instrumentId: '终端',
  filterSlot: '滤镜',
  plannedFrames: '帧数',
};

/** 值班同步：主控/现场两窗口离线工作，网络恢复后合并排程草案与执行事实 */
export default function SyncPage() {
  usePersistentStore();
  const sessions = useSessionStore((s) => s.sessions);
  const role = useSessionStore((s) => s.role);
  const online = useSessionStore((s) => s.online);
  const lastMergedAt = useSessionStore((s) => s.lastMergedAt);
  const setRole = useSessionStore((s) => s.setRole);
  const setOnline = useSessionStore((s) => s.setOnline);
  const mergeNow = useSessionStore((s) => s.mergeNow);
  const importPackage = useSessionStore((s) => s.importPackage);
  const exportPackage = useSessionStore((s) => s.exportPackage);
  const resolveConflict = useSessionStore((s) => s.resolveConflict);

  const nights = useNightStore((s) => s.nights);
  const targets = useTargetStore((s) => s.targets);
  const telescopes = useEquipmentStore((s) => s.telescopes);
  const instruments = useEquipmentStore((s) => s.instruments);

  const [notice, setNotice] = useState('');
  const [outcomes, setOutcomes] = useState<MergeOutcome[]>([]);
  const [importError, setImportError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const targetName = (id: string) => targets.find((item) => item.id === id)?.name ?? id;
  const nightText = (id: string) => nights.find((item) => item.id === id)?.date ?? id;
  const telText = (id: string) => telescopes.find((item) => item.id === id)?.code ?? id;
  const insText = (id: string) => instruments.find((item) => item.id === id)?.model ?? id;

  /** 把计划字段渲染为紧凑差异文案 */
  const planText = (draft: SyncSession['mainDraft']) =>
    draft
      ? `${nightText(draft.nightId)} ${draft.startTime}-${draft.endTime} · ${targetName(draft.targetId)} · ${telText(draft.telescopeId)}/${insText(
          draft.instrumentId,
        )} · ${draft.filterSlot} · ${draft.plannedFrames}帧`
      : '-';

  /** 两版草案之间的字段级差异 */
  const diffFields = (a: SyncSession['mainDraft'], b: SyncSession['fieldDraft']) => {
    if (!a || !b) return [];
    return Object.keys(PLAN_LABEL).filter((key) => a[key as keyof typeof a] !== b[key as keyof typeof b]);
  };

  const renderValue = (field: string, value: unknown) => {
    const v = String(value ?? '');
    if (field === 'nightId') return nightText(v);
    if (field === 'targetId') return targetName(v);
    if (field === 'telescopeId') return telText(v);
    if (field === 'instrumentId') return insText(v);
    return v;
  };

  const conflicts = useMemo(() => sessions.filter((session) => session.pendingConflict), [sessions]);
  const factLocked = useMemo(() => sessions.filter((session) => session.syncState === 'fact-locked'), [sessions]);
  const localDrafts = useMemo(() => sessions.filter((session) => session.syncState === 'local-draft'), [sessions]);
  const remoteDrafts = useMemo(() => sessions.filter((session) => session.syncState === 'remote-draft'), [sessions]);

  const pendingCount = conflicts.length;

  async function handleMerge() {
    setImportError('');
    const result = await mergeNow();
    setOutcomes(result);
    const factWins = result.filter((item) => item.kind === 'fact-wins').length;
    const conflictCount = result.filter((item) => item.kind === 'conflict').length;
    const autoMerged = result.filter((item) => ['plan-single', 'plan-agree', 'local-added', 'remote-added'].includes(item.kind)).length;
    setNotice(`合并完成：自动收敛 ${autoMerged} 段，执行事实优先拦截 ${factWins} 段，待人工处置冲突 ${conflictCount} 段`);
  }

  function handleExport() {
    const pkg = exportPackage();
    downloadText(`gbobsplan-sync-${role}-${pkg.exportedAt.replace(/[:.]/g, '-')}.json`, JSON.stringify(pkg, null, 2), 'application/json');
    setNotice(`已导出 ${DUTY_ROLE_LABEL[role]}离线包，可在对侧窗口联网/恢复后导入`);
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImportError('');
    try {
      const text = await file.text();
      const pkg = JSON.parse(text) as SyncPackage;
      const { outcomes: result, from } = await importPackage(pkg);
      setOutcomes(result);
      const conflictCount = result.filter((item) => item.kind === 'conflict').length;
      setNotice(`已导入并合并来自「${DUTY_ROLE_LABEL[from]}」的离线包，待处置冲突 ${conflictCount} 段`);
    } catch (error) {
      setImportError((error as Error).message || '交换包解析失败');
    }
  }

  async function choose(id: string, side: DutyRole) {
    await resolveConflict(id, side);
    setNotice(`已采纳${DUTY_ROLE_LABEL[side]}草案，该排程段已收敛`);
  }

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        值班同步（主控 / 现场离线合并）
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        网络不稳时两个窗口各自继续排程或登记执行；恢复后按三方合并：执行事实不被草案覆盖，未开始段接受新设备与时段，两边都改的未开始段保留两份草案待人工处置，未处置的段不进入导出清单。
      </Typography>

      {notice ? (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}
      {importError ? (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setImportError('')}>
          {importError}
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems={{ md: 'center' }} flexWrap="wrap">
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              当前值班窗口
            </Typography>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={role}
              onChange={(_event, value: DutyRole | null) => value && void setRole(value)}
            >
              <ToggleButton value="main">主控窗口（排程）</ToggleButton>
              <ToggleButton value="field">现场窗口（执行）</ToggleButton>
            </ToggleButtonGroup>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              网络状态
            </Typography>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={online ? 'online' : 'offline'}
              onChange={(_event, value: string | null) => value && void setOnline(value === 'online')}
            >
              <ToggleButton value="online" color="success">
                联网
              </ToggleButton>
              <ToggleButton value="offline" color="warning">
                网络不稳 / 离线
              </ToggleButton>
            </ToggleButtonGroup>
          </Box>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Button variant="contained" disabled={!online} onClick={() => void handleMerge()}>
              网络恢复，立即合并两边
            </Button>
            <Button variant="outlined" onClick={handleExport}>
              导出本窗口离线包
            </Button>
            <Button variant="outlined" onClick={() => fileRef.current?.click()}>
              导入对侧离线包并合并
            </Button>
            <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(event) => void handleFile(event)} />
          </Stack>
        </Stack>
        <Divider sx={{ my: 1.5 }} />
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Chip size="small" label={`排程段 ${sessions.length}`} />
          <Chip size="small" color={pendingCount ? 'error' : 'success'} label={`待处置冲突 ${pendingCount}`} />
          <Chip size="small" color="warning" variant="outlined" label={`执行事实锁定 ${factLocked.length}`} />
          <Chip size="small" variant="outlined" label={`本窗口未合并草案 ${localDrafts.length}`} />
          <Chip size="small" variant="outlined" label={`已接受对侧草案 ${remoteDrafts.length}`} />
          {lastMergedAt ? <Chip size="small" variant="outlined" label={`上次合并 ${new Date(lastMergedAt).toLocaleString('zh-CN')}`} /> : null}
        </Stack>
      </Paper>

      {outcomes.length > 0 ? (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            本次合并明细
          </Typography>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>排程段</TableCell>
                  <TableCell>结论</TableCell>
                  <TableCell>说明</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {outcomes
                  .filter((item) => item.kind !== 'unchanged' && item.kind !== 'pending')
                  .map((item) => {
                    const session = sessions.find((s) => s.id === item.sessionId);
                    const label = session ? `${targetName(session.targetId)} ${session.startTime}-${session.endTime}` : item.sessionId;
                    const tone =
                      item.kind === 'conflict' ? 'error.main' : item.kind === 'fact-wins' ? 'warning.main' : 'success.main';
                    return (
                      <TableRow key={item.sessionId}>
                        <TableCell>{label}</TableCell>
                        <TableCell>
                          <Typography variant="body2" sx={{ color: tone }}>
                            {item.kind}
                          </Typography>
                        </TableCell>
                        <TableCell>{item.detail}</TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      ) : null}

      {/* 冲突区：同一未开始排程段两边都改 → 保留两份草案与来源，等人处置 */}
      <Typography variant="subtitle1" sx={{ mb: 1 }}>
        冲突区（{conflicts.length} 段待处置，处置前不进入导出清单）
      </Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>排程段</TableCell>
              <TableCell width={300}>主控窗口草案</TableCell>
              <TableCell width={300}>现场窗口草案</TableCell>
              <TableCell>差异字段</TableCell>
              <TableCell align="right">处置</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {conflicts.map((session) => {
              const diffs = diffFields(session.mainDraft, session.fieldDraft);
              return (
                <TableRow key={session.id} selected>
                  <TableCell>
                    <Typography variant="body2">{targetName(session.targetId)}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {session.id}
                    </Typography>
                  </TableCell>
                  <TableCell>{planText(session.mainDraft)}</TableCell>
                  <TableCell>{planText(session.fieldDraft)}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      {diffs.map((field) => (
                        <Chip
                          key={field}
                          size="small"
                          variant="outlined"
                          color="warning"
                          label={`${PLAN_LABEL[field]}：${renderValue(field, session.mainDraft?.[field as keyof typeof session.mainDraft])} → ${renderValue(
                            field,
                            session.fieldDraft?.[field as keyof typeof session.fieldDraft],
                          )}`}
                        />
                      ))}
                    </Stack>
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                      <Button size="small" variant="outlined" onClick={() => void choose(session.id, 'main')}>
                        采纳主控
                      </Button>
                      <Button size="small" variant="outlined" onClick={() => void choose(session.id, 'field')}>
                        采纳现场
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              );
            })}
            {conflicts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <Typography variant="body2" color="text.secondary">
                    没有待处置冲突。旧数据已按历史计划迁移，不会作为新冲突出现。
                  </Typography>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>

      {/* 执行事实优先：被拦截的排程草案留痕 */}
      <Typography variant="subtitle1" sx={{ mb: 1 }}>
        执行事实优先（{factLocked.length} 段：进行中 / 已完成事实未被草案覆盖）
      </Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>排程段</TableCell>
              <TableCell>执行事实（保留）</TableCell>
              <TableCell>被拦截草案与来源</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {factLocked.map((session) => (
              <TableRow key={session.id}>
                <TableCell>{targetName(session.targetId)}</TableCell>
                <TableCell>
                  <Chip size="small" color={session.status === '已完成' ? 'success' : 'primary'} label={session.status} />
                  <Typography variant="caption" display="block" color="text.secondary">
                    {session.startTime}-{session.endTime} · 实际 {session.actualFrames ?? session.plannedFrames} 帧
                    {session.executedBy ? ` · ${session.executedBy}` : ''}
                  </Typography>
                </TableCell>
                <TableCell>
                  {session.blockedDraft ? (
                    <>
                      <Chip size="small" variant="outlined" color="warning" label={`来源：${DUTY_ROLE_LABEL[session.blockedDraft.role]}`} />
                      <Typography variant="caption" display="block">
                        {planText(session.blockedDraft.plan)}
                      </Typography>
                      <Typography variant="caption" display="block" color="text.secondary">
                        {session.blockedDraft.reason} · {new Date(session.blockedDraft.at).toLocaleString('zh-CN')}
                      </Typography>
                    </>
                  ) : (
                    '-'
                  )}
                </TableCell>
              </TableRow>
            ))}
            {factLocked.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3}>
                  <Typography variant="body2" color="text.secondary">
                    暂无被执行事实拦截的排程草案。
                  </Typography>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
