import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Copy, Download, Play, Star, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { api } from '../../api';
import { runsOf, useStore } from '../../store';
import { CATEGORY } from '../../lib/category';
import { copyText, fmtAgo, fmtClock, fmtDuration } from '../../lib/format';
import { parseWorkflow } from '../../lib/workflow';
import { swap } from '../../lib/motion';
import type { Artifact, Task, WorkflowSummary } from '../../types';
import { Button, ConfirmDialog, IconButton, JellyDots, Tape, Tip } from '../ui';
import { Sticker } from '../Sticker';
import { JsonEditor } from '../JsonEditor';
import { ArtifactSheet } from './ArtifactSheet';
import { STATUS_TEXT } from './Stage';
import { UseTab } from './UseTab';

export function AppDetail({ w }: { w: WorkflowSummary }) {
  const tab = useStore((s) => s.appTab);
  const setTab = useStore((s) => s.setAppTab);
  const [sel, setSel] = useState<string | null>(null);
  const [onlyStarred, setOnlyStarred] = useState(false);
  const artifacts = useStore((s) => s.artifacts[w.id]);
  const loadArtifacts = useStore((s) => s.loadArtifacts);
  const tasks = useStore((s) => s.tasks);
  const runs = useMemo(() => runsOf(tasks, w.id), [tasks, w.id]);

  useEffect(() => {
    setSel(null);
    setOnlyStarred(false);
    // 制品 tab fetches on demand; Use tab doesn't need the full list
    if (tab === 'artifacts') {
      loadArtifacts(w.id).catch((e) => toast.error('读取制品失败', { description: e.message }));
    }
  }, [w.id, tab, loadArtifacts]);

  const list = useMemo(
    () => (artifacts ?? []).filter((a) => !onlyStarred || a.starred),
    [artifacts, onlyStarred],
  );
  const selected = sel ? list.find((a) => a.id === sel) ?? (artifacts ?? []).find((a) => a.id === sel) : undefined;
  const starredCount = (artifacts ?? []).filter((a) => a.starred).length;

  return (
    <div className={clsx('wdetail', `wdetail--${tab}`, selected && tab === 'artifacts' && 'has-sheet')}>
      <div className="wdetail__main">
        <div className="wdetail__body">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={tab} className={clsx('wdetail__tab', `wdetail__tab--${tab}`)} {...swap}>
              {tab === 'use' && <UseTab />}
              {tab === 'artifacts' && (
                <>
                  {starredCount > 0 && (
                    <div className="tabbar">
                      <span className="tabbar__title">全部制品<span className="tabbar__n">{artifacts?.length ?? 0}</span></span>
                      <span className="field__spacer" />
                      <button className={clsx('cat-pill', onlyStarred && 'is-on')} onClick={() => setOnlyStarred(!onlyStarred)} aria-pressed={onlyStarred}>
                        <Star size={11} fill={onlyStarred ? 'currentColor' : 'none'} />只看收藏<span>{starredCount}</span>
                      </button>
                    </div>
                  )}
                  {!artifacts ? <div className="page-center"><JellyDots /></div>
                    : list.length ? <ArtifactGrid list={list} selected={sel} onSelect={setSel} />
                      : <EmptyArtifacts w={w} starred={onlyStarred} onUse={() => setTab('use')} />}
                </>
              )}
              {tab === 'runs' && (
                <>
                  <AppSummary w={w} />
                  <RunsTable runs={runs} artifacts={artifacts ?? []} onOpenArtifact={(id) => { setSel(id); setTab('artifacts'); }} />
                </>
              )}
              {tab === 'json' && <JsonTab w={w} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
      <AnimatePresence>
        {selected && tab === 'artifacts' && (
          <ArtifactSheet key="sheet" artifact={selected} list={list} onSelect={setSel} onClose={() => setSel(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── summary (top of 运行记录) ───────────────────────────────────────────────
function AppSummary({ w }: { w: WorkflowSummary }) {
  const rate = w.stats.runs ? Math.round((w.stats.success / w.stats.runs) * 100) : null;
  return (
    <section className="appsum" aria-label="应用概况">
      <div className="appsum__tags">
        <Tape category={w.category} size="sm" tilt={0} />
        {w.baseModel && <span className="model-chip">{w.baseModel}</span>}
        <Tip label="应用编号，也是制品文件夹的名字。点击复制">
          <button className="id-chip" onClick={() => copyText(w.id, '应用编号')}>{w.id}<Copy size={10} /></button>
        </Tip>
        {w.note && <span className="appsum__note">{w.note}</span>}
      </div>
      <dl className="appsum__stats">
        <div><dt>生成</dt><dd>{w.stats.runs}<small>次</small></dd></div>
        <div><dt>成功率</dt><dd>{rate ?? '—'}{rate != null && <small>%</small>}</dd></div>
        <div><dt>制品</dt><dd>{w.stats.artifacts}<small>个</small></dd></div>
        <div><dt>平均用时</dt><dd>{w.stats.avgMs != null ? fmtDuration(w.stats.avgMs) : '—'}</dd></div>
        <div><dt>上次使用</dt><dd className="appsum__ago">{fmtAgo(w.lastRunAt)}</dd></div>
      </dl>
    </section>
  );
}

// ─── artifacts ──────────────────────────────────────────────────────────────
function ArtifactGrid({ list, selected, onSelect }: { list: Artifact[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="agrid">
      <AnimatePresence initial={false}>
        {list.map((a, i) => (
          <motion.div
            key={a.id}
            layout
            className="agrid__cell"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1, transition: { delay: Math.min(i, 24) * 0.018 } }}
            exit={{ opacity: 0, scale: 0.7, transition: { duration: 0.15 } }}
            transition={{ type: 'spring', stiffness: 460, damping: 32 }}
          >
            <Sticker id={a.id} media={a} selected={selected === a.id} onClick={() => onSelect(a.id)} label={a.filename}>
              {a.starred && <span className="sticker__star"><Star size={10} fill="currentColor" /></span>}
              {a.kind === 'video' && <span className="sticker__kind">视频</span>}
            </Sticker>
            <span className="agrid__cap">
              <span className="mono">{a.meta?.seed ?? a.filename}</span>
              <span>{fmtClock(a.createdAt)}</span>
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function EmptyArtifacts({ w, starred, onUse }: { w: WorkflowSummary; starred: boolean; onUse: () => void }) {
  return (
    <div className="empty">
      <div className="empty__sticker" aria-hidden><Tape category={w.category} /></div>
      <b>{starred ? '还没有收藏的制品' : '这个应用还没有作品'}</b>
      <span>{starred ? '在制品详情里点「收藏」，它会出现在这里，也会成为封面。' : `${CATEGORY[w.category].label}的结果会按日期存到 ${w.id} 文件夹，并显示在这里。`}</span>
      {!starred && <Button variant="ink" onClick={onUse}><Play size={13} fill="currentColor" />使用这个应用</Button>}
    </div>
  );
}

// ─── runs ───────────────────────────────────────────────────────────────────
function RunsTable({ runs, artifacts, onOpenArtifact }: { runs: Task[]; artifacts: Artifact[]; onOpenArtifact: (id: string) => void }) {
  const [del, setDel] = useState<Task | null>(null);
  const known = useMemo(() => new Set(artifacts.map((a) => a.id)), [artifacts]);
  if (!runs.length) return <div className="empty"><b>还没有运行记录</b><span>每次按「生成」都会在这里留一条。</span></div>;
  return (
    <>
      <table className="runs">
        <thead>
          <tr><th>状态</th><th>时间</th><th className="runs__label">内容</th><th>用时</th><th>制品</th><th aria-label="操作" /></tr>
        </thead>
        <tbody>
          {runs.map((t) => {
            const first = t.artifacts.find((a) => known.has(a.id));
            return (
              <tr key={t.id} className={clsx(first && 'is-clickable')} onClick={() => first && onOpenArtifact(first.id)}>
                <td><span className={clsx('status', `status--${t.status}`)}><span className="status__dot" />{STATUS_TEXT[t.status]}</span></td>
                <td className="mono runs__time">{fmtClock(t.submittedAt)}</td>
                <td className="runs__label" title={t.error ?? t.meta?.prompt ?? t.label}>
                  {t.status === 'error' ? <span className="runs__err">{t.error?.split('\n')[0]}</span> : t.label}
                </td>
                <td className="mono">{t.startedAt && t.completedAt ? fmtDuration(t.completedAt - t.startedAt) : '—'}</td>
                <td>
                  <span className="runs__thumbs">
                    {t.artifacts.slice(0, 3).map((a) => <img key={a.id} src={a.url} alt="" loading="lazy" />)}
                    {!t.artifacts.length && '—'}
                  </span>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  {t.status !== 'pending' && t.status !== 'running' && (
                    <IconButton label="删除这次运行" size="sm" onClick={() => setDel(t)}><Trash2 size={13} /></IconButton>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ConfirmDialog
        open={!!del}
        onOpenChange={(v) => { if (!v) setDel(null); }}
        title="删除这次运行？"
        body={<>运行记录和它的 {del?.artifacts.length ?? 0} 个制品会从库里移除。</>}
        fileOption={del?.artifacts.length ? '同时删除磁盘上的文件' : undefined}
        confirmLabel="删除"
        onConfirm={async (files) => {
          if (!del) return;
          try { await api.deleteRun(del.id, files); } catch (e: any) { toast.error('删除失败', { description: e.message }); }
        }}
      />
    </>
  );
}

// ─── json ───────────────────────────────────────────────────────────────────
function JsonTab({ w }: { w: WorkflowSummary }) {
  const ensureGraph = useStore((s) => s.ensureGraph);
  const graph = useStore((s) => s.graphs[w.id]?.json);
  const putWorkflow = useStore((s) => s.putWorkflow);
  const original = useMemo(() => (graph ? JSON.stringify(graph, null, 2) : ''), [graph]);
  const [text, setText] = useState(original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { ensureGraph(w.id).catch(() => {}); }, [w.id, w.updatedAt, ensureGraph]);
  useEffect(() => { setText(original); setError(null); }, [original]);

  if (!graph) return <div className="page-center"><JellyDots /></div>;
  const dirty = text !== original;

  const save = async () => {
    const parsed = parseWorkflow(text);
    if (!parsed.ok) { setError(parsed.error); return; }
    setBusy(true);
    try {
      const { workflow } = await api.updateWorkflow(w.id, { json: parsed.workflow });
      putWorkflow(workflow);
      toast.success('工作流 JSON 已更新', { description: '新的默认值从下一次生成开始生效。' });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([original], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${w.name.replace(/[\\/:*?"<>|]+/g, '_')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="jsontab">
      <div className="jsontab__bar">
        <span className="jsontab__hint">导入时的完整原始 JSON，原样保存。使用页改过的参数单独存在数据库里，生成和 API 调用时叠加在它上面。</span>
        <span className="field__spacer" />
        <Button size="sm" variant="ghost" onClick={() => copyText(original, 'JSON')}><Copy size={13} />复制</Button>
        <Button size="sm" variant="ghost" onClick={download}><Download size={13} />下载</Button>
        <AnimatePresence>
          {dirty && (
            <motion.span className="jsontab__save" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }}>
              <Button size="sm" variant="ghost" onClick={() => setText(original)} disabled={busy}>撤销</Button>
              <Button size="sm" variant="ink" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存修改'}</Button>
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      {error && <p className="form-error" role="alert"><TriangleAlert size={14} />{error}</p>}
      <JsonEditor value={text} onChange={(v) => { setText(v); setError(null); }} height="100%" />
    </div>
  );
}
