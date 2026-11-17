import { useEffect, useState } from 'react';
import { Copy, ListChecks, TriangleAlert } from 'lucide-react';
import { api, type AppDescription } from '../../api';
import { useStore } from '../../store';
import { copyText } from '../../lib/format';
import { Button, JellyDots, Modal } from '../ui';
import { ParamPickerDialog } from '../ParamPicker';

const TYPE_LABEL: Record<string, string> = {
  string: '文本', number: '数字', boolean: '开关', image: '图片', video: '视频', audio: '音频',
};

function short(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return '—';
  const one = s.replace(/\s*\n\s*/g, ' ⏎ ');
  return one.length > 60 ? `${one.slice(0, 60)}…` : one || '（空）';
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** How to call this app from outside: only the key inputs are passed, every
 *  other input uses the saved defaults (original JSON + saved edits). */
export function ApiDialog({ workflowId, open, onOpenChange }: {
  workflowId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const version = useStore((s) => s.workflows[workflowId]?.updatedAt);
  const [info, setInfo] = useState<AppDescription | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    api.describeApp(workflowId).then(setInfo, (e) => setError(e.message));
  }, [open, workflowId, version]);

  const body = info && JSON.stringify(info.example, null, 2);
  const curl = info && body
    ? `curl -X POST ${info.endpoint} \\\n  -H 'Content-Type: application/json' \\\n  -d ${shellQuote(body)}`
    : '';
  const origin = info ? info.endpoint.replace(/\/api\/apps\/.*$/, '') : '';

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="API 调用"
      sub="只需要传关键参数，其余参数都用这个应用保存的默认值（原始 JSON + 你在使用页改过的值）。"
      width={720}
    >
      <div className="modal__body apid">
        {error && <p className="form-error" role="alert"><TriangleAlert size={14} />{error}</p>}
        {!info && !error && <div className="page-center"><JellyDots /></div>}
        {info && (
          <>
            <section className="apid__sec">
              <h4 className="apid__h">地址</h4>
              <div className="apid__endpoint">
                <span className="apid__method">POST</span>
                <code>{info.endpoint}</code>
                <button type="button" className="apid__copy" onClick={() => copyText(info.endpoint, '地址')} aria-label="复制地址"><Copy size={12} /></button>
              </div>
            </section>

            <section className="apid__sec">
              <h4 className="apid__h">
                关键参数 <span className="apid__n">{info.inputs.length}</span>
                <span className="field__spacer" />
                <button type="button" className="link-btn" onClick={() => setPicking(true)}><ListChecks size={11} />调整</button>
              </h4>
              {!info.configured ? (
                <p className="apid__warn">
                  <TriangleAlert size={13} />
                  还没选关键参数，现在调用只能整体按默认值跑。在「选择参数」里把要传的参数设成「下方 · 关键」。
                </p>
              ) : info.inputs.length === 0 ? (
                <p className="apid__warn"><TriangleAlert size={13} />没有设成「下方 · 关键」的参数，调用时 inputs 传空对象，全部用默认值。</p>
              ) : (
                <table className="apid__table">
                  <thead><tr><th>参数名</th><th>类型</th><th>对应节点</th><th>默认值</th></tr></thead>
                  <tbody>
                    {info.inputs.map((i) => (
                      <tr key={i.name}>
                        <td><code>{i.name}</code></td>
                        <td>{TYPE_LABEL[i.type] ?? i.type}</td>
                        <td className="apid__node">{i.title ?? '—'} <span>#{i.node}.{i.input}</span></td>
                        <td className="apid__def" title={typeof i.default === 'string' ? i.default : undefined}>{short(i.default)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="apid__sec">
              <h4 className="apid__h">
                示例
                <span className="field__spacer" />
                <button type="button" className="link-btn" onClick={() => copyText(curl, 'curl 命令')}><Copy size={11} />复制 curl</button>
              </h4>
              <pre className="apid__code">{curl}</pre>
              <ul className="apid__notes">
                <li>图片 / 视频 / 音频参数可以传 <code>data:</code> 开头的 base64、<code>http(s)://</code> 链接，或 ComfyUI 输入目录里的文件名。</li>
                <li>种子默认每次随机；传 <code>"random_seed": false</code> 就用保存的种子，或者把种子设成关键参数直接传。</li>
                <li><code>"wait": true</code> 会等生成结束再返回（默认最多 600 秒，可用 <code>"timeout"</code> 调整）；不带 wait 立即返回任务，之后轮询 <code>GET {origin}/api/runs/&lt;task.id&gt;</code>。</li>
                <li>返回的 <code>task.artifacts[].url</code> 就是生成文件的下载地址。</li>
              </ul>
            </section>
          </>
        )}
      </div>
      <footer className="modal__foot">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>关闭</Button>
      </footer>
      <ParamPickerDialog workflowId={workflowId} open={picking} onOpenChange={setPicking} />
    </Modal>
  );
}
