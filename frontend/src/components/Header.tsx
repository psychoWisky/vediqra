import React, { useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, Menu, Search, ShoppingBag } from 'lucide-react';
import { useCart } from '../context/CartContext';
import { useCategoryTree, categoryLink } from '../hooks/useCategoryTree';
import { Modal } from './ui/Modal';
import Logo from './Logo';

interface HeaderProps {
  logo: string | null;
  onLogoError: () => void;
  onOpenCart: () => void;
  onOpenFAQ: () => void;
}

const navLink = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-2 text-sm font-semibold transition-colors hover:bg-brand-subtle ${isActive ? 'text-brand-ink' : 'text-brand-muted hover:text-brand-ink'}`;

/** Desktop search: a real <form> that opens the product listing with ?search=. */
const SearchForm: React.FC<{ className?: string; autoFocus?: boolean; onDone?: () => void }> = ({ className = '', autoFocus, onDone }) => {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const id = useId();
  return (
    <form
      role="search"
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        const term = q.trim();
        navigate(term ? `/products?search=${encodeURIComponent(term)}` : '/products');
        setQ('');
        onDone?.();
      }}
    >
      <label htmlFor={id} className="sr-only">Search products</label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-muted" aria-hidden="true" />
        <input
          id={id}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search products"
          autoFocus={autoFocus}
          className="input !min-h-[40px] !rounded-full !py-2 !pl-9 !pr-4"
        />
      </div>
    </form>
  );
};

const Header: React.FC<HeaderProps> = ({ logo, onLogoError, onOpenCart, onOpenFAQ }) => {
  const { itemCount } = useCart();
  const { tree } = useCategoryTree();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  // The dropdown opens on hover (mouse) or on click / Enter / Space (touch, keyboard). A click while it is only
  // hover-open pins it open instead of closing it.
  const [hoverOpen, setHoverOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const shopOpen = hoverOpen || pinned;
  const setShopOpen = (v: boolean) => { setHoverOpen(v); setPinned(v); };
  const [mobileShopOpen, setMobileShopOpen] = useState(false);
  const shopRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();

  // close menus on navigation
  useEffect(() => { setMenuOpen(false); setShopOpen(false); }, [location.pathname, location.search]);

  // Escape / outside click close the desktop dropdown
  useEffect(() => {
    if (!shopOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShopOpen(false); };
    const onDown = (e: MouseEvent) => { if (shopRef.current && !shopRef.current.contains(e.target as Node)) setShopOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [shopOpen]);

  const openShop = () => { clearTimeout(closeTimer.current); setHoverOpen(true); };
  const closeShopSoon = () => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setHoverOpen(false), 150); };

  return (
    <>
    <header className="sticky top-0 z-40 border-b border-brand-line bg-white/95 backdrop-blur">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-brand-ink focus:px-4 focus:py-2 focus:text-white">Skip to content</a>
      <div className="container-page flex h-16 items-center gap-3">
        {/* mobile menu button */}
        <button type="button" onClick={() => setMenuOpen(true)} aria-label="Open menu" aria-haspopup="dialog" className="btn-ghost -ml-2 !px-2 lg:hidden">
          <Menu className="h-6 w-6" aria-hidden="true" />
        </button>

        <Link to="/" aria-label="VEDIQRA home" onClick={() => window.scrollTo(0, 0)} className="shrink-0 rounded-lg">
          <Logo src={logo} onError={onLogoError} />
        </Link>

        {/* desktop navigation */}
        <nav aria-label="Main" className="ml-6 hidden items-center gap-1 lg:flex">
          <div ref={shopRef} className="relative" onMouseEnter={openShop} onMouseLeave={closeShopSoon}>
            <button
              type="button"
              aria-expanded={shopOpen}
              aria-controls="shop-menu"
              onClick={() => (pinned ? setShopOpen(false) : setPinned(true))}
              className={`${navLink({ isActive: location.pathname.startsWith('/products') })} inline-flex items-center gap-1`}
            >
              Shop <ChevronDown className={`h-4 w-4 transition-transform ${shopOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {shopOpen && (
              <div id="shop-menu" className="absolute left-0 top-full z-50 mt-1 w-[44rem] max-w-[calc(100vw-2rem)] rounded-xl border border-brand-line bg-white p-5 shadow-pop">
                {tree.length === 0 ? (
                  <p className="text-sm text-brand-muted">Categories will appear here.</p>
                ) : (
                  <ul className="grid grid-cols-3 gap-x-6 gap-y-5">
                    {tree.map((parent) => (
                      <li key={parent.id}>
                        <Link to={categoryLink(parent)} className="text-sm font-bold hover:text-brand-accent-ink">{parent.name}</Link>
                        {parent.children && parent.children.length > 0 && (
                          <ul className="mt-1.5 space-y-1">
                            {parent.children.map((child) => (
                              <li key={child.id}>
                                <Link to={categoryLink(child)} className="text-sm text-brand-muted hover:text-brand-ink">{child.name}</Link>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-5 border-t border-brand-line pt-3">
                  <Link to="/products" className="text-sm font-semibold hover:text-brand-accent-ink">View all products →</Link>
                </div>
              </div>
            )}
          </div>
          <NavLink to="/combos" className={navLink}>Combos</NavLink>
          <NavLink to="/custom-combo" className={navLink}>Custom Combo</NavLink>
          <NavLink to="/track-order" className={navLink}>Track Order</NavLink>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <SearchForm className="hidden w-56 xl:block" />
          <Link to="/products" aria-label="Search products" className="btn-ghost !px-2 xl:hidden"><Search className="h-5 w-5" aria-hidden="true" /></Link>
          <button type="button" onClick={onOpenCart} aria-label={`Open cart, ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`} className="btn-ghost relative !px-2">
            <ShoppingBag className="h-6 w-6" aria-hidden="true" />
            {itemCount > 0 && (
              <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-brand-accent px-1 text-[11px] font-bold text-brand-ink">{itemCount}</span>
            )}
          </button>
        </div>
      </div>
    </header>

      {/* mobile / tablet navigation drawer (outside <header>: backdrop-filter would trap position:fixed) */}
      <Modal isOpen={menuOpen} onClose={() => setMenuOpen(false)} title="Menu" placement="left">
        <div className="p-5">
          <SearchForm autoFocus={false} onDone={() => setMenuOpen(false)} />
          <nav aria-label="Mobile" className="mt-4">
            <ul className="divide-y divide-brand-line">
              <li>
                <button type="button" aria-expanded={mobileShopOpen} onClick={() => setMobileShopOpen((o) => !o)} className="flex w-full items-center justify-between py-3.5 text-left font-semibold">
                  Shop <ChevronDown className={`h-4 w-4 transition-transform ${mobileShopOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>
                {mobileShopOpen && (
                  <ul className="pb-3 pl-2">
                    <li><Link to="/products" className="block py-2 text-sm font-semibold">All products</Link></li>
                    {tree.map((parent) => (
                      <li key={parent.id} className="py-1">
                        <Link to={categoryLink(parent)} className="block py-1.5 text-sm font-semibold">{parent.name}</Link>
                        {parent.children && parent.children.length > 0 && (
                          <ul className="pl-3">
                            {parent.children.map((child) => (
                              <li key={child.id}><Link to={categoryLink(child)} className="block py-1.5 text-sm text-brand-muted">{child.name}</Link></li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
              <li><Link to="/combos" className="block py-3.5 font-semibold">Combos</Link></li>
              <li><Link to="/custom-combo" className="block py-3.5 font-semibold">Custom Combo</Link></li>
              <li><Link to="/track-order" className="block py-3.5 font-semibold">Track Order</Link></li>
              <li><button type="button" onClick={() => { setMenuOpen(false); onOpenFAQ(); }} className="block w-full py-3.5 text-left font-semibold">FAQ</button></li>
            </ul>
          </nav>
        </div>
      </Modal>
    </>
  );
};

export default Header;
