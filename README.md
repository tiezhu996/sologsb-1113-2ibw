# 天文观测计划编排台（gbobsplan）

面向业余天文台与高校天文社团的值班排期人员：把「观测目标—可见窗口—月相—望远镜与终端—备用观测夜」串成一份可执行的观测夜编排表，解决目标亮度与月相冲突、设备被重复占用、阴天临时改期难以追溯的问题。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

观测夜值班分**主控**与**现场**两个窗口：网络不稳时两侧各自继续排程或登记执行，网络恢复后做三方合并——已完成 / 进行中的执行事实不被排程草案覆盖；未开始的排程段接受新设备与时段；同一段两边都改过时两份草案与来源都保留，进冲突区等人处置；未处置段不进入导出清单。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21813>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | MUI（Material UI 5）+ Emotion |
| 路由 | React Router 6（5 条业务路由 + 404） |
| 状态 | Zustand（targetStore / sessionStore / equipmentStore / nightStore / syncStore） |
| 存储 | IndexedDB（Dexie，库名 `gbobsplan-db`，`schemaVersion` + v2/v3 迁移） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21813
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # target / session / equipment / night（+ index.ts 统一出口）
│       ├── stores/            # targetStore / sessionStore / equipmentStore / nightStore / syncStore
│       ├── components/common/ # Timeline / StatusChip / ConflictBadge / FieldRow
│       ├── hooks/             # usePersistentStore（Dexie 读写 + Zustand 同步）/ useConflictCheck
│       ├── pages/             # OverviewPage / TargetsPage / SessionsPage / EquipmentPage / SyncPage / ExportPage
│       ├── router/index.tsx   # 路由表
│       └── utils/             # astro.ts（高度角/可见窗口/月相）/ export.ts / merge.ts（三方合并）/ id.ts
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 本夜编排总览 | 30 分钟刻度时间轴 + 月相与月出月落条带；冲突与低于高度阈值的目标自动标灰 |
| `/targets` | 观测目标库 | 按类型与优先级筛选、按视星等排序、维护地平高度阈值与曝光参数，并给出本夜可见窗口 |
| `/sessions` | 排程段与冲突 | 冲突检测结果、按时段/望远镜校验，勾选多条批量改期到备用观测夜并填写改期原因；现场窗口可登记执行事实（实际时刻 / 帧数 / 备注） |
| `/equipment` | 设备分配视图 | 行 = 望远镜、列 = 30 分钟时段；冲突格标红，点击可一键跳转到对应排程段 |
| `/sync` | 值班窗口与合并 | 主控 / 现场角色切换、网络在线 / 离线开关；两侧离线草案各自保存，网络恢复自动三方合并；冲突区保留两份草案与来源，人工处置（留痕） |
| `/export` | 导出观测清单 | 目标、时刻、滤镜、帧数、来源、实拍帧数导出为文本与 CSV，支持打印视图；未处置冲突段自动剔除 |

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbobsplan-db`），表：`targets`、`sessions`、`telescopes`、`instruments`、`nights`、`meta`、`syncBases`、`offlineChanges`、`mergeConflicts`。
- `db.version(1).stores({...})` 声明索引；`db.version(2).upgrade(...)` 为排程段增加 `backupNightId` 索引，并给旧数据补齐 `schemaVersion` 与因云取消排程段的替补夜。
- `db.version(3).upgrade(...)` 启用双窗口离线合并：旧排程段整体写入共同基线 `syncBases` 并标记来源为「历史迁移」，只作基线、不作为任一侧草案，因此不会产生新冲突。
- 首次打开且表为空时写入示例数据（12 个观测目标、5 个观测夜、4 台望远镜、4 台终端、14 段排程，含 1 处设备冲突、1 条改期记录与现场执行事实）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。

## 双窗口离线合并规则

顶栏与 `/sync` 页可切换**值班窗口**（主控 / 现场）与**网络状态**（在线 / 离线），选择持久化在 `meta` 中；纯前端单机模拟两个物理窗口。

1. **离线各自记录**：离线时主控的排程修改、现场的执行登记分别写入 `offlineChanges`（带首次修改前的共同基线 `base` 与时间戳、来源）；各窗口只看到自己的草案，主表不变。
2. **执行事实优先**：`进行中` / `已完成` 是现场执行事实。主控不能把未开始段改成这两个状态，也不能改 / 删事实段——违反时草案以 `blockedByFact` 标记保留、不覆盖事实；现场单边记录合并时自动接纳。
3. **恢复后三方合并**（`utils/merge.ts`，基线 + 主控 + 现场）：
   - 只有一侧改：未开始段的新设备 / 时段等草案、现场执行记录 → 自动接纳；
   - 同一排程段两边都改：**两份草案与来源都保留**进 `mergeConflicts` 冲突区（现场含事实时事实先行生效、主控只能选现场），等人在 `/sync` 处置；
   - 历史迁移数据只存在于基线，永远不算新冲突。
4. **人工处置留痕**：冲突区可选「采用主控草案 / 采用现场记录」（事实保护时主控不可选），填写处置说明；处置前两份原始草案保留，处置结果写入主表与基线。
5. **导出闸门**：`pending` 状态冲突涉及的排程段从文本 / CSV / 打印 / 快捷导出中剔除，导出按钮在存在未处置段时禁用。

合并引擎的规则用例在 `frontend/src/utils/__tests__/merge.rules.ts`（esbuild 打包后 node 执行，覆盖事实保护、单边接纳、双边冲突、历史迁移、导出剔除等场景）。
