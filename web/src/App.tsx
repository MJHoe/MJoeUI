import { useEffect } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Toaster, toast } from 'sonner';
import { TopBar } from './components/TopBar';
import { AppsPage } from './components/apps/AppsPage';
import { SettingsPage } from './components/SettingsPage';
import { TasksPage } from './components/TasksPage';
import { ImportDialog } from './components/ImportDialog';
import { DropCatcher } from './components/DropCatcher';
import { api, openEvents } from './api';
import { useStore } from './store';
import { swap } from './lib/motion';

function useThemeAttr() {
  const theme = useStore((s) => s.theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);
  return theme;
}

export function App() {
  const page = useStore((s) => s.page);
  const socket = useStore((s) => s.socket);
  const theme = useThemeAttr();

  useEffect(() => {
    const { applyEvent, setSocket, setConfig } = useStore.getState();
    api.getConfig().then(setConfig).catch(() => {});
    return openEvents(applyEvent, setSocket);
  }, []);

  useEffect(() => {
    if (socket !== 'open') return;
    useStore.getState().loadWorkflows().catch((e) => toast.error('读取应用库失败', { description: e.message }));
  }, [socket]);

  return (
    <MotionConfig reducedMotion="user">
      <Tooltip.Provider delayDuration={350} skipDelayDuration={150}>
        <div className="app">
          <TopBar />
          <AnimatePresence mode="wait" initial={false}>
            <motion.main
              key={page}
              className="page"
              {...swap}
            >
              {page === 'apps' && <AppsPage />}
              {page === 'tasks' && <TasksPage />}
              {page === 'settings' && <SettingsPage />}
            </motion.main>
          </AnimatePresence>
        </div>
        <ImportDialog />
        <DropCatcher />
        <Toaster position="top-center" theme={theme} toastOptions={{ className: 'toast' }} offset={10} gap={8} />
      </Tooltip.Provider>
    </MotionConfig>
  );
}
