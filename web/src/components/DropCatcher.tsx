import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { FileJson } from 'lucide-react';
import { useStore } from '../store';

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest('.cm-editor'));

/**
 * Drop a .json anywhere, or paste JSON while nothing is focused, and the
 * import dialog opens with it already read.
 */
export function DropCatcher() {
  const openImport = useStore((s) => s.openImport);
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    // only react to things that could be a workflow; images dropped on a LoadImage field pass through
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && [...e.dataTransfer.items].some((i) => i.kind === 'file' && (i.type === 'application/json' || i.type === ''));
    const isFileDrag = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; depth.current++; setOver(true); };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); };
    // always swallow file drops so a stray image never navigates the tab away
    const overFn = (e: DragEvent) => { if (isFileDrag(e)) e.preventDefault(); };
    const drop = async (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const f = [...(e.dataTransfer?.files ?? [])].find((x) => /\.json$/i.test(x.name) || x.type === 'application/json');
      if (f) openImport({ text: await f.text(), fileName: f.name });
    };
    const paste = (e: ClipboardEvent) => {
      if (typing(e.target) || useStore.getState().importOpen) return;
      const t = e.clipboardData?.getData('text') ?? '';
      if (t.trim().startsWith('{') && t.includes('class_type')) { e.preventDefault(); openImport({ text: t }); }
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overFn);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
    };
  }, [openImport]);

  return (
    <AnimatePresence>
      {over && !useStore.getState().importOpen && (
        <motion.div className="drop-veil" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div
            className="drop-veil__card"
            initial={{ scale: 0.8, rotate: -6 }}
            animate={{ scale: 1, rotate: -2 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 18 }}
          >
            <FileJson size={28} />
            <b>松手导入工作流</b>
            <span>API 格式的 ComfyUI JSON</span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
