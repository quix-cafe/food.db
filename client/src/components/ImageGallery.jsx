import { useEffect, useState } from 'react';
import { Icon, Spinner } from './ui.jsx';

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';

/**
 * Thumbnail grid with add/remove/cover controls and a full-size viewer.
 * images: [{ id, url, originalName }] — the first one is the cover when `onMakeCover` is given.
 */
export default function ImageGallery({ images, onAdd, onRemove, onMakeCover, busy = false, label = 'photo', emptyText }) {
  const [viewing, setViewing] = useState(null);
  const [over, setOver] = useState(false);

  const add = (fileList) => {
    const files = [...fileList].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic)$/i.test(f.name));
    if (files.length) onAdd?.(files);
  };

  return (
    <div
      className={`image-gallery ${over ? 'over' : ''}`}
      onDragOver={onAdd ? (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } } : undefined}
      onDragLeave={() => setOver(false)}
      onDrop={onAdd ? (e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); } : undefined}
    >
      {images.map((img, i) => (
        <figure key={img.id} className="thumb">
          <button type="button" className="thumb-img" onClick={() => setViewing(i)} aria-label={`View ${label} ${i + 1}${img.originalName ? ` (${img.originalName})` : ''}`}>
            <img src={img.thumbUrl ?? img.url} alt="" loading="lazy" />
          </button>
          {onMakeCover && i === 0 && images.length > 1 && <span className="badge cover-badge">Cover</span>}
          {(onRemove || (onMakeCover && i > 0)) && (
            <figcaption>
              {onMakeCover && i > 0 && <button type="button" className="link-btn" onClick={() => onMakeCover(img)}>Make cover</button>}
              {onRemove && (
                <button type="button" className="icon-btn" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onRemove(img)}><Icon.trash /></button>
              )}
            </figcaption>
          )}
        </figure>
      ))}
      {onAdd && (
        <label className="thumb add-tile">
          {busy ? <Spinner /> : <Icon.plus />}
          <span>{busy ? 'Uploading…' : `Add ${label}s`}</span>
          <input type="file" accept={ACCEPT} multiple className="visually-hidden" disabled={busy} onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
        </label>
      )}
      {!images.length && !onAdd && emptyText && <p className="muted">{emptyText}</p>}
      {viewing !== null && images[viewing] && (
        <Lightbox images={images} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

export function Lightbox({ images, index, onIndex, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') onIndex((index + 1) % images.length);
      if (e.key === 'ArrowLeft') onIndex((index - 1 + images.length) % images.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, images.length, onClose, onIndex]);

  const img = images[index];
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`Image ${index + 1} of ${images.length}`} onClick={onClose}>
      <img src={img.url} alt={img.originalName ?? ''} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        {images.length > 1 && <button type="button" className="btn small" onClick={() => onIndex((index - 1 + images.length) % images.length)}>Previous</button>}
        <span>{index + 1} / {images.length}{img.originalName ? `, ${img.originalName}` : ''}</span>
        {images.length > 1 && <button type="button" className="btn small" onClick={() => onIndex((index + 1) % images.length)}>Next</button>}
        <button type="button" className="btn small" onClick={onClose} autoFocus>Close</button>
      </div>
    </div>
  );
}

/** Object URLs for local File objects (revoked on change/unmount), shaped like server images. */
export function useLocalImages(files) {
  const [images, setImages] = useState([]);
  useEffect(() => {
    const list = files.map((f, i) => ({ id: `local-${i}-${f.name}-${f.size}`, url: URL.createObjectURL(f), originalName: f.name, file: f }));
    setImages(list);
    return () => list.forEach((l) => URL.revokeObjectURL(l.url));
  }, [files]);
  return images;
}
