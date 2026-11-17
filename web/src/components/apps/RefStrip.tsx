import { useRef, useState } from 'react';
import { ImagePlus, LoaderCircle, Music, RotateCcw, Upload, Video } from 'lucide-react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { api } from '../../api';
import { useStore, usePatches } from '../../store';
import { mediaInputKind, mediaRoleLabel, type Field, type Section } from '../../lib/workflow';
import type { Workflow } from '../../types';
import { Tip } from '../ui';

export type RefSlot = {
  field: Field;
  kind: 'image' | 'video' | 'audio';
  label: string;
  /** `<Picture N>` index for H3 prompts; images only. */
  picture?: number;
};

export type PromptTarget = { nodeId: string; name: string; value: string; domId: string };

export function collectRefs(wf: Workflow, sections: Section[], numberPictures: boolean): RefSlot[] {
  const out: RefSlot[] = [];
  for (const g of sections.find((s) => s.id === 'media')?.groups ?? []) {
    for (const f of g.fields) {
      const kind = mediaInputKind(g.className, f.name);
      if (kind) out.push({ field: f, kind, label: mediaRoleLabel(wf, g.nodeId, kind) });
    }
  }
  const total = new Map<string, number>();
  for (const r of out) total.set(r.label, (total.get(r.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  let pic = 0;
  for (const r of out) {
    if ((total.get(r.label) ?? 0) > 1) {
      const n = (seen.get(r.label) ?? 0) + 1;
      seen.set(r.label, n);
      r.label = `${r.label} ${n}`;
    }
    if (numberPictures && r.kind === 'image') r.picture = ++pic;
  }
  return out;
}

/** References sit above the preview so you can see at a glance what a run
 *  was built from. On H3 apps each picture carries its `<Picture N>` number
 *  and clicking it drops that token into the prompt at the caret. */
export function RefStrip({ refs, target }: { refs: RefSlot[]; target?: PromptTarget | null }) {
  return (
    <section className="refs" aria-label="参考素材">
      <header className="refs__head">
        <span className="refs__title">参考</span>
        <span className="refs__count">{refs.length}</span>
        {target && refs.some((r) => r.picture) && (
          <span className="refs__hint">点图片插入 <code>&lt;Picture N&gt;</code></span>
        )}
      </header>
      <div className="refs__row">
        {refs.map((r) => (
          <RefTile key={`${r.field.nodeId}:${r.field.name}`} slot={r} target={target} />
        ))}
      </div>
    </section>
  );
}

function RefTile({ slot, target }: { slot: RefSlot; target?: PromptTarget | null }) {
  const setPatch = useStore((s) => s.setPatch);
  const resetPatch = useStore((s) => s.resetPatch);
  const patches = usePatches();
  const { field, kind } = slot;
  const modified = patches[field.nodeId]?.[field.name] !== undefined;
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [broken, setBroken] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const name = String(field.value ?? '');
  const hasAsset = !!name && broken !== name;
  const Icon = kind === 'image' ? ImagePlus : kind === 'video' ? Video : Music;
  const accept = { image: 'image/*', video: 'video/*', audio: 'audio/*' }[kind];
  const canInsert = !!(target && slot.picture && hasAsset);

  const upload = async (f?: File | null) => {
    if (!f) return;
    setBusy(true);
    try {
      const r = await api.uploadInput(f);
      setPatch(field.nodeId, field.name, r.name);
      setBroken(null);
      toast.success(`已更新${slot.label}`, { description: r.name });
    } catch (e: any) {
      toast.error('上传失败', { description: e.message });
    } finally {
      setBusy(false);
    }
  };

  const insertToken = () => {
    if (!target || !slot.picture) return;
    const token = `<Picture ${slot.picture}>`;
    const el = document.getElementById(target.domId) as HTMLTextAreaElement | null;
    const cur = target.value;
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    setPatch(target.nodeId, target.name, cur.slice(0, start) + token + cur.slice(end));
    if (el) {
      queueMicrotask(() => {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      });
    }
  };

  const tip = canInsert ? `插入 <Picture ${slot.picture}>` : hasAsset ? `换一个${slot.label}` : `上传${slot.label}`;

  return (
    <div className={clsx('ref', `ref--${kind}`, hasAsset && 'has-asset', over && 'is-over', modified && 'is-modified')}>
      <Tip label={tip}>
        <button
          type="button"
          className="ref__body"
          onClick={canInsert ? insertToken : () => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); void upload(e.dataTransfer.files[0]); }}
          aria-label={tip}
        >
          {hasAsset && kind === 'image' && <img src={api.inputUrl(name)} alt="" onError={() => setBroken(name)} />}
          {hasAsset && kind === 'video' && (
            <video src={`${api.inputUrl(name)}#t=0.1`} muted playsInline preload="metadata" onError={() => setBroken(name)} />
          )}
          {hasAsset && kind === 'audio' && (
            <span className="ref__audio"><Music size={18} strokeWidth={1.8} /><span>{name}</span></span>
          )}
          {!hasAsset && <span className="ref__ph"><Icon size={18} strokeWidth={1.8} /></span>}
          {slot.picture != null && <span className="ref__num" aria-hidden>{slot.picture}</span>}
          {kind === 'video' && hasAsset && <span className="ref__kind" aria-hidden><Video size={10} /></span>}
          {busy && <span className="ref__busy"><LoaderCircle size={16} className="spin" /></span>}
        </button>
      </Tip>
      <div className="ref__foot">
        <span className="ref__label" title={name || slot.label}>{slot.label}</span>
        {canInsert && (
          <Tip label="换一个">
            <button type="button" className="ref__act" onClick={() => input.current?.click()} aria-label={`换一个${slot.label}`}>
              <Upload size={10} />
            </button>
          </Tip>
        )}
        {modified && (
          <Tip label="还原">
            <button type="button" className="ref__act ref__act--reset" onClick={() => resetPatch(field.nodeId, field.name)} aria-label="还原">
              <RotateCcw size={10} />
            </button>
          </Tip>
        )}
      </div>
      <input ref={input} type="file" hidden accept={accept} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
  );
}
