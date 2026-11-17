import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, LoaderCircle, PanelLeft, PanelBottom, Search, Sparkles, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { api } from '../api';
import { useStore } from '../store';
import { useObjectInfo } from '../lib/useObjectInfo';
import { fieldKey, listCandidates, mediaInputKind, type CandidateNode, type Field } from '../lib/workflow';
import { API_NAME_RE, baseApiName, negativePromptNodes, recommendSlots, slotTypeOf, uniqueName } from '../lib/layout';
import type { ParamPlace, ParamSlot, Patches, Workflow } from '../types';
import { Button, JellyDots, Modal } from './ui';

// ─── state ──────────────────────────────────────────────────────────────────
type SlotMap = Map<string, ParamSlot>;

/**
 * Selection state for the parameter picker. Until the user touches anything
 * the selection follows `initial` (the app's saved layout) or, failing that,
 * the automatic recommendation — which can still change while ComfyUI's
 * object_info loads, so it isn't frozen too early.
 */
export function usePickState(wf: Workflow | null, initial: ParamSlot[] | null) {
  const connected = useStore((s) => s.connected);
  const infos = useObjectInfo(wf, connected);
  const candidates = useMemo(() => (wf ? listCandidates(wf, infos) : []), [wf, infos]);
  const byKey = useMemo(() => {
    const m = new Map<string, { field: Field; className: string }>();
    for (const n of candidates) for (const f of n.fields) m.set(fieldKey(f.nodeId, f.name), { field: f, className: n.className });
    return m;
  }, [candidates]);
  const recommended: SlotMap = useMemo(
    () => new Map((wf ? recommendSlots(wf, infos) : []).map((s) => [s.key, s])),
    [wf, infos],
  );
  const negative = useMemo(() => (wf ? negativePromptNodes(wf) : new Set<string>()), [wf]);
  const [picked, setPicked] = useState<SlotMap | null>(null);
  useEffect(() => { setPicked(null); }, [wf]);

  // a saved layout can name inputs the JSON no longer has — ignore those
  const selected: SlotMap = picked
    ?? (initial ? new Map(initial.filter((s) => byKey.has(s.key)).map((s) => [s.key, s])) : recommended);

  const update = (fn: (m: SlotMap) => void) => {
    const next = new Map(selected);
    fn(next);
    setPicked(next);
  };

  const makeSlot = (key: string, m: SlotMap): ParamSlot | null => {
    const hit = byKey.get(key);
    if (!hit) return null;
    const rec = recommended.get(key);
    const type = slotTypeOf(hit.field, hit.className);
    const taken = new Set([...m.values()].map((s) => s.name));
    return { key, place: rec?.place ?? 'side', type, name: uniqueName(rec?.name ?? baseApiName(hit.field, type, negative.has(hit.field.nodeId)), taken) };
  };

  const toggle = (keys: string[], on: boolean) => update((m) => {
    for (const k of keys) {
      if (!on) m.delete(k);
      else if (!m.has(k)) { const s = makeSlot(k, m); if (s) m.set(k, s); }
    }
  });

  const setPlace = (key: string, place: ParamPlace) => update((m) => {
    const s = m.get(key) ?? makeSlot(key, m);
    if (!s) return;
    let name = s.name;
    if (place === 'main') {
      const others = new Set([...m.values()].filter((o) => o.key !== key && o.place === 'main').map((o) => o.name));
      if (others.has(name) || !API_NAME_RE.test(name)) name = uniqueName(API_NAME_RE.test(name) ? name : 'param', others);
    }
    m.set(key, { ...s, place, name });
  });

  const setName = (key: string, name: string) => update((m) => {
    const s = m.get(key);
    if (s) m.set(key, { ...s, name });
  });

  /** API-name problems on key inputs, keyed by slot key. */
  const errors = useMemo(() => {
    const out = new Map<string, string>();
    const seen = new Map<string, string>();
    for (const s of selected.values()) {
      if (s.place !== 'main') continue;
      if (!API_NAME_RE.test(s.name)) out.set(s.key, '只能用字母、数字、下划线，不以数字开头');
      else if (seen.has(s.name)) { out.set(s.key, '和别的关键参数重名'); out.set(seen.get(s.name)!, '和别的关键参数重名'); }
      else seen.set(s.name, s.key);
    }
    return out;
  }, [selected]);

  /** Selected slots in graph order. */
  const toList = (): ParamSlot[] => [...byKey.keys()].flatMap((k) => (selected.has(k) ? [selected.get(k)!] : []));

  const counts = { main: 0, side: 0 };
  for (const s of selected.values()) counts[s.place]++;

  return {
    candidates, recommended, selected, counts, errors,
    toggle, setPlace, setName,
    reset: (to: 'recommended' | 'none') => setPicked(to === 'none' ? new Map() : new Map(recommended)),
    clear: () => setPicked(null),
    toList,
  };
}

export type PickState = ReturnType<typeof usePickState>;

// ─── list ───────────────────────────────────────────────────────────────────
const KIND_LABEL: Record<Field['kind'], string> = {
  prompt: '提示词', text: '文本', int: '整数', float: '小数', seed: '种子', combo: '选项', bool: '开关',
};
const MEDIA_LABEL = { image: '图片', video: '视频', audio: '音频' } as const;

function preview(v: Field['value']): string {
  if (typeof v === 'boolean') return v ? '开' : '关';
  const s = String(v).replace(/\s*\n\s*/g, ' ⏎ ').trim();
  return s.length > 90 ? `${s.slice(0, 90)}…` : s || '（空）';
}

function matches(n: CandidateNode, f: Field, q: string) {
  return [n.title, n.className, f.name, String(f.value)].some((s) => s.toLowerCase().includes(q));
}

const sameSlots = (a: SlotMap, b: SlotMap) =>
  a.size === b.size && [...a.values()].every((s) => b.get(s.key)?.place === s.place);

/** Every literal input in the workflow, grouped by node. Each one can be
 *  hidden, shown on the left, or made a key input (center column, under the
 *  preview — and the only thing the app's API takes). */
export function ParamPicker({ pick }: { pick: PickState }) {
  const { candidates, recommended, selected, counts } = pick;
  const [query, setQuery] = useState('');
  const [onlyPicked, setOnlyPicked] = useState(false);
  const [showPlumbing, setShowPlumbing] = useState(false);
  const q = query.trim().toLowerCase();

  const total = candidates.reduce((n, c) => n + c.fields.length, 0);
  const visible = useMemo(() => {
    const filtered = candidates
      .map((n) => ({
        ...n,
        fields: n.fields.filter((f) =>
          (!q || matches(n, f, q)) && (!onlyPicked || selected.has(fieldKey(f.nodeId, f.name)))),
      }))
      .filter((n) => n.fields.length > 0);
    const hasRec = (n: CandidateNode) => n.fields.some((f) => recommended.has(fieldKey(f.nodeId, f.name)));
    const main = filtered.filter((n) => !n.plumbing);
    return {
      main: [...main.filter(hasRec), ...main.filter((n) => !hasRec(n))],
      plumbing: filtered.filter((n) => n.plumbing),
    };
  }, [candidates, q, onlyPicked, selected, recommended]);

  const plumbingOpen = showPlumbing || !!q || onlyPicked;

  return (
    <div className="pp">
      <div className="pp-bar">
        <label className="pp-search">
          <Search size={13} aria-hidden />
          <input
            className="pp-search__input"
            value={query}
            placeholder="搜节点、参数名或当前值"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && <button type="button" className="pp-search__clear" aria-label="清空搜索" onClick={() => setQuery('')}><X size={12} /></button>}
        </label>
        <button type="button" className={clsx('cat-pill', onlyPicked && 'is-on')} aria-pressed={onlyPicked} onClick={() => setOnlyPicked(!onlyPicked)}>
          只看已选<span>{selected.size}</span>
        </button>
        <span className="field__spacer" />
        <button type="button" className="link-btn" disabled={sameSlots(selected, recommended)} onClick={() => pick.reset('recommended')}>
          <Sparkles size={11} />恢复推荐
        </button>
        <button type="button" className="link-btn" disabled={!selected.size} onClick={() => pick.reset('none')}>全部取消</button>
      </div>
      <div className="pp-legend">
        <span>共识别出 <b>{total}</b> 个参数，勾选的会显示在使用页：</span>
        <span className="pp-legend__item"><PanelLeft size={12} />左侧 <b>{counts.side}</b></span>
        <span className="pp-legend__item pp-legend__item--main"><PanelBottom size={12} />下方 · 关键 <b>{counts.main}</b></span>
        <span className="pp-legend__note">关键参数显示在预览下面，也是 API 调用时要传的参数。没勾的沿用默认值。</span>
      </div>

      {visible.main.map((n) => <NodeBlock key={n.nodeId} node={n} pick={pick} />)}

      {visible.plumbing.length > 0 && (
        <div className="pp-more">
          <button type="button" className="pp-more__head" aria-expanded={plumbingOpen} onClick={() => setShowPlumbing(!showPlumbing)}>
            <ChevronDown size={13} className={clsx('pp-more__chev', plumbingOpen && 'is-open')} />
            另外 {visible.plumbing.length} 个节点：保存、预览、备注之类，一般不用改
          </button>
          {plumbingOpen && visible.plumbing.map((n) => <NodeBlock key={n.nodeId} node={n} pick={pick} />)}
        </div>
      )}

      {!visible.main.length && !visible.plumbing.length && (
        <p className="pp-empty">{q ? `没有匹配「${query}」的参数` : onlyPicked ? '还没有勾选任何参数' : '这个工作流没有可以直接填的参数'}</p>
      )}
    </div>
  );
}

function NodeBlock({ node, pick }: { node: CandidateNode; pick: PickState }) {
  const { selected, recommended, errors } = pick;
  const keys = node.fields.map((f) => fieldKey(f.nodeId, f.name));
  const on = keys.filter((k) => selected.has(k)).length;
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { if (box.current) box.current.indeterminate = on > 0 && on < keys.length; }, [on, keys.length]);

  return (
    <section className={clsx('pp-node', on > 0 && 'has-on')}>
      <label className="pp-node__head">
        <input ref={box} type="checkbox" className="pp-check" checked={on === keys.length} onChange={(e) => pick.toggle(keys, e.target.checked)} />
        <span className="pp-node__title">{node.title}</span>
        {node.title !== node.className && <span className="pp-node__class">{node.className}</span>}
        <span className="field__spacer" />
        <span className="pp-node__count">{on}/{keys.length}</span>
        <span className="pp-node__id">#{node.nodeId}</span>
      </label>
      <div className="pp-node__rows">
        {node.fields.map((f) => {
          const k = fieldKey(f.nodeId, f.name);
          const media = mediaInputKind(node.className, f.name);
          const slot = selected.get(k);
          const err = errors.get(k);
          return (
            <div key={f.name} className={clsx('pp-row', slot && `is-${slot.place}`)}>
              <label className="pp-row__main">
                <input type="checkbox" className="pp-check" checked={!!slot} onChange={(e) => pick.toggle([k], e.target.checked)} />
                <span className="pp-row__name">{f.name}</span>
                <span className={clsx('pp-tag', media && 'pp-tag--media')}>{media ? MEDIA_LABEL[media] : KIND_LABEL[f.kind]}</span>
                {recommended.has(k) && <span className="pp-tag pp-tag--rec">推荐</span>}
                <span className="pp-row__value" title={String(f.value)}>{preview(f.value)}</span>
              </label>
              <div className="pp-place" role="radiogroup" aria-label={`${f.name} 显示位置`}>
                {(['side', 'main'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={slot?.place === p}
                    className={clsx('pp-place__opt', `pp-place__opt--${p}`, slot?.place === p && 'is-on')}
                    onClick={() => pick.setPlace(k, p)}
                    title={p === 'side' ? '显示在左侧' : '作为关键输入，显示在预览下方；API 调用时传这个'}
                  >
                    {p === 'side' ? <><PanelLeft size={11} />左侧</> : <><PanelBottom size={11} />下方 · 关键</>}
                  </button>
                ))}
              </div>
              {slot?.place === 'main' && (
                <label className={clsx('pp-api', err && 'has-error')}>
                  <span className="pp-api__label">API 参数名</span>
                  <input
                    className="pp-api__input"
                    value={slot.name}
                    spellCheck={false}
                    maxLength={64}
                    onChange={(e) => pick.setName(k, e.target.value.trim())}
                    aria-invalid={!!err}
                  />
                  {err && <span className="pp-api__err">{err}</span>}
                </label>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function PickFootCount({ pick }: { pick: PickState }) {
  return (
    <span className="pp-foot-count">
      左侧 <b>{pick.counts.side}</b> · 关键 <b>{pick.counts.main}</b>
      {pick.errors.size > 0 && <span className="pp-foot-count__err"> · API 参数名有 {pick.errors.size} 处要改</span>}
    </span>
  );
}

// ─── dialog for an app that's already in the library ───────────────────────
export function ParamPickerDialog({ workflowId, open, onOpenChange }: {
  workflowId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const w = useStore((s) => s.workflows[workflowId]);
  const graph = useStore((s) => s.graphs[workflowId]?.json ?? null);
  const ensureGraph = useStore((s) => s.ensureGraph);
  const putWorkflow = useStore((s) => s.putWorkflow);
  const pick = usePickState(open ? graph : null, w?.exposed ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    pick.clear();
    ensureGraph(workflowId).catch((e) => setError(e.message));
  }, [open, workflowId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true);
    try {
      const exposed = pick.toList();
      const { workflow } = await api.updateWorkflow(workflowId, { exposed });
      putWorkflow(workflow);
      // Edits on inputs that just got hidden would keep applying invisibly — drop them.
      const s = useStore.getState();
      const draft = s.drafts[workflowId];
      if (draft) {
        const keep = new Set(exposed.map((x) => x.key));
        const next: Patches = {};
        for (const [nodeId, byInput] of Object.entries(draft)) {
          for (const [name, v] of Object.entries(byInput)) {
            if (keep.has(fieldKey(nodeId, name))) (next[nodeId] ??= {})[name] = v;
          }
        }
        s.setDraft(workflowId, next);
      }
      onOpenChange(false);
      const main = exposed.filter((x) => x.place === 'main').length;
      toast.success('参数已更新', { description: `左侧 ${exposed.length - main} 项，下方关键输入 ${main} 项。` });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="选择要显示的参数"
      sub={w ? <>「{w.name}」· 只改显示在哪，不改 JSON 里的默认值。</> : undefined}
      width={760}
    >
      <div className="modal__body">
        {graph ? <ParamPicker pick={pick} /> : <div className="page-center"><JellyDots /></div>}
        {error && <p className="form-error" role="alert"><TriangleAlert size={14} />{error}</p>}
      </div>
      <footer className="modal__foot">
        <PickFootCount pick={pick} />
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
        <Button variant="ink" onClick={save} disabled={busy || !graph || pick.errors.size > 0}>
          {busy ? <><LoaderCircle size={14} className="spin" />保存中</> : '保存'}
        </Button>
      </footer>
    </Modal>
  );
}
