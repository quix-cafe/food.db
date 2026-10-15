import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { api, onDataChanged } from './api.js';

/** GET `path` (skipped when null); refetches on path change and on global data changes. */
export function useApi(path) {
  const [state, setState] = useState({ data: null, error: null, loading: !!path });
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await api(path);
      if (id === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (id === seq.current) setState((s) => ({ ...s, error, loading: false }));
    }
  }, [path]);

  useEffect(() => {
    load();
    return onDataChanged(load);
  }, [load]);

  return { ...state, reload: load, setData: (data) => setState((s) => ({ ...s, data })) };
}

export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Ask before leaving a page with unsaved changes: in-app navigation is blocked until the
 * user confirms (render <LeaveModal blocker={...}>), and closing or reloading the tab gets
 * the browser's own prompt. Call allowLeave() just before navigating away on purpose (after
 * a save, or from a Discard button): that render's blocker still sees the old state.
 * `resetKey` re-arms the guard when it changes (e.g. a new recipe id after creating one).
 */
export function useLeaveGuard(dirty, resetKey) {
  const leaving = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => { leaving.current = false; }, [resetKey]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  return { blocker, allowLeave: () => { leaving.current = true; } };
}

/**
 * Drag-to-reorder for table rows with a handle. Uses pointer events (mouse, touch and pen)
 * rather than HTML5 drag and drop, which phones and tablets don't support. Spread
 * rowProps(i) on each <tr> and handleProps(i) on its handle button; arrow keys on the
 * focused handle move the row too. `move(from, to)` does the actual reorder.
 */
export function useRowReorder(move) {
  const [drag, setDrag] = useState({ from: null, over: null });

  const onPointerDown = (from) => (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const rows = () => [...handle.closest('tbody').querySelectorAll(':scope > tr[data-reorder]')];
    let over = from;
    handle.setPointerCapture?.(e.pointerId);
    setDrag({ from, over });

    const onMove = (ev) => {
      const list = rows();
      let target = list.length - 1;
      for (let k = 0; k < list.length; k++) {
        if (ev.clientY < list[k].getBoundingClientRect().bottom) { target = k; break; }
      }
      if (target !== over) {
        over = target;
        setDrag({ from, over });
      }
      // Keep long lists reachable: scroll when the pointer nears the top or bottom edge.
      if (ev.clientY < 70) window.scrollBy(0, -12);
      else if (ev.clientY > window.innerHeight - 70) window.scrollBy(0, 12);
    };
    const finish = (commit) => () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', cancel);
      setDrag({ from: null, over: null });
      if (commit && over !== from) move(from, over);
    };
    const up = finish(true);
    const cancel = finish(false);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', cancel);
  };

  const onKeyDown = (i) => (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const target = e.currentTarget;
    move(i, i + (e.key === 'ArrowUp' ? -1 : 1));
    requestAnimationFrame(() => target.focus());
  };

  return {
    drag,
    rowProps: (i) => ({
      'data-reorder': '',
      className: `${drag.from === i ? 'dragging' : ''} ${drag.over === i && drag.from !== i ? 'drop-target' : ''}`,
    }),
    handleProps: (i) => ({ onPointerDown: onPointerDown(i), onKeyDown: onKeyDown(i) }),
  };
}
