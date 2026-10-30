import { AlertTriangle, ChevronDown, Loader2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useState } from 'react';
import { ApiError } from '@/crew/lib/api';
import { initials, titleCase } from '@/crew/lib/format';
export const cx = (...c) => c.filter(Boolean).join(' ');
const VARIANTS = {
    primary: 'bg-brand text-on-brand hover:bg-brand-hover shadow-1',
    secondary: 'bg-surface text-fg border border-border hover:bg-bg-subtle',
    ghost: 'text-fg-muted hover:text-fg hover:bg-bg-subtle',
    danger: 'bg-danger-solid text-white hover:opacity-90',
};
export const Button = forwardRef(function Button({ variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
    const sizes = { sm: 'h-8 px-3 text-sm gap-1.5', md: 'h-10 px-4 text-sm gap-2', lg: 'h-12 px-6 text-base gap-2' };
    return (<button ref={ref} className={cx('inline-flex items-center justify-center rounded-lg font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none select-none', VARIANTS[variant], sizes[size], className)} disabled={disabled || loading} {...rest}>
        {loading ? <Loader2 className="size-4 animate-spin"/> : icon}
        {children}
      </button>);
});
// ───────────────────────────── form fields ─────────────────────────────
export function Field({ label, hint, error, children, htmlFor }) {
    return (<div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-fg">
        {label}
      </label>
      {children}
      {error ? <p className="text-xs text-danger-text">{error}</p> : hint ? <p className="text-xs text-fg-subtle">{hint}</p> : null}
    </div>);
}
const control = 'w-full h-10 rounded-lg border border-border bg-surface px-3 text-sm text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none focus:ring-2 focus:ring-focus-ring/30 transition';
export const Input = forwardRef(function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx(control, className)} {...rest}/>;
});
export function Select({ className, children, ...rest }) {
    return (<div className={cx('relative', className)}>
      <select className={cx(control, 'appearance-none pr-9 disabled:opacity-70')} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"/>
    </div>);
}
export function TextField(props) {
    const id = useId();
    const { label, hint, error, ...rest } = props;
    return (<Field label={label} hint={hint} error={error} htmlFor={id}>
      <Input id={id} aria-invalid={!!error} {...rest}/>
    </Field>);
}
/** Field errors from an ApiError (problem+json `errors`), by field path. */
export function fieldErrors(err) {
    if (!(err instanceof ApiError))
        return {};
    return Object.fromEntries(err.fieldErrors.map((e) => [e.path, e.message]));
}
// ───────────────────────────── surfaces ─────────────────────────────
export function Card({ className, children, ...rest }) {
    return (<div className={cx('rounded-2xl border border-border bg-surface shadow-1', className)} {...rest}>
      {children}
    </div>);
}
export function CardHeader({ title, subtitle, action }) {
    return (
    // Wide actions (filter chips) drop below the title on narrow cards instead of squeezing it.
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-5 pb-3">
      <div className="min-w-0 flex-1 basis-48">
        <h3 className="text-base font-semibold text-fg">{title}</h3>
        {subtitle && <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p>}
      </div>
      {action}
    </div>);
}
export function PageHeader({ title, subtitle, actions, eyebrow }) {
    return (<div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-brand-text">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>);
}
// ───────────────────────────── status & identity ─────────────────────────────
const TONES = {
    success: 'bg-success-surface text-success-text border-success-border',
    warning: 'bg-warning-surface text-warning-text border-warning-border',
    danger: 'bg-danger-surface text-danger-text border-danger-border',
    info: 'bg-info-surface text-info-text border-info-border',
    brand: 'bg-brand-surface text-brand-text border-transparent',
    neutral: 'bg-bg-subtle text-fg-muted border-border',
};
export function Badge({ tone = 'neutral', children, dot }) {
    return (<span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone])}>
      {dot && <span className="size-1.5 rounded-full bg-current"/>}
      {children}
    </span>);
}
export const STATUS = {
    present: { label: 'Present', tone: 'success', dot: 'bg-success-solid' },
    late: { label: 'Late', tone: 'warning', dot: 'bg-warning-solid' },
    half_day: { label: 'Half day', tone: 'info', dot: 'bg-info-solid' },
    absent: { label: 'Absent', tone: 'danger', dot: 'bg-danger-solid' },
    mispunch: { label: 'Mispunch', tone: 'danger', dot: 'bg-ember-500' },
    weekly_off: { label: 'Weekly off', tone: 'neutral', dot: 'bg-fg-subtle' },
    holiday: { label: 'Holiday', tone: 'brand', dot: 'bg-brand' },
    leave: { label: 'On leave', tone: 'info', dot: 'bg-aqua-500' },
};
/** Leave-type colour chips (matches the type's colour in the leave screens). */
export const LEAVE_COLOR = {
    iris: { bg: 'bg-iris-100', text: 'text-iris-700', dot: 'bg-iris-500' },
    aqua: { bg: 'bg-aqua-100', text: 'text-aqua-700', dot: 'bg-aqua-500' },
    ember: { bg: 'bg-ember-100', text: 'text-ember-700', dot: 'bg-ember-500' },
    emerald: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-400' },
    amber: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-400' },
    rose: { bg: 'bg-ember-50', text: 'text-ember-700', dot: 'bg-ember-400' },
    sky: { bg: 'bg-aqua-50', text: 'text-aqua-700', dot: 'bg-aqua-400' },
    ink: { bg: 'bg-bg-subtle', text: 'text-fg', dot: 'bg-fg-subtle' },
};
export function StatusBadge({ status, inProgress }) {
    const s = STATUS[status];
    return (<Badge tone={s.tone} dot>
      {s.label}
      {inProgress && <span className="opacity-70">· in progress</span>}
    </Badge>);
}
const AVATAR_HUES = ['bg-iris-100 text-iris-700', 'bg-aqua-100 text-aqua-700', 'bg-ember-100 text-ember-700', 'bg-emerald-50 text-emerald-700', 'bg-amber-50 text-amber-700'];
export function Avatar({ name, size = 'md' }) {
    const hue = AVATAR_HUES[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_HUES.length];
    const sizes = { sm: 'size-7 text-[11px]', md: 'size-9 text-xs', lg: 'size-12 text-sm', xl: 'size-20 text-2xl' };
    return <span className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold', hue, sizes[size])}>{initials(name) || '?'}</span>;
}
export const label = titleCase;
// ───────────────────────────── states ─────────────────────────────
export function Skeleton({ className }) {
    return <div className={cx('animate-pulse rounded-md bg-bg-subtle', className)}/>;
}
export function EmptyState({ icon, title, body, action }) {
    return (<div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 rounded-2xl bg-brand-surface p-3 text-brand-text">{icon}</div>}
      <p className="font-medium text-fg">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-fg-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>);
}
export function ErrorState({ error, retry }) {
    const msg = error instanceof Error ? error.message : 'Something went wrong.';
    return (<div className="flex items-start gap-3 rounded-xl border border-danger-border bg-danger-surface p-4 text-sm text-danger-text">
      <AlertTriangle className="mt-0.5 size-4 shrink-0"/>
      <div className="flex-1">{msg}</div>
      {retry && (<button className="font-medium underline" onClick={retry}>
          Retry
        </button>)}
    </div>);
}
// ───────────────────────────── tabs ─────────────────────────────
export function Tabs({ tabs, value, onChange }) {
    return (<div className="flex gap-1 overflow-x-auto border-b border-border scroll-quiet" role="tablist">
      {tabs.map((t) => (<button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)} className={cx('relative px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors', value === t.id ? 'text-fg' : 'text-fg-muted hover:text-fg')}>
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 rounded-full bg-bg-subtle px-1.5 text-xs text-fg-muted">{t.count}</span>}
          {value === t.id && <motion.span layoutId="tab-underline" className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand"/>}
        </button>))}
    </div>);
}
/** An on/off switch. `label` names it for screen readers when no visible label is next to it. */
export function Switch({ on, onChange, label, disabled }) {
    return (<button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50', on ? 'bg-brand' : 'bg-border-strong')}>
      <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-[left]', on ? 'left-[22px]' : 'left-0.5')}/>
    </button>);
}
// ───────────────────────────── drawer (slide-over) ─────────────────────────────
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 'max-w-lg' }) {
    useEffect(() => {
        if (!open)
            return;
        const onKey = (e) => e.key === 'Escape' && onClose();
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);
    return (<AnimatePresence>
      {open && (<div className="fixed inset-0 z-[200]">
          <motion.div className="absolute inset-0 bg-ink-950/40 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}/>
          <motion.aside role="dialog" aria-modal="true" aria-label={title} className={cx('absolute inset-y-0 right-0 flex w-full flex-col bg-surface shadow-3', width)} initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 32, stiffness: 320 }}>
            <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
              <div>
                <h2 className="text-lg font-semibold text-fg">{title}</h2>
                {subtitle && <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p>}
              </div>
              <button onClick={onClose} className="rounded-lg p-1.5 text-fg-muted hover:bg-bg-subtle hover:text-fg" aria-label="Close">
                <X className="size-5"/>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5 scroll-quiet">{children}</div>
            {footer && <div className="flex justify-end gap-2 border-t border-border px-6 py-4">{footer}</div>}
          </motion.aside>
        </div>)}
    </AnimatePresence>);
}
const ToastCtx = createContext(() => undefined);
export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([]);
    const push = useCallback((tone, text) => {
        const id = Date.now() + Math.random();
        setToasts((t) => [...t, { id, tone, text }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
    }, []);
    return (<ToastCtx.Provider value={push}>
      {children}
      {/* Top centre: never covers drawer footers or primary actions. */}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-[230] flex flex-col items-center gap-2 px-4" aria-live="polite">
        <AnimatePresence>
          {toasts.map((t) => (<motion.div key={t.id} initial={{ opacity: 0, y: -12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6 }} className={cx('pointer-events-auto rounded-xl border px-4 py-3 text-sm shadow-2', t.tone === 'success' ? TONES.success : t.tone === 'danger' ? TONES.danger : TONES.info)}>
              {t.text}
            </motion.div>))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>);
}
export const useToast = () => useContext(ToastCtx);
export function Spinner({ className }) {
    return <Loader2 className={cx('size-5 animate-spin text-fg-subtle', className)}/>;
}
