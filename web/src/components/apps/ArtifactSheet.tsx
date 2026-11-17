import { useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Copy, Download, FileInput, FolderOpen, Star, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import { copyText, fmtBytes, fmtDateTime, fmtDuration } from '../../lib/format';
import { deleteArtifact, reuseRun, revealArtifact, toggleStar } from '../../lib/actions';
import type { Artifact } from '../../types';
import { Button, ConfirmDialog, IconButton, IconLink, revealLabel } from '../ui';
import { Media } from '../Sticker';
import { Lightbox } from '../Lightbox';

/** let long paths wrap at separators instead of mid-name */
const breakable = (p: string) =>
  p.split('/').flatMap((seg, i, all) => (i < all.length - 1 ? [seg, '/', <wbr key={i} />] : [seg]));

export function ArtifactSheet({ artifact: a, list, onSelect, onClose }: {
  artifact: Artifact;
  list: Artifact[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const idx = list.findIndex((x) => x.id === a.id);
  const go = (d: number) => {
    const next = list[(idx + d + list.length) % list.length];
    if (next) onSelect(next.id);
  };
  const m = a.meta ?? {};

  return (
    <motion.aside
      className="sheet"
      aria-label="制品详情"
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 36 }}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement) return;
        if (e.key === 'ArrowLeft') go(-1);
        if (e.key === 'ArrowRight') go(1);
        if (e.key === 'Escape') onClose();
      }}
    >
      <header className="sheet__bar">
        <span className="sheet__pos">{idx + 1} / {list.length}</span>
        <IconButton label="上一个 (←)" size="sm" onClick={() => go(-1)} disabled={list.length < 2}><ChevronLeft size={15} /></IconButton>
        <IconButton label="下一个 (→)" size="sm" onClick={() => go(1)} disabled={list.length < 2}><ChevronRight size={15} /></IconButton>
        <span className="field__spacer" />
        <IconButton label="关闭" size="sm" onClick={onClose}><X size={15} /></IconButton>
      </header>

      <div className="sheet__scroll">
        <button className="sheet__preview" onClick={() => setZoom(true)} aria-label="放大查看">
          <Media key={a.id} media={a} alt={m.prompt ?? a.filename} />
        </button>

        <div className="sheet__actions">
          <Button size="sm" className={clsx(a.starred && 'is-starred')} onClick={() => toggleStar(a)}>
            <Star size={13} fill={a.starred ? 'currentColor' : 'none'} />{a.starred ? '已收藏' : '收藏'}
          </Button>
          <Button size="sm" variant="ink" onClick={() => reuseRun(a.runId)}>
            <FileInput size={13} />用这组参数
          </Button>
          <span className="field__spacer" />
          <IconLink label="下载" href={a.url} download={a.filename}><Download size={15} /></IconLink>
          <IconButton label={revealLabel} onClick={() => revealArtifact(a)}><FolderOpen size={15} /></IconButton>
          <IconButton label="删除这个制品" onClick={() => setConfirm(true)}><Trash2 size={15} /></IconButton>
        </div>

        <dl className="info">
          <Row k="文件"><span className="mono">{a.filename}</span></Row>
          <Row k="规格">{a.width ? `${a.width} × ${a.height}` : '—'} · {a.kind === 'video' ? '视频' : '图片'} · {fmtBytes(a.bytes)}</Row>
          <Row k="生成于">{fmtDateTime(a.createdAt)}{a.durationMs ? ` · 用时 ${fmtDuration(a.durationMs)}` : ''}</Row>
          {m.seed != null && (
            <Row k="种子">
              <button className="copyable mono" onClick={() => copyText(String(m.seed), '种子')}>{m.seed}<Copy size={11} /></button>
            </Row>
          )}
          {(m.steps != null || m.cfg != null) && (
            <Row k="采样">
              {[m.steps != null && `${m.steps} 步`, m.cfg != null && `CFG ${m.cfg}`, m.sampler, m.scheduler].filter(Boolean).join(' · ')}
            </Row>
          )}
          {m.model && <Row k="模型"><span className="mono">{m.model}</span></Row>}
        </dl>

        {m.prompt && <TextBlock label="提示词" text={m.prompt} />}
        {m.negative && <TextBlock label="反向提示词" text={m.negative} muted />}

        <dl className="info info--quiet">
          <Row k="位置">
            <button className="copyable copyable--path mono" onClick={() => revealArtifact(a)} title={revealLabel}>
              {breakable(a.path)}
            </button>
          </Row>
          <Row k="编号">
            <button className="copyable mono" onClick={() => copyText(a.id, '制品编号')}>{a.id}<Copy size={11} /></button>
          </Row>
          <Row k="运行">
            <button className="copyable mono" onClick={() => copyText(a.runId, '运行编号')}>{a.runId.slice(0, 8)}…<Copy size={11} /></button>
          </Row>
        </dl>
      </div>

      <Lightbox items={list} index={Math.max(0, idx)} onIndex={(i) => onSelect(list[i].id)} open={zoom} onOpenChange={setZoom} caption={a.filename} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="删除这个制品？"
        body="它会从工作流库里移除。"
        fileOption="同时删除磁盘上的文件"
        confirmLabel="删除"
        onConfirm={async (files) => {
          if (await deleteArtifact(a, files)) {
            const next = list[idx + 1] ?? list[idx - 1];
            if (next) onSelect(next.id); else onClose();
          }
        }}
      />
    </motion.aside>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return <div className="info__row"><dt>{k}</dt><dd>{children}</dd></div>;
}

function TextBlock({ label, text, muted }: { label: string; text: string; muted?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 180;
  return (
    <div className={clsx('textblock', muted && 'textblock--muted')}>
      <div className="textblock__head">
        <span>{label}</span>
        <button className="link-btn" onClick={() => copyText(text, label)}><Copy size={11} />复制</button>
      </div>
      <p className={clsx('textblock__body', long && !open && 'is-clamped')}>{text}</p>
      {long && <button className="link-btn" onClick={() => setOpen(!open)}>{open ? '收起' : '展开全部'}</button>}
    </div>
  );
}
