import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeftRight, ChevronDown, ChevronUp, Dices, Film, ImagePlus, LoaderCircle, Minus, Music, Pencil, Plus, RotateCcw, Upload } from 'lucide-react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { api } from '../../api';
import { foldKey, useStore, usePatches } from '../../store';
import { randomSeed, type Field } from '../../lib/workflow';
import { fmtNumber } from '../../lib/format';
import type { Primitive } from '../../types';
import { IconButton, Select, Slider, Switch, Tip } from '../ui';

const LABELS: Record<string, string> = {
  text: '提示词',
  prompt: '提示词',
  negative_prompt: '反向提示词',
  seed: '种子',
  noise_seed: '种子',
  steps: '步数',
  cfg: 'CFG',
  sampler_name: '采样器',
  scheduler: '调度器',
  denoise: '降噪强度',
  width: '宽',
  height: '高',
  length: '帧数',
  frame_rate: '帧率',
  fps: '帧率',
  batch_size: '每次张数',
  ckpt_name: '模型',
  unet_name: '扩散模型',
  model_name: '模型',
  vae_name: 'VAE',
  clip_name: 'CLIP',
  clip_name1: 'CLIP 1',
  clip_name2: 'CLIP 2',
  lora_name: 'LoRA',
  strength_model: 'LoRA 强度',
  strength_clip: 'CLIP 强度',
  filename_prefix: '文件名前缀',
  add_noise: '加噪',
  guidance: '引导强度',
  shift: '偏移',
  upscale_method: '放大算法',
  scale_by: '放大倍数',
  image: '图片',
  video: '视频',
  audio: '音频',
  file: '文件',
  url: '链接',
  weight_dtype: '精度',
  start_at_step: '从第几步开始',
  end_at_step: '到第几步停',
};

export const labelFor = (name: string) => LABELS[name] ?? name;

function useFieldState(field: Field) {
  const setPatch = useStore((s) => s.setPatch);
  const resetPatch = useStore((s) => s.resetPatch);
  const patches = usePatches();
  return {
    modified: patches[field.nodeId]?.[field.name] !== undefined,
    set: (v: Primitive) => setPatch(field.nodeId, field.name, v),
    reset: () => resetPatch(field.nodeId, field.name),
  };
}

function ResetDot({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Tip label="还原为工作流里的值">
      <button className="field__reset" onClick={onClick} aria-label={`还原${label}`}>
        <span className="field__dot" aria-hidden />
        <RotateCcw size={11} />
      </button>
    </Tip>
  );
}

function Label({ field, htmlFor, modified, onReset, role, children }: {
  field: Field;
  htmlFor?: string;
  modified: boolean;
  onReset: () => void;
  role?: 'positive' | 'negative';
  children?: React.ReactNode;
}) {
  const zh = role === 'positive' ? '正向提示词' : role === 'negative' ? '反向提示词' : labelFor(field.name);
  const label = (
    <label className="field__label" htmlFor={htmlFor}>
      <span className="field__name">{zh}</span>
    </label>
  );
  return (
    <div className="field__top">
      {role && <span className={clsx('role-dot', `role-dot--${role}`)} aria-hidden />}
      {field.tooltip ? <Tip label={field.tooltip} side="right">{label}</Tip> : label}
      <span className="field__spacer" />
      {children}
      {modified && <ResetDot onClick={onReset} label={zh} />}
    </div>
  );
}

// ─── numeric input that tolerates partial typing ("0.", "-") ────────────────
function NumberInput({ value, onCommit, step = 1, min, max, id, wide, ariaLabel }: {
  value: number;
  onCommit: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  id?: string;
  wide?: boolean;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(fmtNumber(value, step));
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(fmtNumber(value, step)); }, [value, step]);

  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commit = (s: string) => {
    const v = Number(s);
    if (s.trim() !== '' && Number.isFinite(v)) onCommit(clamp(v));
  };

  return (
    <input
      id={id}
      aria-label={ariaLabel}
      className={clsx('num', wide && 'num--wide')}
      inputMode="decimal"
      spellCheck={false}
      value={draft}
      onFocus={(e) => { focused.current = true; e.currentTarget.select(); }}
      onBlur={() => { focused.current = false; setDraft(fmtNumber(value, step)); }}
      onChange={(e) => { setDraft(e.target.value); commit(e.target.value); }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const mult = e.shiftKey ? 10 : 1;
        const next = clamp(+(value + (e.key === 'ArrowUp' ? step : -step) * mult).toFixed(6));
        onCommit(next);
        setDraft(fmtNumber(next, step));
      }}
    />
  );
}

/** A primary field is "inline" (renders as a small pill that flows with
 *  siblings in a wrap row) when it's a tiny-range integer stepper. Prompts,
 *  media and arbitrary text stay as block-level cards. */
export function isInlineField(f: Field): boolean {
  return (
    f.kind === 'int' &&
    f.min != null &&
    f.max != null &&
    f.max - f.min <= 10 &&
    (f.step ?? 1) === 1
  );
}

// ─── rows ───────────────────────────────────────────────────────────────────
export function FieldRow({ field, role, media, compact }: {
  field: Field;
  role?: 'positive' | 'negative';
  media?: 'image' | 'video' | 'audio' | null;
  compact?: boolean;
}) {
  const id = useId();
  const { modified, set, reset } = useFieldState(field);
  const randomize = useStore((s) => s.randomize);
  const setRandomize = useStore((s) => s.setRandomize);

  if (media) return <MediaInput field={field} kind={media} compact={compact} />;

  switch (field.kind) {
    case 'prompt':
      return <PromptField field={field} role={role} />;

    case 'seed':
      return (
        <div className={clsx('field', modified && 'is-modified')}>
          <Label field={field} htmlFor={id} modified={modified} onReset={reset}>
            <label className="field__inline-switch">
              <span>每次随机</span>
              <Switch checked={randomize} onChange={setRandomize} ariaLabel="每次生成都换新种子" />
            </label>
          </Label>
          <div className="field__row">
            <NumberInput id={id} value={Number(field.value)} onCommit={set} min={0} wide />
            <IconButton label="换一个随机种子" variant="default" onClick={() => set(randomSeed())}>
              <Dices size={15} />
            </IconButton>
          </div>
        </div>
      );

    case 'int':
    case 'float': {
      const v = Number(field.value);
      if (isInlineField(field)) {
        const step = field.step ?? 1;
        const min = field.min!;
        const max = field.max!;
        return (
          <div className={clsx('field', 'field--stepper', modified && 'is-modified')}>
            <span className="field__name">{labelFor(field.name)}</span>
            <span className="numstep">
              <button
                type="button"
                className="numstep__btn"
                onClick={() => set(Math.max(min, v - step))}
                disabled={v <= min}
                aria-label="减少"
              >
                <Minus size={10} strokeWidth={2.8} />
              </button>
              <span className="numstep__value" aria-live="polite">{v}</span>
              <button
                type="button"
                className="numstep__btn"
                onClick={() => set(Math.min(max, v + step))}
                disabled={v >= max}
                aria-label="增加"
              >
                <Plus size={10} strokeWidth={2.8} />
              </button>
            </span>
            {modified && (
              <button type="button" className="field__reset field__reset--inline" onClick={reset} aria-label="还原">
                <RotateCcw size={10} />
              </button>
            )}
          </div>
        );
      }
      return (
        <div className={clsx('field', modified && 'is-modified')}>
          <Label field={field} htmlFor={id} modified={modified} onReset={reset}>
            <NumberInput id={id} value={v} onCommit={set} step={field.step} min={field.min} max={field.max} />
          </Label>
        </div>
      );
    }

    case 'combo':
      return (
        <div className={clsx('field', modified && 'is-modified')}>
          <Label field={field} modified={modified} onReset={reset} />
          <Select value={String(field.value)} options={field.options ?? []} onChange={set} ariaLabel={labelFor(field.name)} />
        </div>
      );

    case 'bool':
      return (
        <div className={clsx('field', 'field--bool', modified && 'is-modified')}>
          <Label field={field} htmlFor={id} modified={modified} onReset={reset}>
            <Switch id={id} checked={!!field.value} onChange={set} />
          </Label>
        </div>
      );

    default:
      return (
        <div className={clsx('field', modified && 'is-modified')}>
          <Label field={field} htmlFor={id} modified={modified} onReset={reset} />
          <input id={id} className="text-input" value={String(field.value)} spellCheck={false} onChange={(e) => set(e.target.value)} />
        </div>
      );
  }
}

function AutoTextarea({ value, onChange, id, autoFocus }: { value: string; onChange: (v: string) => void; id: string; autoFocus?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(300, Math.max(64, el.scrollHeight + 2))}px`;
  }, [value]);
  return (
    <div className="prompt">
      <textarea ref={ref} id={id} className="prompt__area" value={value} spellCheck={false} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />
      <span className="prompt__count" aria-hidden>{value.length}</span>
    </div>
  );
}

/** Templates (negative ban-list, 「最佳质量」, 系统提示词) start folded. */
export const isTemplatePrompt = (field: Field, role?: 'positive' | 'negative') =>
  field.promptClass === 'system' || role === 'negative';

/** Whether a prompt is currently folded: the user's choice, else the default. */
export function usePromptFolded(field: Field, role?: 'positive' | 'negative') {
  const key = useStore((s) => foldKey(s.currentId, field));
  const saved = useStore((s) => s.promptFold[key]);
  return { key, folded: saved ?? isTemplatePrompt(field, role) };
}

/** Every prompt can fold down to a one-line preview and open again; the
 *  choice is remembered per app. Templates start folded so the eye lands on
 *  what to edit. */
function PromptField({ field, role }: { field: Field; role?: 'positive' | 'negative' }) {
  const id = useId();
  const { modified, set, reset } = useFieldState(field);
  const setPromptFold = useStore((s) => s.setPromptFold);
  const isSystem = isTemplatePrompt(field, role);
  const { key, folded } = usePromptFolded(field, role);
  // focus the editor only when the user opened it, not on page load
  const [justOpened, setJustOpened] = useState(false);
  const value = String(field.value);
  const labelZh = role === 'positive' ? '正向提示词'
    : role === 'negative' ? '反向提示词'
    : field.name === '系统提示词' ? '系统提示词'
    : labelFor(field.name);
  const zh = isSystem ? `${labelZh} · 模板` : labelZh;
  const preview = value.replace(/\s+/g, ' ').trim();
  const previewShort = preview.slice(0, 60) + (preview.length > 60 ? '…' : '');

  if (folded) {
    return (
      <button
        type="button"
        className={clsx('field', 'field--prompt-collapsed', isSystem && 'field--prompt-collapsed--system', modified && 'is-modified')}
        onClick={() => { setJustOpened(true); setPromptFold([key], false); }}
        aria-expanded={false}
        aria-label={`展开${zh}`}
      >
        <span className="field__top">
          {role && <span className={clsx('role-dot', `role-dot--${role}`)} aria-hidden />}
          <span className="field__name">{zh}</span>
          <span className="prompt-collapsed__len">{value.length} 字</span>
          <span className="field__spacer" />
          {modified && <span className="field__dot" aria-label="已修改" />}
          <span className="prompt-collapsed__action">
            <ChevronDown size={11} strokeWidth={2.4} />展开
          </span>
        </span>
        <span className="prompt-collapsed__preview">{previewShort || '（空）'}</span>
      </button>
    );
  }

  return (
    <div className={clsx('field', 'field--prompt', modified && 'is-modified')}>
      <Label field={field} htmlFor={id} modified={modified} onReset={reset} role={role}>
        <button
          type="button"
          className="link-btn prompt__fold"
          aria-expanded
          onClick={() => { setJustOpened(false); setPromptFold([key], true); }}
        >
          <ChevronUp size={11} strokeWidth={2.4} />收起
        </button>
      </Label>
      <AutoTextarea id={id} value={value} onChange={set} autoFocus={justOpened} />
    </div>
  );
}

// ─── LoadImage / LoadVideo / LoadAudio: just a tile. Click / drop to upload. ─
function MediaInput({ field, kind, compact }: { field: Field; kind: 'image' | 'video' | 'audio'; compact?: boolean }) {
  const { modified, set, reset } = useFieldState(field);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const name = String(field.value ?? '');
  const [broken, setBroken] = useState<string | null>(null);
  const label = { image: '上传图片', video: '上传视频', audio: '上传音频' }[kind];
  const accept = { image: 'image/*', video: 'video/*', audio: 'audio/*' }[kind];
  const Icon = kind === 'image' ? ImagePlus : kind === 'video' ? Film : Music;
  const zhName = /^ref_image_?(\d+)$/i.test(field.name)
    ? `第 ${Number(field.name.match(/\d+/)![0]) + 1} 张`
    : labelFor(field.name);
  const hasImage = kind === 'image' && !!name && broken !== name;
  const hasAsset = !!name && broken !== name; // for video/audio we only know by name presence

  const upload = async (f?: File | null) => {
    if (!f) return;
    setBusy(true);
    try {
      const r = await api.uploadInput(f);
      set(r.name);
      setBroken(null);
      toast.success('已上传', { description: r.name });
    } catch (e: any) {
      toast.error('上传失败', { description: e.message });
    } finally {
      setBusy(false);
    }
  };

  const tile = (
    <button
      type="button"
      className={clsx(
        'media-in__tile',
        `media-in__tile--${kind}`,
        over && 'is-over',
        hasAsset && 'has-asset',
        compact && 'media-in__tile--compact',
      )}
      onClick={() => input.current?.click()}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); void upload(e.dataTransfer.files[0]); }}
      aria-label={label}
    >
      {hasImage ? (
        <img src={api.inputUrl(name)} alt="" onError={() => setBroken(name)} />
      ) : hasAsset ? (
        <span className="media-in__present"><Icon size={compact ? 20 : 26} strokeWidth={1.8} /></span>
      ) : (
        <span className="media-in__ph"><Icon size={compact ? 20 : 26} strokeWidth={1.8} /></span>
      )}
      <span className="media-in__hover">
        {busy ? <LoaderCircle size={14} className="spin" /> : <Upload size={14} />}
        <span>{hasAsset ? '换一张' : label}</span>
      </span>
      {modified && hasAsset && (
        <span className="media-in__reset" onClick={(e) => { e.stopPropagation(); reset(); }} role="button" aria-label="还原">
          <RotateCcw size={10} />
        </span>
      )}
    </button>
  );

  if (compact) {
    return (
      <div className={clsx('field', 'field--media-compact', modified && 'is-modified')}>
        {tile}
        <span className="media-in__compact-label">{zhName}</span>
        <input ref={input} type="file" hidden accept={accept} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
    );
  }

  return (
    <div className={clsx('field', 'field--media', modified && 'is-modified')}>
      <Label field={{ ...field, name: zhName }} modified={modified} onReset={reset} />
      {tile}
      <input ref={input} type="file" hidden accept={accept} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
  );
}

// ─── width × height ─────────────────────────────────────────────────────────
const RATIOS: Array<[number, number]> = [[1, 1], [4, 3], [3, 4], [16, 9], [9, 16]];
const round8 = (n: number) => Math.max(8, Math.round(n / 8) * 8);

export function DimsField({ width, height }: { width: Field; height: Field }) {
  const setPatch = useStore((s) => s.setPatch);
  const resetPatch = useStore((s) => s.resetPatch);
  const patches = usePatches();
  const modified = patches[width.nodeId]?.width !== undefined || patches[height.nodeId]?.height !== undefined;
  const w = Number(width.value);
  const h = Number(height.value);
  const setW = (v: number) => setPatch(width.nodeId, 'width', v);
  const setH = (v: number) => setPatch(height.nodeId, 'height', v);
  const long = Math.max(w, h);

  return (
    <div className={clsx('field', 'dims', modified && 'is-modified')}>
      <div className="field__top">
        <span className="field__label"><span className="field__name">尺寸</span><span className="field__key">width × height</span></span>
        {modified && <ResetDot onClick={() => { resetPatch(width.nodeId, 'width'); resetPatch(height.nodeId, 'height'); }} label="尺寸" />}
      </div>
      <div className="dims__row">
        <NumberInput value={w} onCommit={setW} step={8} min={width.min ?? 16} max={width.max} ariaLabel="宽" />
        <IconButton label="交换宽高" size="sm" onClick={() => { setW(h); setH(w); }}>
          <ArrowLeftRight size={13} />
        </IconButton>
        <NumberInput value={h} onCommit={setH} step={8} min={height.min ?? 16} max={height.max} ariaLabel="高" />
      </div>
      <div className="ratios" role="group" aria-label="常用比例">
        {RATIOS.map(([rw, rh]) => {
          const active = Math.abs(w / h - rw / rh) < 0.02;
          const tw = rw >= rh ? long : round8((long * rw) / rh);
          const th = rw >= rh ? round8((long * rh) / rw) : long;
          const s = 12 / Math.max(rw, rh);
          return (
            <button
              key={`${rw}:${rh}`}
              className={clsx('ratio', active && 'is-active')}
              aria-pressed={active}
              onClick={() => { setW(tw); setH(th); }}
              title={`${tw} × ${th}`}
            >
              <span className="ratio__shape" style={{ width: rw * s, height: rh * s }} aria-hidden />
              {rw}:{rh}
            </button>
          );
        })}
      </div>
    </div>
  );
}
