import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Instagram, Mail, MapPin, Phone } from 'lucide-react';
import { BRAND } from '../config/brand';
import { useCategoryTree, categoryLink } from '../hooks/useCategoryTree';
import Logo from './Logo';

interface FooterProps {
  logo: string | null;
  onLogoError: () => void;
  onOpenFAQ: () => void;
  onOpenShipping: () => void;
  onOpenReturns: () => void;
}

const linkCls = 'text-[14px] text-white/65 transition-colors hover:text-brand-accent-ink';
const headCls = 'mb-5 text-[11px] font-semibold uppercase tracking-[0.22em] text-brand-accent';

const Footer: React.FC<FooterProps> = ({ logo, onLogoError, onOpenFAQ, onOpenShipping, onOpenReturns }) => {
  const { tree } = useCategoryTree();
  const socials = [
    { label: 'Instagram', href: BRAND.social.instagram, icon: <Instagram className="h-5 w-5" aria-hidden="true" /> },
    { label: 'Facebook', href: BRAND.social.facebook, icon: <span className="text-sm font-bold" aria-hidden="true">f</span> },
    { label: 'YouTube', href: BRAND.social.youtube, icon: <span className="text-xs font-bold" aria-hidden="true">YT</span> },
    { label: 'X', href: BRAND.social.x, icon: <span className="text-sm font-bold" aria-hidden="true">X</span> },
  ].filter((s) => s.href);
  const hasContact = Boolean(BRAND.supportEmail || BRAND.supportPhone || BRAND.address.length);

  return (
    <footer className="border-t border-brand-line bg-brand-panel text-white">
      {/* closing statement */}
      <div className="border-b border-white/10">
        <div className="container-page flex flex-col items-start justify-between gap-8 py-14 md:flex-row md:items-end md:py-20">
          <div className="max-w-2xl">
            <p className="eyebrow mb-5">VEDIQRA</p>
            <p className="font-display text-3xl font-semibold leading-[1.15] sm:text-4xl md:text-5xl">Gifts that carry your <span className="text-gold">own words and faces.</span></p>
          </div>
          <Link to="/products" onClick={() => window.scrollTo(0, 0)} className="group inline-flex items-center gap-3 border-b border-brand-accent/70 pb-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:border-brand-accent hover:text-brand-accent-ink">
            Explore the collection <ArrowUpRight className="h-4 w-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="container-page grid gap-12 py-14 sm:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr_1.4fr]">
        <div>
          <Link to="/" onClick={() => window.scrollTo(0, 0)} aria-label="VEDIQRA home" className="inline-block">
            <Logo src={logo} onError={onLogoError} tone="light" />
          </Link>
          <p className="mt-5 max-w-xs text-[14px] leading-relaxed text-white/60">{BRAND.tagline}</p>
          {socials.length > 0 && (
            <ul className="mt-6 flex gap-2">
              {socials.map((s) => (
                <li key={s.label}>
                  <a href={s.href} target="_blank" rel="noopener noreferrer" aria-label={s.label} className="flex h-10 w-10 items-center justify-center rounded-sm border border-white/15 transition-colors hover:border-brand-accent hover:text-brand-accent-ink">{s.icon}</a>
                </li>
              ))}
            </ul>
          )}
        </div>

        <nav aria-label="Shop">
          <h2 className={headCls}>Shop</h2>
          <ul className="space-y-2.5">
            <li><Link to="/products" className={linkCls}>All products</Link></li>
            {tree.slice(0, 6).map((c) => (
              <li key={c.id}><Link to={categoryLink(c)} className={linkCls}>{c.name}</Link></li>
            ))}
            <li><Link to="/combos" className={linkCls}>Combos</Link></li>
            <li><Link to="/custom-combo" className={linkCls}>Custom Combo</Link></li>
          </ul>
        </nav>

        <nav aria-label="Help">
          <h2 className={headCls}>Help</h2>
          <ul className="space-y-2.5">
            <li><Link to="/track-order" className={linkCls}>Track your order</Link></li>
            <li><button type="button" onClick={onOpenFAQ} className={linkCls}>FAQ</button></li>
            <li><button type="button" onClick={onOpenShipping} className={linkCls}>Shipping information</button></li>
            <li><button type="button" onClick={onOpenReturns} className={linkCls}>Returns policy</button></li>
          </ul>
        </nav>

        <div>
          <h2 className={headCls}>Contact</h2>
          {hasContact ? (
            <ul className="space-y-3">
              {BRAND.address.length > 0 && (
                <li className="flex items-start gap-3 text-sm text-white/70"><MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><address className="not-italic">{BRAND.address.map((line) => <span key={line} className="block">{line}</span>)}</address></li>
              )}
              {BRAND.supportEmail && (
                <li className="flex items-center gap-3 text-sm text-white/70"><Mail className="h-4 w-4 shrink-0" aria-hidden="true" /><a href={`mailto:${BRAND.supportEmail}`} className="hover:text-white">{BRAND.supportEmail}</a></li>
              )}
              {BRAND.supportPhone && (
                <li className="flex items-center gap-3 text-sm text-white/70"><Phone className="h-4 w-4 shrink-0" aria-hidden="true" /><a href={`tel:${BRAND.supportPhone.replace(/\s+/g, '')}`} className="hover:text-white">{BRAND.supportPhone}</a></li>
              )}
            </ul>
          ) : (
            <p className="text-sm text-white/50">Contact details will be added here.</p>
          )}
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className="container-page flex flex-col items-center justify-between gap-2 py-6 text-center text-xs text-white/45 sm:flex-row sm:text-left">© {new Date().getFullYear()} {BRAND.name}. All rights reserved. <span className="whitespace-nowrap">Developed by <span className="text-brand-accent-ink">GOBT</span>.</span></div>
      </div>
    </footer>
  );
};

export default Footer;
