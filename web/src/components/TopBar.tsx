import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, Monitor, Moon, Plus, Sun } from 'lucide-react';
import clsx from 'clsx';
import { queueOf, useStore, type AppTab, type Page, type Theme } from '../store';
import { hostOf } from '../lib/format';
import { fade } from '../lib/motion';
import type { WorkflowSummary } from '../types';
import { IconButton, Tape, Tip } from './ui';
import { Cover } from './Cover';
import { QueueChip } from './QueueChip';
import { AppActions } from './apps/AppActions';

const THEME_NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<Theme, string> = { system: '跟随系统', light: '浅色', dark: '深色' };

/**
 * Three fixed slots, so nothing shifts when you go in and out of an app:
 *   left   brand (+ crumb back to the gallery)
 *   center the navigation for where you are — 应用/任务/设置, or the app's tabs
 *   right  the action for where you are (导入 / the app's actions), then
 *          the always-there queue, connection and theme.
 */
export function TopBar() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const setPage = useStore((s) => s.setPage);
  const baseUrl = useStore((s) => s.baseUrl);
  const connected = useStore((s) => s.connected);
  const socket = useStore((s) => s.socket);
  const openImport = useStore((s) => s.openImport);
  const currentApp = useStore((s) => (s.page === 'apps' && s.currentId ? s.workflows[s.currentId] : undefined));
  const closeApp = useStore((s) => s.closeApp);

  const linkState = socket !== 'open' ? 'lost' : connected ? 'online' : 'offline';
  const linkText = linkState === 'lost' ? '后端重连中' : linkState === 'online' ? hostOf(baseUrl) : 'ComfyUI 离线';
  const linkTip =
    linkState === 'lost'
      ? '和 MJoeUI 后端的实时连接断开了，正在自动重连。'
      : linkState === 'online'
        ? `ComfyUI 在线 · ${baseUrl}`
        : `连不上 ${baseUrl || 'ComfyUI'}，到「设置」检查地址。`;

  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const slot = currentApp ? `app:${currentApp.id}` : 'pages';

  return (
    <header className="topbar">
      <div className="topbar__left">
        <button className="brand" aria-label="MJoeUI · 回到应用" onClick={() => { closeApp(); setPage('apps'); }}>
          <span className="brand__mark" aria-hidden><i /></span>
          <span className="brand__word">MJoe</span>
        </button>
        <AnimatePresence mode="wait" initial={false}>
          {currentApp && (
            <motion.button key={slot} className="appcrumb" onClick={closeApp} aria-label="返回应用库" {...fade}>
              <ChevronLeft size={14} strokeWidth={2.4} />
              <Cover w={currentApp} size={22} tilt={false} />
              <span className="appcrumb__name">{currentApp.name}</span>
              <Tape category={currentApp.category} size="sm" tilt={0} icon={false} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <div className="topbar__center">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={currentApp ? 'app' : 'pages'} className="topbar__slot" {...fade}>
            {currentApp ? <AppTabs w={currentApp} /> : <PageTabs />}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="topbar__right">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={slot} className="topbar__slot" {...fade}>
            {currentApp ? <AppActions w={currentApp} /> : (
              <Tip label="导入工作流 JSON（也可以直接拖进窗口或粘贴）">
                <button className="btn btn--default btn--sm topbar__import" onClick={() => openImport()}>
                  <Plus size={14} strokeWidth={2.6} />导入应用
                </button>
              </Tip>
            )}
          </motion.div>
        </AnimatePresence>
        <span className="topbar__divider" aria-hidden />
        <QueueChip />
        <Tip label={linkTip}>
          <button className={clsx('link-pill', `is-${linkState}`)} onClick={() => setPage('settings')}>
            <span className="link-pill__dot" aria-hidden />
            <span className="link-pill__text">{linkText}</span>
          </button>
        </Tip>
        <IconButton label={`主题：${THEME_LABEL[theme]}`} tipSide="bottom" onClick={() => setTheme(THEME_NEXT[theme])}>
          <ThemeIcon size={16} />
        </IconButton>
      </div>
    </header>
  );
}

function Tabs<T extends string>({ id, items, value, onChange, label }: {
  id: string;
  items: ReadonlyArray<{ id: T; label: string; n?: number | null }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <nav className="tabs" aria-label={label}>
      {items.map((t) => (
        <button
          key={t.id}
          className={clsx('tabs__tab', value === t.id && 'is-active')}
          aria-current={value === t.id ? 'page' : undefined}
          onClick={() => onChange(t.id)}
        >
          {value === t.id && (
            <motion.span layoutId={`${id}-pill`} className="tabs__pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
          )}
          <span className="tabs__label">
            {t.label}
            {t.n != null && t.n > 0 && <span className="tabs__count">{t.n}</span>}
          </span>
        </button>
      ))}
    </nav>
  );
}

function PageTabs() {
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const wfCount = useStore((s) => Object.keys(s.workflows).length);
  const live = useStore((s) => queueOf(s.tasks).length);
  return (
    <Tabs<Page>
      id="page"
      label="页面"
      value={page}
      onChange={setPage}
      items={[
        { id: 'apps', label: '应用', n: wfCount },
        { id: 'tasks', label: '任务', n: live },
        { id: 'settings', label: '设置' },
      ]}
    />
  );
}

function AppTabs({ w }: { w: WorkflowSummary }) {
  const tab = useStore((s) => s.appTab);
  const setTab = useStore((s) => s.setAppTab);
  return (
    <Tabs<AppTab>
      id="apptab"
      label="应用页面"
      value={tab}
      onChange={setTab}
      items={[
        { id: 'use', label: '使用' },
        { id: 'artifacts', label: '制品', n: w.stats.artifacts },
        { id: 'runs', label: '运行记录', n: w.stats.runs },
        { id: 'json', label: 'JSON' },
      ]}
    />
  );
}
