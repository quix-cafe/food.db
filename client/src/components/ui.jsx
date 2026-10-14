import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';

const s = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };

export const Icon = {
  database: () => <svg {...s}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></svg>,
  recipe: () => <svg {...s}><path d="M6 3h11a2 2 0 0 1 2 2v16l-3-2-3 2-3-2-3 2-3-2V5a2 2 0 0 1 2-2z" /><path d="M8 8h8M8 12h6" /></svg>,
  calendar: () => <svg {...s}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>,
  search: () => <svg {...s}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>,
  plus: () => <svg {...s}><path d="M12 5v14M5 12h14" /></svg>,
  close: () => <svg {...s}><path d="M6 6l12 12M18 6 6 18" /></svg>,
  dots: () => <svg {...s}><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></svg>,
  grip: () => <svg {...s} strokeWidth="2.5"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" /></svg>,
  trash: () => <svg {...s}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>,
  receipt: () => <svg {...s}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></svg>,
  up: () => <svg {...s} width="14" height="14"><path d="m6 15 6-6 6 6" /></svg>,
  down: () => <svg {...s} width="14" height="14"><path d="m6 9 6 6 6-6" /></svg>,
  alert: () => <svg {...s}><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>,
};

function useEscape(onClose) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

function useInitialFocus(ref) {
  useEffect(() => {
    const prev = document.activeElement;
    const first = ref.current?.querySelector('input, select, textarea, button:not(.icon-btn)') ?? ref.current;
    first?.focus();
    return () => prev?.focus?.();
  }, [ref]);
}

export function Modal({ title, onClose, children }) {
  const ref = useRef(null);
  const id = useId();
  useEscape(onClose);
  useInitialFocus(ref);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} tabIndex={-1}>
        <div className="modal-head">
          <h2 id={id}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon.close /></button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </>
  );
}

export function Drawer({ title, subtitle, onClose, children }) {
  const ref = useRef(null);
  const id = useId();
  useEscape(onClose);
  useEffect(() => ref.current?.focus(), []);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} tabIndex={-1}>
        <div className="drawer-head">
          <div>
            <h2 id={id}>{title}</h2>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon.close /></button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

/** Three-dot context menu. items: [{ label, onSelect, danger }] */
export function Menu({ label, items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon.dots />
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((it) => (
            <button key={it.label} role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => { setOpen(false); it.onSelect(); }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" className="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, className = '' }) {
  return (
    <label className={`field ${className}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Notice({ kind = 'warn', children }) {
  if (!children || (Array.isArray(children) && !children.length)) return null;
  return (
    <div className={`notice ${kind === 'error' ? 'error' : ''}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon.alert />
      <div>{children}</div>
    </div>
  );
}

export const Spinner = () => <span className="spinner" aria-hidden="true" />;

// ---------- Toasts ----------

const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [msg, setMsg] = useState(null);
  const timer = useRef();
  const show = useCallback((text) => {
    setMsg(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 2600);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite">{msg && <div className="toast">{msg}</div>}</div>
    </ToastContext.Provider>
  );
}
