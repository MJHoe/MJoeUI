import { useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import type { Artifact } from '../types';
import { Media } from './Sticker';

export function Lightbox({ items, index, onIndex, open, onOpenChange, caption }: {
  items: Artifact[];
  index: number;
  onIndex: (i: number) => void;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  caption: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const a = items[index];
  if (!a) return null;
  const many = items.length > 1;
  const go = (d: number) => onIndex((index + d + items.length) % items.length);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="lightbox__veil" />
        <Dialog.Content
          ref={contentRef}
          className="lightbox"
          aria-describedby={undefined}
          // Focus the viewer itself, not its first button: a focused button
          // pops its tooltip, and that tooltip would swallow the first Esc.
          onOpenAutoFocus={(e) => { e.preventDefault(); contentRef.current?.focus(); }}
          onKeyDown={(e) => {
            if (!many) return;
            if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
          }}
        >
          <Dialog.Title className="sr-only">{caption}</Dialog.Title>
          <div className="lightbox__bar">
            <span className="lightbox__caption">{caption}</span>
            <span className="lightbox__file">{a.filename}{many && ` · ${index + 1}/${items.length}`}</span>
            <a className="icon-btn icon-btn--ghost" href={a.url} download={a.filename} aria-label="下载">
              <Download size={16} />
            </a>
            {/* native title, not <Tip>: a Radix tooltip is its own Esc layer */}
            <Dialog.Close className="icon-btn icon-btn--ghost" aria-label="关闭 (Esc)" title="关闭 (Esc)">
              <X size={18} />
            </Dialog.Close>
          </div>
          <div className="lightbox__body">
            {many && <button className="lightbox__nav is-prev" onClick={() => go(-1)} aria-label="上一个"><ChevronLeft size={22} /></button>}
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={a.id}
                className="lightbox__media"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              >
                <Media media={a} alt={caption} controls autoPlay />
              </motion.div>
            </AnimatePresence>
            {many && <button className="lightbox__nav is-next" onClick={() => go(1)} aria-label="下一个"><ChevronRight size={22} /></button>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
