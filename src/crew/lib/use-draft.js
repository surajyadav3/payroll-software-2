import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth';
import { PREFIX, read, remove, write } from './draft-store';
/**
 * Unsaved typing survives closing, cancelling, navigating away or reloading: the value is kept as a draft in this
 * browser (per signed-in user and per form) until it is saved or sent. Drafts older than 14 days are dropped, and
 * every draft is wiped on sign-out (`clearAllDrafts`). Storage can be unavailable (private mode, blocked site data);
 * the form then simply works without drafts.
 *
 * Returns [value, setValue, discard, restored]:
 * - `discard()` throws the draft away and puts the form back to `initial` (a "Discard" button, or after creating
 *   something new);
 * - `discard({ keep: true })` forgets the stored draft but keeps what is on screen (after saving an edit — the
 *   saved value comes back from the server);
 * - `restored` is true when the form opened with a draft (show `DraftNotice`).
 * While there is no draft, the value follows `initial` (e.g. the record was updated elsewhere).
 */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function load(key, initial) {
    const found = key ? read(key) : undefined;
    // A stored draft equal to what is saved now is not a draft (it was saved since).
    const saved = found !== undefined && !same(found, initial) ? found : undefined;
    return { key, value: saved ?? initial, baseline: initial, dirty: saved !== undefined, restored: saved !== undefined };
}
export function useDraft(key, initial) {
    const { me } = useAuth();
    const full = key && me?.user.id ? `${PREFIX}${me.user.id}.${key}` : null;
    const [state, setState] = useState(() => load(full, initial));
    const initialRef = useRef(initial);
    useEffect(() => {
        initialRef.current = initial;
    });
    // Another record (another task, channel, review…): load that one's draft.
    if (state.key !== full)
        setState(load(full, initial));
    // No draft and the source changed (saved elsewhere, refetched): follow it.
    else if (!state.dirty && !same(initial, state.baseline))
        setState({ ...state, value: initial, baseline: initial });
    // The draft was saved (the source now holds exactly this value): it is not a draft any more.
    else if (state.dirty && !same(initial, state.baseline) && same(state.value, initial))
        setState({ ...state, baseline: initial, dirty: false, restored: false });
    // Storage follows: no stored draft while the form is clean.
    useEffect(() => {
        if (!state.dirty && state.key)
            remove(state.key);
    }, [state.dirty, state.key]);
    const set = useCallback((v) => {
        setState((s) => {
            const value = typeof v === 'function' ? v(s.value) : v;
            const dirty = !same(value, s.baseline);
            if (s.key) {
                if (dirty)
                    write(s.key, value);
                else
                    remove(s.key);
            }
            return { ...s, value, dirty };
        });
    }, []);
    const discard = useCallback((opts) => {
        setState((s) => {
            if (s.key)
                remove(s.key);
            return opts?.keep ? { ...s, dirty: false, restored: false } : { ...s, value: initialRef.current, baseline: initialRef.current, dirty: false, restored: false };
        });
    }, []);
    return [state.value, set, discard, state.restored];
}
