/** Browser storage for form drafts (see use-draft.ts). Every call tolerates storage being unavailable. */
export const PREFIX = 'crewcore.draft.';
const MAX_AGE_MS = 14 * 86_400_000;
export function read(k) {
    try {
        const raw = localStorage.getItem(k);
        if (!raw)
            return undefined;
        const d = JSON.parse(raw);
        if (Date.now() - d.at > MAX_AGE_MS) {
            localStorage.removeItem(k);
            return undefined;
        }
        return d.v;
    }
    catch {
        return undefined;
    }
}
export function write(k, v) {
    try {
        localStorage.setItem(k, JSON.stringify({ v, at: Date.now() }));
    }
    catch {
        // storage full or blocked: drafts are a convenience
    }
}
export function remove(k) {
    try {
        localStorage.removeItem(k);
    }
    catch {
        // ignore
    }
}
/** Sign-out: no drafts are left behind on a shared computer. */
export function clearAllDrafts() {
    try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k?.startsWith(PREFIX))
                localStorage.removeItem(k);
        }
    }
    catch {
        // ignore
    }
}
