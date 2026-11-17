import clsx from 'clsx';
import { CATEGORY, tiltOf } from '../lib/category';
import type { WorkflowSummary } from '../types';
import { Media } from './Sticker';

/** Small square thumbnail for a workflow: its cover artifact, or its category icon on tape colour. */
export function Cover({ w, size = 40, tilt = true }: { w: WorkflowSummary; size?: number; tilt?: boolean }) {
  const Icon = CATEGORY[w.category].icon;
  return (
    <span
      className={clsx('cover', `cover--${w.category}`, !w.cover && 'cover--empty')}
      style={{ width: size, height: size, rotate: tilt ? `${tiltOf(w.id, 3)}deg` : undefined }}
      aria-hidden
    >
      {w.cover ? <Media media={w.cover} alt="" /> : <Icon size={Math.round(size * 0.42)} strokeWidth={2} />}
    </span>
  );
}
