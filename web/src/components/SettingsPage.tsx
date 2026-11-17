import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Eraser, FolderOpen, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { api } from '../api';
import { useStore } from '../store';
import { fmtBytes, localDayStamp } from '../lib/format';
import type { SystemStats } from '../types';
import { Button, isMac } from './ui';

const card = (i: number) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { type: 'spring' as const, stiffness: 380, damping: 32, delay: i * 0.05 },
});

export function SettingsPage() {
  return (
    <div className="settings">
      <div className="settings__col">
        <ConnectionCard />
        <OutputDirCard />
      </div>
      <InstanceCard />
    </div>
  );
}

function ConnectionCard() {
  const baseUrl = useStore((s) => s.baseUrl);
  const connected = useStore((s) => s.connected);
  const setConfig = useStore((s) => s.setConfig);
  const [draft, setDraft] = useState(baseUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (baseUrl && !draft) setDraft(baseUrl); }, [baseUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const r = await api.setConfig({ baseUrl: draft.trim() });
      setConfig(r);
      setDraft(r.baseUrl);
      if (r.connected) toast.success('地址已保存', { description: `ComfyUI 在 ${r.baseUrl} 上可以访问。` });
      else toast.warning('地址已保存，但连不上', { description: `确认 ComfyUI 正在 ${r.baseUrl} 运行。` });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const dirty = draft.trim().replace(/\/+$/, '') !== baseUrl;

  return (
    <motion.form className="card" onSubmit={save} {...card(0)}>
      <h2 className="card__title">ComfyUI 地址</h2>
      <p className="card__lede">所有生成都提交到这里。本机运行时一般是 <code>http://127.0.0.1:8188</code>。</p>
      <div className="inline-form">
        <input
          className={clsx('text-input', error && 'is-invalid')}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          aria-label="ComfyUI 地址"
          aria-invalid={!!error}
          placeholder="http://127.0.0.1:8188"
          onChange={(e) => { setDraft(e.target.value); setError(null); }}
        />
        <Button type="submit" variant="ink" disabled={saving || !draft.trim() || !dirty}>
          {saving ? <><LoaderCircle size={14} className="spin" />保存中</> : '保存地址'}
        </Button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className={clsx('conn', connected ? 'is-on' : 'is-off')}>
        <span className="conn__dot" aria-hidden />
        {connected ? <>已连接 <code>{baseUrl}</code></> : <>连不上 <code>{baseUrl || '（未设置）'}</code></>}
      </div>
    </motion.form>
  );
}

/** let long paths wrap at separators instead of mid-name */
const breakable = (p: string) =>
  p.split('/').flatMap((seg, i, all) => (i < all.length - 1 ? [seg, '/', <wbr key={i} />] : [seg]));

function OutputDirCard() {
  const outputDir = useStore((s) => s.outputDir);
  const defaultDir = useStore((s) => s.defaultOutputDir);
  const setConfig = useStore((s) => s.setConfig);
  const sampleWf = useStore((s) => s.currentId ?? 'wf_xxxxxxxx');
  const [draft, setDraft] = useState(outputDir);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(outputDir); }, [outputDir]);

  const apply = async (dir: string) => {
    setSaving(true);
    setError(null);
    try {
      const r = await api.setConfig({ outputDir: dir });
      setConfig(r);
      toast.success('保存位置已更新', { description: `之后的制品会存到 ${r.outputDir}` });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const open = async () => {
    try { await api.revealOutputDir(); } catch (e: any) { toast.error('打不开文件夹', { description: e.message }); }
  };

  const dirty = draft.trim() !== outputDir;
  const { day, time } = localDayStamp(new Date());

  return (
    <motion.form className="card" onSubmit={(e) => { e.preventDefault(); void apply(draft); }} {...card(1)}>
      <h2 className="card__title">制品存到哪里</h2>
      <p className="card__lede">
        每个工作流一个文件夹（用它的编号命名，改名也不会变），里面按日期分，文件名是「时分秒_种子」。
        PNG 原样保存，拖回 ComfyUI 能还原整个工作流。
      </p>
      <div className="inline-form">
        <input
          className={clsx('text-input', error && 'is-invalid')}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          aria-label="保存文件夹"
          aria-invalid={!!error}
          placeholder="~/Pictures/MJoeUI"
          onChange={(e) => { setDraft(e.target.value); setError(null); }}
        />
        <Button type="submit" variant="ink" disabled={saving || !draft.trim() || !dirty}>
          {saving ? <><LoaderCircle size={14} className="spin" />保存中</> : '保存位置'}
        </Button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="pathrule">
        <code title={`${outputDir}/${sampleWf}/${day}/${time}_种子.png`}>
          <span className="pathrule__root">{breakable(`${outputDir || '…'}/`)}</span>
          <span className="pathrule__seg pathrule__seg--wf">{sampleWf}</span>/<wbr />
          <span className="pathrule__seg">{day}</span>/<wbr />
          <span className="pathrule__seg">{time}_种子.png</span>
        </code>
        <div className="pathrule__actions">
          {defaultDir && outputDir !== defaultDir && (
            <Button type="button" variant="ghost" size="sm" onClick={() => apply(defaultDir)} disabled={saving}>
              <RotateCcw size={13} />恢复默认
            </Button>
          )}
          <Button type="button" size="sm" onClick={open}>
            <FolderOpen size={13} />{isMac ? '在访达中打开' : '打开文件夹'}
          </Button>
        </div>
      </div>
    </motion.form>
  );
}

function InstanceCard() {
  const baseUrl = useStore((s) => s.baseUrl);
  const connected = useStore((s) => s.connected);
  const setConfig = useStore((s) => s.setConfig);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [freeing, setFreeing] = useState(false);

  const load = async () => {
    setChecking(true);
    try {
      const [c, s] = await Promise.allSettled([api.getConfig(), api.system()]);
      if (c.status === 'fulfilled') setConfig(c.value);
      if (s.status === 'fulfilled') { setStats(s.value); setStatsErr(null); }
      else { setStats(null); setStatsErr(s.reason?.message ?? '读取失败'); }
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => { void load(); }, [baseUrl, connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const free = async () => {
    setFreeing(true);
    try {
      await api.freeMemory();
      toast.success('已请求释放显存', { description: 'ComfyUI 会卸载模型，下一次生成要重新加载。' });
      setTimeout(load, 1200);
    } catch (e: any) {
      toast.error('释放失败', { description: e.message });
    } finally {
      setFreeing(false);
    }
  };

  const sys = stats?.system;
  const dev = stats?.devices?.[0];
  const vramUsed = dev?.vram_total && dev.vram_free != null ? 1 - dev.vram_free / dev.vram_total : null;
  const ramUsed = sys?.ram_total && sys.ram_free != null ? 1 - sys.ram_free / sys.ram_total : null;

  return (
    <motion.section className="card card--instance" aria-label="ComfyUI 实例" {...card(2)}>
      <div className="card__head">
        <h2 className="card__title">实例</h2>
        <Button variant="ghost" size="sm" onClick={load} disabled={checking}>
          <RefreshCw size={13} className={clsx(checking && 'spin')} />重新检测
        </Button>
      </div>
      {stats ? (
        <>
          <dl className="specsheet">
            <div><dt>ComfyUI</dt><dd>{sys?.comfyui_version ?? '—'}</dd></div>
            <div><dt>PyTorch</dt><dd>{sys?.pytorch_version ?? '—'}</dd></div>
            <div><dt>Python</dt><dd>{sys?.python_version?.split(' ')[0] ?? '—'}</dd></div>
            <div><dt>系统</dt><dd>{sys?.os ?? '—'}</dd></div>
            <div className="specsheet__wide"><dt>设备</dt><dd>{dev?.name ?? '—'}</dd></div>
          </dl>
          <Meter label="显存" used={vramUsed} total={dev?.vram_total} free={dev?.vram_free} />
          <Meter label="内存" used={ramUsed} total={sys?.ram_total} free={sys?.ram_free} />
          <div className="card__foot">
            <span>显存吃紧时，可以让 ComfyUI 卸载已加载的模型。</span>
            <Button size="sm" onClick={free} disabled={freeing || !connected}>
              {freeing ? <LoaderCircle size={13} className="spin" /> : <Eraser size={13} />}释放显存
            </Button>
          </div>
        </>
      ) : (
        <p className="card__empty">{statsErr ?? '读取中…'}</p>
      )}
    </motion.section>
  );
}

function Meter({ label, used, total, free }: { label: string; used: number | null; total?: number; free?: number }) {
  if (used == null) return null;
  return (
    <div className="meter">
      <div className="meter__top">
        <span>{label}</span>
        <span className="meter__nums">{fmtBytes(total && free != null ? total - free : undefined)} / {fmtBytes(total)}</span>
      </div>
      <div className="meter__track" role="meter" aria-label={label} aria-valuenow={Math.round(used * 100)} aria-valuemin={0} aria-valuemax={100}>
        <motion.span
          className={clsx('meter__fill', used > 0.85 && 'is-hot')}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: used }}
          transition={{ type: 'spring', stiffness: 90, damping: 20 }}
        />
      </div>
    </div>
  );
}
