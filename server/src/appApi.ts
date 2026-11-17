import path from 'node:path';
import type { ParamSlot, ParamType, Patches, Primitive, Workflow, WorkflowFull } from './types.js';

/**
 * Turning an app into an API: the caller sends only the key inputs (slots the
 * user put in the 「下方 · 关键」 position), and everything else comes from the
 * imported JSON plus the edits saved on the Use page.
 */

const SLOT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TYPES: ParamType[] = ['string', 'number', 'boolean', 'image', 'video', 'audio'];
const SEED_NAMES = new Set(['seed', 'noise_seed']);

export class BadRequest extends Error {}

const isPrimitive = (v: unknown): v is Primitive =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

/** Validate `exposed` from a request body. null clears it. Bare strings (the
 *  old "nodeId:input" format) are accepted as left-column slots. */
export function parseSlots(v: unknown): ParamSlot[] | null {
  if (v === null) return null;
  if (!Array.isArray(v) || v.length > 5000) throw new BadRequest('参数选择格式不对');
  const out: ParamSlot[] = [];
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const raw of v) {
    const s: ParamSlot = typeof raw === 'string'
      ? { key: raw, place: 'side', name: raw.slice(raw.indexOf(':') + 1), type: 'string' }
      : raw;
    if (!s || typeof s.key !== 'string' || !s.key.includes(':') || s.key.length > 300) throw new BadRequest('参数选择格式不对');
    if (s.place !== 'main' && s.place !== 'side') throw new BadRequest(`参数 ${s.key} 的位置不对`);
    if (!TYPES.includes(s.type)) throw new BadRequest(`参数 ${s.key} 的类型不对`);
    if (keys.has(s.key)) continue;
    keys.add(s.key);
    if (s.place === 'main') {
      if (typeof s.name !== 'string' || !SLOT_NAME_RE.test(s.name)) {
        throw new BadRequest(`关键参数的 API 名「${s.name}」不合法：只能用字母、数字、下划线，且不以数字开头`);
      }
      if (names.has(s.name)) throw new BadRequest(`关键参数的 API 名「${s.name}」重复了`);
      names.add(s.name);
    }
    out.push({ key: s.key, place: s.place, name: String(s.name ?? ''), type: s.type });
  }
  return out;
}

/** Validate saved form edits: node → input → primitive. */
export function parseParams(v: unknown): Patches {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BadRequest('参数格式不对');
  const out: Patches = {};
  for (const [nodeId, byInput] of Object.entries(v as Record<string, unknown>)) {
    if (!byInput || typeof byInput !== 'object' || Array.isArray(byInput)) throw new BadRequest(`节点 ${nodeId} 的参数格式不对`);
    for (const [name, val] of Object.entries(byInput as Record<string, unknown>)) {
      if (!isPrimitive(val)) throw new BadRequest(`${nodeId}:${name} 的值必须是文字、数字或开关`);
      (out[nodeId] ??= {})[name] = val;
    }
  }
  return out;
}

export function applyPatches(wf: Workflow, patches: Patches): Workflow {
  const out: Workflow = structuredClone(wf);
  for (const [nodeId, byInput] of Object.entries(patches)) {
    if (!out[nodeId]) continue;
    for (const [name, v] of Object.entries(byInput)) out[nodeId].inputs[name] = v;
  }
  return out;
}

/** The app's effective graph: imported JSON + saved edits. */
export const effectiveGraph = (w: WorkflowFull): Workflow => applyPatches(w.json, w.params);

const splitKey = (key: string) => {
  const i = key.indexOf(':');
  return { nodeId: key.slice(0, i), input: key.slice(i + 1) };
};

export const keySlots = (w: WorkflowFull) => (w.exposed ?? []).filter((s) => s.place === 'main');

/** What GET /api/apps/:id returns — enough for a caller to build a request. */
export function describeApp(w: WorkflowFull, origin: string) {
  const graph = effectiveGraph(w);
  const inputs = keySlots(w).map((s) => {
    const { nodeId, input } = splitKey(s.key);
    const node = graph[nodeId];
    return {
      name: s.name,
      type: s.type,
      node: nodeId,
      input,
      title: node?._meta?.title ?? node?.class_type ?? null,
      default: node?.inputs[input] ?? null,
    };
  });
  const example: Record<string, unknown> = {};
  for (const i of inputs) {
    example[i.name] = ['image', 'video', 'audio'].includes(i.type)
      ? `data:${i.type}/…;base64,… 或 https://… 或 ComfyUI 输入目录里的文件名`
      : i.default;
  }
  return {
    id: w.id,
    name: w.name,
    endpoint: `${origin}/api/apps/${w.id}/run`,
    configured: w.exposed !== null,
    inputs,
    example: { inputs: example, wait: true },
  };
}

// ─── media ──────────────────────────────────────────────────────────────────
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
};
const MAX_MEDIA = 512 * 1024 * 1024;

export type Uploader = (data: Buffer, filename: string, mime: string) => Promise<string>;

/** A media input can be a data URL, an http(s) URL, or the name of a file
 *  already in ComfyUI's input folder. The first two get uploaded. */
async function resolveMedia(v: string, slot: ParamSlot, upload: Uploader): Promise<string> {
  const stamp = `api_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const data = /^data:([\w.+/-]+)?(;[\w=-]+)*;base64,(.*)$/s.exec(v);
  if (data) {
    const mime = data[1] || 'application/octet-stream';
    const buf = Buffer.from(data[3], 'base64');
    if (!buf.length) throw new BadRequest(`${slot.name}：base64 内容是空的`);
    return upload(buf, `${stamp}.${EXT_BY_MIME[mime] ?? slot.type}`, mime);
  }
  if (/^https?:\/\//i.test(v)) {
    let r: Response;
    try { r = await fetch(v); } catch (e: any) { throw new BadRequest(`${slot.name}：下载失败 ${e.message}`); }
    if (!r.ok) throw new BadRequest(`${slot.name}：下载失败（HTTP ${r.status}）`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > MAX_MEDIA) throw new BadRequest(`${slot.name}：文件为空或太大`);
    const mime = (r.headers.get('content-type') ?? '').split(';')[0].trim();
    const base = path.basename(new URL(v).pathname) || stamp;
    const name = /\.\w{2,5}$/.test(base) ? `${stamp}_${base}` : `${stamp}.${EXT_BY_MIME[mime] ?? slot.type}`;
    return upload(buf, name, mime || 'application/octet-stream');
  }
  if (!v.trim()) throw new BadRequest(`${slot.name}：不能为空`);
  return v;
}

function coerce(v: unknown, slot: ParamSlot): Primitive {
  switch (slot.type) {
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new BadRequest(`${slot.name} 需要数字`);
      return n;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      throw new BadRequest(`${slot.name} 需要 true / false`);
    default:
      if (!isPrimitive(v)) throw new BadRequest(`${slot.name} 需要文字`);
      return String(v);
  }
}

/** Build the graph to submit for an API call. */
export async function buildApiGraph(
  w: WorkflowFull,
  inputs: unknown,
  opts: { randomSeed: boolean },
  upload: Uploader,
): Promise<Workflow> {
  if (inputs != null && (typeof inputs !== 'object' || Array.isArray(inputs))) {
    throw new BadRequest('inputs 需要是一个对象：{ "参数名": 值 }');
  }
  const slots = keySlots(w);
  const byName = new Map(slots.map((s) => [s.name, s]));
  const graph = effectiveGraph(w);
  const touched = new Set<string>();
  for (const [name, raw] of Object.entries((inputs ?? {}) as Record<string, unknown>)) {
    const slot = byName.get(name);
    if (!slot) {
      const known = slots.map((s) => s.name).join(', ') || '（无）';
      throw new BadRequest(
        w.exposed === null
          ? `这个应用还没有设置关键参数。在应用里点「选择参数」，把要从 API 传的参数放到「下方 · 关键」后保存。`
          : `未知参数「${name}」。可用的关键参数：${known}`,
      );
    }
    const { nodeId, input } = splitKey(slot.key);
    if (!graph[nodeId]) throw new BadRequest(`参数 ${name} 指向的节点 ${nodeId} 已不在工作流里`);
    const value = ['image', 'video', 'audio'].includes(slot.type)
      ? await resolveMedia(String(raw ?? ''), slot, upload)
      : coerce(raw, slot);
    graph[nodeId].inputs[input] = value;
    touched.add(slot.key);
  }
  if (opts.randomSeed) {
    for (const [nodeId, node] of Object.entries(graph)) {
      for (const [name, v] of Object.entries(node.inputs)) {
        if (SEED_NAMES.has(name) && typeof v === 'number' && !touched.has(`${nodeId}:${name}`)) {
          node.inputs[name] = Math.floor(Math.random() * 2 ** 50);
        }
      }
    }
  }
  return graph;
}
