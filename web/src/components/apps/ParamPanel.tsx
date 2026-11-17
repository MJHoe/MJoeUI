import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronsDownUp, ChevronsUpDown, ListChecks, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import { foldKey, useStore, usePatches } from '../../store';
import { useObjectInfo } from '../../lib/useObjectInfo';
import { buildSections, countPatches, mediaInputKind, SECTION_LABEL, type NodeGroup, type Section } from '../../lib/workflow';
import type { Workflow } from '../../types';
import { Tip } from '../ui';
import { ParamPickerDialog } from '../ParamPicker';
import { FieldRow, DimsField, isInlineField, isTemplatePrompt } from './fields';

export function ParamPanel({ workflow, visible, promoted }: {
  workflow: Workflow;
  /** keys of every input the app shows (left + center) */
  visible: string[];
  /** the subset the center column renders — not repeated here */
  promoted?: Set<string>;
}) {
  const patches = usePatches();
  const connected = useStore((s) => s.connected);
  const currentId = useStore((s) => s.currentId);
  const resetPatches = useStore((s) => s.resetPatches);
  const [picking, setPicking] = useState(false);
  const infos = useObjectInfo(workflow, connected);
  const built = useMemo(
    () => buildSections(workflow, infos, patches, visible),
    [workflow, infos, patches, visible],
  );
  // Filter out fields the parent (essentials strip) already surfaces, so the
  // same prompt / dims / seed never appear twice on screen.
  const { sections, lockedCount } = useMemo(() => {
    if (!promoted?.size) return built;
    const sections = built.sections
      .map((sec) => ({
        ...sec,
        groups: sec.groups
          .map((g) => ({
            ...g,
            fields: g.fields.filter((f) => !promoted.has(`${g.nodeId}:${f.name}`)),
            dims: g.dims && (promoted.has(`${g.dims.width.nodeId}:${g.dims.width.name}`) ||
                             promoted.has(`${g.dims.height.nodeId}:${g.dims.height.name}`))
              ? undefined : g.dims,
          }))
          .filter((g) => g.fields.length > 0 || g.dims),
      }))
      .filter((sec) => sec.groups.length > 0);
    return { sections, lockedCount: built.lockedCount };
  }, [built, promoted]);
  const changed = countPatches(workflow, patches);
  const picker = currentId && (
    <>
      <Tip label="从这个工作流识别出的全部参数里，勾选哪些显示在使用页。没勾的沿用 JSON 里的值。" side="top">
        <button className="params__locked" onClick={() => setPicking(true)}>
          <ListChecks size={11} />
          {lockedCount > 0 ? `另有 ${lockedCount} 项未显示 · 选择参数` : '选择显示的参数'}
        </button>
      </Tip>
      <ParamPickerDialog workflowId={currentId} open={picking} onOpenChange={setPicking} />
    </>
  );

  if (!sections.length) {
    return (
      <div className="params">
        <p className="params__empty">左侧没有要填的参数，直接生成就好。</p>
        {picker}
      </div>
    );
  }

  return (
    <div className="params">
      <AnimatePresence>
        {changed > 0 && (
          <motion.div
            className="params__changed"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
          >
            <Tip label="改过的参数会自动存进数据库，作为这个应用的默认值（生成和 API 调用都用它）。原始 JSON 不变，点「还原」回到 JSON 里的值。" side="bottom">
              <span><b>{changed}</b> 处改动 · 已存为默认值</span>
            </Tip>
            <button className="link-btn" onClick={resetPatches}><RotateCcw size={11} />全部还原</button>
          </motion.div>
        )}
      </AnimatePresence>
      {sections.map((sec) => {
        const fieldCount = sec.groups.reduce((n, g) => n + g.fields.length + (g.dims ? 1 : 0), 0);
        return (
          <section key={sec.id} className={clsx('psec', `psec--${sec.id}`)}>
            <header className="psec__head">
              <span className="psec__title">{SECTION_LABEL[sec.id]}</span>
              <span className="psec__count">{fieldCount}</span>
              <FoldAll section={sec} />
            </header>
            <div className="psec__inner">
              {sec.groups.map((g) => (
                <Group key={`${sec.id}:${g.nodeId}:${g.fields.map((f) => f.name).join(',')}`} group={g} />
              ))}
            </div>
          </section>
        );
      })}
      {picker}
    </div>
  );
}

/** 全部收起 / 全部展开 for every prompt in a section (shown when it has 2+). */
function FoldAll({ section }: { section: Section }) {
  const currentId = useStore((s) => s.currentId);
  const fold = useStore((s) => s.promptFold);
  const setPromptFold = useStore((s) => s.setPromptFold);
  const prompts = section.groups.flatMap((g) =>
    g.fields
      .filter((f) => f.kind === 'prompt' && !mediaInputKind(g.className, f.name))
      .map((f) => ({ key: foldKey(currentId, f), folded: fold[foldKey(currentId, f)] ?? isTemplatePrompt(f, g.role) })));
  if (prompts.length < 2) return null;
  const allFolded = prompts.every((p) => p.folded);
  return (
    <button
      type="button"
      className="psec__fold"
      onClick={() => setPromptFold(prompts.map((p) => p.key), !allFolded)}
    >
      {allFolded ? <><ChevronsUpDown size={11} />全部展开</> : <><ChevronsDownUp size={11} />全部收起</>}
    </button>
  );
}

function Group({ group }: { group: NodeGroup }) {
  const mediaFields = group.fields.filter((f) => mediaInputKind(group.className, f.name));
  const rest = group.fields.filter((f) => !mediaInputKind(group.className, f.name));
  const inlineFields = rest.filter(isInlineField);
  const blockFields = rest.filter((f) => !isInlineField(f));
  const compactMedia = mediaFields.length > 1;

  return (
    <div className={clsx('pgroup', compactMedia && 'pgroup--media-grid')}>
      {group.dims && <DimsField width={group.dims.width} height={group.dims.height} />}
      {compactMedia ? (
        <div className="media-grid">
          {mediaFields.map((f) => (
            <FieldRow key={f.name} field={f} media={mediaInputKind(group.className, f.name)} compact />
          ))}
        </div>
      ) : (
        mediaFields.map((f) => (
          <FieldRow key={f.name} field={f} media={mediaInputKind(group.className, f.name)} />
        ))
      )}
      {blockFields.map((f) => (
        <FieldRow
          key={f.name}
          field={f}
          role={group.role}
          media={null}
        />
      ))}
      {inlineFields.length > 0 && (
        <div className="inline-row">
          {inlineFields.map((f) => (
            <FieldRow key={f.name} field={f} media={null} />
          ))}
        </div>
      )}
    </div>
  );
}
