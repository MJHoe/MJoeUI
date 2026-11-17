import { motion, useAnimate } from 'motion/react';
import { CornerDownLeft, LoaderCircle, Minus, Plus } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../../store';
import { CATEGORY } from '../../lib/category';
import { isMac, Tip } from '../ui';

function useUnit() {
  const kind = useStore((s) => (s.currentId ? CATEGORY[s.workflows[s.currentId]?.category ?? 'other'].kind : 'image'));
  return kind === 'video' ? '段' : '张';
}

export function BatchStepper() {
  const batch = useStore((s) => s.batch);
  const setBatch = useStore((s) => s.setBatch);
  const unit = useUnit();
  return (
    <div className="stepper" role="group" aria-label={`生成${unit}数`}>
      <Tip label={`少一${unit}`}>
        <button className="stepper__btn" onClick={() => setBatch(batch - 1)} disabled={batch <= 1} aria-label={`少一${unit}`}>
          <Minus size={13} strokeWidth={2.6} />
        </button>
      </Tip>
      <motion.span key={batch} className="stepper__value" aria-live="polite" initial={{ y: -6, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>
        ×{batch}
      </motion.span>
      <Tip label={`多一${unit}（每${unit}换新种子）`}>
        <button className="stepper__btn" onClick={() => setBatch(batch + 1)} disabled={batch >= 8} aria-label={`多一${unit}`}>
          <Plus size={13} strokeWidth={2.6} />
        </button>
      </Tip>
    </div>
  );
}

export function GenerateButton({ onSubmit, busy, className }: { onSubmit: () => Promise<boolean>; busy: boolean; className?: string }) {
  const ready = useStore((s) => !!(s.currentId && s.graphs[s.currentId]));
  const connected = useStore((s) => s.connected);
  const batch = useStore((s) => s.batch);
  const unit = useUnit();
  const [scope, animate] = useAnimate();

  const blocked = !ready || !connected;
  const label = !ready ? '载入中…' : !connected ? 'ComfyUI 未连接' : busy ? '提交中…' : batch > 1 ? `生成 ${batch} ${unit}` : '生成';

  const go = async () => {
    // a little jelly squish so the press feels received
    void animate(scope.current, { scaleX: [1, 1.07, 0.97, 1.01, 1], scaleY: [1, 0.9, 1.04, 0.99, 1] }, { duration: 0.45 });
    await onSubmit();
  };

  return (
    <button ref={scope} className={clsx('jelly-btn', className)} onClick={go} disabled={blocked || busy}>
      <span className="jelly-btn__shine" aria-hidden />
      {busy && <LoaderCircle size={16} className="spin" />}
      <span>{label}</span>
      {!blocked && !busy && (
        <span className="jelly-btn__kbd" aria-hidden>{isMac ? '⌘' : 'Ctrl'}<CornerDownLeft size={11} /></span>
      )}
    </button>
  );
}

export function SubmitBar({ onSubmit, busy }: { onSubmit: () => Promise<boolean>; busy: boolean }) {
  return (
    <div className="submit">
      <BatchStepper />
      <GenerateButton onSubmit={onSubmit} busy={busy} />
    </div>
  );
}
