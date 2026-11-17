import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fstatic from '@fastify/static';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { Config } from './config.js';
import { Db, newArtifactId, newTaskId } from './db.js';
import { importLegacy } from './migrate.js';
import { asWorkflow, inspectWorkflow } from './inspect.js';
import { exists, isVideoFile, mimeOf, removeFiles, saveArtifact } from './storage.js';
import { ComfyClient } from './comfy.js';
import { Scheduler } from './queue.js';
import { deriveLabel, deriveMeta, markDone, recompute, topoNodes } from './tracker.js';
import { CATEGORIES } from './types.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(ROOT, 'data');
const WEB_DIST = path.join(ROOT, 'web', 'dist');
const PORT = Number(process.env.PORT ?? 3030);
const TASK_LIST_LIMIT = 400;
const config = new Config(DATA_DIR, path.join(DATA_DIR, 'artifacts'));
const comfy = new ComfyClient(config);
let db;
/** Every task, keyed by our own id. Live progress lives only here. */
const tasks = new Map();
/** ComfyUI's prompt_id → our task id, so events can find the right task. */
const byPrompt = new Map();
const clients = new Set();
const finalizing = new Set();
const objectInfoCache = new Map();
let connected = false;
let queueRemaining = 0;
let runningTaskId = null;
let scheduler;
// ─── broadcast ──────────────────────────────────────────────────────────────
function send(sock, ev) {
    if (sock.readyState === 1)
        sock.send(JSON.stringify(ev));
}
function broadcast(ev) {
    const payload = JSON.stringify(ev);
    for (const c of clients)
        if (c.readyState === 1)
            c.send(payload);
}
const recentTasks = () => [...tasks.values()].sort((a, b) => b.submittedAt - a.submittedAt).slice(0, TASK_LIST_LIMIT);
const configBody = () => ({
    baseUrl: config.baseUrl,
    connected,
    outputDir: config.outputDir,
    defaultOutputDir: config.defaultOutputDir,
});
function setConnected(next) {
    if (next === connected)
        return;
    connected = next;
    broadcast({ type: 'config', ...configBody() });
}
function pushWorkflow(id) {
    if (!id)
        return;
    const w = db.workflowSummary(id);
    if (w)
        broadcast({ type: 'workflow_upsert', workflow: w });
}
/** Mutate a live task and fan it out. `persist` writes the row (status changes only). */
function updateTask(id, fn, persist = false) {
    const t = tasks.get(id);
    if (!t)
        return;
    fn(t);
    broadcast({ type: 'task_upsert', task: t });
    if (persist)
        db.saveRun(t);
}
/** Show a file (or open a folder) in Finder / Explorer / the desktop's file manager. */
function reveal(target, select) {
    return new Promise((resolve, reject) => {
        const [cmd, args] = process.platform === 'darwin' ? ['open', select ? ['-R', target] : [target]]
            : process.platform === 'win32' ? ['explorer', [select ? `/select,${target}` : target]]
                : ['xdg-open', [select ? path.dirname(target) : target]];
        // explorer exits 1 even on success
        execFile(cmd, args, (err) => (err && process.platform !== 'win32' ? reject(err) : resolve()));
    });
}
async function collectArtifacts(t) {
    if (!t.promptId)
        return;
    let entry = await comfy.history(t.promptId);
    for (let i = 0; !entry && i < 3; i++) {
        await new Promise((r) => setTimeout(r, 300));
        entry = await comfy.history(t.promptId);
    }
    if (!entry)
        return;
    const found = [];
    for (const [nodeId, out] of Object.entries(entry.outputs ?? {})) {
        for (const value of Object.values(out)) {
            if (!Array.isArray(value))
                continue;
            for (const item of value) {
                if (item && typeof item.filename === 'string')
                    found.push({ nodeId, item });
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
        if (seen.has(item.filename))
            continue;
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
            t.artifacts.push(db.artifact(id));
            seen.add(item.filename);
        }
        catch (e) {
            console.error(pc.red('[artifacts] save failed'), item.filename, e);
        }
    }
}
async function finalize(id, status, error) {
    const t = tasks.get(id);
    if (!t || finalizing.has(id))
        return;
    if (t.status === 'success' || t.status === 'error' || t.status === 'cancelled')
        return;
    finalizing.add(id);
    if (runningTaskId === id)
        runningTaskId = null;
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
    }
    finally {
        finalizing.delete(id);
        scheduler?.notifyDone(id);
    }
}
// ─── comfy events ───────────────────────────────────────────────────────────
function nodeInfo(t, id) {
    const n = t.nodes?.find((n) => n.id === id);
    return { id, className: n?.className ?? id, title: n?.title ?? `#${id}` };
}
function setCurrent(t, id) {
    if (t.currentNode?.id === id)
        return;
    if (t.currentNode)
        markDone(t, t.currentNode.id);
    t.currentNode = { ...nodeInfo(t, id), startedAt: Date.now() };
}
function onComfyEvent(ev) {
    const d = ev.data ?? {};
    if (ev.type === 'status') {
        const r = d.status?.exec_info?.queue_remaining;
        if (typeof r === 'number' && r !== queueRemaining) {
            queueRemaining = r;
            broadcast({ type: 'queue', remaining: r });
        }
        return;
    }
    const pid = d.prompt_id;
    const id = pid && byPrompt.get(pid);
    if (!id || !tasks.has(id) || finalizing.has(id))
        return;
    switch (ev.type) {
        case 'execution_start':
            runningTaskId = id;
            updateTask(id, (t) => { t.status = 'running'; t.startedAt = Date.now(); recompute(t); }, true);
            break;
        case 'execution_cached':
            updateTask(id, (t) => {
                const ids = (d.nodes ?? []).map(String);
                t.cachedNodes = ids;
                for (const nid of ids)
                    markDone(t, nid);
                recompute(t);
            });
            break;
        case 'executing':
            if (d.node == null) {
                void finalize(id, 'success');
                break;
            }
            updateTask(id, (t) => { t.status = 'running'; setCurrent(t, String(d.node)); recompute(t); });
            break;
        case 'progress':
            updateTask(id, (t) => {
                if (t.currentNode?.id !== String(d.node))
                    setCurrent(t, String(d.node));
                t.currentNode.progress = { value: d.value, max: d.max };
                recompute(t);
            });
            break;
        case 'progress_state':
            updateTask(id, (t) => {
                for (const [nid, s] of Object.entries(d.nodes ?? {})) {
                    if (s.state === 'finished')
                        markDone(t, nid);
                    else if (s.state === 'running') {
                        setCurrent(t, nid);
                        if (s.max > 1)
                            t.currentNode.progress = { value: s.value, max: s.max };
                    }
                }
                if (t.currentNode && t.doneNodes?.includes(t.currentNode.id))
                    t.currentNode = undefined;
                recompute(t);
            });
            break;
        case 'executed':
            updateTask(id, (t) => {
                markDone(t, String(d.node));
                if (t.currentNode?.id === String(d.node))
                    t.currentNode = undefined;
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
const previewLatest = new Map();
const previewTimer = new Map();
function onComfyPreview(p) {
    const id = (p.promptId && byPrompt.get(p.promptId)) ?? runningTaskId;
    if (!id || !tasks.has(id) || clients.size === 0)
        return;
    previewLatest.set(id, p);
    if (previewTimer.has(id))
        return;
    const flush = () => {
        const latest = previewLatest.get(id);
        previewLatest.delete(id);
        if (!latest) {
            previewTimer.delete(id);
            return;
        }
        broadcast({ type: 'preview', taskId: id, mime: latest.mime, data: latest.data.toString('base64') });
        previewTimer.set(id, setTimeout(flush, 150));
    };
    flush();
}
/** After a restart or reconnect, settle runs that were in flight. */
async function reconcile() {
    const open = [...tasks.values()].filter((t) => t.promptId && (t.status === 'pending' || t.status === 'running'));
    if (!open.length)
        return;
    let q;
    try {
        q = await comfy.queue();
    }
    catch {
        return;
    }
    for (const t of open) {
        const pid = t.promptId;
        if (q.running.includes(pid) || q.pending.includes(pid))
            continue;
        const h = await comfy.history(pid).catch(() => null);
        if (h?.status?.status_str === 'success' || (h && !h.status))
            await finalize(t.id, 'success');
        else if (h?.status?.status_str === 'error')
            await finalize(t.id, 'error', { message: '执行出错（详情见 ComfyUI 日志）' });
        else
            await finalize(t.id, 'error', { message: 'ComfyUI 中已找不到这个任务，可能在它重启时丢失了。' });
    }
}
// ─── helpers for routes ─────────────────────────────────────────────────────
const isCategory = (v) => typeof v === 'string' && CATEGORIES.includes(v);
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
function parseGraph(raw) {
    if (raw == null)
        return '缺少工作流';
    if (typeof raw === 'string') {
        try {
            raw = JSON.parse(raw);
        }
        catch (e) {
            return `JSON 无法解析：${e.message}`;
        }
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
        // On startup, anything that was in flight died with the previous process.
        // Flip it to error once so the UI stops spinning on a ghost.
        if (t.status === 'queued' || t.status === 'pending' || t.status === 'running') {
            t.status = 'error';
            t.error = t.error ?? '服务重启时这个任务还没跑完';
            t.completedAt = t.completedAt ?? Date.now();
            db.saveRun(t);
        }
        tasks.set(t.id, t);
        if (t.promptId)
            byPrompt.set(t.promptId, t.id);
    }
    scheduler = new Scheduler(comfy, (id) => tasks.get(id), (id) => db.runSnapshot(id), (id, promptId) => {
        byPrompt.set(promptId, id);
        updateTask(id, (t) => { t.promptId = promptId; t.status = 'pending'; }, true);
    }, (id, msg) => void finalize(id, 'error', { message: msg }));
    comfy.onEvent(onComfyEvent);
    comfy.onPreview(onComfyPreview);
    comfy.onSocket((open) => {
        setConnected(open);
        if (open)
            void reconcile();
    });
    comfy.start();
    connected = await config.probe();
    setInterval(async () => setConnected(comfy.isOpen || (await config.probe())), 5000).unref();
    const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
    await app.register(cors, { origin: true });
    await app.register(websocket);
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 512 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    app.setErrorHandler((err, _req, reply) => {
        const code = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
        reply.code(code).send({ error: err.message ?? '服务器内部错误' });
    });
    // config ----------------------------------------------------------------
    app.get('/api/config', async () => {
        setConnected(comfy.isOpen || (await config.probe()));
        return configBody();
    });
    app.post('/api/config', async (req, reply) => {
        const { baseUrl, outputDir } = req.body ?? {};
        if (typeof baseUrl !== 'string' && typeof outputDir !== 'string') {
            return reply.code(400).send({ error: '没有要保存的内容' });
        }
        if (typeof outputDir === 'string') {
            try {
                await config.setOutputDir(outputDir);
            }
            catch (e) {
                return reply.code(400).send({ error: e.message });
            }
        }
        if (typeof baseUrl === 'string') {
            if (!baseUrl.trim())
                return reply.code(400).send({ error: '请填写 BASE URL' });
            try {
                await config.setBaseUrl(baseUrl);
            }
            catch (e) {
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
        await fs.mkdir(config.outputDir, { recursive: true }).catch(() => { });
        try {
            await reveal(config.outputDir, false);
        }
        catch (e) {
            return reply.code(500).send({ error: `打不开文件夹：${e.message}` });
        }
        return { ok: true };
    });
    // comfy passthroughs ----------------------------------------------------
    app.get('/api/comfy/system', async (_req, reply) => {
        try {
            return await comfy.systemStats();
        }
        catch (e) {
            return reply.code(502).send({ error: `无法读取 ComfyUI 状态：${e.message}` });
        }
    });
    app.post('/api/comfy/free', async (_req, reply) => {
        try {
            await comfy.free();
            return { ok: true };
        }
        catch (e) {
            return reply.code(502).send({ error: `释放失败：${e.message}` });
        }
    });
    app.get('/api/comfy/object-info', async (req) => {
        const classes = (req.query.classes ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        if (req.query.refresh)
            for (const c of classes)
                objectInfoCache.delete(c);
        const result = {};
        await Promise.all(classes.map(async (c) => {
            if (!objectInfoCache.has(c)) {
                try {
                    objectInfoCache.set(c, await comfy.objectInfo(c));
                }
                catch {
                    return void (result[c] = null);
                }
            }
            result[c] = objectInfoCache.get(c) ?? null;
        }));
        return result;
    });
    /** Raw body upload → ComfyUI input folder. Returns the name to put into LoadImage / LoadVideo. */
    app.post('/api/comfy/upload', async (req, reply) => {
        const name = path.basename(req.query.filename || 'upload.png');
        if (!Buffer.isBuffer(req.body) || !req.body.length)
            return reply.code(400).send({ error: '文件是空的' });
        try {
            const r = await comfy.upload(req.body, name, mimeOf(name));
            // loader specs list the input folder; refetch them so the dropdown sees the new file
            for (const k of [...objectInfoCache.keys()])
                if (/load/i.test(k))
                    objectInfoCache.delete(k);
            return { name: r.subfolder ? `${r.subfolder}/${r.name}` : r.name };
        }
        catch (e) {
            return reply.code(502).send({ error: e.message });
        }
    });
    /** A file in ComfyUI's input folder, for the thumbnail next to LoadImage. */
    app.get('/api/comfy/input', async (req, reply) => {
        const name = req.query.name ?? '';
        if (!name)
            return reply.code(400).send({ error: '缺少文件名' });
        const i = name.lastIndexOf('/');
        try {
            const { data, mime } = await comfy.viewRaw({
                filename: i >= 0 ? name.slice(i + 1) : name,
                subfolder: i >= 0 ? name.slice(0, i) : '',
                type: 'input',
            });
            return reply.type(mime).header('Cache-Control', 'private, max-age=300').send(data);
        }
        catch {
            return reply.code(404).send({ error: 'ComfyUI 输入目录里没有这个文件' });
        }
    });
    // workflows -------------------------------------------------------------
    app.post('/api/workflows/inspect', async (req, reply) => {
        const wf = parseGraph(req.body?.json);
        if (typeof wf === 'string')
            return reply.code(400).send({ error: wf });
        const info = inspectWorkflow(wf, req.body?.fileName);
        return { ...info, duplicateOf: db.workflowByHash(info.hash), json: wf };
    });
    app.get('/api/workflows', async () => ({ workflows: db.listWorkflows() }));
    app.post('/api/workflows', async (req, reply) => {
        const b = req.body ?? {};
        const wf = parseGraph(b.json);
        if (typeof wf === 'string')
            return reply.code(400).send({ error: wf });
        const name = clean(b.name, 80);
        if (!name)
            return reply.code(400).send({ error: '给工作流取个名字' });
        const info = inspectWorkflow(wf);
        const id = db.insertWorkflow({
            name,
            category: isCategory(b.category) ? b.category : info.category,
            baseModel: clean(b.baseModel, 60) ?? info.baseModel,
            modelFile: info.modelFile,
            note: clean(b.note, 2000) ?? '',
            json: wf,
            hash: info.hash,
        });
        pushWorkflow(id);
        return { workflow: db.workflow(id) };
    });
    app.get('/api/workflows/:id', async (req, reply) => {
        const w = db.workflow(req.params.id);
        return w ? { workflow: w } : reply.code(404).send({ error: '找不到这个工作流' });
    });
    app.patch('/api/workflows/:id', async (req, reply) => {
        const { id } = req.params;
        if (!db.workflowSummary(id))
            return reply.code(404).send({ error: '找不到这个工作流' });
        const b = req.body ?? {};
        const patch = {};
        if (b.name !== undefined) {
            const name = clean(b.name, 80);
            if (!name)
                return reply.code(400).send({ error: '名字不能为空' });
            patch.name = name;
        }
        if (b.category !== undefined) {
            if (!isCategory(b.category))
                return reply.code(400).send({ error: '未知的类别' });
            patch.category = b.category;
        }
        if (b.baseModel !== undefined)
            patch.baseModel = clean(b.baseModel, 60) ?? '';
        if (b.note !== undefined)
            patch.note = clean(b.note, 2000) ?? '';
        if (b.json !== undefined) {
            const wf = parseGraph(b.json);
            if (typeof wf === 'string')
                return reply.code(400).send({ error: wf });
            const info = inspectWorkflow(wf);
            patch.json = wf;
            patch.hash = info.hash;
            patch.modelFile = info.modelFile;
        }
        db.updateWorkflow(id, patch);
        pushWorkflow(id);
        return { workflow: db.workflow(id) };
    });
    app.delete('/api/workflows/:id', async (req, reply) => {
        const { id } = req.params;
        if (!db.workflowSummary(id))
            return reply.code(404).send({ error: '找不到这个工作流' });
        for (const t of tasks.values()) {
            if (t.workflowId === id && (t.status === 'pending' || t.status === 'running')) {
                return reply.code(409).send({ error: '这个工作流还有任务在跑，等它结束或先取消' });
            }
        }
        const { paths, runIds } = db.deleteWorkflow(id);
        for (const r of runIds) {
            tasks.delete(r);
            broadcast({ type: 'task_removed', id: r });
        }
        const removed = req.query.files === '1' ? await removeFiles(paths, config.outputDir) : 0;
        broadcast({ type: 'workflow_removed', id });
        return { ok: true, removedFiles: removed };
    });
    app.get('/api/workflows/:id/artifacts', async (req) => ({
        artifacts: db.artifactsOf(req.params.id),
    }));
    // runs ------------------------------------------------------------------
    app.post('/api/runs', async (req, reply) => {
        const { workflowId, label } = req.body ?? {};
        const wf = parseGraph(req.body?.workflow);
        if (typeof wf === 'string')
            return reply.code(400).send({ error: wf });
        if (!workflowId || !db.workflowSummary(workflowId))
            return reply.code(400).send({ error: '先在工作流库里选一个工作流' });
        const id = newTaskId();
        const nodes = topoNodes(wf);
        const meta = deriveMeta(wf);
        const task = {
            id,
            workflowId,
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
    });
    app.get('/api/runs', async () => ({ tasks: recentTasks() }));
    app.get('/api/runs/:id/snapshot', async (req, reply) => {
        const t = tasks.get(req.params.id);
        if (!t)
            return reply.code(404).send({ error: '找不到这次运行' });
        const wf = db.runSnapshot(t.id);
        if (!wf || !Object.keys(wf).length)
            return reply.code(404).send({ error: '这次运行的参数快照已丢失' });
        return { workflow: wf, workflowId: t.workflowId };
    });
    app.post('/api/runs/:id/cancel', async (req, reply) => {
        const t = tasks.get(req.params.id);
        if (!t)
            return reply.code(404).send({ error: '找不到这次运行' });
        if (t.status === 'queued') {
            scheduler.remove(t.id);
            await finalize(t.id, 'cancelled', { message: '从任务队列移除' });
        }
        else if (t.status === 'running' && t.promptId) {
            await comfy.interrupt(t.promptId);
        }
        else if (t.status === 'pending' && t.promptId) {
            await comfy.dequeue(t.promptId);
            await finalize(t.id, 'cancelled', { message: '已从 ComfyUI 队列移除' });
        }
        return { ok: true };
    });
    app.delete('/api/runs/:id', async (req) => {
        const t = tasks.get(req.params.id);
        if (t?.status === 'queued')
            scheduler.remove(t.id);
        if (t?.status === 'pending' && t.promptId)
            await comfy.dequeue(t.promptId).catch(() => { });
        if (t?.status === 'running' && t.promptId)
            await comfy.interrupt(t.promptId).catch(() => { });
        const paths = db.deleteRun(req.params.id);
        tasks.delete(req.params.id);
        if (t?.promptId)
            byPrompt.delete(t.promptId);
        const removed = req.query.files === '1' ? await removeFiles(paths, config.outputDir) : 0;
        broadcast({ type: 'task_removed', id: req.params.id });
        pushWorkflow(t?.workflowId ?? null);
        return { ok: true, removedFiles: removed };
    });
    // artifacts -------------------------------------------------------------
    await app.register(fstatic, { root: DATA_DIR, serve: false });
    app.get('/api/artifacts/:id/file', async (req, reply) => {
        const a = db.artifact(req.params.id);
        if (!a)
            return reply.code(404).send({ error: '找不到这个制品' });
        if (!(await exists(a.path)))
            return reply.code(410).send({ error: '文件已被移动或删除' });
        return reply.sendFile(path.basename(a.path), path.dirname(a.path), { maxAge: '30d', immutable: true });
    });
    app.post('/api/artifacts/:id/reveal', async (req, reply) => {
        const a = db.artifact(req.params.id);
        if (!a)
            return reply.code(404).send({ error: '找不到这个制品' });
        if (!(await exists(a.path)))
            return reply.code(410).send({ error: '文件已被移动或删除' });
        try {
            await reveal(a.path, true);
        }
        catch (e) {
            return reply.code(500).send({ error: `打不开文件夹：${e.message}` });
        }
        return { ok: true };
    });
    app.patch('/api/artifacts/:id', async (req, reply) => {
        const a = db.artifact(req.params.id);
        if (!a)
            return reply.code(404).send({ error: '找不到这个制品' });
        if (typeof req.body?.starred === 'boolean')
            db.setStarred(a.id, req.body.starred);
        const next = db.artifact(a.id);
        const t = tasks.get(a.runId);
        if (t)
            t.artifacts = t.artifacts.map((x) => (x.id === a.id ? next : x));
        broadcast({ type: 'artifact_upsert', artifact: next });
        pushWorkflow(a.workflowId);
        return { artifact: next };
    });
    app.delete('/api/artifacts/:id', async (req, reply) => {
        const a = db.artifact(req.params.id);
        if (!a)
            return reply.code(404).send({ error: '找不到这个制品' });
        db.deleteArtifact(a.id);
        const t = tasks.get(a.runId);
        if (t)
            t.artifacts = t.artifacts.filter((x) => x.id !== a.id);
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
        inst.get('/api/ws', { websocket: true }, (sock) => {
            clients.add(sock);
            send(sock, { type: 'task_list', tasks: recentTasks() });
            send(sock, { type: 'config', ...configBody() });
            send(sock, { type: 'queue', remaining: queueRemaining });
            sock.on('close', () => clients.delete(sock));
            sock.on('error', () => clients.delete(sock));
        });
    });
    await app.listen({ port: PORT, host: '127.0.0.1' });
    console.log(`\n  ${pc.bold(pc.magenta('MJoe'))}${pc.dim('UI')}  ${pc.dim('server')}\n` +
        `  ${pc.dim('→')} ${pc.underline(`http://127.0.0.1:${PORT}`)}\n` +
        `  ${pc.dim('→')} ComfyUI ${config.baseUrl} ${connected ? pc.green('● 在线') : pc.yellow('○ 未连接')}\n` +
        `  ${pc.dim('→')} 制品 ${config.outputDir}\n`);
    const shutdown = () => { try {
        db.close();
    }
    catch { /* already closed */ } process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
