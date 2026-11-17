export type WorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
};

/** ComfyUI API-format graph: node id → node. */
export type Workflow = Record<string, WorkflowNode>;

export type Primitive = string | number | boolean;
/** Form edits on top of a stored workflow: node id → input name → value. */
export type Patches = Record<string, Record<string, Primitive>>;

export type Category = 't2i' | 'i2i' | 't2v' | 'i2v' | 'upscale' | 'other';
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
  /** Inputs shown on the Use page. null = not chosen yet — the client falls
   *  back to its automatic classifier. */
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
  /** saved edits on top of `json` — the app's current defaults */
  params: Patches;
};

/** `main` = key input (center column; the only thing the API takes);
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
  url: string;
  filename: string;
  path: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  nodeId: string;
  meta: TaskMeta;
  durationMs?: number;
  starred: boolean;
  createdAt: number;
};

export type TaskStatus = 'queued' | 'pending' | 'running' | 'success' | 'error' | 'cancelled';
export type TaskSource = 'ui' | 'api';
export type TaskNode = { id: string; className: string; title: string };

export type Task = {
  id: string;
  promptId?: string;             // set by the scheduler once ComfyUI accepts it
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
  progress: number;
  etaMs?: number;
  saving?: boolean;
  error?: string;
  errorNode?: string;
  artifacts: Artifact[];
  meta?: TaskMeta;
};

export type AppConfig = {
  baseUrl: string;
  connected: boolean;
  outputDir: string;
  defaultOutputDir: string;
};

export type ClientEvent =
  | { type: 'task_upsert'; task: Task }
  | { type: 'task_list'; tasks: Task[] }
  | { type: 'task_removed'; id: string }
  | { type: 'workflow_upsert'; workflow: WorkflowSummary }
  | { type: 'workflow_removed'; id: string }
  | { type: 'artifact_upsert'; artifact: Artifact }
  | { type: 'artifact_removed'; id: string; runId: string; workflowId: string | null }
  | ({ type: 'config' } & AppConfig)
  | { type: 'queue'; remaining: number }
  | { type: 'preview'; taskId: string; mime: string; data: string };

/** What the server worked out about a JSON before it is saved. */
export type Inspection = {
  nodeCount: number;
  category: Category;
  baseModel: string;
  modelFile: string | null;
  suggestedName: string;
  outputs: string[];
  hash: string;
  duplicateOf: { id: string; name: string } | null;
  json: Workflow;
};

/** ComfyUI /object_info entry (only the parts we read). */
export type InputSpec = [unknown, Record<string, any>?];
export type NodeInfo = {
  display_name?: string;
  input?: {
    required?: Record<string, InputSpec>;
    optional?: Record<string, InputSpec>;
  };
};

export type SystemStats = {
  system?: {
    os?: string;
    comfyui_version?: string;
    python_version?: string;
    pytorch_version?: string;
    ram_total?: number;
    ram_free?: number;
  };
  devices?: Array<{
    name?: string;
    type?: string;
    vram_total?: number;
    vram_free?: number;
  }>;
};
