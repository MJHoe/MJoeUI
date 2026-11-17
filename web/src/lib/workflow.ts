import type { InputSpec, NodeInfo, Patches, Primitive, Workflow } from '../types';

// ─── parsing ────────────────────────────────────────────────────────────────
export function parseWorkflow(raw: string): { ok: true; workflow: Workflow } | { ok: false; error: string } {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch (e: any) {
    return { ok: false, error: `JSON 无法解析：${e.message}` };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: '内容不是一个 JSON 对象。' };
  }
  if ('nodes' in obj && 'links' in obj) {
    return {
      ok: false,
      error: '这是界面格式的工作流。请在 ComfyUI 菜单里选「导出 (API)」，再把导出的文件拖进来。',
    };
  }
  // tolerate {"prompt": {...}} wrappers
  if (obj.prompt && typeof obj.prompt === 'object' && !obj.prompt.class_type) obj = obj.prompt;
  const ids = Object.keys(obj);
  if (ids.length === 0) return { ok: false, error: '工作流是空的。' };
  for (const id of ids) {
    const n = obj[id];
    if (!n || typeof n !== 'object' || typeof n.class_type !== 'string' || typeof n.inputs !== 'object') {
      return { ok: false, error: `节点 ${id} 缺少 class_type 或 inputs，不是 API 格式。` };
    }
  }
  return { ok: true, workflow: obj as Workflow };
}

export const isLink = (v: unknown): v is [string, number] =>
  Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number');

export function patchWorkflow(wf: Workflow, patches: Patches): Workflow {
  const out: Workflow = structuredClone(wf);
  for (const [nodeId, byInput] of Object.entries(patches)) {
    if (!out[nodeId]) continue;
    for (const [name, v] of Object.entries(byInput)) out[nodeId].inputs[name] = v;
  }
  return out;
}

export function countPatches(wf: Workflow | null, patches: Patches): number {
  if (!wf) return 0;
  let n = 0;
  for (const [nodeId, byInput] of Object.entries(patches)) {
    for (const [name, v] of Object.entries(byInput)) {
      if (wf[nodeId]?.inputs[name] !== v) n++;
    }
  }
  return n;
}

/**
 * Turn a run snapshot back into form edits on top of the stored workflow:
 * every primitive input that differs becomes a patch. Nodes that no longer
 * exist (the workflow JSON was edited since) are skipped.
 */
export function diffPatches(base: Workflow, snapshot: Workflow): { patches: Patches; skipped: number } {
  const patches: Patches = {};
  let skipped = 0;
  for (const [nodeId, node] of Object.entries(snapshot)) {
    const cur = base[nodeId];
    if (!cur || cur.class_type !== node.class_type) { skipped++; continue; }
    for (const [name, v] of Object.entries(node.inputs)) {
      if (v === null || typeof v === 'object') continue;
      if (!(name in cur.inputs) || cur.inputs[name] === v) continue;
      (patches[nodeId] ??= {})[name] = v as Primitive;
    }
  }
  return { patches, skipped };
}

/** LoadImage-style inputs that take a file from ComfyUI's input folder. */
export function mediaInputKind(className: string, name: string): 'image' | 'video' | 'audio' | null {
  // Named reference inputs are unambiguous by themselves — custom nodes like
  // ZealmanH3PickReferenceMedia expose `ref_image_0..N` and they're always
  // file handles, regardless of the class name.
  if (/^ref_image(_?\d+)?$/i.test(name) || /^(start|end|init|first|last)_image$/i.test(name)) return 'image';
  if (/^ref_video(_?\d+)?$/i.test(name)) return 'video';
  if (/^ref_audio(_?\d+)?$/i.test(name)) return 'audio';
  // ComfyUI community loader class names come with lots of prefixes / suffixes.
  if (/load.?image|pickreferencemedia/i.test(className) && /^(image|file|url|filename)$/i.test(name)) return 'image';
  if (/load.?video/i.test(className) && /^(video|file|url|filename)$/i.test(name)) return 'video';
  if (/load.?audio/i.test(className) && /^(audio|file|url)$/i.test(name)) return 'audio';
  return null;
}

// ─── "what to show by default" classifier ───────────────────────────────────
/** How prominent an input is in the UI. The default form only shows `primary`
 *  fields — the "payload" a user supplies each run; `advanced` holds the parts
 *  that define the workflow itself (model, sampler, steps, CFG, LoRA…) and
 *  stays collapsed until the user opens 「显示全部」; `hidden` is pure plumbing
 *  and never renders unless the user asks. */
export type Importance = 'primary' | 'advanced' | 'hidden';

/** Node classes we drop entirely. They either save files, carry a note, just
 *  reroute values, or are read-only text echoes — nothing a user should edit. */
const HIDDEN_CLASSES = new Set([
  'SaveImage', 'SaveImageWebsocket', 'PreviewImage', 'PreviewAnimation',
  'Note', 'MarkdownNote',
  'Reroute', 'Reroute (rgthree)', 'PrimitiveNode',
  'PrimitiveInt', 'PrimitiveFloat', 'PrimitiveString', 'PrimitiveStringMultiline', 'PrimitiveBoolean',
  // read-only display / echo nodes — their 'text_0' is whatever the graph
  // computed upstream, not user payload
  'ShowText|pysssss', 'Show Text 🐍', 'easy showAnything',
]);

/** Partial class-name matches for nodes we drop (covers community variants). */
const HIDDEN_CLASS_PATTERNS = [
  /^ShowText/i, /ShowAnything/i, /PreviewAny/i,
  /CleanupImage/i, /VRAMCleanup/i, /RAMCleanup/i,
  /BlockSwap/i, /TorchCompileSettings/i, /ReservedVRAMSetter/i,
];

/** Pure plumbing we never show by name — file naming, encoding details,
 *  implicit loaders, and explicit "system prompt" fields that are part of the
 *  workflow recipe rather than per-run payload. */
const HIDDEN_INPUTS = new Set([
  'filename_prefix',
  'control_after_generate',
  'add_noise', 'return_with_leftover_noise', 'disable_noise',
  'format', 'codec', 'crf', 'pix_fmt', 'pingpong',
  'save_output', 'save_metadata',
  'frame_load_cap', 'skip_first_frames', 'select_every_nth',
  'clip_name', 'clip_name1', 'clip_name2', 'clip_name3',
  'vae_name',
  // "system prompt" field on Zealman LLM nodes — literally the workflow's
  // template direction, not what the user supplies this run
  '系统提示词',
  // ShowText / showAnything output echoes (in case the node itself slipped past)
  'text_0',
  // JSON dial-rack config and math expressions — recipe knobs we fix
  'rack', 'expression',
]);

/** The payload a user actually supplies each run — the explicit allowlist for
 *  "primary" status. Anything not on this list (and not a prompt-kind text
 *  field, and not a media handle) is treated as part of the workflow's
 *  definition and tucked under 高级. */
const PRIMARY_INPUTS = new Set([
  // text — the heuristic in buildField also marks any multiline/long text as a
  // prompt field, so these entries just catch short named inputs
  'text', 'prompt', 'negative_prompt', 'positive_prompt',
  // geometry / shape — what a user picks per run
  'width', 'height',
  'length', 'frame_rate', 'fps',
  'batch_size',
  // randomness
  'seed', 'noise_seed',
]);

/** Inputs that are media handles themselves get hidden here because the
 *  field is rendered separately by MediaInput — we don't want a second row. */
function isMediaHandle(className: string, name: string) {
  return mediaInputKind(className, name) !== null;
}

export function importanceOf(className: string, inputName: string): Importance {
  if (HIDDEN_CLASSES.has(className)) return 'hidden';
  if (HIDDEN_CLASS_PATTERNS.some((re) => re.test(className))) return 'hidden';
  if (HIDDEN_INPUTS.has(inputName)) return 'hidden';
  if (PRIMARY_INPUTS.has(inputName)) return 'primary';
  return 'advanced';
}

/** Prompt-text sub-classification: `user` is what the person actually writes
 *  for this run (character description, scene prompt, lyrics); `system` is the
 *  boilerplate the workflow ships with (quality catch-phrases, the standard
 *  negative ban-list, "最佳质量" templates). The form renders system ones
 *  collapsed behind a "模板" row so the eye lands on the user ones first. */
export type PromptClass = 'user' | 'system';

const SYSTEM_PROMPT_NAME_PATTERNS = [
  /negative/i,
  /系统/,
  /template/i,
  /^style_?prompt$/i,
];

/** Node classes whose `prompt` field is a template the workflow author wrote
 *  for the LLM / analyser, not a per-run user payload. */
const SYSTEM_PROMPT_CLASS_PATTERNS = [
  /TextGenerate/i,
  /ZealmanLLM/i,
  /PromptEnhance|Enhancer/i,
  /CaptionGenerate/i,
];

/** Short preset quality phrases we collapse as "模板" even when the field
 *  isn't explicitly named negative/system. */
const QUALITY_TEMPLATE_RE = /^\s*(最佳质量|最高质量|high[- ]?quality|best quality|masterpiece|杰作)[\s,，。.]*$/i;

export function promptClassOf(name: string, value: string, className = ''): PromptClass {
  if (SYSTEM_PROMPT_NAME_PATTERNS.some((re) => re.test(name))) return 'system';
  if (SYSTEM_PROMPT_CLASS_PATTERNS.some((re) => re.test(className))) return 'system';
  if (QUALITY_TEMPLATE_RE.test(value)) return 'system';
  // ComfyUI's stock negative-prompt string starts with these words
  if (value.length > 40 && /色调艳丽|过曝|模糊不清|worst quality|low quality/i.test(value.slice(0, 80))) return 'system';
  return 'user';
}

export const SEED_NAMES = new Set(['seed', 'noise_seed']);

export function randomSeed(): number {
  // stays within Number.MAX_SAFE_INTEGER and ComfyUI's uint64 seed range
  return Math.floor(Math.random() * 2 ** 50);
}

/** Every seed-like input in the graph, for "randomize on every run". */
export function seedFields(wf: Workflow): Array<{ nodeId: string; name: string }> {
  const out: Array<{ nodeId: string; name: string }> = [];
  for (const [nodeId, node] of Object.entries(wf)) {
    for (const [name, v] of Object.entries(node.inputs)) {
      if (SEED_NAMES.has(name) && typeof v === 'number') out.push({ nodeId, name });
    }
  }
  return out;
}

// ─── fields ─────────────────────────────────────────────────────────────────
export type FieldKind = 'prompt' | 'text' | 'int' | 'float' | 'seed' | 'combo' | 'bool';

export type Field = {
  nodeId: string;
  name: string;
  value: Primitive;
  kind: FieldKind;
  importance: Importance;
  /** Only set when kind === 'prompt'. Decides whether the field renders
   *  expanded (user) or collapsed as a "模板" row (system). */
  promptClass?: PromptClass;
  min?: number;
  max?: number;
  step?: number;
  /** a narrower range that makes a usable slider; absent = no slider */
  slider?: { min: number; max: number; step: number };
  options?: string[];
  tooltip?: string;
};

const SOFT_RANGES: Record<string, { min: number; max: number; step: number }> = {
  steps: { min: 1, max: 80, step: 1 },
  cfg: { min: 0, max: 20, step: 0.1 },
  denoise: { min: 0, max: 1, step: 0.01 },
  batch_size: { min: 1, max: 8, step: 1 },
  strength: { min: 0, max: 2, step: 0.01 },
  strength_model: { min: -2, max: 2, step: 0.01 },
  strength_clip: { min: -2, max: 2, step: 0.01 },
  guidance: { min: 0, max: 10, step: 0.1 },
  shift: { min: 0, max: 10, step: 0.01 },
};

function specOf(info: NodeInfo | null | undefined, name: string): InputSpec | undefined {
  return info?.input?.required?.[name] ?? info?.input?.optional?.[name];
}

function buildField(nodeId: string, name: string, value: Primitive, className: string, info?: NodeInfo | null): Field {
  const spec = specOf(info, name);
  const type = spec?.[0];
  const opts = spec?.[1] ?? {};
  const f: Field = {
    nodeId, name, value, kind: 'text',
    importance: isMediaHandle(className, name) ? 'primary' : importanceOf(className, name),
    tooltip: opts.tooltip,
  };

  if (Array.isArray(type) || type === 'COMBO') {
    const options = (Array.isArray(type) ? type : opts.options ?? []).map(String);
    if (options.length) {
      f.kind = 'combo';
      f.options = options.includes(String(value)) ? options : [String(value), ...options];
      return f;
    }
  }
  if (typeof value === 'boolean' || type === 'BOOLEAN') { f.kind = 'bool'; return f; }
  if (typeof value === 'number') {
    if (SEED_NAMES.has(name) || opts.control_after_generate) { f.kind = 'seed'; return f; }
    const isFloat = type === 'FLOAT' || (type !== 'INT' && !Number.isInteger(value)) || ['cfg', 'denoise'].includes(name);
    f.kind = isFloat ? 'float' : 'int';
    f.min = typeof opts.min === 'number' ? opts.min : undefined;
    f.max = typeof opts.max === 'number' ? opts.max : undefined;
    f.step = typeof opts.step === 'number' ? opts.step : isFloat ? 0.01 : 1;
    if (!isFloat && f.step > 1 && f.step % 8 !== 0 && f.step % 1 === 0) f.step = 1; // legacy INT step*10 quirk
    const soft = SOFT_RANGES[name];
    if (soft) f.slider = soft;
    else if (f.min != null && f.max != null && f.max - f.min <= (isFloat ? 100 : 256)) {
      f.slider = { min: f.min, max: f.max, step: f.step };
    }
    return f;
  }
  const s = String(value);
  // A long string that is actually a model / file path shouldn't be promoted
  // to a user-facing prompt — it's a workflow recipe knob.
  const looksLikeFile =
    /_name$/.test(name) || name === 'lora' || name === 'ckpt' || name === 'unet' ||
    /\.(safetensors|ckpt|pth|pt|onnx|gguf|bin|json|yaml)$/i.test(s) ||
    (/^[^\n\r]+$/.test(s) && /\//.test(s) && s.length < 200); // path-like, single line
  // JSON config strings (dial racks, serialised node state) start with {/[.
  const looksLikeJson = /^\s*[[{]/.test(s) && /[\]}]\s*$/.test(s);
  // "16:9", "1024x768", "0.5" fed through a text node are switches, not prose.
  const looksLikeConstant = /^\s*\d+(\.\d+)?(\s*[:x×*/]\s*\d+(\.\d+)?)?\s*$/i.test(s);
  const isPromptText = !looksLikeConstant && (
    opts.multiline || name === 'text' || name.endsWith('prompt') ||
    (!looksLikeFile && !looksLikeJson && !!s.trim() && (s.length > 60 || s.includes('\n'))));
  if (isPromptText) {
    f.kind = 'prompt';
    f.promptClass = promptClassOf(name, s, className);
    // any text-looking input is user payload, even if the node class is exotic
    if (f.importance === 'advanced') f.importance = 'primary';
  }
  return f;
}

// ─── sections ───────────────────────────────────────────────────────────────
export const fieldKey = (nodeId: string, name: string) => `${nodeId}:${name}`;

const sortedNodeIds = (wf: Workflow) =>
  Object.keys(wf).sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b));

/** One node's worth of editable inputs, for the "pick what to show" list. */
export type CandidateNode = {
  nodeId: string;
  title: string;
  className: string;
  fields: Field[];
  /** Save / preview / note / reroute nodes — listed last, folded away. */
  plumbing: boolean;
};

/** Every literal (non-link) input in the graph, grouped by node in graph
 *  order. `importance === 'primary'` on a field marks what the automatic
 *  classifier would have shown — the picker uses it as the starting pick. */
export function listCandidates(wf: Workflow, infos: Record<string, NodeInfo | null>): CandidateNode[] {
  const out: CandidateNode[] = [];
  for (const nodeId of sortedNodeIds(wf)) {
    const node = wf[nodeId];
    const info = infos[node.class_type];
    const fields: Field[] = [];
    for (const [name, value] of Object.entries(node.inputs)) {
      if (value === null || typeof value === 'object') continue;
      fields.push(buildField(nodeId, name, value as Primitive, node.class_type, info));
    }
    if (!fields.length) continue;
    out.push({
      nodeId,
      title: node._meta?.title || info?.display_name || node.class_type,
      className: node.class_type,
      fields,
      plumbing: HIDDEN_CLASSES.has(node.class_type) || HIDDEN_CLASS_PATTERNS.some((re) => re.test(node.class_type)),
    });
  }
  return out;
}

export type SectionId = 'prompt' | 'media' | 'canvas' | 'seed' | 'other';

export const SECTION_LABEL: Record<SectionId, string> = {
  prompt: '提示词',
  media: '参考素材',
  canvas: '画幅 / 时长',
  seed: '种子',
  other: '其他',
};

const SECTION_ORDER: SectionId[] = ['prompt', 'media', 'canvas', 'seed', 'other'];

export type NodeGroup = {
  nodeId: string;
  title: string;
  className: string;
  role?: 'positive' | 'negative';
  fields: Field[];
  dims?: { width: Field; height: Field };
  /** A LoadImage/LoadVideo/LoadAudio node this group was derived from. */
  media?: 'image' | 'video' | 'audio';
};

export type Section = { id: SectionId; groups: NodeGroup[] };

/** Follow conditioning links upstream until a node with a text input. */
function traceTextNode(wf: Workflow, start: string, depth = 0): string | undefined {
  const node = wf[start];
  if (!node || depth > 6) return undefined;
  if (typeof node.inputs.text === 'string' || typeof node.inputs.prompt === 'string') return start;
  for (const key of ['conditioning', 'positive', 'conditioning_1', 'conditioning_to']) {
    const v = node.inputs[key];
    if (isLink(v)) {
      const hit = traceTextNode(wf, String(v[0]), depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

export function promptRoles(wf: Workflow): Map<string, 'positive' | 'negative'> {
  const roles = new Map<string, 'positive' | 'negative'>();
  for (const node of Object.values(wf)) {
    for (const role of ['positive', 'negative'] as const) {
      const v = node.inputs[role];
      if (!isLink(v)) continue;
      const hit = traceTextNode(wf, String(v[0]));
      if (hit && !roles.has(hit)) roles.set(hit, role);
    }
  }
  return roles;
}

/** Pick the section for a primary field. Unlike the old per-group picker this
 *  runs per-field, so a single node whose inputs span prompts + media + a size
 *  knob can spread its fields across the right sections instead of lumping. */
function sectionForField(f: Field, className: string, mediaKind?: 'image' | 'video' | 'audio'): SectionId {
  if (mediaKind && mediaInputKind(className, f.name)) return 'media';
  if (f.kind === 'prompt') return 'prompt';
  if (/^(width|height|length|frame_rate|fps|batch_size)$/i.test(f.name)) return 'canvas';
  if (f.kind === 'seed' || /^(seed|noise_seed)$/i.test(f.name)) return 'seed';
  return 'other';
}

export function buildSections(
  wf: Workflow,
  infos: Record<string, NodeInfo | null>,
  patches: Patches,
  /** The user's explicit pick ("nodeId:input"). When set it replaces the
   *  classifier: picked inputs show, everything else is locked. */
  exposed?: string[] | null,
): { sections: Section[]; lockedCount: number } {
  const roles = promptRoles(wf);
  const buckets = new Map<SectionId, NodeGroup[]>();
  const ids = sortedNodeIds(wf);
  const picked = exposed ? new Set(exposed) : null;
  let lockedCount = 0;

  const pushGroup = (sec: SectionId, g: NodeGroup) => {
    if (!buckets.has(sec)) buckets.set(sec, []);
    buckets.get(sec)!.push(g);
  };

  for (const nodeId of ids) {
    const node = wf[nodeId];
    const info = infos[node.class_type];
    const raw: Field[] = [];
    let mediaKind: 'image' | 'video' | 'audio' | undefined;
    for (const [name, value] of Object.entries(node.inputs)) {
      if (value === null || typeof value === 'object') continue;
      const v = (patches[nodeId]?.[name] ?? value) as Primitive;
      const f = buildField(nodeId, name, v, node.class_type, info);
      if (picked) f.importance = picked.has(fieldKey(nodeId, name)) ? 'primary' : 'hidden';
      const m = mediaInputKind(node.class_type, name);
      if (m) mediaKind = m;
      raw.push(f);
    }
    if (!raw.length) continue;

    // The workflow itself defines everything that isn't a primary user payload,
    // so hidden + advanced fields never render — they're part of the recipe.
    const primaryFields = raw.filter((f) => {
      if (f.importance === 'primary') return true;
      lockedCount++;
      return false;
    });
    if (!primaryFields.length) continue;

    const base: NodeGroup = {
      nodeId,
      title: node._meta?.title || info?.display_name || node.class_type,
      className: node.class_type,
      role: roles.get(nodeId),
      fields: primaryFields,
      media: mediaKind,
    };
    // Pull width/height out as a combined dims widget.
    const w = primaryFields.find((f) => f.name === 'width' && (f.kind === 'int' || f.kind === 'float'));
    const h = primaryFields.find((f) => f.name === 'height' && (f.kind === 'int' || f.kind === 'float'));
    if (w && h) {
      pushGroup('canvas', { ...base, fields: [], dims: { width: w, height: h }, media: undefined });
    }
    const working = w && h ? primaryFields.filter((f) => f !== w && f !== h) : primaryFields;

    // Bucket the rest per-field so one node can span prompt + media + canvas.
    const bySec = new Map<SectionId, Field[]>();
    for (const f of working) {
      const sec = sectionForField(f, node.class_type, mediaKind);
      (bySec.get(sec) ?? bySec.set(sec, []).get(sec)!).push(f);
    }
    for (const [sec, fields] of bySec) {
      pushGroup(sec, { ...base, fields, dims: undefined, media: sec === 'media' ? mediaKind : undefined });
    }
  }

  const prompts = buckets.get('prompt');
  // user-written prompts float to the top; system templates (negative prompt,
  // "最佳质量" quality preset, 系统提示词) sink to the bottom so the eye lands
  // on what to actually edit.
  prompts?.sort((a, b) => groupPromptRank(a) - groupPromptRank(b));

  const sections = SECTION_ORDER.filter((s) => buckets.has(s)).map((id) => ({ id, groups: buckets.get(id)! }));
  return { sections, lockedCount };
}

const rank = (r?: 'positive' | 'negative') => (r === 'positive' ? 0 : r === 'negative' ? 1 : 2);

function groupPromptRank(g: NodeGroup): number {
  const hasUser = g.fields.some((f) => f.kind === 'prompt' && f.promptClass === 'user');
  const hasSystem = g.fields.some((f) => f.kind === 'prompt' && f.promptClass === 'system');
  if (hasUser && !hasSystem) return 0;
  if (hasUser && hasSystem) return 1;
  // fall back to role so positives still beat negatives when neither is tagged
  return 2 + rank(g.role);
}

export function workflowSummary(wf: Workflow): { nodes: number; samplers: number; outputs: number } {
  const nodes = Object.values(wf);
  return {
    nodes: nodes.length,
    samplers: nodes.filter((n) => /sampler/i.test(n.class_type)).length,
    outputs: nodes.filter((n) => /save|preview/i.test(n.class_type)).length,
  };
}

// ─── MiniMax H3 — prompt tokens + workflow detection ───────────────────────
/**
 * H3 prompts use a structured format where a `<Picture N>` token refers to
 * the Nth uploaded reference image and a `<Subject N>` token refers to a
 * character defined in the `subject_definitions:` block. The relationship
 * between prompt text and reference slots is the central thing to express
 * in the UI, which is why these workflows get a dedicated workspace instead
 * of the generic form.
 */
/** What a reference input is *for*, read off the input it eventually feeds
 *  (LoadImage titles are all "加载图像", but downstream `start_image` vs
 *  `end_image` tells first frame from last). Breadth-first, nearest wins. */
const MEDIA_ROLES: Array<[RegExp, string]> = [
  [/^(start_image|first_frame|start_frame)$/i, '首帧'],
  [/^(end_image|last_frame|end_frame)$/i, '尾帧'],
];

export function mediaRoleLabel(wf: Workflow, nodeId: string, kind: 'image' | 'video' | 'audio'): string {
  let frontier = new Set([nodeId]);
  for (let depth = 0; depth < 4 && frontier.size; depth++) {
    const next = new Set<string>();
    for (const [id, n] of Object.entries(wf)) {
      for (const [k, v] of Object.entries(n.inputs)) {
        if (!isLink(v) || !frontier.has(String(v[0]))) continue;
        const hit = MEDIA_ROLES.find(([re]) => re.test(k));
        if (hit) return hit[1];
        next.add(id);
      }
    }
    frontier = next;
  }
  return kind === 'video' ? '参考视频' : kind === 'audio' ? '参考音频' : '参考图';
}

export const H3_TOKEN_RE = /<(Picture|Subject)\s*(\d+)>/g;

/** Node classes that identify a workflow as the MiniMax H3 family. */
const H3_CLASS_RE = /(ZealmanH3|MiniMaxH3|MinimaxH3|H3Sampler|H3Sigma|DenoMiniMaxH3)/i;

export function isH3Workflow(wf: Workflow): boolean {
  return Object.values(wf).some((n) => H3_CLASS_RE.test(n.class_type));
}

export type H3Token = {
  kind: 'picture' | 'subject';
  n: number;
  raw: string;
  start: number;
  end: number;
};

export function parsePromptTokens(text: string): H3Token[] {
  const out: H3Token[] = [];
  // need a fresh RegExp so we don't leak lastIndex across calls
  const re = new RegExp(H3_TOKEN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      kind: m[1].toLowerCase() === 'subject' ? 'subject' : 'picture',
      n: Number(m[2]),
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/**
 * Extract short labels for Subject N definitions. Scans the standard H3
 * `subject_definitions:` block for lines shaped like `<Subject 1> 是 ...` or
 * `<Subject 1> is ...` and pulls the first noun phrase after the copula as
 * the label. Returns a map from the subject number to its label.
 */
export function extractSubjectLabels(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const re = /<Subject\s*(\d+)>\s*(?:是|为|=|is|are)\s*(?:<Picture\s*\d+>\s*(?:中的|中|from|of|in)?\s*)?([^，。,.;\n]{1,30})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    const label = m[2].trim().replace(/<Picture\s*\d+>/gi, '').trim();
    if (label && !out.has(n)) out.set(n, label.slice(0, 20));
  }
  return out;
}
