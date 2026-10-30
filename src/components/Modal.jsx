import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

// Panels that are open right now, oldest first — Escape only acts on the one
// on top, so a panel opened from another panel closes on its own.
const openPanels = [];

// Every "popup" in the app renders through here as a slide-over panel on the
// right edge — the same pattern as the Messages / Work drawers — so the page
// behind stays in view while a form is filled.
export default function Modal({ show, onClose, title, width, children, footer, fullScreen = false }) {
  // Once the user has touched any field, a stray/accidental click on the
  // backdrop (easy to rack up while filling a long form — adding an employee,
  // posting a job, scheduling a meeting) must never discard their in-progress
  // input. Only the explicit × button or a footer action (e.g. Cancel) closes
  // the panel from then on; the backdrop click (or Escape) just flashes a
  // brief reminder instead of doing nothing silently.
  const [interacted, setInteracted] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const hintTimer = useRef(null);
  const dismissRef = useRef(null);

  useEffect(() => {
    if (show) { setInteracted(false); setShowHint(false); }
  }, [show]);

  useEffect(() => () => clearTimeout(hintTimer.current), []);

  const handleDismiss = () => {
    if (!interacted) {
      onClose();
      return;
    }
    setShowHint(true);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setShowHint(false), 2200);
  };

  useEffect(() => { dismissRef.current = handleDismiss; });

  useEffect(() => {
    if (!show) return undefined;
    const token = {};
    openPanels.push(token);
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (openPanels[openPanels.length - 1] !== token) return;
      dismissRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      openPanels.splice(openPanels.indexOf(token), 1);
    };
  }, [show]);

  return (
    <div className={`modal-overlay ${show ? 'show' : ''}`} onClick={handleDismiss}>
      <aside
        role="dialog"
        aria-modal={show ? 'true' : undefined}
        aria-label={typeof title === 'string' ? title : undefined}
        className={`modal ${fullScreen ? 'modal-fullscreen' : ''}`}
        style={!fullScreen && width ? { width } : undefined}
        onClick={(e) => e.stopPropagation()}
        onChangeCapture={() => setInteracted(true)}
        onInputCapture={() => setInteracted(true)}
      >
        <div className="modal-header">
          <h3>{title}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {showHint && (
          <div className="modal-discard-hint">
            Click × or Cancel to close — your entry is kept safe.
          </div>
        )}
        {footer && <div className="modal-footer">{footer}</div>}
      </aside>
    </div>
  );
}
