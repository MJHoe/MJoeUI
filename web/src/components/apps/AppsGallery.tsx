import { useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { FileJson, Plus, Star } from 'lucide-react';
import clsx from 'clsx';
import { sortWorkflows, useStore } from '../../store';
import { CATEGORY } from '../../lib/category';
import { fmtAgo } from '../../lib/format';
import type { Category } from '../../types';
import { Button, Tape } from '../ui';
import { Media } from '../Sticker';

/** Landing page: every app in the library, one big card each. */
export function AppsGallery() {
  const workflows = useStore((s) => s.workflows);
  const openApp = useStore((s) => s.openApp);
  const openImport = useStore((s) => s.openImport);
  const all = useMemo(() => sortWorkflows(workflows), [workflows]);

  if (!all.length) return <EmptyGallery />;

  return (
    <div className="gallery">
      <div className="appgrid">
        <AnimatePresence initial={false}>
          {all.map((w, i) => (
            <motion.button
              key={w.id}
              layout
              className={clsx('appcard', `appcard--${w.category}`)}
              onClick={() => openApp(w.id)}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 16) * 0.02 } }}
              exit={{ opacity: 0, scale: 0.96 }}
              whileHover={{ y: -3 }}
              transition={{ type: 'spring', stiffness: 460, damping: 32 }}
              aria-label={`打开应用 ${w.name}`}
            >
              <span className="appcard__cover">
                {w.cover ? <Media media={w.cover} alt="" /> : <CoverPlaceholder category={w.category} />}
                <span className="appcard__tape"><Tape category={w.category} size="sm" tilt={-2} /></span>
                {w.stats.artifacts > 0 && (
                  <span className="appcard__count"><Star size={9} />{w.stats.artifacts}</span>
                )}
              </span>
              <span className="appcard__body">
                <span className="appcard__name">{w.name}</span>
                <span className="appcard__meta">
                  {w.baseModel && <span className="model-chip">{w.baseModel}</span>}
                  <span className="appcard__ago">{w.lastRunAt ? fmtAgo(w.lastRunAt) : '新'}</span>
                </span>
              </span>
            </motion.button>
          ))}
        </AnimatePresence>
      </div>

      <button className="gallery__add" onClick={() => openImport()} aria-label="导入新的应用">
        <Plus size={16} strokeWidth={2.8} />
      </button>
    </div>
  );
}

function CoverPlaceholder({ category }: { category: Category }) {
  const Icon = CATEGORY[category].icon;
  return (
    <span className={clsx('cover-ph', `cover-ph--${category}`)}>
      <Icon size={30} strokeWidth={1.6} aria-hidden />
    </span>
  );
}

function EmptyGallery() {
  const openImport = useStore((s) => s.openImport);
  return (
    <div className="welcome">
      <motion.button
        className="welcome__card"
        onClick={() => openImport()}
        initial={{ opacity: 0, y: 20, rotate: -5 }}
        animate={{ opacity: 1, y: 0, rotate: -1.5 }}
        whileHover={{ rotate: 0, y: -4 }}
        transition={{ type: 'spring', stiffness: 260, damping: 18 }}
      >
        <span className="welcome__tape" aria-hidden />
        <FileJson size={34} strokeWidth={1.6} />
        <b>导入第一个应用</b>
        <span>把 ComfyUI 导出的 API 格式 JSON 拖进窗口、直接粘贴，或者点这里选文件。</span>
      </motion.button>
      <ol className="welcome__steps">
        <li>ComfyUI 菜单 → <b>导出 (API)</b></li>
        <li>起个名字，选好类别和基座模型</li>
        <li>这个工作流就成了一张应用卡片 · 调参数、用它生成</li>
      </ol>
      <Button variant="ink" onClick={() => openImport()}><Plus size={14} />导入应用</Button>
    </div>
  );
}
