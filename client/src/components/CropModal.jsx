import { useRef, useState } from 'react';
import { Modal, Notice, Spinner } from './ui.jsx';

const MIN = 0.05; // the smallest selection, as a fraction of a side
const SHAPES = [['free', 'Any shape', null], ['square', 'Square', 1], ['wide', '4 : 3', 4 / 3]];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The largest centered selection of `ratio` (width ÷ height in pixels) on a photo `shape` wide per tall. */
function centered(ratio, shape) {
  if (!ratio) return { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
  const r = ratio / shape; // the ratio in fractions of each side
  const w = r >= 1 ? 0.9 : 0.9 * r;
  const h = r >= 1 ? 0.9 / r : 0.9;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/**
 * Pick a rectangle of a photo to keep: drag it to move, drag a corner to resize. `onCrop` gets
 * { x, y, width, height } as fractions of the photo (so nothing here depends on its pixel size)
 * and may be async; the dialog closes once it's done.
 */
export default function CropModal({ image, onCrop, onClose }) {
  const [rect, setRect] = useState({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 });
  const [shape, setShape] = useState(1); // the photo's width ÷ height, once it has loaded
  const [ratio, setRatio] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const stage = useRef(null);
  const drag = useRef(null);

  const start = (mode) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    stage.current.setPointerCapture?.(e.pointerId);
    drag.current = { mode, from: rect, px: e.clientX, py: e.clientY };
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const box = stage.current.getBoundingClientRect();
    const dx = (e.clientX - d.px) / box.width;
    const dy = (e.clientY - d.py) / box.height;
    const f = d.from;
    if (d.mode === 'move') {
      setRect({ ...f, x: clamp(f.x + dx, 0, 1 - f.w), y: clamp(f.y + dy, 0, 1 - f.h) });
      return;
    }
    // A corner moves; the opposite corner stays put.
    const left = d.mode.includes('w');
    const top = d.mode.includes('n');
    const ax = left ? f.x + f.w : f.x; // the fixed corner
    const ay = top ? f.y + f.h : f.y;
    let w = clamp(left ? f.w - dx : f.w + dx, MIN, left ? ax : 1 - ax);
    let h = clamp(top ? f.h - dy : f.h + dy, MIN, top ? ay : 1 - ay);
    if (ratio) {
      const r = ratio / shape;
      h = w / r;
      const room = top ? ay : 1 - ay;
      if (h > room) { h = room; w = h * r; }
    }
    setRect({ x: left ? ax - w : ax, y: top ? ay - h : ay, w, h });
  };
  const stop = () => { drag.current = null; };

  const pick = (r) => { setRatio(r); setRect(centered(r, shape)); };
  const crop = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCrop({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  const pct = (v) => `${v * 100}%`;

  return (
    <Modal title="Crop photo" className="crop-modal" onClose={() => !busy && onClose()}>
      <div className="crop-stage" ref={stage} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop}>
        <img src={image.url} alt="" draggable={false} onLoad={(e) => setShape(e.target.naturalWidth / e.target.naturalHeight || 1)} />
        <div className="crop-sel" style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }} onPointerDown={start('move')}>
          {['nw', 'ne', 'sw', 'se'].map((c) => <span key={c} className={`crop-handle ${c}`} onPointerDown={start(c)} />)}
        </div>
      </div>
      <div className="crop-shapes" role="group" aria-label="Shape">
        {SHAPES.map(([key, label, r]) => (
          <button key={key} type="button" className="chip" aria-pressed={ratio === r} onClick={() => pick(r)}>{label}</button>
        ))}
        <small className="muted">Drag the box to move it, a corner to resize. What’s outside is cut away for good.</small>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="form-actions">
        <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy} onClick={crop}>{busy && <Spinner />} Crop photo</button>
      </div>
    </Modal>
  );
}

/** A local image File cut down to `rect` (fractions of it), for a photo that isn't uploaded yet. */
export async function cropFile(file, rect) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const x = Math.round(rect.x * bitmap.width);
  const y = Math.round(rect.y * bitmap.height);
  const w = Math.max(1, Math.min(bitmap.width - x, Math.round(rect.width * bitmap.width)));
  const h = Math.max(1, Math.min(bitmap.height - y, Math.round(rect.height * bitmap.height)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, x, y, w, h, 0, 0, w, h);
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('This photo couldn’t be cropped'))), type, 0.92));
  return new File([blob], type === file.type ? file.name : file.name.replace(/\.\w+$/, '') + '.jpg', { type });
}
