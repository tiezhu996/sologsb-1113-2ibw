import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Timeline, { type TimelineBar } from '../components/common/Timeline';
import ConflictBadge from '../components/common/ConflictBadge';
import StatusChip from '../components/common/StatusChip';
import { usePersistentStore } from '../hooks/usePersistentStore';
import { useConflictCheck } from '../hooks/useConflictCheck';
import { useSessionStore } from '../stores/sessionStore';
import { useSyncStore } from '../stores/syncStore';
import { useNightStore } from '../stores/nightStore';
import { useTargetStore } from '../stores/targetStore';
import { useEquipmentStore } from '../stores/equipmentStore';
import { NIGHT_TOTAL_MINUTES, PROVENANCE_COLOR, TARGET_COLOR } from '../types';
import { axisMinutes, timelineTicks } from '../utils/astro';
import { buildNightPlanText, buildPlanCsv, downloadText, printPage } from '../utils/export';
import { filterExportable } from '../utils/merge';

/** 导出当晚观测清单（文本 / CSV / 打印视图） */
export default function ExportPage() {
  usePersistentStore();
  const nights = useNightStore((s) => s.nights);
  const currentNightId = useNightStore((s) => s.currentNightId);
  const setCurrentNight = useNightStore((s) => s.setCurrentNight);
  const sessions = useSessionStore((s) => s.sessions);
  const targets = useTargetStore((s) => s.targets);
  const telescopes = useEquipmentStore((s) => s.telescopes);
  const instruments = useEquipmentStore((s) => s.instruments);
  const mergeConflicts = useSyncStore((s) => s.conflicts);
  const { conflictsOfNight, conflictIds } = useConflictCheck();
  const [notice, setNotice] = useState('');

  const night = nights.find((item) => item.id === currentNightId) ?? nights[0];
  const nightSessions = useMemo(() => sessions.filter((session) => session.nightId === night?.id), [sessions, night?.id]);

  // 没有确认处置的排程段（两边都改、等待人工处置的冲突段）不能进入导出清单
  const exportableSessions = useMemo(
    () => filterExportable(nightSessions, mergeConflicts),
    [nightSessions, mergeConflicts],
  );
  const blockedSessions = useMemo(() => {
    const allowed = new Set(exportableSessions.map((session) => session.id));
    return nightSessions.filter((session) => !allowed.has(session.id));
  }, [nightSessions, exportableSessions]);

  const conflicts = useMemo(() => conflictsOfNight(night?.id ?? ''), [conflictsOfNight, night?.id]);
  const ids = useMemo(() => conflictIds(night?.id), [conflictIds, night?.id]);

  const planText = useMemo(
    () => buildNightPlanText({ night, sessions: exportableSessions, targets, telescopes, instruments }),
    [night, exportableSessions, targets, telescopes, instruments],
  );
  const csv = useMemo(
    () => buildPlanCsv({ night, sessions: exportableSessions, targets, telescopes, instruments }),
    [night, exportableSessions, targets, telescopes, instruments],
  );

  const bars: TimelineBar[] = useMemo(
    () =>
      exportableSessions.map((session) => {
        const target = targets.find((item) => item.id === session.targetId);
        const startMinute = Math.max(0, Math.min(NIGHT_TOTAL_MINUTES, axisMinutes(session.startTime)));
        const rawEnd = axisMinutes(session.endTime);
        return {
          id: session.id,
          startMinute,
          endMinute: Math.max(startMinute + 20, Math.min(NIGHT_TOTAL_MINUTES, rawEnd <= startMinute ? rawEnd + 1440 : rawEnd)),
          label: target?.name ?? '未知目标',
          color: target ? TARGET_COLOR[target.type] : '#607d8b',
          dimmed: session.status === '因云取消',
          tooltip: `${session.startTime}-${session.endTime} · ${session.filterSlot} · ${session.plannedFrames} 帧 · ${session.status}`,
        };
      }),
    [exportableSessions, targets],
  );

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        导出当晚观测清单
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        汇总目标、时刻、滤镜与帧数为文本与 CSV，并支持打印视图；导出内容与时间轴预览保持一致。
      </Typography>

      {notice ? (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}

      {blockedSessions.length > 0 ? (
        <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" href="/sync">前往冲突区处置</Button>}>
          有 {blockedSessions.length} 个排程段两边都改过、尚未人工处置，已从导出清单中剔除：
          {blockedSessions.map((session) => ` ${session.id}`).join('、')}
          。处置完成前不会进入文本、CSV 与打印视图。
        </Alert>
      ) : null}

      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }} alignItems="center" className="no-print">
        <TextField select size="small" label="观测夜" value={night?.id ?? ''} onChange={(event) => setCurrentNight(event.target.value)} sx={{ minWidth: 260 }}>
          {nights.map((item) => (
            <MenuItem key={item.id} value={item.id}>
              {`${item.date} · ${item.siteName} · ${item.cloudText}${item.primary ? '（主夜）' : item.backup ? '（备用夜）' : ''}`}
            </MenuItem>
          ))}
        </TextField>
        <Chip size="small" label={`可导出 ${exportableSessions.length} / ${nightSessions.length} 段`} color={blockedSessions.length > 0 ? 'warning' : 'default'} />
        <Chip size="small" label={`计划帧数合计 ${exportableSessions.reduce((sum, session) => sum + session.plannedFrames, 0)}`} />
        <ConflictBadge conflicts={conflicts} />
        <Button
          variant="contained"
          disabled={blockedSessions.length > 0}
          onClick={() => {
            downloadText(`观测清单-${night?.date ?? 'night'}.txt`, planText);
            setNotice('已下载观测清单文本文件（已排除未处置冲突段）');
          }}
        >
          下载文本
        </Button>
        <Button
          variant="contained"
          color="secondary"
          disabled={blockedSessions.length > 0}
          onClick={() => {
            downloadText(`观测清单-${night?.date ?? 'night'}.csv`, csv, 'text/csv');
            setNotice('已下载观测清单 CSV 文件（已排除未处置冲突段）');
          }}
        >
          下载 CSV
        </Button>
        <Button variant="outlined" disabled={blockedSessions.length > 0} onClick={() => printPage()}>
          打印视图
        </Button>
      </Stack>

      <Box className="no-print" sx={{ mb: 3 }}>
        <Timeline bars={bars} ticks={timelineTicks(120)} totalMinutes={NIGHT_TOTAL_MINUTES} conflictIds={ids} height={104} />
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '2fr 1fr' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            观测清单（文本预览）
          </Typography>
          <Box component="pre" sx={{ m: 0, fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: 'Menlo, Consolas, monospace', maxHeight: 460, overflow: 'auto' }}>
            {planText}
          </Box>
        </Paper>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            排程段状态核对（可导出 {exportableSessions.length} 段）
          </Typography>
          <Stack spacing={1}>
            {[...exportableSessions]
              .sort((a, b) => axisMinutes(a.startTime) - axisMinutes(b.startTime))
              .map((session) => {
                const target = targets.find((item) => item.id === session.targetId);
                return (
                  <Stack key={session.id} direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                    <Chip size="small" label={`${session.startTime}-${session.endTime}`} />
                    <Typography variant="body2">{target?.name ?? '未知目标'}</Typography>
                    <Chip size="small" variant="outlined" label={session.filterSlot} />
                    <Chip size="small" variant="outlined" label={`${session.plannedFrames} 帧`} />
                    <StatusChip status={session.status} />
                    <Chip size="small" color={PROVENANCE_COLOR[session.provenance ?? '初始计划']} variant={session.provenance === '初始计划' || session.provenance === '历史迁移' ? 'outlined' : 'filled'} label={session.provenance ?? '初始计划'} />
                  </Stack>
                );
              })}
            {exportableSessions.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                该观测夜暂无可导出排程段{blockedSessions.length > 0 ? '（全部等待冲突处置）' : ''}
              </Typography>
            ) : null}
            {blockedSessions.length > 0 ? (
              <Paper variant="outlined" sx={{ p: 1, borderColor: 'error.main', mt: 1 }}>
                <Typography variant="caption" color="error" sx={{ fontWeight: 600 }}>
                  已排除（未人工处置）：
                </Typography>
                {blockedSessions.map((session) => {
                  const target = targets.find((item) => item.id === session.targetId);
                  return (
                    <Stack key={session.id} direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
                      <Chip size="small" color="error" label={session.id} />
                      <Typography variant="caption">{target?.name ?? '未知目标'}</Typography>
                    </Stack>
                  );
                })}
              </Paper>
            ) : null}
          </Stack>
        </Paper>
      </Box>
    </Box>
  );
}
