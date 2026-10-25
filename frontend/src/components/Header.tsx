import React, { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, Menu, ShoppingBag } from 'lucide-react';
import { useCart } from '../context/CartContext';
import { useCategoryTree, categoryLink } from '../hooks/useCategoryTree';
import { Modal } from './ui/Modal';
import Logo from './Logo';
import HeaderSearch from './HeaderSearch';
import { BUDGET_BANDS, budgetLink } from '../utils/shopLinks';

interface HeaderProps {
  logo: string | null;
  onLogoError: () => void;
  onOpenCart: () => void;
  onOpenFAQ: () => void;
}

// Editorial navigation: small caps, wide tracking, a gold hairline that draws in under the active / hovered item.
const navLink = ({ isActive }: { isActive: boolean }) =>
  `group relative px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.16em] transition-colors after:absolute after:inset-x-4 after:-bottom-0.5 after:h-px after:origin-left after:scale-x-0 after:bg-brand-accent after:transition-transform after:duration-300 hover:after:scale-x-100 focus-visible:after:scale-x-100 ${isActive ? 'text-brand-accent-ink after:scale-x-100' : 'text-brand-ink/80 hover:text-brand-ink'}`;

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
  const [mobileBudgetOpen, setMobileBudgetOpen] = useState(false);
  const shopRef = useRef<HTMLDivElement>(null);
  const shopBtnRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();

  // close menus on navigation
  useEffect(() => { setMenuOpen(false); setShopOpen(false); }, [location.pathname, location.search]);

  // Escape / outside click close the desktop dropdown
  useEffect(() => {
    if (!shopOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (shopRef.current?.contains(document.activeElement)) shopBtnRef.current?.focus();      // keep the keyboard user's place
      setShopOpen(false);
    };
    const onDown = (e: MouseEvent) => { if (shopRef.current && !shopRef.current.contains(e.target as Node)) setShopOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [shopOpen]);

  const openShop = () => { clearTimeout(closeTimer.current); setHoverOpen(true); };
  const closeShopSoon = () => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setHoverOpen(false), 150); };

  return (
    <>
    <header className="sticky top-0 z-40 border-b border-brand-line bg-brand-surface/90 backdrop-blur-md">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-brand-fill focus:px-4 focus:py-2 focus:text-brand-on-fill">Skip to content</a>
      <div className="container-page flex h-16 items-center gap-3 lg:grid lg:h-[76px] lg:grid-cols-[1fr_auto_1fr] lg:gap-8">
        {/* mobile menu button */}
        <button type="button" onClick={() => setMenuOpen(true)} aria-label="Open menu" aria-haspopup="dialog" className="btn-ghost -ml-2 !px-2 lg:hidden">
          <Menu className="h-6 w-6" strokeWidth={1.5} aria-hidden="true" />
        </button>

        <Link to="/" aria-label="VEDIQRA home" onClick={() => window.scrollTo(0, 0)} className="shrink-0 rounded-sm lg:justify-self-start">
          <Logo src={logo} onError={onLogoError} />
        </Link>

        {/* desktop navigation */}
        <nav aria-label="Main" className="hidden items-center lg:flex">
          <div
            ref={shopRef}
            className="static"
            onMouseEnter={openShop}
            onMouseLeave={closeShopSoon}
            onBlur={(e) => { if (!shopRef.current?.contains(e.relatedTarget as Node | null)) setPinned(false); }}
          >
            <button
              ref={shopBtnRef}
              type="button"
              aria-expanded={shopOpen}
              aria-controls="shop-menu"
              onClick={() => (pinned ? setShopOpen(false) : setPinned(true))}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setPinned(true);
                  setTimeout(() => document.querySelector<HTMLAnchorElement>('#shop-menu a')?.focus(), 0);      // first link of the opened menu
                }
              }}
              className={`${navLink({ isActive: location.pathname.startsWith('/products') })} inline-flex items-center gap-1`}
            >
              Shop <ChevronDown className={`h-4 w-4 transition-transform ${shopOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {shopOpen && (
              <div id="shop-menu" className="absolute inset-x-0 top-full z-50 max-h-[calc(100vh-5rem)] overflow-y-auto border-b border-t border-brand-line bg-brand-surface shadow-pop">
                <div className="container-page grid gap-x-16 gap-y-8 py-10 lg:grid-cols-[1fr_17rem]">
                  <div>
                    <p className="eyebrow mb-6">Collections</p>
                    {tree.length === 0 ? (
                      <p className="text-sm text-brand-muted">Categories will appear here.</p>
                    ) : (
                      <ul className="grid grid-cols-2 gap-x-10 gap-y-8 xl:grid-cols-3">
                        {tree.map((parent) => (
                          <li key={parent.id}>
                            <Link to={categoryLink(parent)} className="font-display text-xl font-semibold leading-tight transition-colors hover:text-brand-accent-ink">{parent.name}</Link>
                            {parent.children && parent.children.length > 0 && (
                              <ul className="mt-3 space-y-1.5 border-l border-brand-line pl-4">
                                {parent.children.map((child) => (
                                  <li key={child.id}>
                                    <Link to={categoryLink(child)} className="text-sm text-brand-muted transition-colors hover:text-brand-ink">{child.name}</Link>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="border-brand-line lg:border-l lg:pl-10">
                    <p className="eyebrow mb-6">Shop by budget</p>
                    <ul className="space-y-1">
                      {BUDGET_BANDS.map((b) => (
                        <li key={b.key}><Link to={budgetLink(b)} className="group flex items-center justify-between border-b border-brand-line py-3 text-[15px] transition-colors hover:text-brand-accent-ink">{b.label}<span aria-hidden="true" className="text-brand-accent opacity-0 transition-all group-hover:translate-x-1 group-hover:opacity-100">→</span></Link></li>
                      ))}
                    </ul>
                    <Link to="/products" className="mt-6 inline-block border-b border-brand-accent/60 pb-1 text-[12px] font-semibold uppercase tracking-[0.14em] hover:border-brand-accent hover:text-brand-accent-ink">View all products →</Link>
                  </div>
                </div>
              </div>
            )}
          </div>
          <NavLink to="/combos" className={navLink}>Combos</NavLink>
          <NavLink to="/custom-combo" className={navLink}>Custom Combo</NavLink>
          <NavLink to="/track-order" className={navLink}>Track Order</NavLink>
        </nav>

        <div className="ml-auto flex items-center gap-3 lg:justify-self-end">
          <HeaderSearch className="hidden w-56 md:block xl:w-72" />
          <button type="button" onClick={onOpenCart} aria-label={`Open cart, ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`} className="btn-ghost relative !px-2">
            <ShoppingBag className="h-[22px] w-[22px]" strokeWidth={1.5} aria-hidden="true" />
            {itemCount > 0 && (
              <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-brand-accent px-1 text-[10px] font-bold text-[#111111]">{itemCount}</span>
            )}
          </button>
        </div>
      </div>
      {/* phones: the search box gets its own full-width row under the bar (an input, not a link to another page) */}
      <div className="container-page pb-3 md:hidden">
        <HeaderSearch />
      </div>
    </header>

      {/* mobile / tablet navigation drawer (outside <header>: backdrop-filter would trap position:fixed) */}
      <Modal isOpen={menuOpen} onClose={() => setMenuOpen(false)} title="Menu" placement="left">
        <div className="p-5">
          <nav aria-label="Mobile">
            <ul className="divide-y divide-brand-line">
              <li>
                <button type="button" aria-expanded={mobileShopOpen} onClick={() => setMobileShopOpen((o) => !o)} className="flex w-full items-center justify-between py-4 text-left font-display text-xl font-semibold">
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
              <li>
                <button type="button" aria-expanded={mobileBudgetOpen} onClick={() => setMobileBudgetOpen((o) => !o)} className="flex w-full items-center justify-between py-4 text-left font-display text-xl font-semibold">
                  Shop by budget <ChevronDown className={`h-4 w-4 transition-transform ${mobileBudgetOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>
                {mobileBudgetOpen && (
                  <ul className="pb-3 pl-2">
                    {BUDGET_BANDS.map((b) => (<li key={b.key}><Link to={budgetLink(b)} className="block py-2 text-sm">{b.label}</Link></li>))}
                  </ul>
                )}
              </li>
              <li><Link to="/combos" className="block py-4 font-display text-xl font-semibold">Combos</Link></li>
              <li><Link to="/custom-combo" className="block py-4 font-display text-xl font-semibold">Custom Combo</Link></li>
              <li><Link to="/track-order" className="block py-4 font-display text-xl font-semibold">Track Order</Link></li>
              <li><button type="button" onClick={() => { setMenuOpen(false); onOpenFAQ(); }} className="block w-full py-4 text-left font-display text-xl font-semibold">FAQ</button></li>
            </ul>
          </nav>
        </div>
      </Modal>
    </>
  );
};

export default Header;
