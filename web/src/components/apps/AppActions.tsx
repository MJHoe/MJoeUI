import { useEffect, useState } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Code2, Copy, ListChecks, LoaderCircle, MoreHorizontal, Pencil, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../api';
import { useStore } from '../../store';
import { copyText } from '../../lib/format';
import type { WorkflowSummary } from '../../types';
import { Button, ConfirmDialog, Modal, Tip } from '../ui';
import { MetaForm, type MetaDraft } from '../MetaForm';
import { ParamPickerDialog } from '../ParamPicker';
import { ApiDialog } from './ApiDialog';

/** App-level actions, in the topbar's right slot while an app is open — the
 *  same place on every tab, so nothing jumps when switching. */
export function AppActions({ w }: { w: WorkflowSummary }) {
  const [api_, setApi] = useState(false);
  const [pick, setPick] = useState(false);
  const [edit, setEdit] = useState(false);
  const [del, setDel] = useState(false);

  return (
    <div className="appactions">
      <Tip label="把这个应用当 API 调用：只传关键参数，其余用保存的默认值">
        <button className="btn btn--ghost btn--sm" onClick={() => setApi(true)}><Code2 size={14} />API</button>
      </Tip>
      <Tip label="选择显示哪些参数、放左侧还是下方">
        <button className="btn btn--ghost btn--sm" onClick={() => setPick(true)}><ListChecks size={14} />参数</button>
      </Tip>
      <Menu.Root modal={false}>
        <Tip label="更多" side="bottom">
          <Menu.Trigger asChild>
            <button className="icon-btn icon-btn--ghost" aria-label="更多操作"><MoreHorizontal size={16} /></button>
          </Menu.Trigger>
        </Tip>
        <Menu.Portal>
          <Menu.Content className="dmenu" align="end" sideOffset={6} collisionPadding={12}>
            <Menu.Item className="dmenu__item" onSelect={() => setEdit(true)}><Pencil size={14} />编辑名字和类别</Menu.Item>
            <Menu.Item className="dmenu__item" onSelect={() => copyText(w.id, '应用编号')}>
              <Copy size={14} />复制应用编号<span className="dmenu__hint">{w.id}</span>
            </Menu.Item>
            <Menu.Separator className="dmenu__sep" />
            <Menu.Item className="dmenu__item is-danger" onSelect={() => setDel(true)}><Trash2 size={14} />删除应用</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>

      <ApiDialog workflowId={w.id} open={api_} onOpenChange={setApi} />
      <ParamPickerDialog workflowId={w.id} open={pick} onOpenChange={setPick} />
      <EditDialog w={w} open={edit} onOpenChange={setEdit} />
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        title={`删除「${w.name}」？`}
        body={<>应用、{w.stats.runs} 条运行记录和 {w.stats.artifacts} 个制品记录都会从库里移除，无法撤销。</>}
        fileOption={w.stats.artifacts ? `同时删除磁盘上的 ${w.stats.artifacts} 个文件` : undefined}
        confirmLabel="删除应用"
        onConfirm={async (files) => {
          try {
            const r = await api.deleteWorkflow(w.id, files);
            toast(`已删除「${w.name}」`, { description: files ? `删掉了 ${r.removedFiles} 个文件。` : '制品文件还留在磁盘上。' });
          } catch (e: any) {
            toast.error('删除失败', { description: e.message });
            throw e;
          }
        }}
      />
    </div>
  );
}

function EditDialog({ w, open, onOpenChange }: { w: WorkflowSummary; open: boolean; onOpenChange: (v: boolean) => void }) {
  const putWorkflow = useStore((s) => s.putWorkflow);
  const [meta, setMeta] = useState<MetaDraft>({ name: w.name, category: w.category, baseModel: w.baseModel, note: w.note });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) { setMeta({ name: w.name, category: w.category, baseModel: w.baseModel, note: w.note }); setError(null); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true);
    try {
      const { workflow } = await api.updateWorkflow(w.id, meta);
      putWorkflow(workflow);
      onOpenChange(false);
      toast.success('已保存');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="编辑工作流信息" sub={<>编号 <code>{w.id}</code> 不会变，已有制品的位置也不会变。</>} width={560}>
      <div className="modal__body">
        <MetaForm value={meta} onChange={setMeta} autoFocus />
        {error && <p className="form-error" role="alert"><TriangleAlert size={14} />{error}</p>}
      </div>
      <footer className="modal__foot">
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
        <Button variant="ink" onClick={save} disabled={busy || !meta.name.trim()}>
          {busy ? <><LoaderCircle size={14} className="spin" />保存中</> : '保存'}
        </Button>
      </footer>
    </Modal>
  );
}
