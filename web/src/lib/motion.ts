import type { Transition } from 'motion/react';

/** One rhythm for every view swap — pages, gallery ↔ app, app tabs, and the
 *  topbar slots that change with them. Old view leaves fast, new one settles
 *  in with a short rise, so the chrome and the content move together. */
const EASE_OUT = [0.22, 1, 0.36, 1] as const;

export const SWAP_IN: Transition = { duration: 0.2, ease: EASE_OUT };
export const SWAP_OUT: Transition = { duration: 0.1, ease: 'easeIn' };

export const swap = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: SWAP_IN },
  exit: { opacity: 0, transition: SWAP_OUT },
};

/** The same, for small chrome pieces that shouldn't rise (topbar slots). */
export const fade = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: SWAP_IN },
  exit: { opacity: 0, transition: SWAP_OUT },
};
