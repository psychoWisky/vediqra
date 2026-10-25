import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { ArrowRight, PackageCheck, PenLine, ShieldCheck, Sparkles, Upload } from 'lucide-react';
import { Category, Combo, HeroContent, Product, Stat } from '../types';
import { apiFetch } from '../utils/api';
import { useCatalogue } from '../hooks/useCatalogue';
import { useCategoryTree, categoryLink } from '../hooks/useCategoryTree';
import HeroSection from '../components/HeroSection';
import ProductCard from '../components/ProductCard';
import ComboCard from '../components/ComboCard';
import Popup from '../components/Popup';
import { ButtonLink } from '../components/ui/Button';
import { SectionHeading } from '../components/ui/SectionHeading';
import { Skeleton } from '../components/ui/States';
import { getImageUrl } from '../utils/helpers';

const FEATURED_COUNT = 8;
const COMBO_COUNT = 4;

/** Category visual: uploaded image, else its lucide icon / emoji, else a neutral tile. */
const CategoryVisual: React.FC<{ category: Category }> = ({ category }) => {
  const type = category.icon_type;
  if (type === 'image' && category.image_url) {
    return <img src={getImageUrl(category.image_url)} alt="" loading="lazy" onError={(e) => { if (!e.currentTarget.src.endsWith('/placeholder.svg')) e.currentTarget.src = '/placeholder.svg'; }} className="h-full w-full object-cover transition duration-500 md:group-hover:scale-105" />;
  }
  if (type === 'emoji' && category.icon) {
    return <span className="text-4xl" aria-hidden="true">{category.icon}</span>;
  }
  const Icon = (category.icon && (Icons as any)[category.icon]) || Icons.Sparkles;
  return <Icon className="h-9 w-9 text-brand-accent-ink" strokeWidth={1.5} aria-hidden="true" />;
};

/** Where a real product image will go: neutral slot, no fabricated imagery. */
const ProductPlaceholder: React.FC = () => (
  <div aria-hidden="true">
    <div className="aspect-[4/5] rounded-xl bg-brand-subtle" />
    <div className="mt-3 h-3.5 w-3/4 rounded bg-brand-line/60" />
    <div className="mt-2 h-3.5 w-1/3 rounded bg-brand-line/60" />
  </div>
);

const Home: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { tree, loading: categoriesLoading } = useCategoryTree();

  const [heroes, setHeroes] = useState<HeroContent[]>([]);
  // The same shared product list the Shop page uses, so going Home -> Shop (or back) does not download the catalogue again.
  const productsRes = useCatalogue<Product[]>('/api/products', []);
  const products = Array.isArray(productsRes.data) ? productsRes.data : [];
  const [combos, setCombos] = useState<Combo[]>([]);
  const [stats, setStats] = useState<Stat[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [showPopup, setShowPopup] = useState(false);

  // Old shared links: /?combo=<id> or /?id=<id> open the combo; /?category=<name> opens the filtered listing.
  useEffect(() => {
    const comboId = searchParams.get('combo') || searchParams.get('id');
    if (comboId) { navigate(`/combo/${comboId}`, { replace: true }); return; }
    const category = searchParams.get('category');
    if (category) navigate(`/products?category=${encodeURIComponent(category)}`, { replace: true });
  }, [searchParams, navigate]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      apiFetch<Combo[]>('/api/combos').catch(() => []),
      apiFetch<HeroContent[]>('/api/hero').catch(() => []),
      // Only real, admin-configured numbers are ever shown. There are no default/made-up figures.
      apiFetch<{ value?: Stat[] }>('/api/settings?key=stats').catch(() => null),
    ]).then(([c, h, s]) => {
      if (!alive) return;
      setCombos(c || []);
      setHeroes(h || []);
      setStats(Array.isArray((s as any)?.value) ? (s as any).value : []);
    }).finally(() => { if (alive) setDataLoading(false); });
    return () => { alive = false; };
  }, []);

  // Admin-configured pop-up (once per session)
  useEffect(() => {
    apiFetch('/api/popups/active')
      .then((popup) => {
        if (popup && !sessionStorage.getItem('popup_seen')) { setShowPopup(true); sessionStorage.setItem('popup_seen', 'true'); }
      })
      .catch(() => {});
  }, []);

  // /api/products is newest first, so the first few are honestly "new arrivals" (no curated or bestseller list exists).
  const featured = products.slice(0, FEATURED_COUNT);

  return (
    <div>
      {showPopup && <Popup onClose={() => setShowPopup(false)} />}

      {/* 1. Hero: admin-managed slides when they exist, otherwise a text hero with an image slot */}
      {heroes.length > 0 ? (
        <HeroSection heroes={heroes} />
      ) : (
        <section className="relative overflow-hidden bg-brand-panel text-white">
          <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-brand-accent/10 blur-3xl" />
          <div className="container-page relative grid items-center gap-10 py-16 md:grid-cols-2 md:py-24">
            <div>
              <p className="eyebrow !text-brand-accent mb-3">Personalised products</p>
              <h1 className="text-4xl font-extrabold leading-tight sm:text-5xl lg:text-6xl">Gifts made <span className="text-brand-accent">personal.</span></h1>
              <p className="mt-4 max-w-md text-lg text-white/75">Add your own text and photos to mugs, frames, cushions, t-shirts and more.</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <ButtonLink to="/products" variant="accent">Shop products <ArrowRight className="h-4 w-4" aria-hidden="true" /></ButtonLink>
                <ButtonLink to="/custom-combo" variant="secondary" className="!border-white/30 !bg-transparent !text-white hover:!bg-white/10">Build a custom combo</ButtonLink>
              </div>
            </div>
            {/* image slot: replaced by real VEDIQRA photography (Admin > Marketing > Hero) */}
            <div aria-hidden="true" className="mx-auto hidden aspect-[4/3] w-full max-w-md items-center justify-center rounded-2xl border border-brand-accent/30 bg-white/5 md:flex">
              <span className="text-8xl font-extrabold text-brand-accent/70">V</span>
            </div>
          </div>
        </section>
      )}

      {/* 2. Category discovery (read from the category tree; parents list their subcategories) */}
      <section className="container-page section" aria-labelledby="home-categories">
        <SectionHeading id="home-categories" title="Shop by category" eyebrow="Browse" action={{ label: 'View all products', to: '/products' }} />
        {categoriesLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4" aria-busy="true">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="aspect-[4/3]" />)}
          </div>
        ) : tree.length === 0 ? (
          <p className="rounded-xl border border-dashed border-brand-line bg-brand-subtle/60 px-6 py-10 text-center text-sm text-brand-muted">Categories will appear here.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
            {tree.map((parent) => (
              <li key={parent.id}>
                <Link to={categoryLink(parent)} className="card group flex h-full flex-col overflow-hidden transition-colors hover:border-brand-accent">
                  <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-brand-subtle"><CategoryVisual category={parent} /></div>
                  <div className="flex flex-1 flex-col border-t-2 border-brand-accent/60 p-3 sm:p-4">
                    <h3 className="flex items-center justify-between gap-2 text-sm font-bold sm:text-base">{parent.name}<ArrowRight className="h-4 w-4 shrink-0 text-brand-accent-ink transition-transform md:group-hover:translate-x-1" aria-hidden="true" /></h3>
                    {parent.children && parent.children.length > 0 && (
                      <p className="mt-1 line-clamp-2 text-xs text-brand-muted">{parent.children.map((c) => c.name).join(' · ')}</p>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 3. Featured products */}
      <section className="bg-brand-subtle/60" aria-labelledby="home-featured">
        <div className="container-page section">
          <SectionHeading id="home-featured" title="New arrivals" eyebrow="Just added" description={featured.length > 0 ? 'The latest additions to the store.' : undefined} action={featured.length > 0 ? { label: 'View all', to: '/products' } : undefined} />
          {productsRes.status === 'loading' ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-4" aria-busy="true">
              {Array.from({ length: 4 }).map((_, i) => <div key={i}><Skeleton className="aspect-[4/5] w-full" /><Skeleton className="mt-3 h-4 w-3/4" /><Skeleton className="mt-2 h-4 w-1/3" /></div>)}
            </div>
          ) : featured.length > 0 ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-4">
              {featured.map((p) => <ProductCard key={p.id} product={p} />)}
            </div>
          ) : (
            <div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => <ProductPlaceholder key={i} />)}
              </div>
              <p className="mt-6 text-center text-sm text-brand-muted">Products are being added. Please check back soon.</p>
            </div>
          )}
        </div>
      </section>

      {/* 4. Personalisation */}
      <section className="border-y border-brand-line bg-brand-panel text-white" aria-labelledby="home-personalise">
        <div className="container-page section grid gap-10 md:grid-cols-2 md:items-center">
          <div>
            <p className="eyebrow !text-brand-accent mb-3">Personalisation</p>
            <h2 id="home-personalise" className="text-3xl font-bold sm:text-4xl">Make it yours</h2>
            <p className="mt-4 max-w-md text-white/70">Choose a personalisable product, add your text and images, and place your order. Look for the Personalisable label on a product.</p>
            <div className="mt-8"><ButtonLink to="/products" variant="accent">Explore products</ButtonLink></div>
          </div>
          <ol className="space-y-4">
            {[
              { icon: <PackageCheck className="h-5 w-5" aria-hidden="true" />, title: 'Pick a product', text: 'Browse the categories and choose what you like.' },
              { icon: <Upload className="h-5 w-5" aria-hidden="true" />, title: 'Add your images', text: 'Upload your photos or artwork on personalisable products.' },
              { icon: <PenLine className="h-5 w-5" aria-hidden="true" />, title: 'Add your text', text: 'Write the names, dates or message you want printed.' },
            ].map((step, i) => (
              <li key={step.title} className="flex gap-4 rounded-xl border border-white/10 p-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-accent text-[#111111]">{step.icon}</span>
                <div><p className="font-semibold"><span className="mr-2 text-white/40">{i + 1}.</span>{step.title}</p><p className="text-sm text-white/70">{step.text}</p></div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 5. Combos / custom combo */}
      <section className="container-page section" aria-labelledby="home-combos">
        {combos.length > 0 ? (
          <>
            <SectionHeading id="home-combos" title="Combos" eyebrow="Sets" description="Sets of products sold together at one price." action={{ label: 'All combos', to: '/combos' }} />
            <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-4">
              {combos.slice(0, COMBO_COUNT).map((c) => <ComboCard key={c.id} combo={c} />)}
            </div>
          </>
        ) : (
          <h2 id="home-combos" className="sr-only">Build a custom combo</h2>
        )}
        <div className={`flex flex-col items-start gap-5 rounded-2xl border border-brand-accent/30 bg-brand-panel p-6 text-white sm:flex-row sm:items-center sm:justify-between sm:p-8 ${combos.length > 0 ? 'mt-12' : ''}`}>
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-accent text-[#111111]"><Sparkles className="h-5 w-5" aria-hidden="true" /></span>
            <div>
              <p className="text-lg font-bold">Build your own combo</p>
              <p className="mt-1 max-w-md text-sm text-white/75">Pick the products you want and see the combo price before you order.</p>
            </div>
          </div>
          <ButtonLink to="/custom-combo" variant="accent" className="shrink-0">Start building <ArrowRight className="h-4 w-4" aria-hidden="true" /></ButtonLink>
        </div>
      </section>

      {/* 6. Service points (facts about the store itself) */}
      <section className="border-y border-brand-line bg-brand-subtle/60" aria-label="Service">
        <ul className="container-page grid gap-6 py-8 sm:grid-cols-3">
          {[
            { icon: <ShieldCheck className="h-6 w-6" aria-hidden="true" />, title: 'Secure checkout', text: 'Pay online by UPI or card.' },
            { icon: <PackageCheck className="h-6 w-6" aria-hidden="true" />, title: 'Track your order', text: 'Follow your order with your order number.' },
            { icon: <PenLine className="h-6 w-6" aria-hidden="true" />, title: 'Personalised on request', text: 'Add your own text and images.' },
          ].map((f) => (
            <li key={f.title} className="flex items-start gap-3">
              <span className="text-brand-accent-ink">{f.icon}</span>
              <div><p className="text-sm font-bold">{f.title}</p><p className="text-sm text-brand-muted">{f.text}</p></div>
            </li>
          ))}
        </ul>
      </section>

      {/* 7. Numbers: only when configured in the admin */}
      {stats.length > 0 && (
        <section className="container-page section" aria-label="In numbers">
          <ul className="grid grid-cols-2 gap-6 text-center md:grid-cols-4">
            {stats.map((s) => (
              <li key={s.label}><p className="text-3xl font-extrabold">{s.value}</p><p className="mt-1 text-sm text-brand-muted">{s.label}</p></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

export default Home;
