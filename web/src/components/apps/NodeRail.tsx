import clsx from 'clsx';
import type { Task } from '../../types';
import { Tip } from '../ui';

type SegState = 'done' | 'cached' | 'current' | 'pending' | 'error';

export function NodeRail({ task }: { task: Task }) {
  const nodes = task.nodes;
  if (!nodes?.length) return null;
  const done = new Set(task.doneNodes ?? []);
  const cached = new Set(task.cachedNodes ?? []);
  const failed = task.status === 'error' || task.status === 'cancelled' ? task.errorNode : undefined;

  const stateOf = (id: string): SegState => {
    if (failed === id) return 'error';
    if (task.currentNode?.id === id && task.status === 'running') return 'current';
    if (cached.has(id)) return 'cached';
    if (done.has(id)) return 'done';
    return 'pending';
  };
  const label: Record<SegState, string> = {
    done: '已完成', cached: '命中缓存，跳过', current: '执行中', pending: '等待', error: task.status === 'cancelled' ? '在这里停止' : '在这里出错',
  };
  const dense = nodes.length > 48;

  return (
    <div className={clsx('rail', dense && 'rail--dense')} role="list" aria-label="节点执行进度">
      {nodes.map((n) => {
        const st = stateOf(n.id);
        const p = st === 'current' && task.currentNode?.progress
          ? task.currentNode.progress.value / Math.max(1, task.currentNode.progress.max)
          : 0;
        return (
          <Tip key={n.id} label={<><b>{n.title}</b><span className="tip__sub">#{n.id} · {n.className} · {label[st]}</span></>}>
            <span role="listitem" className={clsx('rail__seg', `is-${st}`)} aria-label={`${n.title}：${label[st]}`}>
              {st === 'current' && <span className="rail__fill" style={{ transform: `scaleX(${Math.max(0.04, p)})` }} />}
            </span>
          </Tip>
        );
      })}
    </div>
  );
}
