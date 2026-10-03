import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ImageOff, ZoomIn } from 'lucide-react';
import { getImageUrl } from '../../utils/helpers';
import { Modal } from '../ui/Modal';

interface Props {
  images: string[];
  alt: string;
  /** Changing this (e.g. the chosen colour) resets the gallery to its first image. */
  resetKey?: string;
  badges?: React.ReactNode;
}

/**
 * Product image gallery: large image, thumbnails, previous/next, keyboard arrows and a full-size viewer.
 * No auto-advancing slides (they move content while the shopper is trying to read or choose).
 * With no images it shows an intentional placeholder instead of a broken image.
 */
const ProductGallery: React.FC<Props> = ({ images, alt, resetKey, badges }) => {
  const list = images.filter(Boolean);
  const [index, setIndex] = useState(0);
  const [broken, setBroken] = useState<Record<number, boolean>>({});
  const [viewer, setViewer] = useState(false);

  useEffect(() => { setIndex(0); setBroken({}); }, [resetKey, list.join('|')]);

  const count = list.length;
  const go = (delta: number) => setIndex((i) => (count ? (i + delta + count) % count : 0));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  };
  const current = list[index];
  const showPlaceholder = count === 0 || broken[index];

  return (
    <div onKeyDown={onKey}>
      <div className="relative overflow-hidden rounded-2xl border border-brand-line bg-brand-subtle">
        <div className="aspect-square">
          {showPlaceholder ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-brand-muted" role="img" aria-label={`${alt}: image not available`}>
              <ImageOff className="h-10 w-10" aria-hidden="true" />
              <span className="text-sm">Image coming soon</span>
            </div>
          ) : (
            <button type="button" onClick={() => setViewer(true)} aria-label={`Open larger image of ${alt}`} className="group relative block h-full w-full cursor-zoom-in">
              <img
                src={getImageUrl(current)}
                alt={`${alt}${count > 1 ? `, image ${index + 1} of ${count}` : ''}`}
                onError={() => setBroken((b) => ({ ...b, [index]: true }))}
                className="h-full w-full object-cover"
              />
              <span className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-brand-ink shadow" aria-hidden="true"><ZoomIn className="h-4 w-4" /></span>
            </button>
          )}
        </div>
        {badges && <div className="pointer-events-none absolute left-3 top-3 flex flex-col items-start gap-1.5">{badges}</div>}
        {count > 1 && (
          <>
            <button type="button" onClick={() => go(-1)} aria-label="Previous image" className="absolute left-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 shadow hover:bg-white"><ChevronLeft className="h-5 w-5" aria-hidden="true" /></button>
            <button type="button" onClick={() => go(1)} aria-label="Next image" className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 shadow hover:bg-white"><ChevronRight className="h-5 w-5" aria-hidden="true" /></button>
          </>
        )}
      </div>

      {count > 1 && (
        <ul className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Product images">
          {list.map((url, i) => (
            <li key={`${url}-${i}`} className="shrink-0">
              <button
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Show image ${i + 1} of ${count}`}
                aria-current={i === index}
                className={`h-16 w-16 overflow-hidden rounded-lg border-2 sm:h-20 sm:w-20 ${i === index ? 'border-brand-ink' : 'border-transparent opacity-80 hover:opacity-100'}`}
              >
                <img src={getImageUrl(url)} alt="" loading="lazy" className="h-full w-full object-cover" onError={(e) => { e.currentTarget.src = '/placeholder.svg'; }} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal isOpen={viewer} onClose={() => setViewer(false)} title={alt} widthClass="max-w-4xl">
        <div className="relative" onKeyDown={onKey}>
          <img src={getImageUrl(current)} alt={alt} className="mx-auto max-h-[70vh] w-auto max-w-full rounded-lg object-contain" onError={(e) => { e.currentTarget.src = '/placeholder.svg'; }} />
          {count > 1 && (
            <div className="mt-4 flex items-center justify-center gap-3">
              <button type="button" onClick={() => go(-1)} className="btn-secondary btn-sm">Previous</button>
              <span className="text-sm text-brand-muted" aria-live="polite">{index + 1} / {count}</span>
              <button type="button" onClick={() => go(1)} className="btn-secondary btn-sm">Next</button>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
};

export default ProductGallery;
