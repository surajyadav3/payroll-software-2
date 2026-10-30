import { FileClock } from 'lucide-react';
/** "Draft restored · Discard" — shown when a form opens with text the user typed earlier but never saved. */
export function DraftNotice({ show, onDiscard, className }) {
    if (!show)
        return null;
    return (<div className={`flex items-center gap-2 rounded-xl bg-info-surface px-3 py-1.5 text-xs text-info-text ${className ?? ''}`}>
      <FileClock className="size-3.5 shrink-0"/>
      <span className="flex-1">Your unsaved draft was restored.</span>
      <button type="button" onClick={() => onDiscard()} className="font-semibold underline-offset-2 hover:underline">Discard</button>
    </div>);
}
