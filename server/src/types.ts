export type WorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
};

/** ComfyUI API-format graph: node id → node. */
export type Workflow = Record<string, WorkflowNode>;

/** What a workflow is for. Media kind follows from it (t2v / i2v → video). */
export type Category = 't2i' | 'i2i' | 't2v' | 'i2v' | 'upscale' | 'other';
export const CATEGORIES: Category[] = ['t2i', 'i2i', 't2v', 'i2v', 'upscale', 'other'];
export const CATEGORY_LABEL: Record<Category, string> = {
  t2i: '文生图',
  i2i: '图生图',
  t2v: '文生视频',
  i2v: '图生视频',
  upscale: '放大修复',
  other: '其他',
};

export type MediaKind = 'image' | 'video';

export type WorkflowStats = {
  runs: number;
  success: number;
  failed: number;
  artifacts: number;
  avgMs: number | null;
};

export type WorkflowSummary = {
  id: string;
  name: string;
  category: Category;
  baseModel: string;
  modelFile: string | null;
  note: string;
  nodeCount: number;
  /** Inputs shown on the Use page. null = not chosen yet. */
  exposed: ParamSlot[] | null;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  stats: WorkflowStats;
  cover: { url: string; kind: MediaKind } | null;
};

export type WorkflowFull = WorkflowSummary & {
  /** the JSON exactly as imported (or last edited on the JSON tab) */
  json: Workflow;
  /** the user's saved edits on top of `json` — the app's current defaults */
  params: Patches;
};

export type Primitive = string | number | boolean;
/** node id → input name → value */
export type Patches = Record<string, Record<string, Primitive>>;

/** `main` = key input (center column, and the only thing the API takes);
 *  `side` = secondary, left column. */
export type ParamPlace = 'main' | 'side';
export type ParamType = 'string' | 'number' | 'boolean' | 'image' | 'video' | 'audio';
export type ParamSlot = {
  /** "nodeId:inputName" */
  key: string;
  place: ParamPlace;
  /** name used in the API body */
  name: string;
  type: ParamType;
};

/** The knobs worth showing next to a result, derived from the submitted graph. */
export type TaskMeta = {
  width?: number;
  height?: number;
  seed?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  model?: string;
  prompt?: string;
  negative?: string;
};

export type Artifact = {
  id: string;
  runId: string;
  workflowId: string | null;
  kind: MediaKind;
  url: string;             // /api/artifacts/{id}/file
  filename: string;        // name on disk
  path: string;            // absolute path on disk
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  nodeId: string;
  meta: TaskMeta;
  durationMs?: number;     // how long the run took
  starred: boolean;
  createdAt: number;
};

export type TaskStatus = 'queued' | 'pending' | 'running' | 'success' | 'error' | 'cancelled';

export type TaskSource = 'ui' | 'api';
export type TaskNode = { id: string; className: string; title: string };

/** One submission to ComfyUI ("run"). Live fields only exist in memory. */
export type Task = {
  id: string;                    // our own `rn_xxxxxxxx`, stable from submit onwards
  promptId?: string;             // ComfyUI prompt_id, assigned when the scheduler submits
  workflowId: string | null;
  /** the app's name when it was submitted — survives renames */
  appName?: string;
  /** where it came from: the Use page or the external app API */
  source?: TaskSource;
  label: string;
  status: TaskStatus;
  submittedAt: number;
  startedAt?: number;
  completedAt?: number;
  nodes?: TaskNode[];
  doneNodes?: string[];
  cachedNodes?: string[];
  nodesTotal: number;
  nodesDone: number;
  currentNode?: {
    id: string;
    className: string;
    title: string;
    startedAt?: number;
    progress?: { value: number; max: number };
  };
  progress: number;              // 0..1
  etaMs?: number;
  /** finished executing; files are being copied to the output dir */
  saving?: boolean;
  error?: string;
  errorNode?: string;
  artifacts: Artifact[];
  meta?: TaskMeta;
};

export type ClientEvent =
  | { type: 'task_upsert'; task: Task }
  | { type: 'task_list'; tasks: Task[] }
  | { type: 'task_removed'; id: string }
  | { type: 'workflow_upsert'; workflow: WorkflowSummary }
  | { type: 'workflow_removed'; id: string }
  | { type: 'artifact_upsert'; artifact: Artifact }
  | { type: 'artifact_removed'; id: string; runId: string; workflowId: string | null }
  | { type: 'config'; baseUrl: string; connected: boolean; outputDir: string; defaultOutputDir: string }
  | { type: 'queue'; remaining: number }
  | { type: 'preview'; taskId: string; mime: string; data: string };
