import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowUpRight, CircleStop, Copy, FileInput, ImageOff, Inbox, ListOrdered, Search, Trash2, X,
} from 'lucide-react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { api } from '../api';
import { queueOf, useStore } from '../store';
import { copyText, fmtClock, fmtDateTime, fmtDuration } from '../lib/format';
import { reuseRun } from '../lib/actions';
import type { Task, TaskStatus, WorkflowSummary } from '../types';
import { Button, ConfirmDialog, IconButton, Tip } from './ui';
import { Cover } from './Cover';
import { Sticker } from './Sticker';
import { Lightbox } from './Lightbox';
import { STATUS_TEXT } from './apps/Stage';

type Filter = 'all' | 'success' | 'error' | 'cancelled';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'success', label: '已完成' },
  { id: 'error', label: '失败' },
  { id: 'cancelled', label: '已取消' },
];
const LIVE: ReadonlySet<TaskStatus> = new Set(['queued', 'pending', 'running']);
const isLive = (t: Task) => LIVE.has(t.status);

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

const waitOf = (t: Task, now: number) => (t.startedAt ?? (isLive(t) ? now : t.completedAt ?? now)) - t.submittedAt;
const runOf = (t: Task, now: number) => (t.startedAt ? (t.completedAt ?? now) - t.startedAt : null);
const shortId = (id: string) => id.slice(0, 8);

/**
 * 任务 — every submission to ComfyUI, from the Use page or the app API.
 * Top: our FIFO (one task at a time goes to ComfyUI). Below: the history.
 * Click any row to see its ids, timings and the artifacts it produced.
 */
export function TasksPage() {
  const tasks = useStore((s) => s.tasks);
  const workflows = useStore((s) => s.workflows);
  const selId = useStore((s) => s.taskSel);
  const openTask = useStore((s) => s.openTask);
  const [filter, setFilter] = useState<Filter>('all');
  const [app, setApp] = useState<string>('all');
  const [q, setQ] = useState('');

  const queue = useMemo(() => queueOf(tasks), [tasks]);
  const history = useMemo(
    () => Object.values(tasks).filter((t) => !isLive(t)).sort((a, b) => b.submittedAt - a.submittedAt),
    [tasks],
  );
  const now = useNow(queue.length > 0);

  const counts = useMemo(() => {
    const c = { all: history.length, success: 0, error: 0, cancelled: 0 } as Record<Filter, number>;
    for (const t of history) if (t.status in c) c[t.status as Filter]++;
    return c;
  }, [history]);

  /** apps that appear in the history, for the app filter */
  const apps = useMemo(() => {
    const m = new Map<string, { id: string; name: string; n: number }>();
    for (const t of history) {
      const id = t.workflowId ?? '';
      const name = (t.workflowId && workflows[t.workflowId]?.name) || t.appName || '已删除的应用';
      const e = m.get(id) ?? { id, name, n: 0 };
      e.n++;
      m.set(id, e);
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  }, [history, workflows]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return history.filter((t) => {
      if (filter !== 'all' && t.status !== filter) return false;
      if (app !== 'all' && (t.workflowId ?? '') !== app) return false;
      if (!needle) return true;
      const name = (t.workflowId && workflows[t.workflowId]?.name) || t.appName || '';
      return [t.id, t.promptId, t.label, name, t.meta?.prompt].some((s) => s?.toLowerCase().includes(needle));
    });
  }, [history, filter, app, q, workflows]);

  const selected = selId ? tasks[selId] : undefined;
  const running = queue.find((t) => t.status === 'running');

  return (
    <div className={clsx('tasks', selected && 'has-sheet')}>
      <div className="tasks__main">
        <div className="tasks__scroll">
          {/* ─── queue ─────────────────────────────────────────────────── */}
          <section className="tasks__sec" aria-label="任务队列">
            <header className="tasks__h">
              <ListOrdered size={15} strokeWidth={2.3} aria-hidden />
              <h2>队列</h2>
              <span className="tabbar__n">{queue.length}</span>
              <span className="tasks__hint">
                {running ? <span>1 个在跑 · {queue.length - 1} 个等待</span> : queue.length ? <span>{queue.length} 个等待</span> : null}
                {queue.length > 0 && <span aria-hidden>·</span>}
                <span className="tasks__rule">按提交顺序，一次只交给 ComfyUI 一个，上一个结束才提交下一个</span>
              </span>
            </header>
            {queue.length ? (
              <ol className="tq">
                <AnimatePresence initial={false}>
                  {queue.map((t, i) => (
                    <QueueRow
                      key={t.id}
                      t={t}
                      pos={i + 1}
                      w={t.workflowId ? workflows[t.workflowId] : undefined}
                      now={now}
                      selected={t.id === selId}
                      onOpen={() => openTask(t.id)}
                    />
                  ))}
                </AnimatePresence>
              </ol>
            ) : (
              <div className="tq__empty">
                <Inbox size={16} aria-hidden />
                队列是空的。在应用里按「生成」或者调用应用 API，任务会先排到这里，再一个一个交给 ComfyUI。
              </div>
            )}
          </section>

          {/* ─── history ───────────────────────────────────────────────── */}
          <section className="tasks__sec" aria-label="历史任务">
            <header className="tasks__h tasks__h--bar">
              <h2>历史</h2>
              <div className="tasks__filters" role="group" aria-label="按状态筛选">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    className={clsx('cat-pill', `tf--${f.id}`, filter === f.id && 'is-on')}
                    aria-pressed={filter === f.id}
                    onClick={() => setFilter(f.id)}
                  >
                    {f.label}<span>{counts[f.id]}</span>
                  </button>
                ))}
              </div>
              <span className="field__spacer" />
              {apps.length > 1 && (
                <select className="tasks__app" value={app} onChange={(e) => setApp(e.target.value)} aria-label="按应用筛选">
                  <option value="all">全部应用</option>
                  {apps.map((a) => <option key={a.id} value={a.id}>{a.name}（{a.n}）</option>)}
                </select>
              )}
              <label className="search tasks__search">
                <Search size={13} aria-hidden />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索内容、任务号…" aria-label="搜索任务" />
                {q && <button className="search__clear" onClick={() => setQ('')} aria-label="清空"><X size={12} /></button>}
              </label>
            </header>

            {rows.length ? (
              <table className="runs ttable">
                <thead>
                  <tr>
                    <th>状态</th>
                    <th className="ttable__app">应用</th>
                    <th className="runs__label">内容</th>
                    <th>来源</th>
                    <th>ComfyUI 任务号</th>
                    <th>提交时间</th>
                    <th>等待 / 用时</th>
                    <th>制品</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <HistoryRow
                      key={t.id}
                      t={t}
                      w={t.workflowId ? workflows[t.workflowId] : undefined}
                      selected={t.id === selId}
                      onOpen={() => openTask(t.id)}
                    />
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty">
                <b>{history.length ? '没有符合条件的任务' : '还没有任务记录'}</b>
                <span>{history.length ? '换个筛选条件试试。' : '跑完的任务都会记在这里：哪个应用提交的、ComfyUI 的任务号、生成了什么。'}</span>
              </div>
            )}
          </section>
        </div>
      </div>

      <AnimatePresence>
        {selected && (
          <TaskSheet
            key="sheet"
            t={selected}
            w={selected.workflowId ? workflows[selected.workflowId] : undefined}
            pos={queue.indexOf(selected) + 1}
            now={now}
            onClose={() => openTask(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── pieces ─────────────────────────────────────────────────────────────────
function AppName({ t, w, size = 20 }: { t: Task; w?: WorkflowSummary; size?: number }) {
  if (w) {
    return (
      <span className="tapp">
        <Cover w={w} size={size} tilt={false} />
        <span className="tapp__name">{w.name}</span>
      </span>
    );
  }
  return (
    <span className="tapp is-gone" title="这个应用已经被删除">
      <span className="tapp__ph" style={{ width: size, height: size }}><ImageOff size={11} /></span>
      <span className="tapp__name">{t.appName ?? '已删除的应用'}</span>
    </span>
  );
}

function Source({ t }: { t: Task }) {
  return t.source === 'api'
    ? <span className="tsrc tsrc--api">API</span>
    : <span className="tsrc">界面</span>;
}

function PromptId({ t, full }: { t: Task; full?: boolean }) {
  if (!t.promptId) return <span className="tpid is-none">{t.status === 'queued' ? '还没提交' : '—'}</span>;
  return (
    <Tip label={full ? '点击复制' : `${t.promptId} · 点击复制`}>
      <button
        className="copyable mono tpid"
        onClick={(e) => { e.stopPropagation(); void copyText(t.promptId!, 'ComfyUI 任务号'); }}
      >
        {full ? t.promptId : shortId(t.promptId)}<Copy size={10} />
      </button>
    </Tip>
  );
}

function QueueRow({ t, pos, w, now, selected, onOpen }: {
  t: Task; pos: number; w?: WorkflowSummary; now: number; selected: boolean; onOpen: () => void;
}) {
  const cancel = async (e: MouseEvent) => {
    e.stopPropagation();
    try { await api.cancelRun(t.id); } catch (err: any) { toast.error('取消失败', { description: err.message }); }
  };
  const pct = Math.floor(t.progress * 100);
  const run = runOf(t, now);
  return (
    <motion.li
      layout
      className={clsx('tq__row', `tq__row--${t.status}`, selected && 'is-selected')}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -16, transition: { duration: 0.14 } }}
      transition={{ type: 'spring', stiffness: 460, damping: 34 }}
      onClick={onOpen}
    >
      <span className="tq__pos" aria-label={`第 ${pos} 个`}>{pos}</span>
      <div className="tq__body">
        <div className="tq__line">
          <AppName t={t} w={w} />
          <Source t={t} />
          <span className="tq__label" title={t.label}>{t.label}</span>
        </div>
        <div className="tq__meta">
          <span className={clsx('status', `status--${t.status}`)}><span className="status__dot" aria-hidden />{STATUS_TEXT[t.status]}</span>
          {t.status === 'running' && <span className="mono">{pct}%{t.currentNode?.title && ` · ${t.currentNode.title}`}</span>}
          <span className="mono">提交于 {fmtClock(t.submittedAt)}</span>
          <span className="mono">{run != null ? `已跑 ${fmtDuration(run)}` : `已等 ${fmtDuration(waitOf(t, now))}`}</span>
          <span className="tq__pid">ComfyUI <PromptId t={t} /></span>
        </div>
        {t.status === 'running' && (
          <span className="tbar" aria-hidden><motion.i animate={{ width: `${Math.max(2, pct)}%` }} transition={{ duration: 0.4 }} /></span>
        )}
      </div>
      <Tip label={t.status === 'queued' ? '从队列移除' : t.status === 'pending' ? '从 ComfyUI 队列移除' : '中断生成'}>
        <button className="qrow__cancel tq__cancel" onClick={cancel} aria-label="取消">
          {t.status === 'running' ? <CircleStop size={14} /> : <X size={14} strokeWidth={2.4} />}
        </button>
      </Tip>
    </motion.li>
  );
}

function HistoryRow({ t, w, selected, onOpen }: { t: Task; w?: WorkflowSummary; selected: boolean; onOpen: () => void }) {
  const run = runOf(t, Date.now());
  return (
    <tr className={clsx('is-clickable', selected && 'is-selected')} onClick={onOpen}>
      <td><span className={clsx('status', `status--${t.status}`)}><span className="status__dot" />{STATUS_TEXT[t.status]}</span></td>
      <td className="ttable__app"><AppName t={t} w={w} /></td>
      <td className="runs__label" title={t.error ?? t.meta?.prompt ?? t.label}>
        {t.status === 'error' ? <span className="runs__err">{t.error?.split('\n')[0]}</span> : t.label}
      </td>
      <td><Source t={t} /></td>
      <td><PromptId t={t} /></td>
      <td className="mono runs__time">{fmtDateTime(t.submittedAt)}</td>
      <td className="mono runs__time">
        {t.startedAt ? fmtDuration(waitOf(t, 0)) : '—'} / {run != null ? fmtDuration(run) : '—'}
      </td>
      <td>
        <span className="runs__thumbs">
          {t.artifacts.slice(0, 3).map((a) => (
            a.kind === 'video'
              ? <video key={a.id} src={`${a.url}#t=0.1`} muted preload="metadata" />
              : <img key={a.id} src={a.url} alt="" loading="lazy" />
          ))}
          {t.artifacts.length > 3 && <span className="runs__more">+{t.artifacts.length - 3}</span>}
          {!t.artifacts.length && '—'}
        </span>
      </td>
    </tr>
  );
}

// ─── detail sheet ───────────────────────────────────────────────────────────
function TaskSheet({ t, w, pos, now, onClose }: {
  t: Task; w?: WorkflowSummary; pos: number; now: number; onClose: () => void;
}) {
  const openApp = useStore((s) => s.openApp);
  const focusRun = useStore((s) => s.focusRun);
  const [zoom, setZoom] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const m = t.meta ?? {};
  const live = isLive(t);
  const run = runOf(t, now);
  const name = w?.name ?? t.appName ?? '已删除的应用';

  const cancel = async () => {
    try { await api.cancelRun(t.id); } catch (e: any) { toast.error('取消失败', { description: e.message }); }
  };
  const goApp = () => { if (!w) return; openApp(w.id); focusRun(t.id); };

  return (
    <>
      <motion.aside
        className="sheet tsheet"
        aria-label="任务详情"
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 420, damping: 36 }}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <header className="sheet__bar">
          <span className={clsx('status', `status--${t.status}`)}><span className="status__dot" aria-hidden />{STATUS_TEXT[t.status]}</span>
          {t.status === 'queued' && pos > 0 && <span className="tsheet__pos">队列第 {pos} 个</span>}
          <span className="field__spacer" />
          <IconButton label="关闭 (Esc)" size="sm" onClick={onClose}><X size={15} /></IconButton>
        </header>

        <div className="sheet__scroll">
          <div className="tsheet__head">
            <AppName t={t} w={w} size={28} />
            <p className="tsheet__label">{t.label}</p>
          </div>

          {t.status === 'running' && (
            <div className="tsheet__progress">
              <span className="tbar"><motion.i animate={{ width: `${Math.max(2, Math.floor(t.progress * 100))}%` }} transition={{ duration: 0.4 }} /></span>
              <span className="mono">{Math.floor(t.progress * 100)}% · 节点 {t.nodesDone}/{t.nodesTotal}{t.currentNode?.title && ` · ${t.currentNode.title}`}</span>
            </div>
          )}

          <section aria-label="制品">
            <h3 className="tsheet__h">制品<span className="tabbar__n">{t.artifacts.length}</span></h3>
            {t.artifacts.length ? (
              <div className="tsheet__grid">
                {t.artifacts.map((a, i) => (
                  <Sticker key={a.id} id={a.id} media={a} onClick={() => setZoom(i)} label={`放大 ${a.filename}`}>
                    {a.kind === 'video' && <span className="sticker__kind">视频</span>}
                  </Sticker>
                ))}
              </div>
            ) : (
              <div className="tsheet__none">
                {t.status === 'queued' ? '还在排队，轮到它时才会提交给 ComfyUI。'
                  : t.status === 'pending' ? '已经交给 ComfyUI，等它开始执行。'
                    : t.status === 'running' ? (t.saving ? '生成完了，正在把文件存下来…' : '正在生成，完成后制品会出现在这里。')
                      : t.status === 'success' ? '这次运行没有输出文件，或者文件已经被删掉了。'
                        : '没有制品。'}
              </div>
            )}
          </section>

          {t.error && <pre className="tsheet__err">{t.error}</pre>}

          <dl className="info">
            <Row k="任务号">
              <button className="copyable mono" onClick={() => copyText(t.id, '任务号')}>{t.id}<Copy size={10} /></button>
            </Row>
            <Row k="ComfyUI"><PromptId t={t} full /></Row>
            <Row k="应用">
              {w ? <button className="tsheet__app" onClick={goApp}>{name}<ArrowUpRight size={11} /></button> : <span className="faint">{name}（已删除）</span>}
            </Row>
            <Row k="来源">{t.source === 'api' ? '应用 API（/api/apps/…/run）' : '使用页「生成」'}</Row>
            <Row k="提交">{fmtDateTime(t.submittedAt)}</Row>
            {t.startedAt && <Row k="开始">{fmtDateTime(t.startedAt)}<span className="faint"> · 等了 {fmtDuration(waitOf(t, now))}</span></Row>}
            {t.completedAt && <Row k="结束">{fmtDateTime(t.completedAt)}</Row>}
            {run != null && <Row k="用时">{fmtDuration(run)}</Row>}
            {live && !t.startedAt && <Row k="已等">{fmtDuration(waitOf(t, now))}</Row>}
            {(m.width || m.seed != null || m.steps) && (
              <Row k="参数">
                <span className="mono tsheet__meta">
                  {[m.width && m.height && `${m.width}×${m.height}`, m.seed != null && `seed ${m.seed}`, m.steps && `${m.steps} 步`, m.cfg != null && `cfg ${m.cfg}`]
                    .filter(Boolean).join(' · ')}
                </span>
              </Row>
            )}
            {m.model && <Row k="模型"><span className="mono tsheet__meta">{m.model}</span></Row>}
          </dl>

          {m.prompt && (
            <div className="textblock">
              <span className="tsheet__h">提示词</span>
              <p className="tsheet__prompt">{m.prompt}</p>
            </div>
          )}

          <div className="sheet__actions">
            {w && <Button size="sm" variant="ink" onClick={goApp}><ArrowUpRight size={13} />打开应用</Button>}
            {w && !live && <Button size="sm" onClick={() => reuseRun(t.id)}><FileInput size={13} />用这组参数</Button>}
            <span className="field__spacer" />
            {live
              ? <Button size="sm" onClick={cancel}>{t.status === 'running' ? <CircleStop size={13} /> : <X size={13} />}{t.status === 'running' ? '中断' : '取消'}</Button>
              : <IconButton label="删除这条任务" onClick={() => setConfirm(true)}><Trash2 size={15} /></IconButton>}
          </div>
        </div>
      </motion.aside>

      <Lightbox
        items={t.artifacts}
        index={zoom ?? 0}
        onIndex={setZoom}
        open={zoom != null}
        onOpenChange={(v) => { if (!v) setZoom(null); }}
        caption={`${name} · ${t.label}`}
      />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="删除这条任务？"
        body={<>任务记录和它的 {t.artifacts.length} 个制品会从库里移除。</>}
        fileOption={t.artifacts.length ? '同时删除磁盘上的文件' : undefined}
        confirmLabel="删除"
        onConfirm={async (files) => {
          try { await api.deleteRun(t.id, files); onClose(); } catch (e: any) { toast.error('删除失败', { description: e.message }); throw e; }
        }}
      />
    </>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return <div className="info__row"><dt>{k}</dt><dd>{children}</dd></div>;
}
