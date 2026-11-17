import type {
  AppConfig, Artifact, Category, ClientEvent, Inspection, NodeInfo, ParamSlot, ParamType, Patches, SystemStats, Task,
  Workflow, WorkflowFull, WorkflowSummary,
} from './types';

async function req<T>(input: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(input, init);
  } catch {
    throw new Error('连不上 MJoeUI 后端，确认 npm run dev 正在运行。');
  }
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const body = await r.json();
      if (body?.error) msg = body.error;
    } catch { /* not json */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const post = (body?: unknown) => send('POST', body ?? {});

export type WorkflowMeta = { name: string; category: Category; baseModel: string; note: string };
/** The app's layout of exposed inputs; null = automatic. */
export type Exposed = ParamSlot[] | null;

/** GET /api/apps/:id — how to call an app from outside. */
export type AppDescription = {
  id: string;
  name: string;
  endpoint: string;
  configured: boolean;
  inputs: Array<{ name: string; type: ParamType; node: string; input: string; title: string | null; default: unknown }>;
  example: { inputs: Record<string, unknown>; wait: boolean };
};

export const api = {
  // app ---------------------------------------------------------------------
  getConfig: () => req<AppConfig>('/api/config'),
  setConfig: (patch: { baseUrl?: string; outputDir?: string }) => req<AppConfig>('/api/config', post(patch)),
  revealOutputDir: () => req<{ ok: true }>('/api/output-dir/reveal', post()),

  // ComfyUI passthrough -----------------------------------------------------
  system: () => req<SystemStats>('/api/comfy/system'),
  freeMemory: () => req<{ ok: true }>('/api/comfy/free', post()),
  objectInfo: (classes: string[], refresh = false) =>
    req<Record<string, NodeInfo | null>>(
      `/api/comfy/object-info?classes=${encodeURIComponent(classes.join(','))}${refresh ? '&refresh=1' : ''}`,
    ),
  uploadInput: (file: File) =>
    req<{ name: string }>(`/api/comfy/upload?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    }),
  inputUrl: (name: string) => `/api/comfy/input?name=${encodeURIComponent(name)}`,

  // workflows ---------------------------------------------------------------
  inspect: (json: unknown, fileName?: string) => req<Inspection>('/api/workflows/inspect', post({ json, fileName })),
  listWorkflows: () => req<{ workflows: WorkflowSummary[] }>('/api/workflows'),
  getWorkflow: (id: string) => req<{ workflow: WorkflowFull }>(`/api/workflows/${id}`),
  createWorkflow: (body: WorkflowMeta & { json: Workflow; exposed?: Exposed }) =>
    req<{ workflow: WorkflowFull }>('/api/workflows', post(body)),
  updateWorkflow: (id: string, patch: Partial<WorkflowMeta> & { json?: Workflow; exposed?: Exposed }) =>
    req<{ workflow: WorkflowFull }>(`/api/workflows/${id}`, send('PATCH', patch)),
  deleteWorkflow: (id: string, files: boolean) =>
    req<{ ok: true; removedFiles: number }>(`/api/workflows/${id}${files ? '?files=1' : ''}`, send('DELETE')),
  workflowArtifacts: (id: string) => req<{ artifacts: Artifact[] }>(`/api/workflows/${id}/artifacts`),
  saveParams: (id: string, params: Patches) => req<{ ok: true }>(`/api/workflows/${id}/params`, send('PUT', { params })),
  describeApp: (id: string) => req<AppDescription>(`/api/apps/${id}`),

  // runs --------------------------------------------------------------------
  submitRun: (workflowId: string, workflow: Workflow) =>
    req<{ task: Task; queueNumber: number }>('/api/runs', post({ workflowId, workflow })),
  runSnapshot: (id: string) => req<{ workflow: Workflow; workflowId: string | null }>(`/api/runs/${id}/snapshot`),
  cancelRun: (id: string) => req<{ ok: true }>(`/api/runs/${id}/cancel`, post()),
  deleteRun: (id: string, files: boolean) =>
    req<{ ok: true; removedFiles: number }>(`/api/runs/${id}${files ? '?files=1' : ''}`, send('DELETE')),

  // artifacts ---------------------------------------------------------------
  revealArtifact: (id: string) => req<{ ok: true }>(`/api/artifacts/${id}/reveal`, post()),
  starArtifact: (id: string, starred: boolean) =>
    req<{ artifact: Artifact }>(`/api/artifacts/${id}`, send('PATCH', { starred })),
  deleteArtifact: (id: string, files: boolean) =>
    req<{ ok: true; removedFiles: number }>(`/api/artifacts/${id}${files ? '?files=1' : ''}`, send('DELETE')),
};

export type SocketState = 'connecting' | 'open' | 'closed';

/** Realtime channel with backoff reconnect. Returns a disposer. */
export function openEvents(
  onEvent: (ev: ClientEvent) => void,
  onState: (s: SocketState) => void,
): () => void {
  let disposed = false;
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: number | undefined;

  const connect = () => {
    if (disposed) return;
    onState('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/api/ws`);
    ws.onopen = () => { attempt = 0; onState('open'); };
    ws.onmessage = (e) => {
      try { onEvent(JSON.parse(e.data)); } catch { /* ignore malformed */ }
    };
    ws.onclose = () => {
      if (disposed) return;
      onState('closed');
      const delay = Math.min(8000, 600 * 2 ** attempt++);
      timer = window.setTimeout(connect, delay);
    };
    ws.onerror = () => ws?.close();
  };
  connect();
  return () => {
    disposed = true;
    window.clearTimeout(timer);
    ws?.close();
  };
}
