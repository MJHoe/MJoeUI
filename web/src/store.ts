import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { toast } from 'sonner';
import { api, type SocketState } from './api';
import type { AppConfig, Artifact, ClientEvent, Patches, Primitive, Task, Workflow, WorkflowSummary } from './types';

export type Page = 'apps' | 'tasks' | 'settings';
export type AppTab = 'use' | 'artifacts' | 'runs' | 'json';
export type Theme = 'system' | 'light' | 'dark';

type Graph = { json: Workflow; updatedAt: number };

type State = {
  page: Page;
  theme: Theme;
  baseUrl: string;
  connected: boolean;
  outputDir: string;
  defaultOutputDir: string;
  socket: SocketState;
  queue: number;

  workflows: Record<string, WorkflowSummary>;
  workflowsReady: boolean;
  /** full JSON per app, fetched on demand */
  graphs: Record<string, Graph>;
  /** app the user is inside; null means they're on the gallery */
  currentId: string | null;
  /** which tab of the app detail is active */
  appTab: AppTab;
  /** unsaved form edits, kept per app */
  drafts: Record<string, Patches>;
  randomize: boolean;
  batch: number;
  /** prompt fields the user folded / unfolded, keyed `${appId}:${nodeId}:${input}`;
   *  absent = the field's default (templates folded, user prompts open) */
  promptFold: Record<string, boolean>;
  /** Use page: left param panel folded down to a slim rail */
  sideCollapsed: boolean;

  tasks: Record<string, Task>;
  previews: Record<string, string>;
  /** run shown on the Use tab's stage; null = follow the newest */
  focusRunId: string | null;
  /** task open in the 任务 page's detail panel */
  taskSel: string | null;
  /** artifacts per app, loaded when the Artifacts tab opens */
  artifacts: Record<string, Artifact[]>;

  importOpen: boolean;
  importSeed: { text: string; fileName?: string } | null;

  setPage: (p: Page) => void;
  setTheme: (t: Theme) => void;
  setSocket: (s: SocketState) => void;
  setConfig: (c: Partial<AppConfig>) => void;
  applyEvent: (ev: ClientEvent) => void;

  loadWorkflows: () => Promise<void>;
  ensureGraph: (id: string) => Promise<Workflow | null>;
  putWorkflow: (w: WorkflowSummary & { json?: Workflow; params?: Patches }) => void;
  /** Enter an app and switch to the given tab (default: 使用). */
  openApp: (id: string, tab?: AppTab) => void;
  /** Leave the app detail — back to the gallery. */
  closeApp: () => void;
  setAppTab: (tab: AppTab) => void;
  focusRun: (id: string | null) => void;
  /** Go to the 任务 page, optionally with one task opened. */
  openTask: (id: string | null) => void;
  loadArtifacts: (workflowId: string) => Promise<void>;

  setPatch: (nodeId: string, name: string, v: Primitive) => void;
  resetPatch: (nodeId: string, name: string) => void;
  resetPatches: () => void;
  setDraft: (workflowId: string, patches: Patches) => void;
  setRandomize: (v: boolean) => void;
  setBatch: (n: number) => void;
  setPromptFold: (keys: string[], folded: boolean) => void;
  setSideCollapsed: (v: boolean) => void;

  openImport: (seed?: { text: string; fileName?: string }) => void;
  closeImport: () => void;
};

const TERMINAL = new Set(['success', 'error', 'cancelled']);
const LIVE: ReadonlySet<string> = new Set(['queued', 'pending', 'running']);
/** How many of the user's tasks are still "owned" by us (queued, waiting, or running). */
export const livenessOf = (tasks: Record<string, Task>) =>
  Object.values(tasks).filter((t) => LIVE.has(t.status)).length;
/** All non-terminal tasks across workflows, in submission order. */
export const queueOf = (tasks: Record<string, Task>) =>
  Object.values(tasks).filter((t) => LIVE.has(t.status)).sort((a, b) => a.submittedAt - b.submittedAt);
export const EMPTY_PATCHES: Patches = Object.freeze({}) as Patches;

const without = <T,>(obj: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in obj)) return obj;
  const { [key]: _drop, ...rest } = obj;
  return rest;
};

const newestFirst = (a: Artifact, b: Artifact) => b.createdAt - a.createdAt;

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      page: 'apps',
      theme: 'system',
      baseUrl: '',
      connected: false,
      outputDir: '',
      defaultOutputDir: '',
      socket: 'connecting',
      queue: 0,

      workflows: {},
      workflowsReady: false,
      graphs: {},
      currentId: null,
      appTab: 'use',
      drafts: {},
      randomize: false,
      batch: 1,
      promptFold: {},
      sideCollapsed: false,

      tasks: {},
      previews: {},
      focusRunId: null,
      taskSel: null,
      artifacts: {},

      importOpen: false,
      importSeed: null,

      setPage: (page) => set({ page }),
      setTheme: (theme) => set({ theme }),
      setSocket: (socket) => set({ socket }),
      setConfig: (c) => set(c),

      applyEvent: (ev) => {
        const s = get();
        switch (ev.type) {
          case 'config': {
            const { type: _t, ...c } = ev;
            set(c);
            break;
          }
          case 'queue':
            set({ queue: ev.remaining });
            break;

          case 'workflow_upsert':
            get().putWorkflow(ev.workflow);
            break;
          case 'workflow_removed': {
            const workflows = without(s.workflows, ev.id);
            set({
              workflows,
              graphs: without(s.graphs, ev.id),
              drafts: without(s.drafts, ev.id),
              artifacts: without(s.artifacts, ev.id),
              // if the user was inside the deleted app, send them back to the gallery
              currentId: s.currentId === ev.id ? null : s.currentId,
            });
            break;
          }

          case 'task_list': {
            const tasks: Record<string, Task> = {};
            for (const t of ev.tasks) tasks[t.id] = t;
            set({ tasks, focusRunId: s.focusRunId && tasks[s.focusRunId] ? s.focusRunId : null });
            break;
          }
          case 'task_removed': {
            const t = s.tasks[ev.id];
            const patch: Partial<State> = {
              tasks: without(s.tasks, ev.id),
              previews: without(s.previews, ev.id),
              focusRunId: s.focusRunId === ev.id ? null : s.focusRunId,
            };
            const wf = t?.workflowId;
            if (wf && s.artifacts[wf]) {
              patch.artifacts = { ...s.artifacts, [wf]: s.artifacts[wf].filter((a) => a.runId !== ev.id) };
            }
            set(patch);
            break;
          }
          case 'task_upsert': {
            const t = ev.task;
            const prev = s.tasks[t.id];
            const patch: Partial<State> = { tasks: { ...s.tasks, [t.id]: t } };
            if (TERMINAL.has(t.status) && s.previews[t.id]) patch.previews = without(s.previews, t.id);
            const wf = t.workflowId;
            if (wf && s.artifacts[wf] && t.artifacts.length) {
              const known = new Set(s.artifacts[wf].map((a) => a.id));
              const fresh = t.artifacts.filter((a) => !known.has(a.id));
              if (fresh.length) patch.artifacts = { ...s.artifacts, [wf]: [...fresh, ...s.artifacts[wf]].sort(newestFirst) };
            }
            set(patch);
            if (prev && prev.status !== t.status) notify(t, get().workflows[t.workflowId ?? '']?.name);
            break;
          }
          case 'artifact_upsert': {
            const a = ev.artifact;
            const patch: Partial<State> = {};
            const t = s.tasks[a.runId];
            if (t) {
              patch.tasks = { ...s.tasks, [t.id]: { ...t, artifacts: t.artifacts.map((x) => (x.id === a.id ? a : x)) } };
            }
            const wf = a.workflowId;
            if (wf && s.artifacts[wf]) {
              const list = s.artifacts[wf];
              patch.artifacts = {
                ...s.artifacts,
                [wf]: list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [a, ...list].sort(newestFirst),
              };
            }
            set(patch);
            break;
          }
          case 'artifact_removed': {
            const patch: Partial<State> = {};
            const t = s.tasks[ev.runId];
            if (t) patch.tasks = { ...s.tasks, [t.id]: { ...t, artifacts: t.artifacts.filter((x) => x.id !== ev.id) } };
            const wf = ev.workflowId;
            if (wf && s.artifacts[wf]) {
              patch.artifacts = { ...s.artifacts, [wf]: s.artifacts[wf].filter((x) => x.id !== ev.id) };
            }
            set(patch);
            break;
          }
          case 'preview': {
            const st = s.tasks[ev.taskId]?.status;
            if (st === 'running' || st === 'pending') {
              set({ previews: { ...s.previews, [ev.taskId]: `data:${ev.mime};base64,${ev.data}` } });
            }
            break;
          }
        }
      },

      loadWorkflows: async () => {
        const { workflows: list } = await api.listWorkflows();
        const workflows: Record<string, WorkflowSummary> = {};
        for (const w of list) workflows[w.id] = w;
        const { currentId } = get();
        set({
          workflows,
          workflowsReady: true,
          // don't auto-pick an app — the gallery is the landing page
          currentId: currentId && workflows[currentId] ? currentId : null,
        });
      },

      ensureGraph: async (id) => {
        const w = get().workflows[id];
        const g = get().graphs[id];
        if (g && (!w || g.updatedAt === w.updatedAt)) return g.json;
        const { workflow } = await api.getWorkflow(id);
        get().putWorkflow(workflow);
        return workflow.json;
      },

      putWorkflow: (w) => {
        const { json, params, ...summary } = w as WorkflowSummary & { json?: Workflow; params?: Patches };
        const s = get();
        const patch: Partial<State> = { workflows: { ...s.workflows, [summary.id]: summary } };
        if (json) patch.graphs = { ...s.graphs, [summary.id]: { json, updatedAt: summary.updatedAt } };
        // First full load of an app this session: the database is the source of
        // truth for its saved edits. Older installs kept them only in
        // localStorage — push those up once instead of dropping them.
        if (params && !hydrated.has(summary.id)) {
          hydrated.add(summary.id);
          const local = s.drafts[summary.id];
          if (hasEdits(params)) patch.drafts = { ...s.drafts, [summary.id]: params };
          else if (local && hasEdits(local)) scheduleSave(summary.id, 0);
        }
        set(patch);
      },

      openApp: (id, tab = 'use') => set({ currentId: id, appTab: tab, focusRunId: null, page: 'apps' }),
      closeApp: () => set({ currentId: null, focusRunId: null, page: 'apps' }),
      setAppTab: (appTab) => set({ appTab }),
      focusRun: (focusRunId) => set({ focusRunId }),
      openTask: (taskSel) => set({ page: 'tasks', taskSel }),

      loadArtifacts: async (workflowId) => {
        const { artifacts } = await api.workflowArtifacts(workflowId);
        set({ artifacts: { ...get().artifacts, [workflowId]: artifacts } });
      },

      setPatch: (nodeId, name, v) => {
        const { currentId, drafts, graphs } = get();
        if (!currentId) return;
        const cur = drafts[currentId] ?? {};
        const node = { ...(cur[nodeId] ?? {}), [name]: v };
        if (graphs[currentId]?.json[nodeId]?.inputs[name] === v) delete node[name];
        set({ drafts: { ...drafts, [currentId]: { ...cur, [nodeId]: node } } });
      },
      resetPatch: (nodeId, name) => {
        const { currentId, drafts } = get();
        if (!currentId) return;
        const cur = drafts[currentId] ?? {};
        const { [name]: _drop, ...rest } = cur[nodeId] ?? {};
        set({ drafts: { ...drafts, [currentId]: { ...cur, [nodeId]: rest } } });
      },
      resetPatches: () => {
        const { currentId, drafts } = get();
        if (currentId) set({ drafts: without(drafts, currentId) });
      },
      setDraft: (workflowId, patches) => set({ drafts: { ...get().drafts, [workflowId]: patches } }),
      setRandomize: (randomize) => set({ randomize }),
      setBatch: (batch) => set({ batch: Math.max(1, Math.min(8, Math.round(batch))) }),
      setPromptFold: (keys, folded) => {
        const promptFold = { ...get().promptFold };
        for (const k of keys) promptFold[k] = folded;
        set({ promptFold });
      },
      setSideCollapsed: (sideCollapsed) => set({ sideCollapsed }),

      openImport: (seed) => set({ importOpen: true, importSeed: seed ?? null }),
      closeImport: () => set({ importOpen: false, importSeed: null }),
    }),
    {
      name: 'mjoeui.v2',
      version: 1,
      storage: createJSONStorage(() => {
        try { return localStorage; } catch { return sessionStorage; }
      }),
      partialize: (s) => ({
        theme: s.theme,
        page: s.page,
        currentId: s.currentId,
        appTab: s.appTab,
        drafts: s.drafts,
        randomize: s.randomize,
        batch: s.batch,
        promptFold: s.promptFold,
        sideCollapsed: s.sideCollapsed,
      }),
    },
  ),
);

// ─── saved edits ────────────────────────────────────────────────────────────
/** Apps whose saved edits have been loaded from the server this session.
 *  Autosave only runs for these, so a stale local draft can't overwrite the
 *  database before we've read it. */
const hydrated = new Set<string>();
const saveTimers = new Map<string, number>();
let saveErrorShown = false;

const hasEdits = (p: Patches) => Object.values(p).some((n) => Object.keys(n).length > 0);

/** Drop empty node entries so the stored JSON stays tidy. */
function compact(p: Patches | undefined): Patches {
  const out: Patches = {};
  for (const [nodeId, byInput] of Object.entries(p ?? {})) if (Object.keys(byInput).length) out[nodeId] = byInput;
  return out;
}

function scheduleSave(id: string, delay = 600) {
  window.clearTimeout(saveTimers.get(id));
  saveTimers.set(id, window.setTimeout(() => {
    saveTimers.delete(id);
    if (!useStore.getState().workflows[id]) return;
    api.saveParams(id, compact(useStore.getState().drafts[id]))
      .then(() => { saveErrorShown = false; })
      .catch((e) => {
        if (saveErrorShown) return;
        saveErrorShown = true;
        toast.error('参数没能保存到数据库', { description: e.message });
      });
  }, delay));
}

useStore.subscribe((s, prev) => {
  if (s.drafts === prev.drafts) return;
  for (const id of new Set([...Object.keys(s.drafts), ...Object.keys(prev.drafts)])) {
    if (s.drafts[id] !== prev.drafts[id] && hydrated.has(id)) scheduleSave(id);
  }
});

// ─── derived helpers ────────────────────────────────────────────────────────
export function sortWorkflows(w: Record<string, WorkflowSummary>): WorkflowSummary[] {
  return Object.values(w).sort((a, b) => (b.lastRunAt ?? b.updatedAt) - (a.lastRunAt ?? a.updatedAt));
}

/** Form edits for the workflow open in the studio. */
export const foldKey = (appId: string | null, f: { nodeId: string; name: string }) => `${appId ?? ''}:${f.nodeId}:${f.name}`;

export const usePatches = () => useStore((s) => (s.currentId && s.drafts[s.currentId]) || EMPTY_PATCHES);

export function runsOf(tasks: Record<string, Task>, workflowId: string | null): Task[] {
  return Object.values(tasks)
    .filter((t) => t.workflowId === workflowId)
    .sort((a, b) => b.submittedAt - a.submittedAt);
}

function notify(t: Task, wfName = '生成') {
  if (t.status === 'success') {
    const secs = t.startedAt && t.completedAt ? ` · ${Math.max(1, Math.round((t.completedAt - t.startedAt) / 1000))}s` : '';
    const n = t.artifacts.length;
    const file = t.artifacts[0]?.path.split(/[\\/]/).slice(-3).join('/');
    toast.success(`${wfName} · ${n > 1 ? `${n} 个制品` : '完成'}${secs}`, { description: file ? `已保存 ${file}` : t.label });
  } else if (t.status === 'error') {
    toast.error(`${wfName} · 生成失败`, { description: t.error?.slice(0, 160) });
  } else if (t.status === 'cancelled') {
    toast(`${wfName} · 已取消`, { description: t.label });
  }
}
