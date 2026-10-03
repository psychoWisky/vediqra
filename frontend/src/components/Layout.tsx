import React, { useState, useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { ArrowUp } from 'lucide-react';
import CartDrawer from './CartDrawer';
import FAQModal from './FAQModal';
import ShippingInfoModal from './ShippingInfoModal';
import ReturnPolicyModal from './ReturnPolicyModal';
import Header from './Header';
import Footer from './Footer';
import { publicFetch } from '../utils/api';
import { OPEN_CART_EVENT } from '../utils/cartUi';
import { trackPageView } from '../utils/metaPixel';

const Layout: React.FC = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [showFAQ, setShowFAQ] = useState(false);
  const [showShipping, setShowShipping] = useState(false);
  const [showReturns, setShowReturns] = useState(false);
  const [logo, setLogo] = useState<string | null>(null);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const location = useLocation();

  // any page can ask for the cart drawer (utils/cartUi)
  useEffect(() => {
    const open = () => setIsCartOpen(true);
    window.addEventListener(OPEN_CART_EVENT, open);
    return () => window.removeEventListener(OPEN_CART_EVENT, open);
  }, []);

  // back-to-top appears after scrolling
  useEffect(() => {
    const onScroll = () => setShowBackToTop(window.scrollY > 600);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // A new page starts at the top (route changes only; ?query changes such as filters keep the position).
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);

  // Meta Pixel PageView on client-side navigation. The initial load's PageView is already sent by
  // initMetaPixel() in App.tsx, so this effect only fires on subsequent route changes.
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    trackPageView();
  }, [location.pathname]);

  // Logo / favicon uploaded in the admin (Marketing > Logo). Falls back to the built-in wordmark.
  useEffect(() => {
    publicFetch('/api/logo/active')
      .then((data: any) => {
        if (!data?.logo_url) return;
        setLogo(data.logo_url);
        if (data.favicon_url) {
          let link = document.querySelector("link[rel~='icon']") as HTMLLinkElement | null;
          if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
          link.href = data.favicon_url;
        }
      })
      .catch(() => { /* no logo configured: wordmark is used */ });
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <Header logo={logo} onLogoError={() => setLogo(null)} onOpenCart={() => setIsCartOpen(true)} onOpenFAQ={() => setShowFAQ(true)} />

      <main id="main" tabIndex={-1} className="min-h-[60vh] flex-1 focus:outline-none">
        <Outlet />
      </main>

      <Footer
        logo={logo}
        onLogoError={() => setLogo(null)}
        onOpenFAQ={() => setShowFAQ(true)}
        onOpenShipping={() => setShowShipping(true)}
        onOpenReturns={() => setShowReturns(true)}
      />

      <FAQModal isOpen={showFAQ} onClose={() => setShowFAQ(false)} />
      <ShippingInfoModal isOpen={showShipping} onClose={() => setShowShipping(false)} />
      <ReturnPolicyModal isOpen={showReturns} onClose={() => setShowReturns(false)} />
      <CartDrawer isOpen={isCartOpen} onClose={() => setIsCartOpen(false)} />

      {showBackToTop && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          aria-label="Back to top"
          className="fixed bottom-20 right-4 z-20 lg:bottom-5 lg:right-5 flex h-11 w-11 items-center justify-center rounded-full bg-brand-ink text-white shadow-pop transition-colors hover:bg-brand-ink-soft"
        >
          <ArrowUp className="h-5 w-5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
};

export default Layout;
