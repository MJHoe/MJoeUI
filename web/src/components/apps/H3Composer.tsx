import { useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../api';
import { useStore, usePatches } from '../../store';
import { extractSubjectLabels, parsePromptTokens, type Field } from '../../lib/workflow';
import { Tip } from '../ui';
import { FieldRow } from './fields';
import type { PromptTarget, RefSlot } from './RefStrip';

export const h3PromptDomId = (f: Field) => `h3-prompt-${f.nodeId}-${f.name}`;

export function h3Target(f: Field | null): PromptTarget | null {
  return f ? { nodeId: f.nodeId, name: f.name, value: String(f.value ?? ''), domId: h3PromptDomId(f) } : null;
}

/** H3 prompt card: token-highlighted prompt plus chips for every
 *  `<Picture N>` / `<Subject N>` it uses. Sits under the reference strip. */
export function H3PromptCard({ field, more = [], refs }: {
  field: Field;
  more?: Array<{ field: Field; role?: 'positive' | 'negative' }>;
  refs: RefSlot[];
}) {
  const setPatch = useStore((s) => s.setPatch);
  const resetPatch = useStore((s) => s.resetPatch);
  const patches = usePatches();
  const modified = patches[field.nodeId]?.[field.name] !== undefined;
  const value = String(field.value ?? '');
  const [focus, setFocus] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLDivElement>(null);
  const syncScroll = () => {
    if (hlRef.current && taRef.current) hlRef.current.scrollTop = taRef.current.scrollTop;
  };

  return (
    <section className={clsx('composer', 'composer--prompt', 'composer--h3', focus && 'is-focus', modified && 'is-modified')} aria-label="提示词">
      <header className="composer__head">
        <label className="composer__title" htmlFor={h3PromptDomId(field)}>提示词</label>
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
      <div className="h3-canvas">
        <div ref={hlRef} className="h3-canvas__hl" aria-hidden>
          {renderHighlight(value + (value.endsWith('\n') || !value ? ' ' : ''))}
        </div>
        <textarea
          id={h3PromptDomId(field)}
          ref={taRef}
          className="h3-canvas__ta"
          value={value}
          spellCheck={false}
          placeholder="用 <Picture 1> 指代上面的第 1 张参考图…"
          onChange={(e) => setPatch(field.nodeId, field.name, e.target.value)}
          onScroll={syncScroll}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
        />
      </div>
      <div className="h3-tokens"><TokenLegend value={value} refs={refs} /></div>
      {more.length > 0 && (
        <div className="composer__more">
          {more.map(({ field: f, role }) => <FieldRow key={`${f.nodeId}:${f.name}`} field={f} role={role} media={null} />)}
        </div>
      )}
    </section>
  );
}

const HL_RE = /(<(?:Picture|Subject)\s*\d+>|\[(?:reference generation|Shot\s*\d+)\]|^\s*(?:subject_definitions|summary|retention_analysis|scene_description)\s*:)/gm;

function renderHighlight(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = new RegExp(HL_RE.source, HL_RE.flags);
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    const cls =
      /^<Picture/i.test(token) ? 'hl--picture' :
      /^<Subject/i.test(token) ? 'hl--subject' :
      /^\[Shot/i.test(token) ? 'hl--shot' :
      /^\[reference/i.test(token) ? 'hl--mode' :
      'hl--block';
    parts.push(<span key={i++} className={clsx('hl', cls)}>{token}</span>);
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Chips for every token the prompt currently uses; picture chips show the
 *  thumbnail of the reference they point at, so a dangling `<Picture 5>` with
 *  only four refs is obvious. */
function TokenLegend({ value, refs }: { value: string; refs: RefSlot[] }) {
  const tokens = useMemo(() => {
    const counts = new Map<string, { kind: 'picture' | 'subject'; n: number; count: number }>();
    for (const t of parsePromptTokens(value)) {
      const key = `${t.kind}:${t.n}`;
      counts.set(key, { kind: t.kind, n: t.n, count: (counts.get(key)?.count ?? 0) + 1 });
    }
    return [...counts.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.n - b.n);
  }, [value]);
  const subjects = useMemo(() => extractSubjectLabels(value), [value]);

  if (!tokens.length) {
    return <span className="composer__hint">还没引用参考图 — 点参考图插入 <code>&lt;Picture N&gt;</code></span>;
  }

  return (
    <div className="h3-legend">
      {tokens.map((t) => {
        const ref = t.kind === 'picture' ? refs.find((r) => r.picture === t.n) : undefined;
        const asset = ref ? String(ref.field.value ?? '') : '';
        const missing = t.kind === 'picture' && !ref;
        const label = t.kind === 'picture' ? `Picture ${t.n}` : `Subject ${t.n}${subjects.get(t.n) ? ` · ${subjects.get(t.n)}` : ''}`;
        return (
          <span key={`${t.kind}${t.n}`} className={clsx('h3-chip', `h3-chip--${t.kind}`, missing && 'is-missing')} title={missing ? '没有对应的参考图' : label}>
            {asset
              ? <img className="h3-chip__thumb" src={api.inputUrl(asset)} alt="" />
              : <span className="h3-chip__num">{t.n}</span>}
            <span className="h3-chip__label">{label}</span>
            {t.count > 1 && <span className="h3-chip__count">×{t.count}</span>}
          </span>
        );
      })}
    </div>
  );
}
