import { useSyncExternalStore } from 'react';

// Which skin the app renders: 'default' or 'alt' (the alternate theme, in development under
// skins/alt/). Per browser: saved as `skin` in localStorage and mirrored on <html data-skin>,
// which index.html sets before the first paint (also from ?skin=alt / ?skin=default).
const listeners = new Set();

export const getSkin = () => (document.documentElement.dataset.skin === 'alt' ? 'alt' : 'default');

export function setSkin(skin) {
  const alt = skin === 'alt';
  try { localStorage.setItem('skin', alt ? 'alt' : ''); } catch { /* not remembered, still applied */ }
  if (alt) document.documentElement.dataset.skin = 'alt';
  else delete document.documentElement.dataset.skin;
  listeners.forEach((fn) => fn());
}

const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** The current skin; re-renders when it's switched. */
export const useSkin = () => useSyncExternalStore(subscribe, getSkin);
