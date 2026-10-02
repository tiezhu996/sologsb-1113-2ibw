# 天文观测计划编排台（gbobsplan）

面向业余天文台与高校天文社团的值班排期人员：把「观测目标—可见窗口—月相—望远镜与终端—备用观测夜」串成一份可执行的观测夜编排表，解决目标亮度与月相冲突、设备被重复占用、阴天临时改期难以追溯的问题。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

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
| 状态 | Zustand（targetStore / sessionStore / equipmentStore / nightStore） |
| 存储 | IndexedDB（Dexie，库名 `gbobsplan-db`，`schemaVersion` + v3 三副本迁移） |
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
│       ├── types/             # target / session / equipment / night / sync（+ index.ts 统一出口）
│       ├── stores/            # targetStore / sessionStore / equipmentStore / nightStore
│       ├── components/common/ # Timeline / StatusChip / ConflictBadge / FieldRow
│       ├── hooks/             # usePersistentStore（Dexie 读写 + Zustand 同步）/ useConflictCheck / schemaVersion
│       ├── pages/             # OverviewPage / TargetsPage / SessionsPage / EquipmentPage / SyncPage / ExportPage
│       ├── router/index.tsx   # 路由表
│       └── utils/             # astro.ts（高度角/可见窗口/月相）/ export.ts / sync.ts（双窗口三方合并）/ id.ts
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 本夜编排总览 | 30 分钟刻度时间轴 + 月相与月出月落条带；冲突与低于高度阈值的目标自动标灰 |
| `/targets` | 观测目标库 | 按类型与优先级筛选、按视星等排序、维护地平高度阈值与曝光参数，并给出本夜可见窗口 |
| `/sessions` | 排程段与冲突 | 冲突检测、按时段/望远镜校验、批量改期；离线草案 / 现场执行事实带同步状态与执行登记 |
| `/equipment` | 设备分配视图 | 行 = 望远镜、列 = 30 分钟时段；冲突格标红，点击可一键跳转到对应排程段 |
| `/sync` | 值班同步与合并 | 主控/现场窗口切换、网络状态模拟、离线交换包导入导出、冲突区人工处置 |
| `/export` | 导出观测清单 | 目标、时刻、滤镜、帧数导出为文本与 CSV，支持打印视图；未处置冲突段不纳入导出 |

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbobsplan-db`），表：`targets`、`sessionReplicas`、`telescopes`、`instruments`、`nights`、`meta`。
- `db.version(1/2)` 声明旧索引；`db.version(3).upgrade(...)` 把每个排程段迁移成 `base / main / field` 三副本（三份同源，旧数据按历史计划迁移，不产生新冲突），原 `sessions` 表废弃。
- 首次打开且表为空时写入示例数据（12 个观测目标、5 个观测夜、4 台望远镜、4 台终端、14 段排程，含 1 处设备冲突与 1 条改期记录）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。

## 主控 / 现场双窗口离线合并

观测夜值班分为主控（编排排程草案）与现场（记录执行事实）两个窗口，网络不稳时各自继续工作，恢复后在「值班同步与合并」页合并（也可用导出/导入离线 JSON 交换包）。每个排程段保存 `base`（最近一致基线）、`main`、`field` 三份副本，按三方合并处理（核心逻辑在 `src/utils/sync.ts`，规则验证脚本 `scripts/verify-merge.cjs`）：

1. **执行事实优先**：任一副本为「进行中 / 已完成」并登记执行事实（实际帧数/时刻/执行人）后，对侧排程草案不得覆盖，被拦草案保留来源与内容留痕。
2. **未开始排程段**：单侧改设备或时段直接采纳；两边都改且改后一致自动收敛。
3. **两人处置冲突区**：两边都改同一未开始段且不一致时，保留主控、现场两份草案与来源，排程段只读并进入冲突区；人工在同步页选择采纳某一侧后才收敛。
4. **导出闸门**：处于冲突区、未确认处置的排程段不进入导出清单（文本/CSV/快捷导出均排除）。
5. **旧数据**：v3 迁移三份同源，沿用历史计划，不算作新冲突。
6. 删除排程段记录墓碑（tombstone），对侧过期交换包不会让其复活；含执行事实或待处置冲突的段禁止删除。
