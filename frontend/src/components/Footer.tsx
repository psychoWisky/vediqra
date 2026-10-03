import React from 'react';
import { Link } from 'react-router-dom';
import { Instagram, Mail, Phone } from 'lucide-react';
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

const linkCls = 'text-sm text-white/70 transition-colors hover:text-white';
const headCls = 'mb-4 text-xs font-semibold uppercase tracking-[0.14em] text-brand-accent';

const Footer: React.FC<FooterProps> = ({ logo, onLogoError, onOpenFAQ, onOpenShipping, onOpenReturns }) => {
  const { tree } = useCategoryTree();
  const socials = [
    { label: 'Instagram', href: BRAND.social.instagram, icon: <Instagram className="h-5 w-5" aria-hidden="true" /> },
    { label: 'Facebook', href: BRAND.social.facebook, icon: <span className="text-sm font-bold" aria-hidden="true">f</span> },
    { label: 'YouTube', href: BRAND.social.youtube, icon: <span className="text-xs font-bold" aria-hidden="true">YT</span> },
    { label: 'X', href: BRAND.social.x, icon: <span className="text-sm font-bold" aria-hidden="true">X</span> },
  ].filter((s) => s.href);
  const hasContact = Boolean(BRAND.supportEmail || BRAND.supportPhone);

  return (
    <footer className="bg-brand-ink text-white">
      <div className="container-page grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <Link to="/" onClick={() => window.scrollTo(0, 0)} aria-label="VEDIQRA home" className="inline-block">
            <Logo src={logo} onError={onLogoError} tone="light" />
          </Link>
          <p className="mt-4 max-w-xs text-sm text-white/70">{BRAND.tagline}</p>
          {socials.length > 0 && (
            <ul className="mt-5 flex gap-3">
              {socials.map((s) => (
                <li key={s.label}>
                  <a href={s.href} target="_blank" rel="noopener noreferrer" aria-label={s.label} className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-brand-accent hover:text-brand-ink">{s.icon}</a>
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
        <div className="container-page py-6 text-center text-xs text-white/50">© {new Date().getFullYear()} {BRAND.name}. All rights reserved.</div>
      </div>
    </footer>
  );
};

export default Footer;
