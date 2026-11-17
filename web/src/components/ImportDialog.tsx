import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, ArrowRight, FileJson, LoaderCircle, TriangleAlert, Upload } from 'lucide-react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { api } from '../api';
import { useStore } from '../store';
import { parseWorkflow } from '../lib/workflow';
import type { Inspection } from '../types';
import { Button, Modal } from './ui';
import { MetaForm, type MetaDraft } from './MetaForm';
import { ParamPicker, PickFootCount, usePickState } from './ParamPicker';

type Phase = 'source' | 'form' | 'params';

const TITLE: Record<Phase, string> = { source: '导入工作流', form: '给它起个名字', params: '选择要显示的参数' };
const WIDTH: Record<Phase, number> = { source: 480, form: 560, params: 720 };

export function ImportDialog() {
  const open = useStore((s) => s.importOpen);
  const seed = useStore((s) => s.importSeed);
  const close = useStore((s) => s.closeImport);
  const [phase, setPhase] = useState<Phase>('source');
  const [text, setText] = useState('');
  const [info, setInfo] = useState<Inspection | null>(null);
  const [meta, setMeta] = useState<MetaDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = usePickState(info?.json ?? null, null);

  const reset = () => { setPhase('source'); setText(''); setInfo(null); setMeta(null); setError(null); setBusy(false); };
  useEffect(() => { if (!open) reset(); }, [open]);

  const inspect = async (raw: string, fileName?: string) => {
    setText(raw);
    setError(null);
    const parsed = parseWorkflow(raw);
    if (!parsed.ok) { setError(parsed.error); return; }
    setBusy(true);
    try {
      const r = await api.inspect(parsed.workflow, fileName);
      setInfo(r);
      setMeta({ name: r.suggestedName, category: r.category, baseModel: r.baseModel, note: '' });
      setPhase('form');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (open && seed) void inspect(seed.text, seed.fileName);
  }, [open, seed]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!info || !meta) return;
    if (!meta.name.trim()) { setError('给工作流取个名字'); return; }
    setBusy(true);
    try {
      const { workflow } = await api.createWorkflow({ ...meta, name: meta.name.trim(), json: info.json, exposed: pick.toList() });
      const s = useStore.getState();
      s.putWorkflow(workflow);
      s.openApp(workflow.id);
      close();
      toast.success(`「${workflow.name}」已加入工作流库`, {
        description: `编号 ${workflow.id}，之后的制品都会存到这个编号的文件夹里。`,
        action: { label: '查看', onClick: () => useStore.getState().openApp(workflow.id, 'artifacts') },
      });
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(v) => { if (!v) close(); }}
      title={TITLE[phase]}
      sub={phase === 'source'
        ? <>需要 <b>API 格式</b>的 JSON：在 ComfyUI 菜单里选「导出 (API)」。</>
        : phase === 'form' ? '名字和类别之后都可以改。'
          : '一个一个勾选。之后在应用里也能随时改。'}
      width={WIDTH[phase]}
    >
      <AnimatePresence mode="wait" initial={false}>
        {phase === 'source' ? (
          <motion.div key="source" className="modal__body" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }}>
            <SourcePicker busy={busy} text={text} onText={setText} onInspect={inspect} />
            {error && <p className="form-error" role="alert"><TriangleAlert size={14} />{error}</p>}
          </motion.div>
        ) : phase === 'params' ? (
          <motion.div key="params" className="modal__body" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.18 }}>
            <ParamPicker pick={pick} />
            {error && <p className="form-error" role="alert"><TriangleAlert size={14} />{error}</p>}
          </motion.div>
        ) : (
          <motion.div key="form" className="modal__body" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.18 }}>
            {info && <InspectStrip info={info} />}
            {info?.duplicateOf && <Duplicate dup={info.duplicateOf} onOpen={close} />}
            {meta && info && (
              <MetaForm
                value={meta}
                onChange={setMeta}
                detected={{ category: info.category, baseModel: info.baseModel, modelFile: info.modelFile }}
                autoFocus
              />
            )}
            {error && <p className="form-error" role="alert"><TriangleAlert size={14} />{error}</p>}
          </motion.div>
        )}
      </AnimatePresence>
      <footer className="modal__foot">
        {phase === 'params' && <PickFootCount pick={pick} />}
        {phase === 'form' ? (
          <Button variant="ghost" onClick={() => { setPhase('source'); setError(null); }} disabled={busy}>
            <ArrowLeft size={14} />换一个文件
          </Button>
        ) : phase === 'params' ? (
          <Button variant="ghost" onClick={() => { setPhase('form'); setError(null); }} disabled={busy}>
            <ArrowLeft size={14} />上一步
          </Button>
        ) : (
          <Button variant="ghost" onClick={close}>取消</Button>
        )}
        {phase === 'source' ? (
          <Button variant="ink" disabled={busy || !text.trim()} onClick={() => inspect(text)}>
            {busy ? <><LoaderCircle size={14} className="spin" />识别中</> : '识别'}
          </Button>
        ) : phase === 'form' ? (
          <Button
            variant="ink"
            disabled={!meta?.name.trim()}
            onClick={() => { if (meta?.name.trim()) { setError(null); setPhase('params'); } else setError('给工作流取个名字'); }}
          >
            下一步 · 选参数<ArrowRight size={14} />
          </Button>
        ) : (
          <Button variant="ink" disabled={busy || !meta?.name.trim() || pick.errors.size > 0} onClick={save}>
            {busy ? <><LoaderCircle size={14} className="spin" />保存中</> : '保存到工作流库'}
          </Button>
        )}
      </footer>
    </Modal>
  );
}

function SourcePicker({ busy, text, onText, onInspect }: {
  busy: boolean;
  text: string;
  onText: (s: string) => void;
  onInspect: (raw: string, fileName?: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const readFile = async (f?: File | null) => {
    if (!f) return;
    onInspect(await f.text(), f.name);
  };

  return (
    <>
      <button
        type="button"
        className={clsx('dropzone', over && 'is-over')}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); void readFile(e.dataTransfer.files[0]); }}
        disabled={busy}
      >
        <span className="dropzone__icon" aria-hidden>
          {busy ? <LoaderCircle size={22} className="spin" /> : <FileJson size={22} />}
        </span>
        <span className="dropzone__title">把 .json 拖到这里</span>
        <span className="dropzone__sub"><Upload size={12} />或点击选择文件</span>
      </button>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => { void readFile(e.target.files?.[0]); e.target.value = ''; }}
      />
      <div className="or-rule"><span>或者粘贴</span></div>
      <textarea
        className="text-input paste-area"
        value={text}
        spellCheck={false}
        placeholder={'{\n  "3": { "class_type": "KSampler", "inputs": { … } },\n  …\n}'}
        onChange={(e) => onText(e.target.value)}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text');
          if (t.trim().startsWith('{')) { e.preventDefault(); onInspect(t); }
        }}
      />
    </>
  );
}

function InspectStrip({ info }: { info: Inspection }) {
  const outs = [...new Set(info.outputs)];
  return (
    <div className="inspect">
      <span className="inspect__chip"><b>{info.nodeCount}</b> 个节点</span>
      {outs.length > 0 && <span className="inspect__chip">输出 <b>{outs.join(' · ')}</b></span>}
      {info.modelFile && <span className="inspect__chip inspect__chip--mono" title={info.modelFile}>{info.modelFile}</span>}
    </div>
  );
}

function Duplicate({ dup, onOpen }: { dup: { id: string; name: string }; onOpen: () => void }) {
  const openApp = useStore((s) => s.openApp);
  const exists = useStore((s) => !!s.workflows[dup.id]);
  return (
    <div className="dup">
      <TriangleAlert size={15} />
      <span>库里已经有一个一模一样的：<b>{dup.name}</b>。仍然可以再存一份。</span>
      {exists && (
        <button type="button" className="link-btn" onClick={() => { openApp(dup.id, 'artifacts'); onOpen(); }}>打开它</button>
      )}
    </div>
  );
}
