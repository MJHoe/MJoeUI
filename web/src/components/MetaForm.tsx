import { useId } from 'react';
import { motion } from 'motion/react';
import { Check } from 'lucide-react';
import clsx from 'clsx';
import { BASE_MODELS, CATEGORIES, CATEGORY } from '../lib/category';
import type { Category } from '../types';

export type MetaDraft = { name: string; category: Category; baseModel: string; note: string };

/** Name, category, base model and note — used by both import and edit. */
export function MetaForm({ value, onChange, detected, autoFocus }: {
  value: MetaDraft;
  onChange: (v: MetaDraft) => void;
  detected?: { category: Category; baseModel: string; modelFile: string | null };
  autoFocus?: boolean;
}) {
  const id = useId();
  const set = <K extends keyof MetaDraft>(k: K, v: MetaDraft[K]) => onChange({ ...value, [k]: v });

  return (
    <div className="meta-form">
      <label className="mf-field">
        <span className="mf-label">名字</span>
        <input
          className="text-input text-input--lg"
          value={value.name}
          autoFocus={autoFocus}
          maxLength={80}
          placeholder="比如：SDXL 人像精修"
          onChange={(e) => set('name', e.target.value)}
        />
      </label>

      <div className="mf-field">
        <span className="mf-label" id={`${id}-cat`}>
          类别
          <span className="mf-hint">决定制品是图片还是视频</span>
        </span>
        <div className="cat-picker" role="radiogroup" aria-labelledby={`${id}-cat`}>
          {CATEGORIES.map((c) => {
            const meta = CATEGORY[c];
            const Icon = meta.icon;
            const on = value.category === c;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={on}
                className={clsx('cat-chip', `cat-chip--${c}`, on && 'is-on')}
                onClick={() => set('category', c)}
              >
                <Icon size={14} strokeWidth={2.2} aria-hidden />
                <span className="cat-chip__label">{meta.label}</span>
                <span className="cat-chip__hint">{meta.hint}</span>
                {on && (
                  <motion.span layoutId={`${id}-check`} className="cat-chip__check" transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
                    <Check size={10} strokeWidth={3.2} />
                  </motion.span>
                )}
                {detected?.category === c && !on && <span className="cat-chip__auto">识别</span>}
              </button>
            );
          })}
        </div>
      </div>

      <label className="mf-field">
        <span className="mf-label">
          基座模型
          {detected?.modelFile && <span className="mf-hint">从 <code>{detected.modelFile}</code> 识别</span>}
        </span>
        <input
          className="text-input"
          value={value.baseModel}
          list={`${id}-models`}
          maxLength={60}
          placeholder="SDXL / FLUX / Wan 2.2 …"
          onChange={(e) => set('baseModel', e.target.value)}
        />
        <datalist id={`${id}-models`}>
          {BASE_MODELS.map((m) => <option key={m} value={m} />)}
        </datalist>
      </label>

      <label className="mf-field">
        <span className="mf-label">备注 <span className="mf-hint">可选</span></span>
        <textarea
          className="text-input mf-note"
          value={value.note}
          rows={2}
          maxLength={2000}
          placeholder="适合什么、要注意什么、从哪里来的"
          onChange={(e) => set('note', e.target.value)}
        />
      </label>
    </div>
  );
}
