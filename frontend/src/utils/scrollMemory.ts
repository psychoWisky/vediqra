/**
 * Remembers how far each history entry was scrolled, so Back/Forward can return to the same place.
 * Positions are stored by the router's per-entry `location.key` in sessionStorage (survives a reload, gone with the tab).
 */
const STORAGE_KEY = 'vq_scroll';
const MAX_ENTRIES = 50;

const read = (): Record<string, number> => {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { return {}; }
};
const write = (all: Record<string, number>) => {
  try {
    const keys = Object.keys(all);
    if (keys.length > MAX_ENTRIES) keys.slice(0, keys.length - MAX_ENTRIES).forEach((k) => delete all[k]);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch { /* storage unavailable: positions are simply not remembered */ }
};

// The router keeps a unique `key` in each history entry's state ('default' for the first one). Reading it at the moment the scroll
// event is handled keeps positions attached to the right entry even while a lazy page is still loading and React has not re-rendered.
const entryKey = (): string => (window.history.state && window.history.state.key) || 'default';
let pending = 0;

export const rememberScroll = {
  /** Save the position of the current entry while the user scrolls (once per frame). Returns the cleanup. */
  listen() {
    // We restore positions ourselves; the browser's own (automatic) restoration would race with the page being rebuilt.
    const previousMode = 'scrollRestoration' in history ? history.scrollRestoration : null;
    if (previousMode !== null) history.scrollRestoration = 'manual';
    const onScroll = () => {
      if (pending) return;
      const key = entryKey();           // taken now: by the time the frame runs a navigation may have happened
      pending = requestAnimationFrame(() => {
        pending = 0;
        const all = read();
        delete all[key];                 // re-insert so the most recent entries are the ones kept
        all[key] = Math.round(window.scrollY);
        write(all);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { if (previousMode !== null) history.scrollRestoration = previousMode; window.removeEventListener('scroll', onScroll); if (pending) { cancelAnimationFrame(pending); pending = 0; } };
  },
};

/**
 * Scroll to where this history entry was left. The page may still be filling in (data arriving), so it waits, for up to about
 * two seconds, until the document is tall enough; if the visitor scrolls or presses a key meanwhile, it gives up immediately.
 * Returns a cleanup that cancels a pending restore.
 */
// The stylesheet makes page scrolling smooth; restoring a position must jump, not glide.
const jump = (y: number) => window.scrollTo({ top: y, left: 0, behavior: 'instant' as ScrollBehavior });

let firstRestore = true;
/** True when this document was opened by following a link / typing an address, as opposed to a reload or Back from elsewhere. */
const isFreshVisit = (): boolean => {
  try { return (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type === 'navigate'; } catch { return false; }
};

export const restoreScroll = (key: string): (() => void) => {
  const all = read();
  let y: number | undefined = all[key];
  // The first history entry of every visit is called 'default'. A brand-new visit must not inherit the position saved by an older
  // visit in the same tab; only a reload or a Back/Forward into this document may restore it.
  if (firstRestore) {
    firstRestore = false;
    if (isFreshVisit()) { y = undefined; if (key in all) { delete all[key]; write(all); } }
  }
  if (!y || y <= 0) { jump(0); return () => {}; }
  let cancelled = false;
  let frames = 0;
  const events = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
  const stop = () => { cancelled = true; events.forEach((e) => window.removeEventListener(e, stop)); };
  events.forEach((e) => window.addEventListener(e, stop, { passive: true }));
  const step = () => {
    if (cancelled) return;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    if (maxScroll >= y || frames >= 120) { jump(Math.min(y, Math.max(maxScroll, 0))); stop(); return; }
    frames++;
    requestAnimationFrame(step);
  };
  step();
  return stop;
};
