import { AnimatePresence, motion } from 'motion/react';
import { useStore } from '../../store';
import { swap } from '../../lib/motion';
import { JellyDots } from '../ui';
import { AppsGallery } from './AppsGallery';
import { AppDetail } from './AppDetail';

/** The "Apps" page: gallery when no app is selected, detail when one is. */
export function AppsPage() {
  const ready = useStore((s) => s.workflowsReady);
  const current = useStore((s) => (s.currentId ? s.workflows[s.currentId] : undefined));

  if (!ready) return <div className="page-center"><JellyDots label="载入应用库" /></div>;

  return (
    <div className="apps">
      <AnimatePresence mode="wait" initial={false}>
        {current ? (
          <motion.div
            key={`detail:${current.id}`}
            className="apps__layer"
            {...swap}
          >
            <AppDetail w={current} />
          </motion.div>
        ) : (
          <motion.div
            key="gallery"
            className="apps__layer"
            {...swap}
          >
            <AppsGallery />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
