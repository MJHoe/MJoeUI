import { promises as fs } from 'node:fs';
import path from 'node:path';

const pad = (n: number) => String(n).padStart(2, '0');
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};
export const mimeOf = (file: string) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
export const isVideoFile = (file: string) => /\.(mp4|webm|mov|mkv)$/i.test(file);

/**
 * Artifact layout on disk:
 *
 *   {root}/{workflowId}/{YYYY-MM-DD}/{HHmmss}_{seed}[_n].{ext}
 *
 * One folder per workflow (the id never changes, even when the workflow is
 * renamed), a sub-folder per local day, and a file name that sorts in the
 * order things were made and carries the seed. ComfyUI's bytes are copied
 * untouched, so PNGs keep the graph ComfyUI embeds in them.
 */
export async function saveArtifact(
  root: string,
  opts: { workflowId: string | null; filename: string; data: Buffer; seed?: number; at: Date; index: number },
): Promise<string> {
  const { workflowId, filename, data, seed, at, index } = opts;
  const dir = path.join(root, workflowId ?? 'unsorted', localDay(at));
  await fs.mkdir(dir, { recursive: true });
  const ext = (path.extname(path.basename(filename)) || '.png').toLowerCase();
  let stem = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  if (seed != null) stem += `_${seed}`;
  if (index > 0) stem += `_${index + 1}`;
  for (let n = 0; ; n++) {
    const file = path.join(dir, `${stem}${n ? `-${n}` : ''}${ext}`);
    try {
      await fs.writeFile(file, data, { flag: 'wx' });
      return file;
    } catch (e: any) {
      if (e.code !== 'EEXIST' || n > 50) throw e;
    }
  }
}

/** Best-effort removal; also drops the day / workflow folders if they end up empty. */
export async function removeFiles(paths: string[], root: string) {
  let removed = 0;
  for (const p of paths) {
    try { await fs.unlink(p); removed++; } catch { /* already gone */ }
    let dir = path.dirname(p);
    for (let i = 0; i < 2 && dir.startsWith(root) && dir !== root; i++) {
      try { await fs.rmdir(dir); } catch { break; }
      dir = path.dirname(dir);
    }
  }
  return removed;
}

export const exists = (p: string) => fs.stat(p).then(() => true, () => false);
export const sizeOf = (p: string) => fs.stat(p).then((s) => s.size, () => 0);
