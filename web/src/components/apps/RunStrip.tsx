import { useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpRight, Star, TriangleAlert, X } from 'lucide-react';
import clsx from 'clsx';
import { runsOf, useStore } from '../../store';
import type { Task } from '../../types';
import { Sticker } from '../Sticker';
import { useFocusedRun } from './Stage';

const LIMIT = 80;

/** Every run of the open workflow, as stickers — a vertical column beside the
 *  workbench, or a horizontal filmstrip under a stage. */
export function RunStrip({ layout = 'row' }: { layout?: 'row' | 'column' }) {
  const currentId = useStore((s) => s.currentId);
  const tasks = useStore((s) => s.tasks);
  const wf = useStore((s) => (s.currentId ? s.workflows[s.currentId] : undefined));
  const focusRun = useStore((s) => s.focusRun);
  const openApp = useStore((s) => s.openApp);
  const focused = useFocusedRun();
  const runs = useMemo(() => runsOf(tasks, currentId).slice(0, LIMIT), [tasks, currentId]);

  // runs that appear after this workflow was opened get slapped on
  const seen = useRef<{ wf: string | null; ids: Set<string> }>({ wf: null, ids: new Set() });
  if (seen.current.wf !== currentId) seen.current = { wf: currentId, ids: new Set(runs.map((r) => r.id)) };

  return (
    <aside className={clsx('strip', `strip--${layout}`)} aria-label="这个工作流的历史">
      <header className="strip__head">
        <span className="strip__title">{layout === 'column' ? '历史' : '最近'}</span>
        <span className="strip__count">{wf?.stats.artifacts ?? 0}</span>
        <span className="field__spacer" />
        {wf && (
          <button className="link-btn" onClick={() => openApp(wf.id, 'artifacts')}>全部<ArrowUpRight size={12} /></button>
        )}
      </header>
      <div className="strip__rail">
        <AnimatePresence initial={false}>
          {runs.map((t) => (
            <motion.div
              key={t.id}
              layout
              className="strip__cell"
              exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.15 } }}
              transition={{ type: 'spring', stiffness: 500, damping: 34 }}
            >
              <RunTile task={t} fresh={!seen.current.ids.has(t.id)} selected={focused?.id === t.id} onClick={() => focusRun(t.id)} />
            </motion.div>
          ))}
        </AnimatePresence>
        {!runs.length && <p className="strip__empty">每次生成都会留在这里，点一下回看。</p>}
      </div>
    </aside>
  );
}

function RunTile({ task, fresh, selected, onClick }: { task: Task; fresh: boolean; selected: boolean; onClick: () => void }) {
  const preview = useStore((s) => s.previews[task.id]);
  const a = task.artifacts[0];

  if (task.status === 'success' && a) {
    return (
      <Sticker id={task.id} media={a} slap={fresh} selected={selected} onClick={onClick} label={task.label}>
        {task.artifacts.length > 1 && <span className="sticker__count">{task.artifacts.length}</span>}
        {task.artifacts.some((x) => x.starred) && <span className="sticker__star"><Star size={10} fill="currentColor" /></span>}
      </Sticker>
    );
  }

  const live = task.status === 'pending' || task.status === 'running' || task.status === 'queued';
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <motion.button
      type="button"
      className={clsx('tile', live ? 'tile--live' : 'tile--fail', task.status === 'queued' && 'tile--queued', selected && 'is-selected')}
      onClick={onClick}
      aria-label={`${task.label}：${task.status === 'queued' ? '排队中' : live ? '进行中' : '失败'}`}
      initial={fresh ? { scale: 0.5, opacity: 0 } : false}
      animate={{ scale: 1, opacity: 1 }}
      whileHover={{ y: -2 }}
      transition={{ type: 'spring', stiffness: 500, damping: 26 }}
    >
      {live && preview && <img src={preview} alt="" className="tile__preview" />}
      {live ? (
        <svg className="ring" viewBox="0 0 36 36" aria-hidden>
          <circle className="ring__track" cx="18" cy="18" r={r} />
          <motion.circle
            className="ring__fill"
            cx="18"
            cy="18"
            r={r}
            strokeDasharray={c}
            animate={{ strokeDashoffset: c * (1 - Math.max(0.03, task.progress)) }}
            transition={{ type: 'spring', stiffness: 120, damping: 20 }}
          />
        </svg>
      ) : task.status === 'cancelled' ? <X size={18} /> : <TriangleAlert size={18} />}
      {live && (
        <span className="tile__pct">
          {task.status === 'queued' ? '等' : task.status === 'pending' ? '…' : Math.floor(task.progress * 100)}
        </span>
      )}
    </motion.button>
  );
}
