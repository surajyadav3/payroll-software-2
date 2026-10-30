import { SendHorizontal } from 'lucide-react';
import { useRef, useState } from 'react';
import { useDismiss } from '@/crew/lib/use-dismiss';
import { useDraft } from '@/crew/lib/use-draft';
import { useColleagues } from '@/crew/lib/work';
import { Avatar, cx } from '../ui';
/**
 * Message box with @mentions: type "@" and a name, pick a person, keep typing. Enter sends; Shift+Enter is a new
 * line. Only people whose "@Name" is still in the text when sent are mentioned.
 */
export function Composer({ onSend, placeholder, autoFocus, compact, disabled, draftKey }) {
    // Unsent text survives closing the task, switching channels or reloading (cleared once sent).
    const [draft, setDraft, discardDraft] = useDraft(draftKey ? `composer:${draftKey}` : null, { text: '', picked: [] });
    const { text, picked } = draft;
    const setText = (v) => setDraft((d) => ({ ...d, text: v }));
    const setPicked = (f) => setDraft((d) => ({ ...d, picked: f(d.picked) }));
    const [query, setQuery] = useState(null);
    const [active, setActive] = useState(0);
    const [sending, setSending] = useState(false);
    const ref = useRef(null);
    const people = useColleagues(query ?? '');
    const suggestions = query === null ? [] : (people.data ?? []).slice(0, 6);
    const box = useDismiss(suggestions.length > 0, () => setQuery(null));
    function onChange(v) {
        setText(v);
        const caret = ref.current?.selectionStart ?? v.length;
        const m = /(?:^|\s)@([\p{L}.'-]{0,30})$/u.exec(v.slice(0, caret));
        setQuery(m ? m[1] : null);
        setActive(0);
    }
    function choose(p) {
        const el = ref.current;
        const caret = el?.selectionStart ?? text.length;
        const before = text.slice(0, caret).replace(/@([\p{L}.'-]{0,30})$/u, `@${p.fullName} `);
        const next = before + text.slice(caret);
        setText(next);
        setPicked((s) => (s.some((x) => x.id === p.id) ? s : [...s, { id: p.id, name: p.fullName }]));
        setQuery(null);
        requestAnimationFrame(() => {
            el?.focus();
            el?.setSelectionRange(before.length, before.length);
        });
    }
    async function send() {
        const body = text.trim();
        if (!body || sending)
            return;
        const mentions = picked.filter((p) => body.includes(`@${p.name}`)).map((p) => p.id);
        setSending(true);
        try {
            await onSend(body, mentions);
            discardDraft();
        }
        finally {
            setSending(false);
            requestAnimationFrame(() => ref.current?.focus());
        }
    }
    function onKey(e) {
        if (suggestions.length) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => (a + 1) % suggestions.length);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                choose(suggestions[active]);
                return;
            }
            if (e.key === 'Escape') {
                setQuery(null);
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
        }
    }
    return (<div ref={box} className="relative">
      {suggestions.length > 0 && (<div className="absolute bottom-full z-30 mb-2 w-72 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-3">
          <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">Mention</div>
          {suggestions.map((p, i) => (<button key={p.id} type="button" onMouseDown={(e) => { e.preventDefault(); choose(p); }} className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm', i === active ? 'bg-brand-surface text-brand-text' : 'text-fg hover:bg-bg-subtle')}>
              <Avatar name={p.fullName} size="sm"/>
              <span className="truncate">{p.fullName}</span>
              {p.designation?.name && <span className="ml-auto truncate text-xs text-fg-subtle">{p.designation.name}</span>}
            </button>))}
        </div>)}
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface p-2 shadow-1 focus-within:border-brand focus-within:ring-2 focus-within:ring-focus-ring/30">
        <textarea ref={ref} value={text} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} rows={compact ? 1 : 2} maxLength={8000} autoFocus={autoFocus} disabled={disabled} placeholder={placeholder ?? 'Write a message — @ to mention someone'} className="max-h-48 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-fg outline-none placeholder:text-fg-subtle"/>
        <button type="button" onClick={() => void send()} disabled={!text.trim() || sending || disabled} className="rounded-xl bg-brand p-2 text-on-brand transition hover:bg-brand-hover disabled:opacity-40" aria-label="Send">
          <SendHorizontal className="size-4"/>
        </button>
      </div>
    </div>);
}
/** Message text with @mentions and links highlighted. */
export function RichText({ body, mentioned }) {
    const names = mentioned.map((m) => m.name).filter(Boolean).sort((a, b) => b.length - a.length);
    const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(https?://[^\\s]+${escaped.length ? `|@(?:${escaped.join('|')})` : ''})`, 'g');
    const parts = body.split(re);
    return (<span className="whitespace-pre-wrap break-words">
      {parts.map((p, i) => p.startsWith('http') ? <a key={i} href={p} target="_blank" rel="noreferrer noopener" className="text-brand-text underline underline-offset-2">{p}</a>
            : p.startsWith('@') && names.includes(p.slice(1)) ? <span key={i} className="rounded bg-brand-surface px-1 font-medium text-brand-text">{p}</span>
                : <span key={i}>{p}</span>)}
    </span>);
}
