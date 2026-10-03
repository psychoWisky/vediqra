import React from 'react';
import { BRAND } from '../config/brand';

// The VEDIQRA brand mark: a gold ribbon "V" plus the wordmark, rendered once as PNGs (see
// frontend/public/brand) from the client's supplied logo and brand-spec screenshots (Bodoni/Didot-style
// serif, champagne-gold metallic gradient #F7D77A -> #B8862D -> #FFE6A0). Both read cleanly on black or white,
// so no separate light/dark variant is needed.
const MARK_SRC = '/brand/vediqra-mark.png';
const WORDMARK_SRC = '/brand/vediqra-wordmark.png';

/** Brand mark. Shows the logo uploaded in the admin when there is one, otherwise the VEDIQRA brand assets. */
const Logo: React.FC<{ src?: string | null; onError?: () => void; tone?: 'light' | 'dark'; className?: string }> = ({ src, onError, className = '' }) => {
  if (src) {
    return <img src={src} alt={BRAND.name} onError={onError} className={`h-9 w-auto sm:h-10 ${className}`} />;
  }
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <img src={MARK_SRC} alt="" aria-hidden="true" className="h-8 w-auto sm:h-9" />
      <img src={WORDMARK_SRC} alt={BRAND.name} className="h-5 w-auto sm:h-6" />
    </span>
  );
};

export default Logo;
