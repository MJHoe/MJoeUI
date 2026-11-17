import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fstatic from '@fastify/static';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import pc from 'picocolors';
import { Config } from './config.js';
import { Db, newArtifactId, newTaskId } from './db.js';
import { importLegacy } from './migrate.js';
import { asWorkflow, inspectWorkflow } from './inspect.js';
import { exists, isVideoFile, mimeOf, removeFiles, saveArtifact } from './storage.js';
import { ComfyClient, type ComfyEvent, type ComfyFileRef, type ComfyPreview } from './comfy.js';
import { Scheduler } from './queue.js';
import { BadRequest, buildApiGraph, describeApp, effectiveGraph, parseParams, parseSlots } from './appApi.js';
import { deriveLabel, deriveMeta, markDone, recompute, topoNodes } from './tracker.js';
import type { Artifact, Category, ClientEvent, Task, TaskSource, TaskStatus, Workflow } from './types.js';
import { CATEGORIES } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');
const WEB_DIST = path.join(ROOT, 'web', 'dist');
const PORT = Number(process.env.PORT ?? 3030);
const TASK_LIST_LIMIT = 400;

const config = new Config(DATA_DIR, path.join(DATA_DIR, 'artifacts'));
const comfy = new ComfyClient(config);
let db: Db;

/** Every task, keyed by our own id. Live progress lives only here. */
const tasks = new Map<string, Task>();
/** ComfyUI's prompt_id → our task id, so events can find the right task. */
const byPrompt = new Map<string, string>();
const clients = new Set<WebSocket>();
const finalizing = new Set<string>();
const objectInfoCache = new Map<string, unknown | null>();
let connected = false;
let queueRemaining = 0;
let runningTaskId: string | null = null;
let scheduler: Scheduler;

// ─── broadcast ──────────────────────────────────────────────────────────────
function send(sock: WebSocket, ev: ClientEvent) {
  if (sock.readyState === 1) sock.send(JSON.stringify(ev));
}
function broadcast(ev: ClientEvent) {
  const payload = JSON.stringify(ev);
  for (const c of clients) if (c.readyState === 1) c.send(payload);
}
const recentTasks = () =>
  [...tasks.values()].sort((a, b) => b.submittedAt - a.submittedAt).slice(0, TASK_LIST_LIMIT);

const configBody = () => ({
  baseUrl: config.baseUrl,
  connected,
  outputDir: config.outputDir,
  defaultOutputDir: config.defaultOutputDir,
});

function setConnected(next: boolean) {
  if (next === connected) return;
  connected = next;
  broadcast({ type: 'config', ...configBody() });
}

function pushWorkflow(id: string | null) {
  if (!id) return;
  const w = db.workflowSummary(id);
  if (w) broadcast({ type: 'workflow_upsert', workflow: w });
}

/** Mutate a live task and fan it out. `persist` writes the row (status changes only). */
function updateTask(id: string, fn: (t: Task) => void, persist = false) {
  const t = tasks.get(id);
  if (!t) return;
  fn(t);
  broadcast({ type: 'task_upsert', task: t });
  if (persist) db.saveRun(t);
}

/** Show a file (or open a folder) in Finder / Explorer / the desktop's file manager. */
function reveal(target: string, select: boolean) {
  return new Promise<void>((resolve, reject) => {
    const [cmd, args] =
      process.platform === 'darwin' ? ['open', select ? ['-R', target] : [target]]
      : process.platform === 'win32' ? ['explorer', [select ? `/select,${target}` : target]]
      : ['xdg-open', [select ? path.dirname(target) : target]];
    // explorer exits 1 even on success
    execFile(cmd, args as string[], (err) => (err && process.platform !== 'win32' ? reject(err) : resolve()));
  });
}

// ─── outputs → artifacts ────────────────────────────────────────────────────
type OutputItem = ComfyFileRef & { metadata?: { width?: number; height?: number } };

async function collectArtifacts(t: Task) {
  if (!t.promptId) return;
  // ComfyUI sends execution_success a moment *before* it writes the history
  // entry, and a remote box can lag — keep asking for ~10s before giving up.
  let entry: Awaited<ReturnType<typeof comfy.history>> = null;
  for (let i = 0, wait = 300; i < 10; i++, wait = Math.min(2000, wait * 1.6)) {
    entry = await comfy.history(t.promptId).catch(() => null);
    if (entry) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  if (!entry) {
    console.error(pc.yellow('[artifacts] no history entry for'), t.id, t.promptId);
    return;
  }

  const found: Array<{ nodeId: string; item: OutputItem }> = [];
  for (const [nodeId, out] of Object.entries(entry.outputs ?? {})) {
    for (const value of Object.values(out)) {
      if (!Array.isArray(value)) continue;
      for (const item of value as OutputItem[]) {
        if (item && typeof item.filename === 'string') found.push({ nodeId, item });
      }
    }
  }
  // SaveImage writes `output`, PreviewImage writes `temp`. When a workflow has
  // both, the temp ones are intermediate looks — keep the real results.
  const finals = found.some((f) => f.item.type === 'output') ? found.filter((f) => f.item.type === 'output') : found;

  const seen = db.artifactSources(t.id);
  const at = new Date();
  const durationMs = t.startedAt ? at.getTime() - t.startedAt : undefined;
  for (const { nodeId, item } of finals) {
    if (seen.has(item.filename)) continue;
    try {
      const data = await comfy.view(item);
      const filePath = await saveArtifact(config.outputDir, {
        workflowId: t.workflowId,
        filename: item.filename,
        data,
        seed: t.meta?.seed,
        at,
        index: t.artifacts.length,
      });
      const id = newArtifactId();
      db.insertArtifact({
        id,
        runId: t.id,
        workflowId: t.workflowId,
        kind: isVideoFile(item.filename) ? 'video' : 'image',
        filename: path.basename(filePath),
        path: filePath,
        source: item.filename,
        mime: mimeOf(filePath),
        bytes: data.length,
        width: item.metadata?.width ?? t.meta?.width,
        height: item.metadata?.height ?? t.meta?.height,
        nodeId,
        meta: t.meta ?? {},
        durationMs,
        starred: false,
        createdAt: at.getTime(),
      });
      t.artifacts.push(db.artifact(id)!);
      seen.add(item.filename);
    } catch (e) {
      console.error(pc.red('[artifacts] save failed'), item.filename, e);
    }
  }
}

async function finalize(id: string, status: TaskStatus, error?: { message: string; node?: string }) {
  const t = tasks.get(id);
  if (!t || finalizing.has(id)) return;
  if (t.status === 'success' || t.status === 'error' || t.status === 'cancelled') return;
  finalizing.add(id);
  if (runningTaskId === id) runningTaskId = null;
  try {
    // Copy the files first and only then flip to success, so the client never
    // sees a finished run without its picture.
    if (status === 'success') {
      updateTask(id, (t) => {
        t.saving = true;
        t.etaMs = 0;
        t.progress = 1;
        t.currentNode = undefined;
        t.doneNodes = (t.nodes ?? []).map((n) => n.id);
        t.nodesDone = t.nodesTotal;
      });
      await collectArtifacts(t).catch((e) => console.error(pc.red('[artifacts]'), e));
    }
    updateTask(id, (t) => {
      t.saving = undefined;
      t.status = status;
      t.completedAt = Date.now();
      t.etaMs = 0;
      if (status !== 'success' && error) {
        t.error = error.message;
        t.errorNode = error.node ?? t.currentNode?.id;
      }
    }, true);
    pushWorkflow(t.workflowId);
  } finally {
    finalizing.delete(id);
    scheduler?.notifyDone(id);
  }
}

// ─── comfy events ───────────────────────────────────────────────────────────
function nodeInfo(t: Task, id: string) {
  const n = t.nodes?.find((n) => n.id === id);
  return { id, className: n?.className ?? id, title: n?.title ?? `#${id}` };
}

function setCurrent(t: Task, id: string) {
  if (t.currentNode?.id === id) return;
  if (t.currentNode) markDone(t, t.currentNode.id);
  t.currentNode = { ...nodeInfo(t, id), startedAt: Date.now() };
}

function onComfyEvent(ev: ComfyEvent) {
  const d = ev.data ?? {};
  if (ev.type === 'status') {
    const r = d.status?.exec_info?.queue_remaining;
    if (typeof r === 'number' && r !== queueRemaining) {
      queueRemaining = r;
      broadcast({ type: 'queue', remaining: r });
    }
    return;
  }
  const pid: string | undefined = d.prompt_id;
  const id = pid && byPrompt.get(pid);
  if (!id || !tasks.has(id) || finalizing.has(id)) return;

  switch (ev.type) {
    case 'execution_start':
      runningTaskId = id;
      updateTask(id, (t) => { t.status = 'running'; t.startedAt = Date.now(); recompute(t); }, true);
      break;
    case 'execution_cached':
      updateTask(id, (t) => {
        const ids: string[] = (d.nodes ?? []).map(String);
        t.cachedNodes = ids;
        for (const nid of ids) markDone(t, nid);
        recompute(t);
      });
      break;
    case 'executing':
      if (d.node == null) { void finalize(id, 'success'); break; }
      updateTask(id, (t) => { t.status = 'running'; setCurrent(t, String(d.node)); recompute(t); });
      break;
    case 'progress':
      updateTask(id, (t) => {
        if (t.currentNode?.id !== String(d.node)) setCurrent(t, String(d.node));
        t.currentNode!.progress = { value: d.value, max: d.max };
        recompute(t);
      });
      break;
    case 'progress_state':
      updateTask(id, (t) => {
        for (const [nid, s] of Object.entries<any>(d.nodes ?? {})) {
          if (s.state === 'finished') markDone(t, nid);
          else if (s.state === 'running') {
            setCurrent(t, nid);
            if (s.max > 1) t.currentNode!.progress = { value: s.value, max: s.max };
          }
        }
        if (t.currentNode && t.doneNodes?.includes(t.currentNode.id)) t.currentNode = undefined;
        recompute(t);
      });
      break;
    case 'executed':
      updateTask(id, (t) => {
        markDone(t, String(d.node));
        if (t.currentNode?.id === String(d.node)) t.currentNode = undefined;
        recompute(t);
      });
      break;
    case 'execution_success':
      void finalize(id, 'success');
      break;
    case 'execution_error':
      void finalize(id, 'error', {
        message: [d.node_type && `${d.node_type}`, d.exception_message].filter(Boolean).join('：') || '执行出错',
        node: d.node_id != null ? String(d.node_id) : undefined,
      });
      break;
    case 'execution_interrupted':
      void finalize(id, 'cancelled', { message: '已取消', node: d.node_id != null ? String(d.node_id) : undefined });
      break;
  }
}

// latent previews: throttle per task, always deliver the latest frame
const previewLatest = new Map<string, ComfyPreview>();
const previewTimer = new Map<string, NodeJS.Timeout>();
function onComfyPreview(p: ComfyPreview) {
  const id = (p.promptId && byPrompt.get(p.promptId)) ?? runningTaskId;
  if (!id || !tasks.has(id) || clients.size === 0) return;
  previewLatest.set(id, p);
  if (previewTimer.has(id)) return;
  const flush = () => {
    const latest = previewLatest.get(id);
    previewLatest.delete(id);
    if (!latest) { previewTimer.delete(id); return; }
    broadcast({ type: 'preview', taskId: id, mime: latest.mime, data: latest.data.toString('base64') });
    previewTimer.set(id, setTimeout(flush, 150));
  };
  flush();
}

/**
 * Settle runs that ComfyUI has already finished. Runs on every (re)connect
 * and every few seconds while anything is in flight, so a result is picked
 * up even when the websocket silently stopped delivering events — the live
 * events are for progress, this is what guarantees the outcome.
 */
const historyMisses = new Map<string, number>();
const STALE_EVENTS_MS = 30_000;
let reconciling = false;
async function reconcile() {
  if (reconciling) return;
  const open = [...tasks.values()].filter((t) => t.promptId && (t.status === 'pending' || t.status === 'running'));
  if (!open.length) return;
  reconciling = true;
  try {
    let q: { running: string[]; pending: string[] };
    try { q = await comfy.queue(); } catch { return; }
    // One of ours is executing but the socket has gone quiet: it may have been
    // dropped on ComfyUI's side while still open on ours. A fresh socket gets
    // the live progress back (ComfyUI re-sends the current node on reconnect).
    const ours = open.some((t) => q.running.includes(t.promptId!));
    if (ours && comfy.isOpen && Date.now() - comfy.lastEventAt > STALE_EVENTS_MS) {
      console.warn(pc.yellow('[comfy] no events while a run is executing — reconnecting'));
      comfy.lastEventAt = Date.now(); // don't fire again until the new socket had a chance
      comfy.reconnect();
    }
    for (const t of open) {
      const pid = t.promptId!;
      if (finalizing.has(t.id)) continue;
      if (q.running.includes(pid) || q.pending.includes(pid)) { historyMisses.delete(t.id); continue; }
      let h: Awaited<ReturnType<typeof comfy.history>>;
      try { h = await comfy.history(pid); } catch { continue; } // network blip: try next round
      if (h?.status?.status_str === 'error') {
        await finalize(t.id, 'error', { message: errorFromHistory(h) });
      } else if (h) {
        if (!h.status || h.status.completed || h.status.status_str === 'success') await finalize(t.id, 'success');
      } else {
        // not queued and no history — only give up after it's missing twice
        const n = (historyMisses.get(t.id) ?? 0) + 1;
        historyMisses.set(t.id, n);
        if (n >= 2) {
          historyMisses.delete(t.id);
          await finalize(t.id, 'error', { message: 'ComfyUI 中已找不到这个任务，可能在它重启时丢失了。' });
        }
      }
    }
  } finally {
    reconciling = false;
  }
}

function errorFromHistory(h: NonNullable<Awaited<ReturnType<typeof comfy.history>>>): string {
  for (const m of (h.status?.messages ?? []) as any[]) {
    if (Array.isArray(m) && m[0] === 'execution_error' && m[1]) {
      return [m[1].node_type, m[1].exception_message].filter(Boolean).join('：') || '执行出错';
    }
  }
  return '执行出错（详情见 ComfyUI 日志）';
}

// ─── helpers for routes ─────────────────────────────────────────────────────
const isCategory = (v: unknown): v is Category => typeof v === 'string' && (CATEGORIES as string[]).includes(v);
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

/** Queue a graph for a library app. Shared by the Use page and the app API. */
function enqueueRun(
  workflowId: string, wf: Workflow, label: string | undefined, source: TaskSource,
): { task: Task; queuePosition: number } {
  const id = newTaskId();
  const nodes = topoNodes(wf);
  const meta = deriveMeta(wf);
  const task: Task = {
    id,
    workflowId,
    appName: db.workflowSummary(workflowId)?.name,
    source,
    label: label?.trim() || deriveLabel(meta, `任务 ${id.slice(3, 7)}`),
    status: 'queued',
    submittedAt: Date.now(),
    nodes,
    doneNodes: [],
    nodesTotal: nodes.length,
    nodesDone: 0,
    progress: 0,
    artifacts: [],
    meta,
  };
  tasks.set(id, task);
  db.insertRun(task, wf);
  broadcast({ type: 'task_upsert', task });
  pushWorkflow(workflowId);
  scheduler.enqueue(id);
  return { task, queuePosition: scheduler.waiting.indexOf(id) + 1 };
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['success', 'error', 'cancelled']);

/** Resolve once the task has finished (artifacts copied), or after `ms`. */
function waitForTask(id: string, ms: number): Promise<Task | undefined> {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      const t = tasks.get(id);
      if (!t || (TERMINAL.has(t.status) && !t.saving) || Date.now() > deadline) return resolve(t);
      setTimeout(tick, 400);
    };
    tick();
  });
}

/** A task as the external API returns it: absolute artifact URLs, no live internals. */
function publicTask(t: Task, origin: string) {
  return {
    id: t.id,
    promptId: t.promptId ?? null,
    appId: t.workflowId,
    status: t.status,
    progress: t.progress,
    error: t.error ?? null,
    submittedAt: t.submittedAt,
    startedAt: t.startedAt ?? null,
    completedAt: t.completedAt ?? null,
    artifacts: t.artifacts.map((a) => ({
      id: a.id, kind: a.kind, mime: a.mime, url: `${origin}${a.url}`, filename: a.filename, path: a.path,
      width: a.width ?? null, height: a.height ?? null,
    })),
  };
}

function parseGraph(raw: unknown): Workflow | string {
  if (raw == null) return '缺少工作流';
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (e: any) { return `JSON 无法解析：${e.message}`; }
  }
  return asWorkflow(raw);
}

// ─── server ─────────────────────────────────────────────────────────────────
async function main() {
  await config.load();
  await fs.mkdir(DATA_DIR, { recursive: true });
  db = new Db(path.join(DATA_DIR, 'mjoe.db'));
  await importLegacy(db, DATA_DIR);
  for (const t of db.loadRuns()) {
    // On startup: a run that never reached ComfyUI died with the previous
    // process (our FIFO is in memory). One that did reach it is still running
    // or already done over there — keep it open and let reconcile() collect it.
    if (t.status === 'queued' || ((t.status === 'pending' || t.status === 'running') && !t.promptId)) {
      t.status = 'error';
      t.error = t.error ?? '服务重启时这个任务还在排队，没有提交给 ComfyUI';
      t.completedAt = t.completedAt ?? Date.now();
      db.saveRun(t);
    }
    tasks.set(t.id, t);
    if (t.promptId) byPrompt.set(t.promptId, t.id);
  }

  scheduler = new Scheduler(
    comfy,
    (id) => tasks.get(id),
    (id) => db.runSnapshot(id),
    (id, promptId) => {
      byPrompt.set(promptId, id);
      updateTask(id, (t) => { t.promptId = promptId; t.status = 'pending'; }, true);
    },
    (id, msg) => void finalize(id, 'error', { message: msg }),
  );

  comfy.onEvent(onComfyEvent);
  comfy.onPreview(onComfyPreview);
  comfy.onSocket((open) => {
    setConnected(open);
    if (open) void reconcile();
  });
  comfy.start();
  connected = await config.probe();
  setInterval(async () => setConnected(comfy.isOpen || (await config.probe())), 5000).unref();
  setInterval(() => void reconcile(), 4000).unref();

  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  await app.register(cors, { origin: true });
  await app.register(websocket);
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 512 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  app.setErrorHandler((err: { statusCode?: number; message?: string }, _req, reply) => {
    if (err instanceof BadRequest) return reply.code(400).send({ error: err.message });
    const code = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    reply.code(code).send({ error: err.message ?? '服务器内部错误' });
  });

  // config ----------------------------------------------------------------
  app.get('/api/config', async () => {
    setConnected(comfy.isOpen || (await config.probe()));
    return configBody();
  });
  app.post<{ Body: { baseUrl?: string; outputDir?: string } }>('/api/config', async (req, reply) => {
    const { baseUrl, outputDir } = req.body ?? {};
    if (typeof baseUrl !== 'string' && typeof outputDir !== 'string') {
      return reply.code(400).send({ error: '没有要保存的内容' });
    }
    if (typeof outputDir === 'string') {
      try { await config.setOutputDir(outputDir); } catch (e: any) { return reply.code(400).send({ error: e.message }); }
    }
    if (typeof baseUrl === 'string') {
      if (!baseUrl.trim()) return reply.code(400).send({ error: '请填写 BASE URL' });
      try {
        await config.setBaseUrl(baseUrl);
      } catch (e: any) {
        return reply.code(400).send({ error: e.message?.startsWith('Invalid URL') ? '地址格式不正确' : e.message });
      }
      objectInfoCache.clear();
      comfy.stop();
      comfy.start();
      connected = await config.probe();
    }
    broadcast({ type: 'config', ...configBody() });
    return configBody();
  });
  app.post('/api/output-dir/reveal', async (_req, reply) => {
    await fs.mkdir(config.outputDir, { recursive: true }).catch(() => {});
    try { await reveal(config.outputDir, false); } catch (e: any) {
      return reply.code(500).send({ error: `打不开文件夹：${e.message}` });
    }
    return { ok: true };
  });

  // comfy passthroughs ----------------------------------------------------
  app.get('/api/comfy/system', async (_req, reply) => {
    try { return await comfy.systemStats(); } catch (e: any) {
      return reply.code(502).send({ error: `无法读取 ComfyUI 状态：${e.message}` });
    }
  });
  app.post('/api/comfy/free', async (_req, reply) => {
    try { await comfy.free(); return { ok: true }; } catch (e: any) {
      return reply.code(502).send({ error: `释放失败：${e.message}` });
    }
  });
  app.get<{ Querystring: { classes?: string; refresh?: string } }>('/api/comfy/object-info', async (req) => {
    const classes = (req.query.classes ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (req.query.refresh) for (const c of classes) objectInfoCache.delete(c);
    const result: Record<string, unknown | null> = {};
    await Promise.all(classes.map(async (c) => {
      if (!objectInfoCache.has(c)) {
        try { objectInfoCache.set(c, await comfy.objectInfo(c)); } catch { return void (result[c] = null); }
      }
      result[c] = objectInfoCache.get(c) ?? null;
    }));
    return result;
  });
  /** Raw body upload → ComfyUI input folder. Returns the name to put into LoadImage / LoadVideo. */
  app.post<{ Querystring: { filename?: string }; Body: Buffer }>('/api/comfy/upload', async (req, reply) => {
    const name = path.basename(req.query.filename || 'upload.png');
    if (!Buffer.isBuffer(req.body) || !req.body.length) return reply.code(400).send({ error: '文件是空的' });
    try {
      const r = await comfy.upload(req.body, name, mimeOf(name));
      // loader specs list the input folder; refetch them so the dropdown sees the new file
      for (const k of [...objectInfoCache.keys()]) if (/load/i.test(k)) objectInfoCache.delete(k);
      return { name: r.subfolder ? `${r.subfolder}/${r.name}` : r.name };
    } catch (e: any) {
      return reply.code(502).send({ error: e.message });
    }
  });
  /** A file in ComfyUI's input folder, for the thumbnail next to LoadImage. */
  app.get<{ Querystring: { name?: string } }>('/api/comfy/input', async (req, reply) => {
    const name = req.query.name ?? '';
    if (!name) return reply.code(400).send({ error: '缺少文件名' });
    const i = name.lastIndexOf('/');
    try {
      const { data, mime } = await comfy.viewRaw({
        filename: i >= 0 ? name.slice(i + 1) : name,
        subfolder: i >= 0 ? name.slice(0, i) : '',
        type: 'input',
      });
      return reply.type(mime).header('Cache-Control', 'private, max-age=300').send(data);
    } catch {
      return reply.code(404).send({ error: 'ComfyUI 输入目录里没有这个文件' });
    }
  });

  // workflows -------------------------------------------------------------
  app.post<{ Body: { json?: unknown; fileName?: string } }>('/api/workflows/inspect', async (req, reply) => {
    const wf = parseGraph(req.body?.json);
    if (typeof wf === 'string') return reply.code(400).send({ error: wf });
    const info = inspectWorkflow(wf, req.body?.fileName);
    return { ...info, duplicateOf: db.workflowByHash(info.hash), json: wf };
  });

  app.get('/api/workflows', async () => ({ workflows: db.listWorkflows() }));

  app.post<{ Body: { name?: string; category?: string; baseModel?: string; note?: string; json?: unknown; exposed?: unknown } }>(
    '/api/workflows',
    async (req, reply) => {
      const b = req.body ?? {};
      const wf = parseGraph(b.json);
      if (typeof wf === 'string') return reply.code(400).send({ error: wf });
      const name = clean(b.name, 80);
      if (!name) return reply.code(400).send({ error: '给工作流取个名字' });
      const exposed = b.exposed === undefined ? null : parseSlots(b.exposed);
      const info = inspectWorkflow(wf);
      const id = db.insertWorkflow({
        name,
        category: isCategory(b.category) ? b.category : info.category,
        baseModel: clean(b.baseModel, 60) ?? info.baseModel,
        modelFile: info.modelFile,
        note: clean(b.note, 2000) ?? '',
        json: wf,
        hash: info.hash,
        exposed,
      });
      pushWorkflow(id);
      return { workflow: db.workflow(id) };
    },
  );

  app.get<{ Params: { id: string } }>('/api/workflows/:id', async (req, reply) => {
    const w = db.workflow(req.params.id);
    return w ? { workflow: w } : reply.code(404).send({ error: '找不到这个工作流' });
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; category?: string; baseModel?: string; note?: string; json?: unknown; exposed?: unknown } }>(
    '/api/workflows/:id',
    async (req, reply) => {
      const { id } = req.params;
      if (!db.workflowSummary(id)) return reply.code(404).send({ error: '找不到这个工作流' });
      const b = req.body ?? {};
      const patch: Parameters<Db['updateWorkflow']>[1] = {};
      if (b.name !== undefined) {
        const name = clean(b.name, 80);
        if (!name) return reply.code(400).send({ error: '名字不能为空' });
        patch.name = name;
      }
      if (b.category !== undefined) {
        if (!isCategory(b.category)) return reply.code(400).send({ error: '未知的类别' });
        patch.category = b.category;
      }
      if (b.baseModel !== undefined) patch.baseModel = clean(b.baseModel, 60) ?? '';
      if (b.note !== undefined) patch.note = clean(b.note, 2000) ?? '';
      if (b.exposed !== undefined) patch.exposed = parseSlots(b.exposed);
      if (b.json !== undefined) {
        const wf = parseGraph(b.json);
        if (typeof wf === 'string') return reply.code(400).send({ error: wf });
        const info = inspectWorkflow(wf);
        patch.json = wf;
        patch.hash = info.hash;
        patch.modelFile = info.modelFile;
      }
      db.updateWorkflow(id, patch);
      pushWorkflow(id);
      return { workflow: db.workflow(id) };
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { files?: string } }>('/api/workflows/:id', async (req, reply) => {
    const { id } = req.params;
    if (!db.workflowSummary(id)) return reply.code(404).send({ error: '找不到这个工作流' });
    for (const t of tasks.values()) {
      if (t.workflowId === id && (t.status === 'pending' || t.status === 'running')) {
        return reply.code(409).send({ error: '这个工作流还有任务在跑，等它结束或先取消' });
      }
    }
    const { paths, runIds } = db.deleteWorkflow(id);
    for (const r of runIds) { tasks.delete(r); broadcast({ type: 'task_removed', id: r }); }
    const removed = req.query.files === '1' ? await removeFiles(paths, config.outputDir) : 0;
    broadcast({ type: 'workflow_removed', id });
    return { ok: true, removedFiles: removed };
  });

  app.get<{ Params: { id: string } }>('/api/workflows/:id/artifacts', async (req) => ({
    artifacts: db.artifactsOf(req.params.id),
  }));

  /** Autosaved Use-page edits. Separate from PATCH so it doesn't bump
   *  updated_at (which makes every client refetch the JSON). */
  app.put<{ Params: { id: string }; Body: { params?: unknown } }>('/api/workflows/:id/params', async (req, reply) => {
    if (!db.workflowSummary(req.params.id)) return reply.code(404).send({ error: '找不到这个工作流' });
    db.setParams(req.params.id, parseParams(req.body?.params));
    return { ok: true };
  });

  /** The app's effective graph — imported JSON with saved edits applied. */
  app.get<{ Params: { id: string } }>('/api/workflows/:id/effective', async (req, reply) => {
    const w = db.workflow(req.params.id);
    return w ? { workflow: effectiveGraph(w) } : reply.code(404).send({ error: '找不到这个工作流' });
  });

  // app API: call a library app with only its key inputs -------------------
  const originOf = (req: { protocol: string; headers: { host?: string } }) => `${req.protocol}://${req.headers.host ?? `127.0.0.1:${PORT}`}`;

  app.get<{ Params: { id: string } }>('/api/apps/:id', async (req, reply) => {
    const w = db.workflow(req.params.id);
    return w ? describeApp(w, originOf(req)) : reply.code(404).send({ error: '找不到这个应用' });
  });

  app.post<{
    Params: { id: string };
    Body: { inputs?: unknown; random_seed?: boolean; wait?: boolean; timeout?: number; label?: string };
  }>('/api/apps/:id/run', async (req, reply) => {
    const w = db.workflow(req.params.id);
    if (!w) return reply.code(404).send({ error: '找不到这个应用' });
    const b = req.body ?? {};
    const graph = await buildApiGraph(w, b.inputs, { randomSeed: b.random_seed !== false }, async (data, name, mime) => {
      try {
        const r = await comfy.upload(data, name, mime);
        return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
      } catch (e: any) {
        throw new BadRequest(`上传到 ComfyUI 失败：${e.message}`);
      }
    });
    const { task, queuePosition } = enqueueRun(w.id, graph, typeof b.label === 'string' ? b.label : undefined, 'api');
    const origin = originOf(req);
    if (!b.wait) return reply.code(202).send({ task: publicTask(task, origin), queuePosition });
    const timeoutMs = Math.min(3600, Math.max(1, Number(b.timeout) || 600)) * 1000;
    const done = (await waitForTask(task.id, timeoutMs)) ?? task;
    return reply.code(TERMINAL.has(done.status) ? 200 : 202).send({ task: publicTask(done, origin) });
  });

  // runs ------------------------------------------------------------------
  app.post<{ Body: { workflowId?: string; workflow?: unknown; label?: string } }>('/api/runs', async (req, reply) => {
    const { workflowId, label } = req.body ?? {};
    const wf = parseGraph(req.body?.workflow);
    if (typeof wf === 'string') return reply.code(400).send({ error: wf });
    if (!workflowId || !db.workflowSummary(workflowId)) return reply.code(400).send({ error: '先在工作流库里选一个工作流' });
    return enqueueRun(workflowId, wf, label, 'ui');
  });

  app.get('/api/runs', async () => ({ tasks: recentTasks() }));

  /** One run, in the external API's shape — for polling after `wait: false`. */
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const t = tasks.get(req.params.id);
    return t ? { task: publicTask(t, originOf(req)) } : reply.code(404).send({ error: '找不到这次运行' });
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/snapshot', async (req, reply) => {
    const t = tasks.get(req.params.id);
    if (!t) return reply.code(404).send({ error: '找不到这次运行' });
    const wf = db.runSnapshot(t.id);
    if (!wf || !Object.keys(wf).length) return reply.code(404).send({ error: '这次运行的参数快照已丢失' });
    return { workflow: wf, workflowId: t.workflowId };
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (req, reply) => {
    const t = tasks.get(req.params.id);
    if (!t) return reply.code(404).send({ error: '找不到这次运行' });
    if (t.status === 'queued') {
      scheduler.remove(t.id);
      await finalize(t.id, 'cancelled', { message: '从任务队列移除' });
    } else if (t.status === 'running' && t.promptId) {
      await comfy.interrupt(t.promptId);
    } else if (t.status === 'pending' && t.promptId) {
      await comfy.dequeue(t.promptId);
      await finalize(t.id, 'cancelled', { message: '已从 ComfyUI 队列移除' });
    }
    return { ok: true };
  });

  app.delete<{ Params: { id: string }; Querystring: { files?: string } }>('/api/runs/:id', async (req) => {
    const t = tasks.get(req.params.id);
    if (t?.status === 'queued') scheduler.remove(t.id);
    if (t?.status === 'pending' && t.promptId) await comfy.dequeue(t.promptId).catch(() => {});
    if (t?.status === 'running' && t.promptId) await comfy.interrupt(t.promptId).catch(() => {});
    const paths = db.deleteRun(req.params.id);
    tasks.delete(req.params.id);
    if (t?.promptId) byPrompt.delete(t.promptId);
    const removed = req.query.files === '1' ? await removeFiles(paths, config.outputDir) : 0;
    broadcast({ type: 'task_removed', id: req.params.id });
    pushWorkflow(t?.workflowId ?? null);
    return { ok: true, removedFiles: removed };
  });

  // artifacts -------------------------------------------------------------
  await app.register(fstatic, { root: DATA_DIR, serve: false });

  app.get<{ Params: { id: string } }>('/api/artifacts/:id/file', async (req, reply) => {
    const a = db.artifact(req.params.id);
    if (!a) return reply.code(404).send({ error: '找不到这个制品' });
    if (!(await exists(a.path))) return reply.code(410).send({ error: '文件已被移动或删除' });
    return reply.sendFile(path.basename(a.path), path.dirname(a.path), { maxAge: '30d', immutable: true });
  });

  app.post<{ Params: { id: string } }>('/api/artifacts/:id/reveal', async (req, reply) => {
    const a = db.artifact(req.params.id);
    if (!a) return reply.code(404).send({ error: '找不到这个制品' });
    if (!(await exists(a.path))) return reply.code(410).send({ error: '文件已被移动或删除' });
    try { await reveal(a.path, true); } catch (e: any) {
      return reply.code(500).send({ error: `打不开文件夹：${e.message}` });
    }
    return { ok: true };
  });

  app.patch<{ Params: { id: string }; Body: { starred?: boolean } }>('/api/artifacts/:id', async (req, reply) => {
    const a = db.artifact(req.params.id);
    if (!a) return reply.code(404).send({ error: '找不到这个制品' });
    if (typeof req.body?.starred === 'boolean') db.setStarred(a.id, req.body.starred);
    const next = db.artifact(a.id)!;
    const t = tasks.get(a.runId);
    if (t) t.artifacts = t.artifacts.map((x) => (x.id === a.id ? next : x));
    broadcast({ type: 'artifact_upsert', artifact: next });
    pushWorkflow(a.workflowId);
    return { artifact: next };
  });

  app.delete<{ Params: { id: string }; Querystring: { files?: string } }>('/api/artifacts/:id', async (req, reply) => {
    const a = db.artifact(req.params.id);
    if (!a) return reply.code(404).send({ error: '找不到这个制品' });
    db.deleteArtifact(a.id);
    const t = tasks.get(a.runId);
    if (t) t.artifacts = t.artifacts.filter((x) => x.id !== a.id);
    const removed = req.query.files === '1' ? await removeFiles([a.path], config.outputDir) : 0;
    broadcast({ type: 'artifact_removed', id: a.id, runId: a.runId, workflowId: a.workflowId });
    pushWorkflow(a.workflowId);
    return { ok: true, removedFiles: removed };
  });

  // web -------------------------------------------------------------------
  if (existsSync(WEB_DIST)) {
    await app.register(fstatic, { root: WEB_DIST, prefix: '/', decorateReply: false });
  }

  // realtime --------------------------------------------------------------
  app.register(async (inst) => {
    inst.get('/api/ws', { websocket: true }, (sock: WebSocket) => {
      clients.add(sock);
      send(sock, { type: 'task_list', tasks: recentTasks() });
      send(sock, { type: 'config', ...configBody() });
      send(sock, { type: 'queue', remaining: queueRemaining });
      sock.on('close', () => clients.delete(sock));
      sock.on('error', () => clients.delete(sock));
    });
  });

  await app.listen({ port: PORT, host: '127.0.0.1' });
  console.log(
    `\n  ${pc.bold(pc.magenta('MJoe'))}${pc.dim('UI')}  ${pc.dim('server')}\n` +
    `  ${pc.dim('→')} ${pc.underline(`http://127.0.0.1:${PORT}`)}\n` +
    `  ${pc.dim('→')} ComfyUI ${config.baseUrl} ${connected ? pc.green('● 在线') : pc.yellow('○ 未连接')}\n` +
    `  ${pc.dim('→')} 制品 ${config.outputDir}\n`,
  );

  const shutdown = () => {
    comfy.stop();
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
