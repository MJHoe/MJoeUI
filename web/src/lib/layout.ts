import type { NodeInfo, ParamSlot, ParamType, Workflow } from '../types';
import {
  buildSections, fieldKey, isH3Workflow, isLink, listCandidates, mediaInputKind, promptRoles,
  type Field, type Section,
} from './workflow';

/**
 * Where every exposed input lives on the Use page:
 *   main → center column (references above the preview, everything else in
 *          the key-input card under it). These are also the API's inputs.
 *   side → left column.
 * When the user hasn't picked yet, `recommendSlots` reproduces the automatic
 * layout: hero prompt + reference media are key, the other primary fields go
 * left.
 */

const H3_TOKEN_TEST = /<(Picture|Subject)\s*\d+>/;

/** The one prompt the user actually came here to write. A standalone text node
 *  (CR Prompt Text, Text Multiline…) is where people type their idea; text
 *  typed straight into an encoder is often a fixed refine/upscale instruction.
 *  So: standalone source first, then a sampler's positive input, then longest.
 *  `allow` narrows the candidates (e.g. to the user's key inputs). */
export function pickHero(wf: Workflow, sections: Section[], allow?: (f: Field) => boolean): Field | null {
  const cands: Array<{ field: Field; source: boolean; positive: boolean; user: boolean }> = [];
  for (const g of sections.find((s) => s.id === 'prompt')?.groups ?? []) {
    const node = wf[g.nodeId];
    const source = !!node && !isLink(node.inputs.clip) && !/TextEncode/i.test(node.class_type);
    for (const f of g.fields) {
      if (f.kind !== 'prompt' || (allow && !allow(f))) continue;
      // without an explicit allow-list, negatives and templates never qualify;
      // with one, the user chose it as key, so it may — just ranked last
      const user = f.promptClass === 'user' && g.role !== 'negative';
      if (!allow && !user) continue;
      cands.push({ field: f, source, positive: g.role === 'positive', user });
    }
  }
  const len = (f: Field) => String(f.value).length;
  cands.sort((a, b) =>
    Number(b.user) - Number(a.user)
    || Number(b.source) - Number(a.source)
    || Number(b.positive) - Number(a.positive)
    || len(b.field) - len(a.field));
  return cands[0]?.field ?? null;
}

/** MiniMax H3 prompts reference numbered assets via `<Picture N>` /
 *  `<Subject N>`. The hero is the user prompt that carries those tokens,
 *  else the longest user prompt. */
export function pickH3Hero(sections: Section[], allow?: (f: Field) => boolean): Field | null {
  const prompts: Field[] = [];
  for (const g of sections.find((s) => s.id === 'prompt')?.groups ?? []) {
    for (const f of g.fields) {
      if (f.kind !== 'prompt' || (allow && !allow(f))) continue;
      if (!allow && f.promptClass !== 'user') continue;
      prompts.push(f);
    }
  }
  return prompts.find((f) => H3_TOKEN_TEST.test(String(f.value)))
    ?? [...prompts].sort((a, b) => String(b.value).length - String(a.value).length)[0]
    ?? null;
}

export function slotTypeOf(f: Field, className: string): ParamType {
  const media = mediaInputKind(className, f.name);
  if (media) return media;
  if (f.kind === 'bool') return 'boolean';
  if (f.kind === 'int' || f.kind === 'float' || f.kind === 'seed') return 'number';
  return 'string';
}

export const API_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A readable API name for an input: prompts → `prompt`, media → `image`,
 *  otherwise the input name with anything non-ASCII squeezed out. */
export function baseApiName(f: Field, type: ParamType, negative = false): string {
  // media first: offline, a long image filename can look like prompt text
  if (type === 'image' || type === 'video' || type === 'audio') return type;
  if (f.kind === 'prompt') return negative || /negative/i.test(f.name) ? 'negative_prompt' : 'prompt';
  const s = f.name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return !s ? 'param' : /^\d/.test(s) ? `p_${s}` : s;
}

/** Prompt nodes that feed a sampler's `negative` input, or are titled so. */
export function negativePromptNodes(wf: Workflow): Set<string> {
  const out = new Set<string>();
  for (const [id, role] of promptRoles(wf)) if (role === 'negative') out.add(id);
  for (const [id, node] of Object.entries(wf)) if (/negative|反向|负面/i.test(node._meta?.title ?? '')) out.add(id);
  return out;
}

/** First free name: `prompt`, `prompt_2`, `prompt_3`… */
export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** The automatic layout, as explicit slots. */
export function recommendSlots(wf: Workflow, infos: Record<string, NodeInfo | null>): ParamSlot[] {
  const { sections } = buildSections(wf, infos, {});
  const hero = isH3Workflow(wf) ? pickH3Hero(sections) : pickHero(wf, sections);
  const heroKey = hero ? fieldKey(hero.nodeId, hero.name) : null;
  const negative = negativePromptNodes(wf);
  const taken = new Set<string>();
  const out: ParamSlot[] = [];
  for (const node of listCandidates(wf, infos)) {
    for (const f of node.fields) {
      if (f.importance !== 'primary') continue;
      const key = fieldKey(f.nodeId, f.name);
      const type = slotTypeOf(f, node.className);
      const media = type === 'image' || type === 'video' || type === 'audio';
      const name = uniqueName(baseApiName(f, type, negative.has(f.nodeId)), taken);
      taken.add(name);
      out.push({ key, place: key === heroKey || media ? 'main' : 'side', name, type });
    }
  }
  return out;
}
