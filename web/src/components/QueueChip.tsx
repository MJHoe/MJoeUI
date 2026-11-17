import { useMemo } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, CircleStop, Inbox, Layers, X } from 'lucide-react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { api } from '../api';
import { queueOf, useStore } from '../store';
import { CATEGORY } from '../lib/category';
import { fmtAgo, fmtDuration } from '../lib/format';
import type { Task } from '../types';
import { Tip } from './ui';
import { STATUS_TEXT } from './apps/Stage';

/** Top-bar chip showing our own queue (not ComfyUI's). Click to see the list
 *  of waiting / live tasks, in submission order, with per-task cancel. */
export function QueueChip() {
  const tasks = useStore((s) => s.tasks);
  const workflows = useStore((s) => s.workflows);
  const openApp = useStore((s) => s.openApp);
  const focusRun = useStore((s) => s.focusRun);
  const openTask = useStore((s) => s.openTask);
  const queue = useMemo(() => queueOf(tasks), [tasks]);

  const queued = queue.filter((t) => t.status === 'queued' || t.status === 'pending').length;
  const running = queue.find((t) => t.status === 'running');
  if (!queue.length) return null;

  const cancel = async (id: string) => {
    try { await api.cancelRun(id); } catch (e: any) { toast.error('取消失败', { description: e.message }); }
  };

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className={clsx('queue-chip', running && 'is-running')} aria-label={`任务队列 ${queue.length}`}>
          <Layers size={13} strokeWidth={2.4} aria-hidden />
          <span className="queue-chip__text">
            {running ? <>生成中 · {Math.floor(running.progress * 100)}%</> : <>任务队列</>}
          </span>
          <span className="queue-chip__n">{queue.length}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="qmenu" align="end" sideOffset={6} collisionPadding={12}>
          <header className="qmenu__head">
            <span className="qmenu__title">任务队列</span>
            <span className="qmenu__meta">
              {running ? <>1 个在跑 · {queued} 个排队</> : <>{queued} 个排队中</>}
            </span>
          </header>
          <div className="qmenu__list">
            <AnimatePresence initial={false}>
              {queue.map((t, i) => {
                const wf = t.workflowId ? workflows[t.workflowId] : undefined;
                const cat = wf ? CATEGORY[wf.category] : null;
                const Icon = cat?.icon ?? Inbox;
                return (
                  <motion.div
                    key={t.id}
                    layout
                    className={clsx('qrow', `qrow--${t.status}`)}
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -12, transition: { duration: 0.14 } }}
                    transition={{ type: 'spring', stiffness: 460, damping: 32 }}
                  >
                    <span className={clsx('qrow__dot', `qrow__dot--${t.status}`)} aria-hidden />
                    <span className="qrow__pos">{i + 1}</span>
                    <button
                      type="button"
                      className="qrow__body"
                      onClick={() => { if (wf) { openApp(wf.id); focusRun(t.id); } }}
                      title={t.label}
                    >
                      <span className="qrow__title">
                        <Icon size={11} strokeWidth={2.4} aria-hidden />
                        <span className="qrow__wf">{wf?.name ?? '未知工作流'}</span>
                      </span>
                      <span className="qrow__label">{t.label}</span>
                      <span className="qrow__meta"><Status task={t} /></span>
                    </button>
                    <Tip label={t.status === 'queued' ? '从任务队列移除' : t.status === 'pending' ? '从 ComfyUI 队列移除' : '中断生成'}>
                      <button className="qrow__cancel" onClick={() => cancel(t.id)} aria-label="取消">
                        {t.status === 'running' ? <CircleStop size={13} /> : <X size={13} strokeWidth={2.4} />}
                      </button>
                    </Tip>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
          <footer className="qmenu__foot">
            <span>调度器把它们按顺序一个一个提交给 ComfyUI。</span>
            <Popover.Close asChild>
              <button className="qmenu__all" onClick={() => openTask(null)}>全部任务<ArrowRight size={11} strokeWidth={2.6} /></button>
            </Popover.Close>
          </footer>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Status({ task }: { task: Task }) {
  if (task.status === 'running') {
    const pct = Math.floor(task.progress * 100);
    const cur = task.currentNode?.title;
    return <>生成中 · {pct}%{cur && ` · ${cur}`}</>;
  }
  if (task.status === 'queued' || task.status === 'pending') {
    return <>{STATUS_TEXT[task.status]} · 提交于 {fmtAgo(task.submittedAt)}</>;
  }
  return <>{STATUS_TEXT[task.status]} · {fmtDuration(Date.now() - task.submittedAt)}</>;
}
