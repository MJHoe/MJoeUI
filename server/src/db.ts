import Database from 'better-sqlite3';
import { customAlphabet } from 'nanoid';
import type {
  Artifact, Category, MediaKind, ParamSlot, Patches, Task, TaskMeta, TaskNode, TaskStatus, Workflow, WorkflowFull, WorkflowSummary,
} from './types.js';
import { CATEGORIES } from './types.js';

/** Lower-case, no look-alikes (no i/l/o/u) — readable when it shows up in a folder name. */
const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
export const newWorkflowId = (() => { const f = customAlphabet(alphabet, 8); return () => `wf_${f()}`; })();
export const newTaskId = (() => { const f = customAlphabet(alphabet, 10); return () => `rn_${f()}`; })();
export const newArtifactId = (() => { const f = customAlphabet(alphabet, 12); return () => `ar_${f()}`; })();

const MIGRATIONS: string[] = [
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
  // 3 — Which inputs the user chose to show on the Use page ("nodeId:input"
  // JSON array). NULL = never chosen, the client falls back to its classifier.
  `
  ALTER TABLE workflows ADD COLUMN exposed TEXT;
  `,
  // 4 — The user's saved edits on top of the imported JSON (node → input →
  // value). The JSON itself stays exactly as imported; generate and the
  // external API both apply these on top.
  `
  ALTER TABLE workflows ADD COLUMN params TEXT NOT NULL DEFAULT '{}';
  `,
  // 5 — The task list records which app submitted a run (name kept as it was
  // at submit time) and whether it came from the UI or the external API.
  `
  ALTER TABLE runs ADD COLUMN app_name TEXT;
  ALTER TABLE runs ADD COLUMN source TEXT NOT NULL DEFAULT 'ui';
  UPDATE runs SET app_name = (SELECT w.name FROM workflows w WHERE w.id = runs.workflow_id);
  `,
];

/** `exposed` was a bare "nodeId:input" list before slots had a place — read
 *  those as left-column entries. */
function toSlots(v: unknown): ParamSlot[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((s): ParamSlot[] => {
    if (typeof s === 'string') return [{ key: s, place: 'side', name: s.slice(s.indexOf(':') + 1), type: 'string' }];
    if (s && typeof s === 'object' && typeof s.key === 'string') return [s as ParamSlot];
    return [];
  });
}

const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

type WorkflowRow = {
  id: string; name: string; category: string; base_model: string; model_file: string | null; note: string;
  json: string; hash: string; node_count: number; created_at: number; updated_at: number;
  exposed?: string | null; params?: string;
  runs?: number; success?: number; failed?: number; artifacts?: number; avg_ms?: number | null;
  last_run_at?: number | null; cover_id?: string | null; cover_kind?: string | null;
};

type RunRow = {
  id: string; prompt_id: string | null; workflow_id: string | null; label: string; status: string;
  app_name: string | null; source: string | null;
  submitted_at: number; started_at: number | null; completed_at: number | null;
  error: string | null; error_node: string | null;
  meta: string; nodes: string; done_nodes: string; cached_nodes: string;
};

type ArtifactRow = {
  id: string; run_id: string; workflow_id: string | null; kind: string; path: string; filename: string;
  source: string | null; mime: string; bytes: number; width: number | null; height: number | null;
  node_id: string; meta: string; duration_ms: number | null; starred: number; created_at: number;
};

export const artifactUrl = (id: string) => `/api/artifacts/${id}/file`;

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
  readonly sql: Database.Database;

  constructor(file: string) {
    this.sql = new Database(file);
    this.sql.pragma('journal_mode = WAL');
    this.sql.pragma('foreign_keys = ON');
    this.sql.pragma('synchronous = NORMAL');
    const version = this.sql.pragma('user_version', { simple: true }) as number;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.sql.transaction(() => {
        this.sql.exec(MIGRATIONS[v]);
        this.sql.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  close() { this.sql.close(); }

  // ─── workflows ────────────────────────────────────────────────────────────
  private toSummary(r: WorkflowRow): WorkflowSummary {
    return {
      id: r.id,
      name: r.name,
      category: (CATEGORIES as string[]).includes(r.category) ? (r.category as Category) : 'other',
      baseModel: r.base_model,
      modelFile: r.model_file,
      note: r.note,
      nodeCount: r.node_count,
      exposed: toSlots(json<unknown>(r.exposed, null)),
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
      cover: r.cover_id ? { url: artifactUrl(r.cover_id), kind: (r.cover_kind as MediaKind) ?? 'image' } : null,
    };
  }

  listWorkflows(): WorkflowSummary[] {
    const rows = this.sql
      .prepare(`${STATS_SQL} ORDER BY COALESCE(last_run_at, w.updated_at) DESC`)
      .all() as WorkflowRow[];
    return rows.map((r) => this.toSummary(r));
  }

  workflowSummary(id: string): WorkflowSummary | null {
    const r = this.sql.prepare(`${STATS_SQL} WHERE w.id = ?`).get(id) as WorkflowRow | undefined;
    return r ? this.toSummary(r) : null;
  }

  workflow(id: string): WorkflowFull | null {
    const r = this.sql.prepare(`${STATS_SQL} WHERE w.id = ?`).get(id) as WorkflowRow | undefined;
    return r ? { ...this.toSummary(r), json: JSON.parse(r.json), params: json<Patches>(r.params, {}) } : null;
  }

  /** Saved form edits. Deliberately doesn't touch updated_at: they autosave
   *  while typing, and updated_at is what tells clients to refetch the JSON. */
  setParams(id: string, params: Patches) {
    this.sql.prepare('UPDATE workflows SET params = ? WHERE id = ?').run(JSON.stringify(params), id);
  }

  workflowByHash(hash: string): { id: string; name: string } | null {
    return (this.sql.prepare('SELECT id, name FROM workflows WHERE hash = ? LIMIT 1').get(hash) as any) ?? null;
  }

  insertWorkflow(w: {
    id?: string; name: string; category: Category; baseModel: string; modelFile: string | null; note: string;
    json: Workflow; hash: string; createdAt?: number; exposed?: ParamSlot[] | null;
  }): string {
    const id = w.id ?? newWorkflowId();
    const now = w.createdAt ?? Date.now();
    this.sql
      .prepare(`INSERT INTO workflows (id, name, category, base_model, model_file, note, json, hash, node_count, exposed, created_at, updated_at)
                VALUES (@id, @name, @category, @baseModel, @modelFile, @note, @json, @hash, @nodeCount, @exposed, @now, @now)`)
      .run({
        id, name: w.name, category: w.category, baseModel: w.baseModel, modelFile: w.modelFile, note: w.note,
        json: JSON.stringify(w.json), hash: w.hash, nodeCount: Object.keys(w.json).length,
        exposed: w.exposed ? JSON.stringify(w.exposed) : null, now,
      });
    return id;
  }

  updateWorkflow(id: string, patch: {
    name?: string; category?: Category; baseModel?: string; note?: string;
    json?: Workflow; hash?: string; modelFile?: string | null; exposed?: ParamSlot[] | null;
  }) {
    const sets: string[] = [];
    const args: Record<string, unknown> = { id, now: Date.now() };
    const col = (c: string, k: string, v: unknown) => { sets.push(`${c} = @${k}`); args[k] = v; };
    if (patch.name !== undefined) col('name', 'name', patch.name);
    if (patch.category !== undefined) col('category', 'category', patch.category);
    if (patch.baseModel !== undefined) col('base_model', 'baseModel', patch.baseModel);
    if (patch.note !== undefined) col('note', 'note', patch.note);
    if (patch.modelFile !== undefined) col('model_file', 'modelFile', patch.modelFile);
    if (patch.json !== undefined) {
      col('json', 'json', JSON.stringify(patch.json));
      col('node_count', 'nodeCount', Object.keys(patch.json).length);
    }
    if (patch.hash !== undefined) col('hash', 'hash', patch.hash);
    if (patch.exposed !== undefined) col('exposed', 'exposed', patch.exposed ? JSON.stringify(patch.exposed) : null);
    if (!sets.length) return;
    this.sql.prepare(`UPDATE workflows SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(args);
  }

  /** Removes the workflow with its runs and artifact records. Returns the files that belonged to it. */
  deleteWorkflow(id: string): { paths: string[]; runIds: string[] } {
    const paths = (this.sql.prepare('SELECT path FROM artifacts WHERE workflow_id = ?').all(id) as { path: string }[]).map((r) => r.path);
    const runIds = (this.sql.prepare('SELECT id FROM runs WHERE workflow_id = ?').all(id) as { id: string }[]).map((r) => r.id);
    this.sql.transaction(() => {
      this.sql.prepare('DELETE FROM artifacts WHERE workflow_id = ?').run(id);
      this.sql.prepare('DELETE FROM runs WHERE workflow_id = ?').run(id);
      this.sql.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    })();
    return { paths, runIds };
  }

  // ─── runs ─────────────────────────────────────────────────────────────────
  insertRun(t: Task, snapshot: Workflow) {
    this.sql
      .prepare(`INSERT OR REPLACE INTO runs (id, prompt_id, workflow_id, app_name, source, label, status, submitted_at, started_at, completed_at, error, error_node, meta, nodes, done_nodes, cached_nodes, snapshot)
                VALUES (@id, @promptId, @workflowId, @appName, @source, @label, @status, @submittedAt, @startedAt, @completedAt, @error, @errorNode, @meta, @nodes, @doneNodes, @cachedNodes, @snapshot)`)
      .run({ ...this.runArgs(t), appName: t.appName ?? null, source: t.source ?? 'ui', snapshot: JSON.stringify(snapshot) });
  }

  saveRun(t: Task) {
    this.sql
      .prepare(`UPDATE runs SET status = @status, label = @label, prompt_id = @promptId,
                started_at = @startedAt, completed_at = @completedAt,
                error = @error, error_node = @errorNode, meta = @meta, done_nodes = @doneNodes, cached_nodes = @cachedNodes
                WHERE id = @id`)
      .run(this.runArgs(t));
  }

  private runArgs(t: Task) {
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
  loadRuns(): Task[] {
    const rows = this.sql.prepare('SELECT * FROM runs ORDER BY submitted_at DESC').all() as RunRow[];
    const arts = this.sql.prepare('SELECT * FROM artifacts ORDER BY created_at ASC, rowid ASC').all() as ArtifactRow[];
    const byRun = new Map<string, Artifact[]>();
    for (const a of arts) {
      const list = byRun.get(a.run_id) ?? [];
      list.push(this.toArtifact(a));
      byRun.set(a.run_id, list);
    }
    return rows.map((r) => {
      const nodes = json<TaskNode[]>(r.nodes, []);
      const done = json<string[]>(r.done_nodes, []);
      return {
        id: r.id,
        promptId: r.prompt_id ?? undefined,
        workflowId: r.workflow_id,
        appName: r.app_name ?? undefined,
        source: r.source === 'api' ? 'api' : 'ui',
        label: r.label,
        status: r.status as TaskStatus,
        submittedAt: r.submitted_at,
        startedAt: r.started_at ?? undefined,
        completedAt: r.completed_at ?? undefined,
        error: r.error ?? undefined,
        errorNode: r.error_node ?? undefined,
        meta: json<TaskMeta>(r.meta, {}),
        nodes,
        doneNodes: done,
        cachedNodes: json<string[]>(r.cached_nodes, []),
        nodesTotal: nodes.length,
        nodesDone: r.status === 'success' ? nodes.length : done.length,
        progress: r.status === 'success' ? 1 : 0,
        artifacts: byRun.get(r.id) ?? [],
      };
    });
  }

  runSnapshot(id: string): Workflow | null {
    const r = this.sql.prepare('SELECT snapshot FROM runs WHERE id = ?').get(id) as { snapshot: string } | undefined;
    return r ? json<Workflow | null>(r.snapshot, null) : null;
  }

  deleteRun(id: string): string[] {
    const paths = (this.sql.prepare('SELECT path FROM artifacts WHERE run_id = ?').all(id) as { path: string }[]).map((r) => r.path);
    this.sql.prepare('DELETE FROM runs WHERE id = ?').run(id); // artifacts cascade
    return paths;
  }

  // ─── artifacts ────────────────────────────────────────────────────────────
  private toArtifact(r: ArtifactRow): Artifact {
    return {
      id: r.id,
      runId: r.run_id,
      workflowId: r.workflow_id,
      kind: r.kind as MediaKind,
      url: artifactUrl(r.id),
      filename: r.filename,
      path: r.path,
      mime: r.mime,
      bytes: r.bytes,
      width: r.width ?? undefined,
      height: r.height ?? undefined,
      nodeId: r.node_id,
      meta: json<TaskMeta>(r.meta, {}),
      durationMs: r.duration_ms ?? undefined,
      starred: !!r.starred,
      createdAt: r.created_at,
    };
  }

  insertArtifact(a: Omit<Artifact, 'url'> & { source?: string }) {
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
  artifactSources(runId: string): Set<string> {
    const rows = this.sql.prepare('SELECT source FROM artifacts WHERE run_id = ?').all(runId) as { source: string | null }[];
    return new Set(rows.map((r) => r.source).filter((s): s is string => !!s));
  }

  artifact(id: string): Artifact | null {
    const r = this.sql.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
    return r ? this.toArtifact(r) : null;
  }

  artifactsOf(workflowId: string): Artifact[] {
    const rows = this.sql
      .prepare('SELECT * FROM artifacts WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(workflowId) as ArtifactRow[];
    return rows.map((r) => this.toArtifact(r));
  }

  setStarred(id: string, starred: boolean) {
    this.sql.prepare('UPDATE artifacts SET starred = ? WHERE id = ?').run(starred ? 1 : 0, id);
  }

  deleteArtifact(id: string) {
    this.sql.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
  }

  isEmpty(): boolean {
    const r = this.sql.prepare('SELECT (SELECT COUNT(*) FROM runs) + (SELECT COUNT(*) FROM workflows) AS n').get() as { n: number };
    return r.n === 0;
  }
}
