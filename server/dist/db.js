import Database from 'better-sqlite3';
import { customAlphabet } from 'nanoid';
import { CATEGORIES } from './types.js';
/** Lower-case, no look-alikes (no i/l/o/u) — readable when it shows up in a folder name. */
const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
export const newWorkflowId = (() => { const f = customAlphabet(alphabet, 8); return () => `wf_${f()}`; })();
export const newTaskId = (() => { const f = customAlphabet(alphabet, 10); return () => `rn_${f()}`; })();
export const newArtifactId = (() => { const f = customAlphabet(alphabet, 12); return () => `ar_${f()}`; })();
const MIGRATIONS = [
    `
  CREATE TABLE workflows (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT 'other',
    base_model  TEXT NOT NULL DEFAULT '',
    model_file  TEXT,
    note        TEXT NOT NULL DEFAULT '',
    json        TEXT NOT NULL,
    hash        TEXT NOT NULL,
    node_count  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX workflows_hash ON workflows(hash);

  CREATE TABLE runs (
    id            TEXT PRIMARY KEY,
    workflow_id   TEXT REFERENCES workflows(id) ON DELETE SET NULL,
    label         TEXT NOT NULL,
    status        TEXT NOT NULL,
    submitted_at  INTEGER NOT NULL,
    started_at    INTEGER,
    completed_at  INTEGER,
    error         TEXT,
    error_node    TEXT,
    meta          TEXT NOT NULL DEFAULT '{}',
    nodes         TEXT NOT NULL DEFAULT '[]',
    done_nodes    TEXT NOT NULL DEFAULT '[]',
    cached_nodes  TEXT NOT NULL DEFAULT '[]',
    snapshot      TEXT NOT NULL
  );
  CREATE INDEX runs_workflow ON runs(workflow_id, submitted_at DESC);

  CREATE TABLE artifacts (
    id           TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    workflow_id  TEXT REFERENCES workflows(id) ON DELETE SET NULL,
    kind         TEXT NOT NULL,
    path         TEXT NOT NULL,
    filename     TEXT NOT NULL,
    source       TEXT,
    mime         TEXT NOT NULL,
    bytes        INTEGER NOT NULL DEFAULT 0,
    width        INTEGER,
    height       INTEGER,
    node_id      TEXT NOT NULL DEFAULT '',
    meta         TEXT NOT NULL DEFAULT '{}',
    duration_ms  INTEGER,
    starred      INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX artifacts_workflow ON artifacts(workflow_id, created_at DESC);
  CREATE INDEX artifacts_run ON artifacts(run_id);
  `,
    // 2 — Our own task id (`rn_...`) is now the primary key; ComfyUI's prompt_id
    // moves to its own column, so queued tasks can exist before we have one.
    `
  ALTER TABLE runs ADD COLUMN prompt_id TEXT;
  UPDATE runs SET prompt_id = id;
  CREATE INDEX runs_prompt ON runs(prompt_id);
  `,
];
const json = (s, fallback) => {
    if (!s)
        return fallback;
    try {
        return JSON.parse(s);
    }
    catch {
        return fallback;
    }
};
export const artifactUrl = (id) => `/api/artifacts/${id}/file`;
const STATS_SQL = `
  SELECT w.*,
    (SELECT COUNT(*) FROM runs r WHERE r.workflow_id = w.id) AS runs,
    (SELECT COUNT(*) FROM runs r WHERE r.workflow_id = w.id AND r.status = 'success') AS success,
    (SELECT COUNT(*) FROM runs r WHERE r.workflow_id = w.id AND r.status = 'error') AS failed,
    (SELECT AVG(r.completed_at - r.started_at) FROM runs r
       WHERE r.workflow_id = w.id AND r.status = 'success' AND r.started_at IS NOT NULL) AS avg_ms,
    (SELECT MAX(r.submitted_at) FROM runs r WHERE r.workflow_id = w.id) AS last_run_at,
    (SELECT COUNT(*) FROM artifacts a WHERE a.workflow_id = w.id) AS artifacts,
    (SELECT a.id FROM artifacts a WHERE a.workflow_id = w.id ORDER BY a.starred DESC, a.created_at DESC LIMIT 1) AS cover_id,
    (SELECT a.kind FROM artifacts a WHERE a.workflow_id = w.id ORDER BY a.starred DESC, a.created_at DESC LIMIT 1) AS cover_kind
  FROM workflows w`;
export class Db {
    sql;
    constructor(file) {
        this.sql = new Database(file);
        this.sql.pragma('journal_mode = WAL');
        this.sql.pragma('foreign_keys = ON');
        this.sql.pragma('synchronous = NORMAL');
        const version = this.sql.pragma('user_version', { simple: true });
        for (let v = version; v < MIGRATIONS.length; v++) {
            this.sql.transaction(() => {
                this.sql.exec(MIGRATIONS[v]);
                this.sql.pragma(`user_version = ${v + 1}`);
            })();
        }
    }
    close() { this.sql.close(); }
    // ─── workflows ────────────────────────────────────────────────────────────
    toSummary(r) {
        return {
            id: r.id,
            name: r.name,
            category: CATEGORIES.includes(r.category) ? r.category : 'other',
            baseModel: r.base_model,
            modelFile: r.model_file,
            note: r.note,
            nodeCount: r.node_count,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            lastRunAt: r.last_run_at ?? null,
            stats: {
                runs: r.runs ?? 0,
                success: r.success ?? 0,
                failed: r.failed ?? 0,
                artifacts: r.artifacts ?? 0,
                avgMs: r.avg_ms != null ? Math.round(r.avg_ms) : null,
            },
            cover: r.cover_id ? { url: artifactUrl(r.cover_id), kind: r.cover_kind ?? 'image' } : null,
        };
    }
    listWorkflows() {
        const rows = this.sql
            .prepare(`${STATS_SQL} ORDER BY COALESCE(last_run_at, w.updated_at) DESC`)
            .all();
        return rows.map((r) => this.toSummary(r));
    }
    workflowSummary(id) {
        const r = this.sql.prepare(`${STATS_SQL} WHERE w.id = ?`).get(id);
        return r ? this.toSummary(r) : null;
    }
    workflow(id) {
        const r = this.sql.prepare(`${STATS_SQL} WHERE w.id = ?`).get(id);
        return r ? { ...this.toSummary(r), json: JSON.parse(r.json) } : null;
    }
    workflowByHash(hash) {
        return this.sql.prepare('SELECT id, name FROM workflows WHERE hash = ? LIMIT 1').get(hash) ?? null;
    }
    insertWorkflow(w) {
        const id = w.id ?? newWorkflowId();
        const now = w.createdAt ?? Date.now();
        this.sql
            .prepare(`INSERT INTO workflows (id, name, category, base_model, model_file, note, json, hash, node_count, created_at, updated_at)
                VALUES (@id, @name, @category, @baseModel, @modelFile, @note, @json, @hash, @nodeCount, @now, @now)`)
            .run({
            id, name: w.name, category: w.category, baseModel: w.baseModel, modelFile: w.modelFile, note: w.note,
            json: JSON.stringify(w.json), hash: w.hash, nodeCount: Object.keys(w.json).length, now,
        });
        return id;
    }
    updateWorkflow(id, patch) {
        const sets = [];
        const args = { id, now: Date.now() };
        const col = (c, k, v) => { sets.push(`${c} = @${k}`); args[k] = v; };
        if (patch.name !== undefined)
            col('name', 'name', patch.name);
        if (patch.category !== undefined)
            col('category', 'category', patch.category);
        if (patch.baseModel !== undefined)
            col('base_model', 'baseModel', patch.baseModel);
        if (patch.note !== undefined)
            col('note', 'note', patch.note);
        if (patch.modelFile !== undefined)
            col('model_file', 'modelFile', patch.modelFile);
        if (patch.json !== undefined) {
            col('json', 'json', JSON.stringify(patch.json));
            col('node_count', 'nodeCount', Object.keys(patch.json).length);
        }
        if (patch.hash !== undefined)
            col('hash', 'hash', patch.hash);
        if (!sets.length)
            return;
        this.sql.prepare(`UPDATE workflows SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(args);
    }
    /** Removes the workflow with its runs and artifact records. Returns the files that belonged to it. */
    deleteWorkflow(id) {
        const paths = this.sql.prepare('SELECT path FROM artifacts WHERE workflow_id = ?').all(id).map((r) => r.path);
        const runIds = this.sql.prepare('SELECT id FROM runs WHERE workflow_id = ?').all(id).map((r) => r.id);
        this.sql.transaction(() => {
            this.sql.prepare('DELETE FROM artifacts WHERE workflow_id = ?').run(id);
            this.sql.prepare('DELETE FROM runs WHERE workflow_id = ?').run(id);
            this.sql.prepare('DELETE FROM workflows WHERE id = ?').run(id);
        })();
        return { paths, runIds };
    }
    // ─── runs ─────────────────────────────────────────────────────────────────
    insertRun(t, snapshot) {
        this.sql
            .prepare(`INSERT OR REPLACE INTO runs (id, prompt_id, workflow_id, label, status, submitted_at, started_at, completed_at, error, error_node, meta, nodes, done_nodes, cached_nodes, snapshot)
                VALUES (@id, @promptId, @workflowId, @label, @status, @submittedAt, @startedAt, @completedAt, @error, @errorNode, @meta, @nodes, @doneNodes, @cachedNodes, @snapshot)`)
            .run({ ...this.runArgs(t), snapshot: JSON.stringify(snapshot) });
    }
    saveRun(t) {
        this.sql
            .prepare(`UPDATE runs SET status = @status, label = @label, prompt_id = @promptId,
                started_at = @startedAt, completed_at = @completedAt,
                error = @error, error_node = @errorNode, meta = @meta, done_nodes = @doneNodes, cached_nodes = @cachedNodes
                WHERE id = @id`)
            .run(this.runArgs(t));
    }
    runArgs(t) {
        return {
            id: t.id,
            promptId: t.promptId ?? null,
            workflowId: t.workflowId,
            label: t.label,
            status: t.status,
            submittedAt: t.submittedAt,
            startedAt: t.startedAt ?? null,
            completedAt: t.completedAt ?? null,
            error: t.error ?? null,
            errorNode: t.errorNode ?? null,
            meta: JSON.stringify(t.meta ?? {}),
            nodes: JSON.stringify(t.nodes ?? []),
            doneNodes: JSON.stringify(t.doneNodes ?? []),
            cachedNodes: JSON.stringify(t.cachedNodes ?? []),
        };
    }
    /** Every run with its artifacts, newest first. */
    loadRuns() {
        const rows = this.sql.prepare('SELECT * FROM runs ORDER BY submitted_at DESC').all();
        const arts = this.sql.prepare('SELECT * FROM artifacts ORDER BY created_at ASC, rowid ASC').all();
        const byRun = new Map();
        for (const a of arts) {
            const list = byRun.get(a.run_id) ?? [];
            list.push(this.toArtifact(a));
            byRun.set(a.run_id, list);
        }
        return rows.map((r) => {
            const nodes = json(r.nodes, []);
            const done = json(r.done_nodes, []);
            return {
                id: r.id,
                promptId: r.prompt_id ?? undefined,
                workflowId: r.workflow_id,
                label: r.label,
                status: r.status,
                submittedAt: r.submitted_at,
                startedAt: r.started_at ?? undefined,
                completedAt: r.completed_at ?? undefined,
                error: r.error ?? undefined,
                errorNode: r.error_node ?? undefined,
                meta: json(r.meta, {}),
                nodes,
                doneNodes: done,
                cachedNodes: json(r.cached_nodes, []),
                nodesTotal: nodes.length,
                nodesDone: r.status === 'success' ? nodes.length : done.length,
                progress: r.status === 'success' ? 1 : 0,
                artifacts: byRun.get(r.id) ?? [],
            };
        });
    }
    runSnapshot(id) {
        const r = this.sql.prepare('SELECT snapshot FROM runs WHERE id = ?').get(id);
        return r ? json(r.snapshot, null) : null;
    }
    deleteRun(id) {
        const paths = this.sql.prepare('SELECT path FROM artifacts WHERE run_id = ?').all(id).map((r) => r.path);
        this.sql.prepare('DELETE FROM runs WHERE id = ?').run(id); // artifacts cascade
        return paths;
    }
    // ─── artifacts ────────────────────────────────────────────────────────────
    toArtifact(r) {
        return {
            id: r.id,
            runId: r.run_id,
            workflowId: r.workflow_id,
            kind: r.kind,
            url: artifactUrl(r.id),
            filename: r.filename,
            path: r.path,
            mime: r.mime,
            bytes: r.bytes,
            width: r.width ?? undefined,
            height: r.height ?? undefined,
            nodeId: r.node_id,
            meta: json(r.meta, {}),
            durationMs: r.duration_ms ?? undefined,
            starred: !!r.starred,
            createdAt: r.created_at,
        };
    }
    insertArtifact(a) {
        this.sql
            .prepare(`INSERT INTO artifacts (id, run_id, workflow_id, kind, path, filename, source, mime, bytes, width, height, node_id, meta, duration_ms, starred, created_at)
                VALUES (@id, @runId, @workflowId, @kind, @path, @filename, @source, @mime, @bytes, @width, @height, @nodeId, @meta, @durationMs, @starred, @createdAt)`)
            .run({
            ...a,
            source: a.source ?? null,
            width: a.width ?? null,
            height: a.height ?? null,
            meta: JSON.stringify(a.meta ?? {}),
            durationMs: a.durationMs ?? null,
            starred: a.starred ? 1 : 0,
        });
    }
    /** Sources already saved for a run — lets a retried finalize skip files it already copied. */
    artifactSources(runId) {
        const rows = this.sql.prepare('SELECT source FROM artifacts WHERE run_id = ?').all(runId);
        return new Set(rows.map((r) => r.source).filter((s) => !!s));
    }
    artifact(id) {
        const r = this.sql.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
        return r ? this.toArtifact(r) : null;
    }
    artifactsOf(workflowId) {
        const rows = this.sql
            .prepare('SELECT * FROM artifacts WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC')
            .all(workflowId);
        return rows.map((r) => this.toArtifact(r));
    }
    setStarred(id, starred) {
        this.sql.prepare('UPDATE artifacts SET starred = ? WHERE id = ?').run(starred ? 1 : 0, id);
    }
    deleteArtifact(id) {
        this.sql.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
    }
    isEmpty() {
        const r = this.sql.prepare('SELECT (SELECT COUNT(*) FROM runs) + (SELECT COUNT(*) FROM workflows) AS n').get();
        return r.n === 0;
    }
}
