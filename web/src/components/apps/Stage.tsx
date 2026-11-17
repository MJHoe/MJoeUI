import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  CircleStop, Copy, Download, FileInput, FolderOpen, Maximize2, Star, Trash2, TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { api } from '../../api';
import { runsOf, useStore } from '../../store';
import { tiltOf } from '../../lib/category';
import { copyText, fmtBytes, fmtClock, fmtDuration, pad2, tailPath } from '../../lib/format';
import { reuseRun, revealArtifact, toggleStar } from '../../lib/actions';
import type { Artifact, Task } from '../../types';
import { ConfirmDialog, IconButton, IconLink, JellyDots, Tip, revealLabel } from '../ui';
import { Media } from '../Sticker';
import { Lightbox } from '../Lightbox';
import { NodeRail } from './NodeRail';

export const STATUS_TEXT: Record<Task['status'], string> = {
  queued: '排队中',
  pending: '等待 ComfyUI',
  running: '生成中',
  success: '已完成',
  error: '失败',
  cancelled: '已取消',
};

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export function useFocusedRun(): Task | null {
  return useStore((s) => {
    if (s.focusRunId && s.tasks[s.focusRunId]?.workflowId === s.currentId) return s.tasks[s.focusRunId];
    let best: Task | null = null;
    for (const t of Object.values(s.tasks)) {
      if (t.workflowId === s.currentId && (!best || t.submittedAt > best.submittedAt)) best = t;
    }
    return best;
  });
}

export function Stage() {
  const task = useFocusedRun();
  const [outIndex, setOutIndex] = useState(0);
  const [zoom, setZoom] = useState(false);
  useEffect(() => { setOutIndex(0); }, [task?.id]);

  if (!task) return <EmptyStage />;
  const art = task.artifacts[outIndex] ?? task.artifacts[0];

  return (
    <div className="stage">
      <StageBar task={task} art={art} onZoom={() => setZoom(true)} />
      <div className="stage__viewport">
        <Frame task={task} art={art} onZoom={() => setZoom(true)} />
      </div>
      <StageFoot task={task} outIndex={outIndex} onOutIndex={setOutIndex} />
      {task.status === 'success' && task.artifacts.length > 0 && (
        <Lightbox items={task.artifacts} index={outIndex} onIndex={setOutIndex} open={zoom} onOpenChange={setZoom} caption={task.label} />
      )}
    </div>
  );
}

// ─── bar ────────────────────────────────────────────────────────────────────
function StageBar({ task, art, onZoom }: { task: Task; art?: Artifact; onZoom: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const runNo = useStore((s) => {
    const runs = runsOf(s.tasks, task.workflowId);
    return runs.length - runs.findIndex((t) => t.id === task.id);
  });
  const live = task.status === 'queued' || task.status === 'pending' || task.status === 'running';

  const cancel = async () => {
    try { await api.cancelRun(task.id); } catch (e: any) { toast.error('取消失败', { description: e.message }); }
  };

  return (
    <header className="stage__bar">
      <span className="run-no" aria-label={`第 ${runNo} 次`}>#{pad2(runNo)}</span>
      <div className="stage__title">
        <span className="stage__label" title={task.meta?.prompt ?? task.label}>{task.label}</span>
        <span className="stage__sub">
          <span className={clsx('status', `status--${task.status}`)}><span className="status__dot" aria-hidden />{STATUS_TEXT[task.status]}</span>
          <span>{fmtClock(task.submittedAt)}</span>
        </span>
      </div>
      <div className="stage__actions">
        {live && (
          <Tip label={task.status === 'queued' ? '从任务队列移除' : task.status === 'pending' ? '从 ComfyUI 队列移除' : '中断这次生成'}>
            <button className="btn btn--default btn--sm" onClick={cancel}><CircleStop size={14} />取消</button>
          </Tip>
        )}
        {task.status === 'success' && art && (
          <>
            <IconButton label={art.starred ? '取消收藏' : '收藏'} onClick={() => toggleStar(art)} className={clsx(art.starred && 'is-starred')}>
              <Star size={16} fill={art.starred ? 'currentColor' : 'none'} />
            </IconButton>
            <IconButton label="放大查看" onClick={onZoom}><Maximize2 size={16} /></IconButton>
            <IconLink label="下载" href={art.url} download={art.filename}><Download size={16} /></IconLink>
            <IconButton label={revealLabel} onClick={() => revealArtifact(art)}><FolderOpen size={16} /></IconButton>
          </>
        )}
        {!live && <IconButton label="把这次的参数载入表单" onClick={() => reuseRun(task.id)}><FileInput size={16} /></IconButton>}
        {!live && <IconButton label="删除这次运行" onClick={() => setConfirm(true)}><Trash2 size={16} /></IconButton>}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="删除这次运行？"
        body={<>运行记录和它的 {task.artifacts.length} 个制品会从库里移除。</>}
        fileOption={task.artifacts.length ? '同时删除磁盘上的文件' : undefined}
        confirmLabel="删除"
        onConfirm={async (files) => {
          try { await api.deleteRun(task.id, files); } catch (e: any) { toast.error('删除失败', { description: e.message }); }
        }}
      />
    </header>
  );
}

// ─── the big sticker ────────────────────────────────────────────────────────
function Frame({ task, art, onZoom }: { task: Task; art?: Artifact; onZoom: () => void }) {
  const preview = useStore((s) => s.previews[task.id]);
  const queue = useStore((s) => s.queue);
  // only slap the sticker in when the user watched this run finish
  const watched = useRef<{ id: string; live: boolean } | null>(null);
  if (watched.current?.id !== task.id) watched.current = { id: task.id, live: task.status !== 'success' };

  const w = art?.width ?? task.meta?.width ?? 1;
  const h = art?.height ?? task.meta?.height ?? 1;
  const ar = Number.isFinite(w / h) && w / h > 0 ? w / h : 1;
  const deg = tiltOf(task.id, 0.9);
  const live = task.status === 'running' || task.status === 'pending' || task.status === 'queued';

  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div
        key={`${task.id}:${task.status === 'success' ? art?.id ?? 'none' : 'live'}`}
        className={clsx('frame', `frame--${task.status}`)}
        style={{ '--ar': ar } as CSSProperties}
        initial={task.status === 'success' && watched.current.live
          ? { scale: 1.18, rotate: deg + 7, opacity: 0, y: -18 }
          : { opacity: 0, scale: 0.98 }}
        animate={{ scale: 1, rotate: deg, opacity: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
        transition={{ type: 'spring', stiffness: 420, damping: 22 }}
      >
        {task.status === 'success' && art && (
          <button className="frame__media" onClick={onZoom} aria-label="放大查看">
            <Media media={art} alt={task.label} autoPlay={art.kind === 'video'} />
          </button>
        )}
        {task.status === 'success' && !art && (
          <p className="frame__note">跑完了，但没有产出可保存的文件。<br />检查输出节点是不是 SaveImage / 视频合成节点。</p>
        )}
        {live && (
          <div className="frame__live">
            {preview ? (
              <img src={preview} alt="" className="frame__latent" style={{ '--p': task.progress } as CSSProperties} />
            ) : (
              <div className="frame__wait">
                <JellyDots />
                <span>
                  {task.status === 'queued' ? '在任务队列里等 ComfyUI'
                    : task.status === 'pending' ? (queue > 1 ? `排队中 · 前面还有 ${queue - 1} 个` : '排队中')
                    : '正在准备…'}
                </span>
              </div>
            )}
          </div>
        )}
        {(task.status === 'error' || task.status === 'cancelled') && (
          <div className="frame__void">
            <TriangleAlert size={26} />
            <span>{task.status === 'error' ? '这一张没能生成' : '已取消'}</span>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}

// ─── footer ─────────────────────────────────────────────────────────────────
function StageFoot({ task, outIndex, onOutIndex }: { task: Task; outIndex: number; onOutIndex: (i: number) => void }) {
  const live = task.status === 'running' || task.status === 'pending' || task.status === 'queued';
  const now = useNow(live);

  if (live) {
    const pct = Math.floor(task.progress * 100);
    const cur = task.currentNode;
    const step = cur?.progress && cur.progress.max > 1 ? `${cur.progress.value}/${cur.progress.max} 步` : null;
    const queued = task.status === 'queued' || task.status === 'pending';
    return (
      <footer className="stage__foot stage__foot--live">
        <div className="live">
          <span className="live__pct"><b>{pct}</b>%</span>
          <div className="live__main">
            <div className={clsx('jelly-bar', queued && 'jelly-bar--queue')} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <motion.span className="jelly-bar__fill" animate={{ width: `${Math.max(3, pct)}%` }} transition={{ type: 'spring', stiffness: 120, damping: 22 }} />
            </div>
            <div className="live__text">
              <span className="live__node">
                {task.saving ? '保存到本地'
                  : task.status === 'queued' ? '在任务队列里等'
                  : task.status === 'pending' ? '等 ComfyUI 空出来'
                  : cur ? <>{cur.title}{step && <em>{step}</em>}</>
                  : '准备中'}
              </span>
              <span className="live__clock">
                {task.startedAt ? `已用 ${fmtDuration(now - task.startedAt)}` : `已排队 ${fmtDuration(now - task.submittedAt)}`}
                {task.etaMs != null && task.startedAt && !task.saving && ` · 还需约 ${fmtDuration(task.etaMs)}`}
                {task.nodesTotal > 0 && ` · ${task.nodesDone}/${task.nodesTotal} 节点`}
              </span>
            </div>
          </div>
        </div>
        <NodeRail task={task} />
      </footer>
    );
  }

  if (task.status === 'success') {
    const m = task.meta ?? {};
    const i = task.artifacts[outIndex] ? outIndex : 0;
    const a = task.artifacts[i];
    return (
      <footer className="stage__foot">
        {task.artifacts.length > 1 && (
          <div className="outs" role="tablist" aria-label="本次制品">
            {task.artifacts.map((o, k) => (
              <button key={o.id} role="tab" aria-selected={k === i} className={clsx('outs__thumb', k === i && 'is-active')} onClick={() => onOutIndex(k)}>
                <Media media={o} alt={`制品 ${k + 1}`} />
              </button>
            ))}
          </div>
        )}
        <div className="chips">
          {m.seed != null && (
            <Tip label="复制种子">
              <button className="chip chip--btn" onClick={() => copyText(String(m.seed), '种子')}>
                <span className="chip__k">种子</span><span className="chip__v mono">{m.seed}</span><Copy size={11} />
              </button>
            </Tip>
          )}
          {m.steps != null && <span className="chip"><span className="chip__k">步数</span><span className="chip__v">{m.steps}</span></span>}
          {m.cfg != null && <span className="chip"><span className="chip__k">CFG</span><span className="chip__v">{m.cfg}</span></span>}
          {m.sampler && <span className="chip"><span className="chip__k">采样</span><span className="chip__v">{m.sampler}{m.scheduler && ` · ${m.scheduler}`}</span></span>}
          {a?.width && <span className="chip"><span className="chip__k">尺寸</span><span className="chip__v">{a.width}×{a.height}</span></span>}
          {task.startedAt && task.completedAt && (
            <span className="chip"><span className="chip__k">用时</span><span className="chip__v">{fmtDuration(task.completedAt - task.startedAt)}</span></span>
          )}
          {a && (
            <Tip label={`${revealLabel} · ${a.path}`}>
              <button className="chip chip--btn chip--file" onClick={() => revealArtifact(a)}>
                <FolderOpen size={11} /><span className="chip__v mono">{tailPath(a.path)}</span><span className="chip__k">{fmtBytes(a.bytes)}</span>
              </button>
            </Tip>
          )}
        </div>
      </footer>
    );
  }

  return (
    <footer className="stage__foot stage__foot--fail">
      <div className="fail">
        <b>{task.status === 'cancelled' ? '这次生成被取消了' : '生成失败'}</b>
        {task.error && task.status === 'error' && <pre className="fail__msg">{task.error}</pre>}
        <p className="fail__hint">
          {task.status === 'error'
            ? '改好参数后再生成一次。'
            : '已经跑完的节点还在 ComfyUI 缓存里，重新生成会更快。'}
        </p>
      </div>
      <NodeRail task={task} />
    </footer>
  );
}

// ─── nothing yet ────────────────────────────────────────────────────────────
function EmptyStage() {
  const ready = useStore((s) => !!(s.currentId && s.graphs[s.currentId]));
  return (
    <div className="stage stage--empty">
      <div className="stage__viewport">
        <motion.div
          className="frame frame--ghost"
          style={{ '--ar': 1 } as CSSProperties}
          initial={{ opacity: 0, rotate: -4, scale: 0.94 }}
          animate={{ opacity: 1, rotate: -1.5, scale: 1 }}
          transition={{ type: 'spring', stiffness: 260, damping: 20 }}
        >
          <div className="frame__intro">
            <b>{ready ? '这里会贴上第一张作品' : '正在载入工作流…'}</b>
            <span>{ready ? '准备好提示词或素材，按「生成」。过程会实时显示在这里。' : ''}</span>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
