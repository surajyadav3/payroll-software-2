import { useEffect, useRef } from 'react';
/**
 * Closes a popup (menu, dropdown, suggestion list) when the user presses anywhere outside it, or presses Escape.
 * Attach the returned ref to the element that holds BOTH the trigger and the popup, so clicking the trigger toggles
 * instead of closing and reopening.
 *
 * Why not a full-screen invisible overlay: a `position: fixed` overlay is sized to the nearest ancestor with a
 * transform / filter / backdrop-filter (the blurred top bar, an animated drawer), not to the screen — clicks on the
 * rest of the page never reach it. A document listener in the capture phase works everywhere.
 * Escape closes only this popup: it stops the key from also closing a drawer or dialog behind it.
 */
export function useDismiss(open, onClose) {
    const ref = useRef(null);
    const close = useRef(onClose);
    useEffect(() => {
        close.current = onClose;
    });
    useEffect(() => {
        if (!open)
            return;
        const down = (e) => {
            const el = ref.current;
            if (el && !el.contains(e.target))
                close.current();
        };
        const key = (e) => {
            if (e.key !== 'Escape')
                return;
            e.stopPropagation();
            close.current();
        };
        document.addEventListener('pointerdown', down, true);
        window.addEventListener('keydown', key, true);
        return () => {
            document.removeEventListener('pointerdown', down, true);
            window.removeEventListener('keydown', key, true);
        };
    }, [open]);
    return ref;
}
