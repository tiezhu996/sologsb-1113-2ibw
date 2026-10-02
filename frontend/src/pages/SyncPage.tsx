import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import StatusChip from '../components/common/StatusChip';
import { usePersistentStore } from '../hooks/usePersistentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSyncStore } from '../stores/syncStore';
import { useNightStore } from '../stores/nightStore';
import { useTargetStore } from '../stores/targetStore';
import { DUTY_ROLE_LABEL, type DutyRole, type MergeConflict, type ObsSession, type OfflineChange } from '../types';
import { canChooseMaster } from '../utils/merge';

/** 草案 / 基线的紧凑字段展示 */
function DiffFields({ snapshot, dimmed }: { snapshot: ObsSession | null; dimmed?: boolean }) {
  if (!snapshot) {
    return (
      <Chip size="small" color="error" variant="outlined" label="（该侧已删除此段）" sx={{ opacity: dimmed ? 0.6 : 1 }} />
    );
  }
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" sx={{ rowGap: 0.5, opacity: dimmed ? 0.65 : 1 }}>
      <Chip size="small" label={`${snapshot.startTime}-${snapshot.endTime}`} />
      <Chip size="small" variant="outlined" label={`设备 ${snapshot.telescopeId}/${snapshot.instrumentId}`} />
      <Chip size="small" variant="outlined" label={`滤镜 ${snapshot.filterSlot}`} />
      <Chip size="small" variant="outlined" label={`${snapshot.plannedFrames} 帧`} />
      <StatusChip status={snapshot.status} />
      {snapshot.actualFrames !== undefined ? <Chip size="small" color="success" variant="outlined" label={`实拍 ${snapshot.actualFrames} 帧`} /> : null}
      {snapshot.actualStartTime ? <Chip size="small" color="success" variant="outlined" label={`实际 ${snapshot.actualStartTime}-${snapshot.actualEndTime ?? '…'}`} /> : null}
      {snapshot.executionNote ? (
        <Typography variant="caption" color="text.secondary" sx={{ width: '100%' }}>
          现场备注：{snapshot.executionNote}
        </Typography>
      ) : null}
      {snapshot.rescheduleReason ? (
        <Typography variant="caption" color="text.secondary" sx={{ width: '100%' }}>
          改期原因：{snapshot.rescheduleReason}
        </Typography>
      ) : null}
    </Stack>
  );
}

function DraftCard({
  title,
  change,
  onDiscard,
}: {
  title: string;
  change: OfflineChange;
  onDiscard?: (key: string) => void;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderColor: change.blockedByFact ? 'warning.main' : 'divider' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }} flexWrap="wrap">
        <Typography variant="subtitle2">{title}</Typography>
        <Chip size="small" color={change.side === 'master' ? 'primary' : 'success'} label={DUTY_ROLE_LABEL[change.side]} />
        <Chip size="small" variant="outlined" label={change.kind === 'delete' ? '删除' : '修改'} />
        {change.blockedByFact ? <Chip size="small" color="warning" label="执行事实拦截" /> : null}
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
          {new Date(change.updatedAt).toLocaleString('zh-CN')}
        </Typography>
      </Stack>
      <Box sx={{ mb: 0.5 }}>
        <DiffFields snapshot={change.snapshot} dimmed={change.blockedByFact} />
      </Box>
      {change.blockedByFact && change.blockedReason ? (
        <Alert severity="warning" sx={{ mb: onDiscard ? 1 : 0, py: 0.25 }}>
          <Typography variant="caption">{change.blockedReason}</Typography>
        </Alert>
      ) : null}
      {onDiscard ? (
        <Button size="small" color="inherit" onClick={() => onDiscard(change.key)}>
          丢弃该草案
        </Button>
      ) : null}
    </Paper>
  );
}

/** 值班双窗口与离线合并：角色 / 网络切换、两侧草案、合并、冲突区人工处置 */
export default function SyncPage() {
  usePersistentStore();
  const sync = useSyncStore();
  const sessions = useSessionStore((s) => s.sessions);
  const nights = useNightStore((s) => s.nights);
  const targets = useTargetStore((s) => s.targets);
  const [merging, setMerging] = useState(false);
  const [notice, setNotice] = useState('');
  const [resolving, setResolving] = useState<MergeConflict | null>(null);
  const [resolution, setResolution] = useState<'master' | 'field'>('field');
  const [resolutionNote, setResolutionNote] = useState('');

  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const masterDrafts = useMemo(() => sync.offlineChanges.filter((change) => change.side === 'master'), [sync.offlineChanges]);
  const fieldDrafts = useMemo(() => sync.offlineChanges.filter((change) => change.side === 'field'), [sync.offlineChanges]);
  const pendingConflicts = useMemo(() => sync.conflicts.filter((conflict) => conflict.status === 'pending'), [sync.conflicts]);
  const resolvedConflicts = useMemo(() => sync.conflicts.filter((conflict) => conflict.status === 'resolved'), [sync.conflicts]);

  const describeSession = (id: string) => {
    const session = sessionById.get(id);
    const target = targets.find((item) => item.id === session?.targetId);
    const night = nights.find((item) => item.id === session?.nightId);
    return { session, target, night };
  };

  async function doMerge() {
    setMerging(true);
    try {
      const report = await sync.mergeWhenRecovered();
      setNotice(
        `合并完成：自动接纳 ${report.autoApplied} 段，执行事实优先搁置草案 ${report.factWins} 段，拦截 ${report.blocked} 段，进入冲突区 ${report.conflicts} 段，待处置 ${report.pending} 段`,
      );
    } finally {
      setMerging(false);
    }
  }

  function openResolve(conflict: MergeConflict) {
    setResolving(conflict);
    setResolution('field');
    setResolutionNote('');
  }

  async function submitResolve() {
    if (!resolving) return;
    if (resolution === 'master' && !canChooseMaster(resolving)) return;
    await sync.resolveConflict(resolving.sessionId, resolution, resolutionNote, sync.role === 'master' ? '主控值班人' : '现场值班人');
    setNotice(`冲突段 ${resolving.sessionId} 已按「${resolution === 'master' ? '保留主控草案' : '保留现场记录'}」处置，两份草案仍留痕`);
    setResolving(null);
  }

  const totalDrafts = sync.offlineChanges.length;

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        值班窗口与离线合并
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        观测夜分主控、现场两个窗口：网络不稳时各自继续排程或记执行，恢复后在此合并。
        已完成 / 进行中的执行事实不被排程草案覆盖；同一段两边都改时两份草案都保留进冲突区，由人工处置后才能导出。
      </Typography>

      {notice ? (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}
      {sync.migratedAt ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          检测到旧版本数据已于 {new Date(sync.migratedAt).toLocaleString('zh-CN')} 按历史计划迁移（排程段标记为「历史迁移」），作为合并共同基线，不视为新冲突。
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              当前值班窗口
            </Typography>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={sync.role}
              onChange={(_event, value: DutyRole | null) => value && void sync.setRole(value)}
            >
              <ToggleButton value="master">主控窗口（排程草案）</ToggleButton>
              <ToggleButton value="field">现场窗口（执行记录）</ToggleButton>
            </ToggleButtonGroup>
          </Box>
          <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', md: 'block' } }} />
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              网络状态
            </Typography>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={sync.online ? 'online' : 'offline'}
              onChange={(_event, value: string | null) => value && void sync.setOnline(value === 'online')}
            >
              <ToggleButton value="online" color="success">
                在线
              </ToggleButton>
              <ToggleButton value="offline">离线（各自记录）</ToggleButton>
            </ToggleButtonGroup>
          </Box>
          <Box sx={{ ml: { md: 'auto' } }}>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              待合并 / 待处置
            </Typography>
            <Stack direction="row" spacing={1}>
              <Chip size="small" label={`离线草案 ${totalDrafts}`} color={totalDrafts > 0 ? 'warning' : 'default'} />
              <Chip size="small" label={`待处置冲突 ${pendingConflicts.length}`} color={pendingConflicts.length > 0 ? 'error' : 'default'} />
            </Stack>
          </Box>
        </Stack>
        {!sync.online ? (
          <Alert severity="warning" sx={{ mt: 2 }}>
            当前处于离线状态：{DUTY_ROLE_LABEL[sync.role]}的修改只保存在本侧草案中（{sync.role === 'master' ? '可调整未开始段的设备与时段，不能改动已在执行 / 已完成的段' : '可登记执行状态、实际时刻与帧数'}
            ），网络恢复后统一合并。
          </Alert>
        ) : (
          <Alert severity="success" sx={{ mt: 2 }}>
            网络在线：修改直接生效并同步共同基线。{totalDrafts > 0 ? '存在两侧离线草案，请执行合并。' : '无待合并草案。'}
            {pendingConflicts.length > 0 ? ` 有 ${pendingConflicts.length} 段冲突待人工处置，处置完成前不会进入导出清单。` : ''}
          </Alert>
        )}
        <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
          <Button variant="contained" disabled={sync.online || totalDrafts === 0 || merging} onClick={() => void doMerge()}>
            模拟网络恢复并合并
          </Button>
          {!sync.online && totalDrafts > 0 ? (
            <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
              也可直接把网络切到「在线」，恢复时会自动合并
            </Typography>
          ) : null}
        </Stack>
      </Paper>

      {/* 冲突区 */}
      <Typography variant="h6" sx={{ mb: 1 }}>
        冲突区（同一排程段两边都改过，保留两份草案与来源）
      </Typography>
      {pendingConflicts.length === 0 ? (
        <Alert severity="success" sx={{ mb: 2 }}>
          没有待处置的冲突段。
        </Alert>
      ) : (
        <Stack spacing={1.5} sx={{ mb: 2 }}>
          {pendingConflicts.map((conflict) => {
            const { target, night } = describeSession(conflict.sessionId);
            return (
              <Paper key={conflict.id} variant="outlined" sx={{ p: 1.5, borderColor: 'error.main' }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }} flexWrap="wrap">
                  <Chip size="small" color="error" label="待人工处置" />
                  <Typography variant="subtitle2">{conflict.sessionId}</Typography>
                  <Typography variant="body2">
                    {night?.date ?? '-'} · {target?.name ?? '未知目标'}
                  </Typography>
                  {conflict.fieldHasFact ? <Chip size="small" color="success" label="现场含执行事实：只能保留现场" /> : null}
                </Stack>
                <Alert severity="warning" sx={{ mb: 1, py: 0.25 }}>
                  <Typography variant="caption">{conflict.reason}</Typography>
                </Alert>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
                  <Box sx={{ flex: 1 }}>
                    <Typography variant="caption" color="primary" sx={{ fontWeight: 600 }}>
                      主控排程草案（{new Date(conflict.updatedAt).toLocaleString('zh-CN')}）
                    </Typography>
                    <Box sx={{ mt: 0.5 }}>
                      <DiffFields snapshot={conflict.masterDraft} dimmed={conflict.fieldHasFact} />
                    </Box>
                  </Box>
                  <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', md: 'block' } }} />
                  <Box sx={{ flex: 1 }}>
                    <Typography variant="caption" color="success.main" sx={{ fontWeight: 600 }}>
                      现场执行记录
                    </Typography>
                    <Box sx={{ mt: 0.5 }}>
                      <DiffFields snapshot={conflict.fieldDraft} />
                    </Box>
                  </Box>
                </Stack>
                <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                  <Button size="small" variant="contained" onClick={() => openResolve(conflict)}>
                    人工处置
                  </Button>
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      )}

      {resolvedConflicts.length > 0 ? (
        <>
          <Typography variant="h6" sx={{ mb: 1 }}>
            已处置（留痕）
          </Typography>
          <Stack spacing={1} sx={{ mb: 2 }}>
            {resolvedConflicts.map((conflict) => (
              <Paper key={conflict.id} variant="outlined" sx={{ p: 1.25, opacity: 0.85 }}>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                  <Chip size="small" color="success" label="已处置" />
                  <Typography variant="body2">{conflict.sessionId}</Typography>
                  <Chip size="small" variant="outlined" label={conflict.resolution === 'master' ? '采用主控草案' : '采用现场记录'} />
                  <Typography variant="caption" color="text.secondary">
                    {conflict.resolvedBy} · {conflict.resolvedAt ? new Date(conflict.resolvedAt).toLocaleString('zh-CN') : ''}
                  </Typography>
                  {conflict.resolutionNote ? (
                    <Typography variant="caption" color="text.secondary" sx={{ width: '100%' }}>
                      处置说明：{conflict.resolutionNote}
                    </Typography>
                  ) : null}
                </Stack>
              </Paper>
            ))}
          </Stack>
        </>
      ) : null}

      {/* 两侧离线草案 */}
      <Typography variant="h6" sx={{ mb: 1 }}>
        两侧离线草案（网络恢复前各自保存）
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 1.5 }}>
          <Typography variant="subtitle2" color="primary" sx={{ mb: 1 }}>
            主控草案（{masterDrafts.length}）
          </Typography>
          <Stack spacing={1}>
            {masterDrafts.map((change) => (
              <DraftCard
                key={change.key}
                title={change.sessionId}
                change={change}
                onDiscard={(key) => void sync.discardChange(key)}
              />
            ))}
            {masterDrafts.length === 0 ? (
              <Typography variant="caption" color="text.secondary">
                主控暂无离线草案
              </Typography>
            ) : null}
          </Stack>
        </Paper>
        <Paper variant="outlined" sx={{ p: 1.5 }}>
          <Typography variant="subtitle2" color="success.main" sx={{ mb: 1 }}>
            现场记录（{fieldDrafts.length}）
          </Typography>
          <Stack spacing={1}>
            {fieldDrafts.map((change) => (
              <DraftCard key={change.key} title={change.sessionId} change={change} onDiscard={(key) => void sync.discardChange(key)} />
            ))}
            {fieldDrafts.length === 0 ? (
              <Typography variant="caption" color="text.secondary">
                现场暂无离线执行记录
              </Typography>
            ) : null}
          </Stack>
        </Paper>
      </Box>

      {/* 人工处置对话框 */}
      <Dialog open={!!resolving} onClose={() => setResolving(null)} maxWidth="md" fullWidth>
        <DialogTitle>冲突处置：{resolving?.sessionId}</DialogTitle>
        <DialogContent>
          {resolving ? (
            <>
              <Alert severity={resolving.fieldHasFact ? 'warning' : 'info'} sx={{ mb: 2 }}>
                {resolving.reason}
                {resolving.fieldHasFact ? ' 该段现场已登记执行事实，按规则只能保留现场记录。' : ''}
              </Alert>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                两份草案与来源（处置后仍保留留痕）
              </Typography>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 2 }}>
                <Paper
                  variant="outlined"
                  sx={{
                    p: 1.5,
                    flex: 1,
                    borderColor: resolution === 'master' && canChooseMaster(resolving) ? 'primary.main' : 'divider',
                    borderWidth: resolution === 'master' ? 2 : 1,
                    opacity: canChooseMaster(resolving) ? 1 : 0.5,
                  }}
                >
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                    <Chip size="small" color="primary" label="主控草案" />
                    {!canChooseMaster(resolving) ? <Chip size="small" label="不可选（执行事实保护）" /> : null}
                  </Stack>
                  <DiffFields snapshot={resolving.masterDraft} dimmed={!canChooseMaster(resolving)} />
                </Paper>
                <Paper
                  variant="outlined"
                  sx={{
                    p: 1.5,
                    flex: 1,
                    borderColor: resolution === 'field' ? 'success.main' : 'divider',
                    borderWidth: resolution === 'field' ? 2 : 1,
                  }}
                >
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                    <Chip size="small" color="success" label="现场记录" />
                  </Stack>
                  <DiffFields snapshot={resolving.fieldDraft} />
                </Paper>
              </Stack>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={resolution}
                onChange={(_event, value: 'master' | 'field' | null) => {
                  if (value === 'master' && resolving.fieldHasFact) return;
                  if (value) setResolution(value);
                }}
                sx={{ mb: 2 }}
              >
                <ToggleButton value="master" disabled={!canChooseMaster(resolving)}>
                  采用主控草案
                </ToggleButton>
                <ToggleButton value="field">采用现场记录</ToggleButton>
              </ToggleButtonGroup>
              <TextField
                size="small"
                fullWidth
                multiline
                minRows={2}
                label="处置说明（可选）"
                value={resolutionNote}
                onChange={(event) => setResolutionNote(event.target.value)}
              />
            </>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResolving(null)}>取消</Button>
          <Button variant="contained" color={resolution === 'master' ? 'primary' : 'success'} onClick={() => void submitResolve()}>
            确认处置
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
