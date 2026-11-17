import { promises as fs } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import type { Db } from './db.js';
import { newArtifactId } from './db.js';
import { asWorkflow, inspectWorkflow, structureKey } from './inspect.js';
import { deriveMeta, topoNodes } from './tracker.js';
import { isVideoFile, mimeOf, sizeOf } from './storage.js';
import type { Task, TaskMeta, Workflow } from './types.js';
import { CATEGORY_LABEL } from './types.js';

type LegacyTask = {
  id: string;
  label: string;
  status: Task['status'];
  submittedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  errorNode?: string;
  meta?: TaskMeta;
  workflowPath?: string;
  outputs?: Array<{ filename: string; localPath: string; nodeId: string; kind?: 'image' | 'video'; width?: number; height?: number }>;
};

/**
 * One-time import of the pre-SQLite `tasks.json` history. Runs that share a
 * graph shape become one workflow ("…（导入）"), so earlier results show up in
 * the library under the workflow that made them. Files stay where they are.
 */
export async function importLegacy(db: Db, dataDir: string) {
  const file = path.join(dataDir, 'tasks.json');
  let legacy: Record<string, LegacyTask>;
  try {
    legacy = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return;
  }
  if (!db.isEmpty()) return;

  const runs = Object.values(legacy).sort((a, b) => a.submittedAt - b.submittedAt);
  const groups = new Map<string, string>(); // structure key → workflow id
  let workflows = 0, artifacts = 0;

  for (const t of runs) {
    let snapshot: Workflow | null = null;
    if (t.workflowPath) {
      try {
        const parsed = asWorkflow(JSON.parse(await fs.readFile(path.join(dataDir, t.workflowPath), 'utf8')));
        if (typeof parsed !== 'string') snapshot = parsed;
      } catch { /* snapshot lost */ }
    }

    let workflowId: string | null = null;
    if (snapshot) {
      const key = structureKey(snapshot);
      workflowId = groups.get(key) ?? null;
      if (!workflowId) {
        const info = inspectWorkflow(snapshot);
        const name = `${[info.baseModel, CATEGORY_LABEL[info.category]].filter(Boolean).join(' ')}（导入）`;
        workflowId = db.insertWorkflow({
          name,
          category: info.category,
          baseModel: info.baseModel,
          modelFile: info.modelFile,
          note: '从旧版历史记录自动整理出来的工作流。',
          json: snapshot,
          hash: info.hash,
          createdAt: t.submittedAt,
        });
        groups.set(key, workflowId);
        workflows++;
      }
    }

    const nodes = snapshot ? topoNodes(snapshot) : [];
    const meta = t.meta ?? (snapshot ? deriveMeta(snapshot) : {});
    const status = t.status === 'pending' || t.status === 'running' ? 'error' : t.status;
    const task: Task = {
      id: t.id,
      promptId: t.id,   // old-format ids were ComfyUI prompt_ids
      workflowId,
      label: t.label,
      status,
      submittedAt: t.submittedAt,
      startedAt: t.startedAt,
      completedAt: t.completedAt ?? t.submittedAt,
      error: status === 'error' && !t.error ? '升级时这个任务还没有完成' : t.error,
      errorNode: t.errorNode,
      meta,
      nodes,
      doneNodes: status === 'success' ? nodes.map((n) => n.id) : [],
      cachedNodes: [],
      nodesTotal: nodes.length,
      nodesDone: 0,
      progress: 0,
      artifacts: [],
    };
    db.insertRun(task, snapshot ?? {});

    for (const o of t.outputs ?? []) {
      db.insertArtifact({
        id: newArtifactId(),
        runId: t.id,
        workflowId,
        kind: o.kind ?? (isVideoFile(o.filename) ? 'video' : 'image'),
        path: o.localPath,
        filename: path.basename(o.localPath),
        source: o.filename,
        mime: mimeOf(o.localPath),
        bytes: await sizeOf(o.localPath),
        width: o.width ?? meta.width,
        height: o.height ?? meta.height,
        nodeId: o.nodeId,
        meta,
        durationMs: t.startedAt && t.completedAt ? t.completedAt - t.startedAt : undefined,
        starred: false,
        createdAt: t.completedAt ?? t.submittedAt,
      });
      artifacts++;
    }
  }

  await fs.rename(file, path.join(dataDir, 'tasks.legacy.json'));
  console.log(pc.dim(`  ↳ 已从 tasks.json 导入 ${runs.length} 次运行、${workflows} 个工作流、${artifacts} 个制品`));
}
