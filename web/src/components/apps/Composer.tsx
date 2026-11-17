import { useLayoutEffect, useRef } from 'react';
import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import clsx from 'clsx';
import type { Field } from '../../lib/workflow';
import { useStore, usePatches } from '../../store';
import { Tip } from '../ui';
import { DimsField, FieldRow, isInlineField } from './fields';
import { BatchStepper, GenerateButton } from './SubmitBar';

/** Key inputs other than the hero prompt — the rest of what the user put in
 *  the 「下方 · 关键」 position. width + height from one node pair up into the
 *  usual dims widget; small knobs flow in a wrap grid, prompts take a row. */
export function KeyExtras({ fields }: { fields: Field[] }) {
  if (!fields.length) return null;
  const used = new Set<Field>();
  const dims: Array<{ width: Field; height: Field }> = [];
  for (const w of fields) {
    if (w.name !== 'width') continue;
    const h = fields.find((f) => f.name === 'height' && f.nodeId === w.nodeId);
    if (h) { dims.push({ width: w, height: h }); used.add(w); used.add(h); }
  }
  const rest = fields.filter((f) => !used.has(f));
  const wide = rest.filter((f) => f.kind === 'prompt');
  const small = rest.filter((f) => f.kind !== 'prompt');
  return (
    <div className="composer__extras">
      {wide.map((f) => <FieldRow key={`${f.nodeId}:${f.name}`} field={f} media={null} />)}
      {(dims.length > 0 || small.length > 0) && (
        <div className="composer__knobs">
          {dims.map((d) => <DimsField key={`${d.width.nodeId}:dims`} width={d.width} height={d.height} />)}
          {small.map((f) => (
            <div key={`${f.nodeId}:${f.name}`} className={clsx('composer__knob', isInlineField(f) && 'is-inline')}>
              <FieldRow field={f} media={null} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The main prompt card. It sits above the preview, under the reference
 *  strip when the app has one. Other key prompts stack under the main one
 *  and fold like the ones on the left. */
export function PromptCard({ field, more = [] }: { field: Field; more?: Array<{ field: Field; role?: 'positive' | 'negative' }> }) {
  const setPatch = useStore((s) => s.setPatch);
  const resetPatch = useStore((s) => s.resetPatch);
  const patches = usePatches();
  const ta = useRef<HTMLTextAreaElement>(null);
  const value = String(field.value ?? '');
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  const modified = patches[field.nodeId]?.[field.name] !== undefined;

  return (
    <section className={clsx('composer', 'composer--prompt', modified && 'is-modified')} aria-label="提示词">
      <header className="composer__head">
        <label className="composer__title" htmlFor="composer-prompt">提示词</label>
        <span className="composer__count">{value.length} 字</span>
        <span className="field__spacer" />
        {modified && (
          <Tip label="还原为工作流里的值">
            <button className="link-btn" onClick={() => resetPatch(field.nodeId, field.name)}>
              <RotateCcw size={11} />还原
            </button>
          </Tip>
        )}
      </header>
      <textarea
        id="composer-prompt"
        ref={ta}
        className="composer__area"
        value={value}
        rows={2}
        spellCheck={false}
        placeholder="描述你想要的画面…"
        onChange={(e) => setPatch(field.nodeId, field.name, e.target.value)}
      />
      {more.length > 0 && (
        <div className="composer__more">
          {more.map(({ field: f, role }) => <FieldRow key={`${f.nodeId}:${f.name}`} field={f} role={role} media={null} />)}
        </div>
      )}
    </section>
  );
}

/** Under the preview: the remaining key inputs and the generate button. */
export function ActionCard({ extras = [], hasPrompt, submit, busy, children }: {
  extras?: Field[];
  /** whether there is a prompt card above (changes the empty-state hint) */
  hasPrompt: boolean;
  submit: () => Promise<boolean>;
  busy: boolean;
  /** replaces the hint on the left of the footer (H3 token legend) */
  children?: React.ReactNode;
}) {
  if (!extras.length) {
    return (
      <section className="composer composer--bare">
        {children ?? (
          <p className="composer__bare">
            <SlidersHorizontal size={13} />
            {hasPrompt ? '其余参数在左侧' : '没有设置关键输入，参考素材和左侧参数准备好就能生成。'}
          </p>
        )}
        <Go submit={submit} busy={busy} />
      </section>
    );
  }
  return (
    <section className="composer composer--action" aria-label="关键输入">
      <KeyExtras fields={extras} />
      <footer className="composer__foot">
        {children ?? <span className="composer__hint">其余参数在左侧</span>}
        <Go submit={submit} busy={busy} />
      </footer>
    </section>
  );
}

/** How many to make, right beside the button that makes them. */
function Go({ submit, busy }: { submit: () => Promise<boolean>; busy: boolean }) {
  return (
    <div className="composer__go-group">
      <BatchStepper />
      <GenerateButton onSubmit={submit} busy={busy} className="composer__go" />
    </div>
  );
}
