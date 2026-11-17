# MJoeUI

本地运行的 ComfyUI 封装。拖入 API 格式的工作流 → 给它起名字和类别 → 存进本地工作流库 → 在生成页改参数、看进度、留下作品。每个工作流都有唯一编号，它的制品按编号归档，可以反向追踪。

## 启动

```bash
# 首次
npm run install:all

# 开发（前端 :5173，后端 :3030）
npm run dev

# 生产构建 + 启动
npm run build
npm start   # 默认监听 :3030，同一端口服务前端静态与 API
```

默认 ComfyUI 地址 `http://127.0.0.1:8188`，可以在「设置」页改。首次启动如果 `data/tasks.json` 存在，会自动导入到 SQLite 并把文件改名为 `tasks.legacy.json`。

> better-sqlite3 需要本机编译原生模块；如果 install 时跳过了脚本，运行一次 `npm --prefix server approve-scripts better-sqlite3` 即可。

## 用法

- **导入工作流**（工具栏「+ 导入」或直接把 JSON 拖进窗口，也可以 `⌘V` / `Ctrl V` 粘贴）：ComfyUI 菜单 → **导出 (API)**。界面格式的 JSON 会被拒掉并提示切换。
- **元信息**：名字、类别（6 个预设：文生图 / 图生图 / 文生视频 / 图生视频 / 放大修复 / 其他）、基座模型（从模型文件名识别，可改）、备注。重复的工作流会标出来。
- **生成页**（顶部工作流选择器 + 中间画面 + 右侧作品栏）：改过的项有粉色圆点，点它还原。`⌘↵` / `Ctrl ↵` 提交。`×N` 一次多张，每张换种子；「每次随机」开启后第一张也换。
- **LoadImage / LoadVideo 节点**：直接拖图到节点卡上传到 ComfyUI 的 input 目录，或用下拉选已有的。
- **工作流页**：左侧列表（可搜索、按类别过滤）；右侧 Hero（washi 胶带、基座模型、工作流编号、运行次数、成功率、平均用时、上次使用）+ **制品 / 运行记录 / JSON** 三个子页。制品点开右侧抽屉看完整信息：文件、规格、种子、采样、提示词、路径、ID，可以收藏（当封面）、用这组参数回生成页、下载、在访达定位、删除。
- **复用参数**：抽屉里的「用这组参数」把那次运行的快照和当前工作流默认值做 diff，只把不一样的填成表单改动；没改过的保持默认。
- **设置**：ComfyUI 地址 · 制品保存位置（显示带工作流编号高亮的路径规则）· 实例信息（版本 / 系统 / 显存 / 内存）· 一键「释放显存」。

## 制品存储规则

```
{保存文件夹}/{工作流编号}/{YYYY-MM-DD}/{HHmmss}_{种子}[_n].{ext}
```

- 默认保存文件夹是 `data/artifacts`。工作流改名，编号和文件夹不变。
- PNG 原样保存，保留 ComfyUI 写入的工作流元数据，拖回 ComfyUI 可以复原整个图。
- 删除工作流 / 运行 / 制品时勾选「同时删除磁盘上的文件」才会真正 `unlink`，不然只从数据库里移除。

## 接口

全部挂在 `/api` 下。WebSocket 在 `/api/ws`。

### 自身状态

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / POST | `/api/config` | 读 / 改 BASE URL 和保存文件夹 |
| POST | `/api/output-dir/reveal` | 在访达 / 资源管理器中打开保存文件夹 |

### 工作流 / 运行 / 制品

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/workflows/inspect` | 识别 JSON：节点数、类别、基座模型、模型文件、建议名、`duplicateOf` |
| GET | `/api/workflows` | 列表（带 stats 和封面） |
| POST | `/api/workflows` | 新建（body: `name, category, baseModel, note, json`） |
| GET / PATCH / DELETE | `/api/workflows/:id` | 读 / 改元信息或 JSON / 删除（`?files=1` 连文件一起删） |
| GET | `/api/workflows/:id/artifacts` | 这个工作流的全部制品 |
| POST | `/api/runs` | 提交一次运行（`workflowId, workflow` 必填） |
| GET | `/api/runs` | 近 400 条运行 |
| GET | `/api/runs/:id/snapshot` | 这次运行当时的工作流 JSON |
| POST | `/api/runs/:id/cancel` | 运行中则中断，排队中则从队列移除 |
| DELETE | `/api/runs/:id` | 删运行（`?files=1` 连制品文件一起删） |
| GET | `/api/artifacts/:id/file` | 下载 / 显示制品（30 天 `immutable`，支持 Range） |
| POST | `/api/artifacts/:id/reveal` | 在访达中定位 |
| PATCH | `/api/artifacts/:id` | 收藏 / 取消收藏 |
| DELETE | `/api/artifacts/:id` | 删制品（`?files=1` 也删文件） |

### ComfyUI 透传（封装了哪些上游 API）

| 方法 | MJoeUI 端点 | ComfyUI 端点 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/comfy/system` | `GET /system_stats` | 版本、系统、设备、显存 |
| POST | `/api/comfy/free` | `POST /free {unload_models, free_memory}` | 释放显存 |
| GET | `/api/comfy/object-info` | `GET /object_info/{class}` | 节点入参规格（带缓存） |
| POST | `/api/comfy/upload` | `POST /upload/image` | 传图 / 视频到 input 目录 |
| GET | `/api/comfy/input` | `GET /view?type=input` | 读 input 文件（给 LoadImage 做缩略图） |

内部还封装了：`POST /prompt`（提交）、`GET /history/{id}`（后续核对）、`GET /queue` / `POST /queue {delete:[id]}`（队列 / 取消排队）、`POST /interrupt`（中断运行）、`GET /view`（读 output 落盘）。WebSocket `/ws?clientId=…` 关心 `status / execution_start / execution_cached / executing / progress / progress_state / executed / execution_success / execution_error / execution_interrupted`，以及 `BinaryEventTypes = 1 / 4` 的潜空间预览帧，所有事件转成 `task_upsert / preview / queue` 推给前端。

### WebSocket 事件

```
task_upsert   task_list   task_removed
workflow_upsert   workflow_removed
artifact_upsert   artifact_removed
config   queue   preview
```

## 数据落地

- `data/mjoe.db` — SQLite（WAL，外键开），表：`workflows` / `runs` / `artifacts`，用 `user_version` 迁移。
- `data/config.json` — BASE URL、保存文件夹（改过才写）、固定的 ComfyUI clientId（重启后仍能收到任务事件）。
- `data/artifacts/{workflowId}/YYYY-MM-DD/HHmmss_种子.png` — 默认保存文件夹。
- `data/tasks.legacy.json` — 首次启动时迁移完的旧流水，保留为纪念；旧的图片文件停留在 `data/images/*`，位置仍记在 artifacts 表里。

## 前端

React 18 + Vite 5 + TypeScript，zustand（持久化前端偏好）、motion/react（弹簧和 layoutId）、Radix（tooltip / select / slider / switch / dialog / popover）、sonner、CodeMirror、lucide-react。视觉用「贴纸手帐」主题（见 `web/src/styles/tokens.css`），字体 Bricolage Grotesque / Nunito / JetBrains Mono，粉色草莓果冻 (`--jelly`) 只用在「生成」和进行中的任务上。
