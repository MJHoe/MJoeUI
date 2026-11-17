import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { useStore } from '../../store';
import { useSubmit } from '../../lib/useSubmit';
import { useSections } from '../../lib/useSections';
import { useObjectInfo } from '../../lib/useObjectInfo';
import { fieldKey, isH3Workflow, mediaInputKind, type Field, type Section } from '../../lib/workflow';
import { pickH3Hero, pickHero, recommendSlots } from '../../lib/layout';
import type { ParamSlot, Workflow } from '../../types';
import clsx from 'clsx';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { IconButton, JellyDots, Tip } from '../ui';
import { ParamPanel } from './ParamPanel';
import { Stage } from './Stage';
import { RunStrip } from './RunStrip';
import { ActionCard, PromptCard } from './Composer';
import { H3PromptCard, h3Target } from './H3Composer';
import { collectRefs, RefStrip } from './RefStrip';

export function UseTab() {
  const currentId = useStore((s) => s.currentId);
  const version = useStore((s) => (s.currentId ? s.workflows[s.currentId]?.updatedAt : undefined));
  const graph = useStore((s) => (s.currentId ? s.graphs[s.currentId]?.json : undefined));
  const ensureGraph = useStore((s) => s.ensureGraph);

  useEffect(() => {
    if (!currentId) return;
    ensureGraph(currentId).catch((e) => toast.error('载入应用失败', { description: e.message }));
  }, [currentId, version, ensureGraph]);

  if (!graph) return <div className="use use--loading"><div className="page-center"><JellyDots /></div></div>;
  return <Workbench workflow={graph} />;
}

/** The app's saved layout, or the automatic one if the user never picked. */
export function useSlots(workflow: Workflow): ParamSlot[] {
  const connected = useStore((s) => s.connected);
  const saved = useStore((s) => (s.currentId ? s.workflows[s.currentId]?.exposed : null));
  const infos = useObjectInfo(workflow, connected);
  return useMemo(() => saved ?? recommendSlots(workflow, infos), [saved, workflow, infos]);
}

/** Every rendered field in section order, dims unpacked. */
type Placed = { field: Field; className: string; role?: 'positive' | 'negative' };
function allFields(sections: Section[]): Placed[] {
  const out: Placed[] = [];
  for (const s of sections) {
    for (const g of s.groups) {
      if (g.dims) out.push({ field: g.dims.width, className: g.className }, { field: g.dims.height, className: g.className });
      for (const f of g.fields) out.push({ field: f, className: g.className, role: g.role });
    }
  }
  return out;
}

const SIDE_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘\\' : 'Ctrl+\\';

/** The left panel folded away: a slim rail that pops it back out. The toggle
 *  sits exactly where the panel's collapse button was, so it never moves. */
function SideRail({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <Tip label={`展开参数栏 · ${SIDE_KEY}`} side="right">
      <button
        type="button"
        className="use__rail"
        aria-label="展开参数栏"
        aria-expanded={false}
        onClick={onOpen}
      >
        <span className="use__toggle use__rail-icon"><PanelLeftOpen size={16} /></span>
        <span className="use__rail-label">参数</span>
        {count > 0 && <span className="use__count">{count}</span>}
      </button>
    </Tip>
  );
}

/** Three columns. Left: secondary params. Center, top to bottom: a compact
 *  strip of key references (if any), the prompt card, the preview (as big as
 *  the column allows), and the remaining key inputs with generate. Right:
 *  this app's history. */
function Workbench({ workflow }: { workflow: Workflow }) {
  const { submit, busy } = useSubmit();
  const slots = useSlots(workflow);
  const visible = useMemo(() => slots.map((s) => s.key), [slots]);
  const mainOrder = useMemo(() => {
    const m = new Map<string, number>();
    slots.forEach((s, i) => { if (s.place === 'main') m.set(s.key, i); });
    return m;
  }, [slots]);
  const { sections } = useSections(workflow, visible);
  const h3 = useMemo(() => isH3Workflow(workflow), [workflow]);

  const { hero, prompts, knobs, refs } = useMemo(() => {
    const isMain = (f: Field) => mainOrder.has(fieldKey(f.nodeId, f.name));
    const hero = h3 ? pickH3Hero(sections, isMain) : pickHero(workflow, sections, isMain);
    const refs = collectRefs(workflow, sections, h3).filter((r) => isMain(r.field));
    const order = (f: Field) => mainOrder.get(fieldKey(f.nodeId, f.name))!;
    const extras = allFields(sections)
      .filter(({ field, className }) => isMain(field) && field !== hero && !mediaInputKind(className, field.name))
      .sort((a, b) => order(a.field) - order(b.field));
    // key prompts go up with the main one; everything else stays under the preview
    return {
      hero,
      prompts: extras.filter((x) => x.field.kind === 'prompt'),
      knobs: extras.filter((x) => x.field.kind !== 'prompt').map((x) => x.field),
      refs,
    };
  }, [h3, workflow, sections, mainOrder]);

  const promoted = useMemo(() => new Set(mainOrder.keys()), [mainOrder]);

  const collapsed = useStore((s) => s.sideCollapsed);
  const setCollapsed = useStore((s) => s.setSideCollapsed);
  const sideCount = useMemo(() => slots.filter((s) => s.place === 'side').length, [slots]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit(); }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        const s = useStore.getState();
        s.setSideCollapsed(!s.sideCollapsed);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit]);

  return (
    <div className={clsx('use', collapsed && 'is-side-collapsed')}>
      {collapsed ? (
        <SideRail count={sideCount} onOpen={() => setCollapsed(false)} />
      ) : (
        <aside className="use__side" id="use-side" aria-label="参数">
          <header className="use__head">
            <IconButton
              label={`收起参数栏 · ${SIDE_KEY}`}
              tipSide="right"
              size="sm"
              className="use__toggle"
              aria-expanded
              aria-controls="use-side"
              onClick={() => setCollapsed(true)}
            >
              <PanelLeftClose size={16} />
            </IconButton>
            <span className="use__title">参数</span>
            {sideCount > 0 && <span className="use__count">{sideCount}</span>}
          </header>
          <div className="use__scroll">
            <ParamPanel workflow={workflow} visible={visible} promoted={promoted} />
          </div>
        </aside>
      )}
      <section className="use__main">
        <div className="use__center">
          {refs.length > 0 && <RefStrip refs={refs} target={h3 ? h3Target(hero) : null} />}
          {hero && (h3
            ? <H3PromptCard field={hero} more={prompts} refs={refs} />
            : <PromptCard field={hero} more={prompts} />)}
          <div className="use__stage">
            <Stage />
          </div>
          <ActionCard extras={knobs} hasPrompt={!!hero} submit={submit} busy={busy} />
        </div>
      </section>
      <RunStrip layout="column" />
    </div>
  );
}
