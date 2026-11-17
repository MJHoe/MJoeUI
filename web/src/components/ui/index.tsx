import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as RSelect from '@radix-ui/react-select';
import * as RSlider from '@radix-ui/react-slider';
import * as RSwitch from '@radix-ui/react-switch';
import * as Dialog from '@radix-ui/react-dialog';
import { motion } from 'motion/react';
import { Check, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { CATEGORY } from '../../lib/category';
import type { Category } from '../../types';

// ─── Tip ────────────────────────────────────────────────────────────────────
export function Tip({ label, children, side = 'top' }: {
  label: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tip" side={side} sideOffset={6} collisionPadding={12}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

// ─── Buttons ────────────────────────────────────────────────────────────────
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'ink' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
};

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = 'default', size = 'md', className, type = 'button', ...rest }, ref,
) {
  return <button ref={ref} type={type} className={clsx('btn', `btn--${variant}`, `btn--${size}`, className)} {...rest} />;
});

export const IconButton = forwardRef<HTMLButtonElement, BtnProps & { label: string; tipSide?: 'top' | 'bottom' | 'left' | 'right' }>(
  function IconButton({ label, tipSide, className, variant = 'ghost', size = 'md', type = 'button', ...rest }, ref) {
    return (
      <Tip label={label} side={tipSide}>
        <button
          ref={ref}
          type={type}
          aria-label={label}
          className={clsx('icon-btn', `icon-btn--${variant}`, size === 'sm' && 'icon-btn--sm', className)}
          {...rest}
        />
      </Tip>
    );
  },
);

/** An <a> styled as an icon button (downloads, open-in-tab). */
export function IconLink({ label, href, download, newTab, children }: {
  label: string;
  href: string;
  download?: string;
  newTab?: boolean;
  children: ReactNode;
}) {
  return (
    <Tip label={label}>
      <a
        className="icon-btn icon-btn--ghost"
        href={href}
        download={download}
        target={newTab ? '_blank' : undefined}
        rel={newTab ? 'noreferrer' : undefined}
        aria-label={label}
      >
        {children}
      </a>
    </Tip>
  );
}

// ─── Washi tape (category label) ────────────────────────────────────────────
export function Tape({ category, size = 'md', tilt = -2, icon = true }: {
  category: Category;
  size?: 'sm' | 'md';
  tilt?: number;
  icon?: boolean;
}) {
  const c = CATEGORY[category];
  const Icon = c.icon;
  return (
    <span className={clsx('tape', `tape--${category}`, `tape--${size}`)} style={{ '--tape-tilt': `${tilt}deg` } as React.CSSProperties}>
      {icon && <Icon size={size === 'sm' ? 10 : 12} strokeWidth={2.4} aria-hidden />}
      {c.label}
    </span>
  );
}

// ─── Loader: three bouncing jelly dots ──────────────────────────────────────
export function JellyDots({ label }: { label?: string }) {
  return (
    <span className="jelly-dots" role="status" aria-label={label ?? '加载中'}>
      <i /><i /><i />
    </span>
  );
}

// ─── Select ─────────────────────────────────────────────────────────────────
export function Select({ value, options, onChange, id, ariaLabel, render }: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  id?: string;
  ariaLabel?: string;
  render?: (v: string) => ReactNode;
}) {
  return (
    <RSelect.Root value={value} onValueChange={onChange}>
      <RSelect.Trigger className="select" id={id} aria-label={ariaLabel}>
        <span className="select__value"><RSelect.Value /></span>
        <RSelect.Icon className="select__icon"><ChevronDown size={14} /></RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content className="select__content" position="popper" sideOffset={6} collisionPadding={12}>
          <RSelect.Viewport className="select__viewport">
            {options.map((o) => (
              <RSelect.Item key={o} value={o} className="select__item">
                <RSelect.ItemText>{render ? render(o) : o}</RSelect.ItemText>
                <RSelect.ItemIndicator className="select__check"><Check size={13} /></RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

// ─── Slider ─────────────────────────────────────────────────────────────────
export function Slider({ value, min, max, step, onChange, ariaLabel }: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  ariaLabel?: string;
}) {
  const clamped = Math.min(max, Math.max(min, value));
  return (
    <RSlider.Root className="slider" value={[clamped]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)}>
      <RSlider.Track className="slider__track">
        <RSlider.Range className="slider__range" />
      </RSlider.Track>
      <RSlider.Thumb className="slider__thumb" aria-label={ariaLabel} />
    </RSlider.Root>
  );
}

// ─── Switch ─────────────────────────────────────────────────────────────────
export function Switch({ checked, onChange, id, ariaLabel }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  id?: string;
  ariaLabel?: string;
}) {
  return (
    <RSwitch.Root className="switch" checked={checked} onCheckedChange={onChange} id={id} aria-label={ariaLabel}>
      <RSwitch.Thumb className="switch__thumb" />
    </RSwitch.Root>
  );
}

// ─── Modal shell ────────────────────────────────────────────────────────────
export function Modal({ open, onOpenChange, title, sub, children, width = 460, className }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  width?: number;
  className?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal__veil" />
        <Dialog.Content className={clsx('modal', className)} style={{ width: `min(${width}px, calc(100vw - 32px))` }} aria-describedby={undefined}>
          <motion.div
            className="modal__card"
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
          >
            <header className="modal__head">
              <Dialog.Title className="modal__title">{title}</Dialog.Title>
              {sub && <p className="modal__sub">{sub}</p>}
            </header>
            {children}
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Destructive confirm with an optional "also remove files" checkbox. */
export function ConfirmDialog({ open, onOpenChange, title, body, confirmLabel, fileOption, onConfirm }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  body: ReactNode;
  confirmLabel: string;
  fileOption?: string;
  onConfirm: (files: boolean) => Promise<unknown> | void;
}) {
  const [files, setFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onOpenChange={(v) => { if (!busy) { onOpenChange(v); if (!v) setFiles(false); } }} title={title} width={420}>
      <div className="modal__body">
        <div className="confirm__body">{body}</div>
        {fileOption && (
          <label className="check">
            <input type="checkbox" checked={files} onChange={(e) => setFiles(e.target.checked)} />
            <span className="check__box" aria-hidden><Check size={11} strokeWidth={3} /></span>
            <span>{fileOption}</span>
          </label>
        )}
      </div>
      <footer className="modal__foot">
        <Dialog.Close asChild><Button variant="ghost" disabled={busy}>取消</Button></Dialog.Close>
        <Button
          variant="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try { await onConfirm(files); onOpenChange(false); setFiles(false); } catch { /* caller reported it; stay open */ } finally { setBusy(false); }
          }}
        >
          {confirmLabel}
        </Button>
      </footer>
    </Modal>
  );
}

// ─── Kbd ────────────────────────────────────────────────────────────────────
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const revealLabel = isMac ? '在访达中显示' : '在文件夹中显示';
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
