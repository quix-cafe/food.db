import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';

const s = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };

export const Icon = {
  // Main menu: one distinct silhouette per section.
  carrot: () => <svg {...s}><path d="M3 21 10.6 8.6a4.6 4.6 0 0 1 6.8 6.8z" /><path d="M8.2 14.6l1.5 1.5M10.9 11.4l1.3 1.3" /><path d="M15 8c-.4-2.3.3-4.4 2-6M16.3 9.3 20.6 5M17.6 10.6c2.2-.6 4-.3 5.4.7" /></svg>,
  chefHat: () => <svg {...s}><path d="M6 13.9V20h12v-6.1a4 4 0 1 0-1.7-7.6 4.5 4.5 0 0 0-8.6 0A4 4 0 1 0 6 13.9z" /><path d="M6 16.5h12" /></svg>,
  glass: () => <svg {...s}><path d="M7.5 3h9l-.4 5.5a4.1 4.1 0 0 1-8.2 0z" /><path d="M12 12.6V20M8 21h8" /><path d="M19.5 2.5v3M18 4h3" /></svg>,
  calendar: () => <svg {...s}><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /><path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01" /></svg>,
  cart: () => <svg {...s}><circle cx="9" cy="20" r="1.4" /><circle cx="17.5" cy="20" r="1.4" /><path d="M2 3h2.8l2.6 12a1.6 1.6 0 0 0 1.6 1.3h8.4a1.6 1.6 0 0 0 1.5-1.2L21 7H5.7" /></svg>,
  history: () => <svg {...s}><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5" /><path d="M3.5 3.5v5h5" /><path d="M12 7.5V12l3 2" /></svg>,
  starburst: () => <svg {...s}><path d="M12.0 1.5 L13.4 8.7 L19.4 4.6 L15.3 10.6 L22.5 12.0 L15.3 13.4 L19.4 19.4 L13.4 15.3 L12.0 22.5 L10.6 15.3 L4.6 19.4 L8.7 13.4 L1.5 12.0 L8.7 10.6 L4.6 4.6 L10.6 8.7z" /></svg>,
  sun: () => <svg {...s}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></svg>,
  moon: () => <svg {...s}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></svg>,
  menu: () => <svg {...s}><path d="M4 6h16M4 12h16M4 18h16" /></svg>,
  print: () => <svg {...s}><path d="M6.5 9V3h11v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M6.5 14h11v7h-11z" /></svg>,
  search: () => <svg {...s}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>,
  plus: () => <svg {...s}><path d="M12 5v14M5 12h14" /></svg>,
  check: () => <svg {...s}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>,
  close: () => <svg {...s}><path d="M6 6l12 12M18 6 6 18" /></svg>,
  dots: () => <svg {...s}><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></svg>,
  grip: () => <svg {...s} strokeWidth="2.5"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" /></svg>,
  trash: () => <svg {...s}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>,
  download: () => <svg {...s}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>,
  upload: () => <svg {...s}><path d="M12 20V9M7 14l5-5 5 5M5 4h14" /></svg>,
  copy: () => <svg {...s}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>,
  pencil: () => <svg {...s} width="14" height="14"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></svg>,
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

/** Confirmation for useLeaveGuard's blocker; `onSave` (returns true on success) adds "Save and leave". */
export function LeaveModal({ blocker, children, error, onSave, saving }) {
  if (blocker.state !== 'blocked') return null;
  return (
    <Modal title="Leave without saving?" onClose={() => blocker.reset()}>
      <p>{children}</p>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="form-actions">
        <button className="btn ghost" onClick={() => blocker.reset()}>Keep editing</button>
        <button className="btn danger" onClick={() => blocker.proceed()}>Discard changes</button>
        {onSave && (
          <button className="btn primary" disabled={saving} onClick={async () => { if (await onSave()) blocker.proceed(); }}>
            {saving && <Spinner />} Save and leave
          </button>
        )}
      </div>
    </Modal>
  );
}

export function Modal({ title, onClose, children, className = '' }) {
  const ref = useRef(null);
  const id = useId();
  useEscape(onClose);
  useInitialFocus(ref);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} tabIndex={-1}>
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

/** tabs: [{ value, label, short? }]; `short` is the label on a phone. */
export function Tabs({ tabs, value, onChange, className = '' }) {
  return (
    <div className={`tabs ${className}`} role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" className="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)} aria-label={t.short ? t.label : undefined}>
          {t.short ? <><span className="hide-sm">{t.label}</span><span className="show-sm">{t.short}</span></> : t.label}
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

/** Marks a record added in test mode. */
export function TestBadge({ item }) {
  return item?.isTest ? <span className="badge test" title="Test data: removed when you clear test data on the Backup page">Test</span> : null;
}

export function Notice({ kind = 'warn', children }) {
  if (!children || (Array.isArray(children) && !children.length)) return null;
  return (
    <div className={`notice ${kind === 'error' ? 'error' : kind === 'success' ? 'success' : ''}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon.alert />
      <div>{children}</div>
    </div>
  );
}

export const Spinner = () => <span className="spinner" aria-hidden="true" />;

/**
 * A page's main save button. Every label it can show is stacked in one grid cell, so switching
 * between "Save changes" and "Saved" doesn't change its width and shift the header. With unsaved
 * changes, a phone also shows it floating at the bottom of the screen once the header's button
 * has scrolled away. `isNew`: the item isn't saved yet, so it reads `createLabel` and stays enabled.
 */
export function SaveButton({ dirty, saving, disabled, onClick, isNew = false, createLabel = 'Create' }) {
  const ref = useRef(null);
  const [offscreen, setOffscreen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setOffscreen(!entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const labels = isNew ? [createLabel, 'Saving…'] : ['Save changes', 'Saved', 'Saving…'];
  const current = saving ? 'Saving…' : isNew ? createLabel : dirty ? 'Save changes' : 'Saved';
  const inner = (
    <span className="btn-stack">
      {labels.map((l) => (
        <span key={l} className={l === current ? undefined : 'off'} aria-hidden={l !== current || undefined}>
          {l === 'Saving…' && <Spinner />}{l}
        </span>
      ))}
    </span>
  );
  return (
    <>
      <button ref={ref} className="btn primary" disabled={disabled} onClick={onClick}>{inner}</button>
      {dirty && offscreen && (
        <div className="floating-save save-float">
          <button className="btn primary" disabled={disabled} onClick={onClick} tabIndex={-1} aria-hidden="true">{inner}</button>
        </div>
      )}
    </>
  );
}

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
