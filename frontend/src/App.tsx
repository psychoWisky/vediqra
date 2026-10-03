import React, { useEffect, Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { CartProvider } from './context/CartContext';
import { initMetaPixel } from './utils/metaPixel';
import Layout from './components/Layout';
import './styles/globals.css';

// Route-level code splitting: each page (and, crucially, the admin panel — by far the largest bundle,
// previously shipped to every storefront visitor via AdminLogin's static import of AdminPanel) loads
// only when its route is visited, instead of all being bundled into one multi-hundred-KB entry chunk.
const Home = lazy(() => import('./pages/Home'));
const Products = lazy(() => import('./pages/Products'));
const Combos = lazy(() => import('./pages/Combos'));
const CustomCombo = lazy(() => import('./pages/CustomCombo'));
const Checkout = lazy(() => import('./pages/Checkout'));
const AdminLogin = lazy(() => import('./pages/AdminLogin'));
const NotFound = lazy(() => import('./pages/NotFound'));
const OrderTracking = lazy(() => import('./pages/OrderTracking'));
const OrderConfirmation = lazy(() => import('./pages/OrderConfirmation'));
const ProductPage = lazy(() => import('./pages/ProductPage'));
const ComboPage = lazy(() => import('./pages/ComboPage'));

const RouteFallback: React.FC = () => (
  <div className="flex min-h-[40vh] items-center justify-center" role="status" aria-live="polite">
    <span className="sr-only">Loading…</span>
    <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-accent border-t-transparent" aria-hidden="true" />
  </div>
);

function App() {
  useEffect(() => {
    initMetaPixel();
  }, []);

  return (
    <Router>
      <CartProvider>
        {/* Every toast in the app (errors, coupon results, confirmations) needs a mounted Toaster to be visible. */}
        <Toaster position="bottom-center" containerStyle={{ bottom: 84 }} toastOptions={{ duration: 4000 }} />
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* Routes with Layout */}
            <Route path="/" element={<Layout />}>
              <Route index element={<Home />} />
              <Route path="/products" element={<Products />} />
              <Route path="/combos" element={<Combos />} />
              <Route path="/custom-combo" element={<CustomCombo />} />
              <Route path="/checkout" element={<Checkout />} />
              <Route path="/track-order" element={<OrderTracking />} />
              <Route path="/order-confirmation" element={<OrderConfirmation />} />
              <Route path="/product/:id" element={<ProductPage />} />
              <Route path="/combo/:id" element={<ComboPage />} />
              {/* unknown URLs: 404 inside the storefront layout */}
              <Route path="*" element={<NotFound />} />
            </Route>

            {/* Admin route without Layout */}
            <Route path="/admin" element={<AdminLogin />} />

          </Routes>
        </Suspense>
      </CartProvider>
    </Router>
  );
}

export default App;
