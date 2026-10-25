import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { ArrowRight, PackageCheck, PenLine, ShieldCheck, Upload } from 'lucide-react';
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
import { formatCurrency, getImageUrl } from '../utils/helpers';

const FEATURED_COUNT = 8;
const COMBO_COUNT = 4;
const FALLBACK = '/placeholder.svg';
const onImgError = (e: React.SyntheticEvent<HTMLImageElement>) => { if (!e.currentTarget.src.endsWith(FALLBACK)) e.currentTarget.src = FALLBACK; };

const hasRealImage = (p: Product) => typeof p.image_url === 'string' && p.image_url.trim() !== '' && getImageUrl(p.image_url) !== FALLBACK;
const namesOf = (c: Category): string[] => [c.name, ...(c.children || []).map((k) => k.name)];
const productCategoryNames = (p: Product): string[] => (p.categories && p.categories.length ? p.categories.map((c) => c.name) : p.category ? [p.category] : []);

/** Quiet brand composition used wherever there is no photograph: the gold mark inside fine hairline frames. */
const BrandArt: React.FC<{ className?: string; label?: string }> = ({ className = '', label }) => (
  <div className={`fallback-art relative flex items-center justify-center overflow-hidden ${className}`} aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
    <div className="absolute inset-[7%] border border-brand-accent/25" />
    <div className="absolute inset-[13%] border border-brand-accent/15" />
    <img src="/brand/vediqra-mark.png" alt="" className="relative h-[34%] w-auto opacity-90 drop-shadow-[0_8px_30px_rgba(201,166,70,0.25)]" />
  </div>
);

/** Image-led category tile: the category's own image, else a real product photo from it, else brand art. Always a real link. */
const CategoryTile: React.FC<{ category: Category; image?: string; count: number; big?: boolean }> = ({ category, image, count, big }) => {
  const Icon = (category.icon && category.icon_type !== 'image' && category.icon_type !== 'emoji' && (Icons as any)[category.icon]) || null;
  return (
    <Link
      to={categoryLink(category)}
      className={`group relative block overflow-hidden bg-brand-subtle ${big ? 'aspect-[4/5] md:aspect-auto md:h-full md:min-h-[34rem]' : 'aspect-[4/5]'}`}
    >
      {image ? (
        <img src={image} alt="" loading="lazy" onError={onImgError} className="absolute inset-0 h-full w-full object-cover transition-transform duration-[900ms] ease-out group-hover:scale-[1.05]" />
      ) : (
        <div className="fallback-art absolute inset-0 flex items-center justify-center">
          {category.icon_type === 'emoji' && category.icon
            ? <span className="text-6xl opacity-80" aria-hidden="true">{category.icon}</span>
            : Icon
              ? <Icon className="h-14 w-14 text-brand-accent/70" strokeWidth={1} aria-hidden="true" />
              : <img src="/brand/vediqra-mark.png" alt="" className="h-16 w-auto opacity-60" />}
        </div>
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" aria-hidden="true" />
      <div className="absolute inset-0 border border-white/[0.06] transition-colors group-hover:border-brand-accent/50" aria-hidden="true" />
      <div className="absolute inset-x-0 bottom-0 p-5 md:p-7">
        <h3 className={`font-display font-semibold leading-tight text-white ${big ? 'text-3xl md:text-4xl' : 'text-xl md:text-2xl'}`}>{category.name}</h3>
        {category.children && category.children.length > 0 && (
          <p className="mt-2 line-clamp-1 text-[12px] text-white/70">{category.children.map((c) => c.name).join(' · ')}</p>
        )}
        <p className="mt-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-accent-ink">
          {count > 0 ? `${count} ${count === 1 ? 'product' : 'products'}` : 'Explore'}
          <ArrowRight className="h-3.5 w-3.5 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" aria-hidden="true" />
        </p>
      </div>
    </Link>
  );
};

/** Hero collage built from the shop's own photographs (links to those products); brand art when there are none. */
const HeroCollage: React.FC<{ products: Product[] }> = ({ products }) => {
  const [main, second, third] = products;
  if (!main) return <BrandArt className="aspect-[4/5] w-full max-w-md justify-self-center lg:max-w-none" />;
  const Frame: React.FC<{ p: Product; className: string; priority?: boolean; right?: boolean }> = ({ p, className, priority, right }) => (
    <Link to={`/product/${p.slug || p.id}`} className={`group img-frame absolute block ${className}`}>
      <img src={getImageUrl(p.image_url)} alt={p.name} loading={priority ? 'eager' : 'lazy'} onError={onImgError} className="h-full w-full object-cover transition-transform duration-[900ms] ease-out group-hover:scale-[1.04]" />
      <span className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2.5 pt-8 text-[11px] font-medium uppercase tracking-[0.14em] text-white/90 ${right ? 'text-right' : ''}`}>
        <span className="line-clamp-1">{p.name}</span>
      </span>
    </Link>
  );
  return (
    <div className="relative mx-auto aspect-[5/6] w-full max-w-md sm:max-w-lg lg:max-w-none" data-testid="hero-collage">
      <div className="absolute right-[2%] top-[4%] h-[84%] w-[64%] translate-x-3 translate-y-3 border border-brand-accent/40" aria-hidden="true" />
      <Frame p={main} priority right className="right-[2%] top-[4%] h-[84%] w-[64%]" />
      {second && <Frame p={second} className="bottom-[2%] left-0 h-[44%] w-[42%]" />}
      {third && <Frame p={third} className="left-[12%] top-0 hidden h-[26%] w-[28%] sm:block" />}
    </div>
  );
};

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

  // Real photographs for the hero collage, the category tiles and the personalisation panel: only the catalogue's own images.
  const withImages = useMemo(() => products.filter(hasRealImage), [products]);
  const heroProducts = withImages.slice(0, 3);
  const personalisable = useMemo(() => withImages.find((p) => p.is_customizable) || null, [withImages]);
  const tileData = useMemo(() => tree.map((c) => {
    const names = new Set(namesOf(c));
    const inCat = products.filter((p) => productCategoryNames(p).some((n) => names.has(n)));
    const own = c.icon_type === 'image' && c.image_url ? getImageUrl(c.image_url) : '';
    const photo = own && own !== FALLBACK ? own : (inCat.find(hasRealImage) ? getImageUrl(inCat.find(hasRealImage)!.image_url) : '');
    return { category: c, image: photo, count: inCat.length };
  }), [tree, products]);
  const editorial = tileData.length >= 3;      // a large lead tile only when there are enough categories to balance it

  return (
    <div>
      {showPopup && <Popup onClose={() => setShowPopup(false)} />}

      {/* 1. Hero: admin-managed slides when they exist, otherwise an editorial composition */}
      {heroes.length > 0 ? (
        <HeroSection heroes={heroes} />
      ) : (
        <section className="relative overflow-hidden border-b border-brand-line">
          <div aria-hidden="true" className="pointer-events-none absolute -left-40 top-1/3 h-[32rem] w-[32rem] rounded-full bg-brand-accent/[0.07] blur-3xl" />
          <div className="container-page relative grid items-center gap-12 py-14 md:py-20 lg:grid-cols-[1.05fr_1fr] lg:gap-20 lg:py-24">
            <div>
              <p className="eyebrow mb-6">Personalised products</p>
              <h1 className="text-[2.9rem] font-semibold leading-[1.02] sm:text-6xl lg:text-[4.75rem]">Gifts made <span className="text-gold italic">personal.</span></h1>
              <p className="mt-7 max-w-md text-[17px] leading-relaxed text-brand-muted">Add your own text and photos to mugs, frames, cushions, t-shirts and more.</p>
              <div className="mt-10 flex flex-wrap gap-4">
                <ButtonLink to="/products" variant="accent">Shop products <ArrowRight className="h-4 w-4" aria-hidden="true" /></ButtonLink>
                <ButtonLink to="/custom-combo" variant="secondary">Build a custom combo</ButtonLink>
              </div>
              <dl className="mt-14 grid max-w-md grid-cols-3 gap-6 border-t border-brand-line pt-6 text-[11px] uppercase tracking-[0.16em] text-brand-muted">
                <div><dt className="text-brand-accent-ink">01</dt><dd className="mt-1">Choose a piece</dd></div>
                <div><dt className="text-brand-accent-ink">02</dt><dd className="mt-1">Add your words</dd></div>
                <div><dt className="text-brand-accent-ink">03</dt><dd className="mt-1">Add your photos</dd></div>
              </dl>
            </div>
            <HeroCollage products={heroProducts} />
          </div>
        </section>
      )}

      {/* 2. Service points (facts about the store itself) */}
      <section className="border-b border-brand-line" aria-label="Service">
        <ul className="container-page grid divide-brand-line sm:grid-cols-3 sm:divide-x">
          {[
            { icon: <ShieldCheck className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />, title: 'Secure checkout', text: 'Pay online by UPI or card.' },
            { icon: <PackageCheck className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />, title: 'Track your order', text: 'Follow your order with your order number.' },
            { icon: <PenLine className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />, title: 'Personalised on request', text: 'Add your own text and images.' },
          ].map((f) => (
            <li key={f.title} className="flex items-start gap-4 py-6 sm:px-8 sm:first:pl-0 sm:last:pr-0">
              <span className="mt-0.5 text-brand-accent">{f.icon}</span>
              <div><p className="text-[12px] font-semibold uppercase tracking-[0.16em]">{f.title}</p><p className="mt-1 text-[14px] text-brand-muted">{f.text}</p></div>
            </li>
          ))}
        </ul>
      </section>

      {/* 3. Category discovery (read from the category tree; parents list their subcategories) */}
      <section className="container-page section" aria-labelledby="home-categories">
        <SectionHeading id="home-categories" title="Shop by category" eyebrow="Collections" action={{ label: 'View all products', to: '/products' }} />
        {categoriesLoading ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4" aria-busy="true">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="aspect-[4/5]" />)}
          </div>
        ) : tree.length === 0 ? (
          <p className="rounded-sm border border-brand-line bg-brand-subtle px-6 py-12 text-center text-sm text-brand-muted">Categories will appear here.</p>
        ) : (
          <ul className={`grid grid-cols-2 gap-3 md:gap-4 ${editorial ? 'md:grid-cols-4' : tileData.length === 2 ? 'md:grid-cols-2' : 'md:grid-cols-1'}`}>
            {tileData.map((t, i) => (
              <li key={t.category.id} className={editorial && i === 0 ? 'col-span-2 md:row-span-2' : ''}>
                <CategoryTile category={t.category} image={t.image} count={t.count} big={editorial && i === 0} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 4. New arrivals */}
      <section className="border-y border-brand-line bg-brand-subtle" aria-labelledby="home-featured">
        <div className="container-page section">
          <SectionHeading id="home-featured" title="New arrivals" eyebrow="Just added" description={featured.length > 0 ? 'The latest additions to the store.' : undefined} action={featured.length > 0 ? { label: 'View all', to: '/products' } : undefined} />
          {productsRes.status === 'loading' ? (
            <div className="grid grid-cols-2 gap-x-5 gap-y-10 md:grid-cols-4" aria-busy="true">
              {Array.from({ length: 4 }).map((_, i) => <div key={i}><Skeleton className="aspect-[4/5] w-full" /><Skeleton className="mt-4 h-4 w-3/4" /><Skeleton className="mt-2 h-4 w-1/3" /></div>)}
            </div>
          ) : featured.length > 0 ? (
            <div className="grid grid-cols-2 gap-x-5 gap-y-12 md:grid-cols-4 md:gap-x-7">
              {featured.map((p) => <ProductCard key={p.id} product={p} />)}
            </div>
          ) : (
            <div>
              <div className="grid grid-cols-2 gap-x-5 gap-y-10 md:grid-cols-4" aria-hidden="true">
                {Array.from({ length: 4 }).map((_, i) => <div key={i}><BrandArt className="aspect-[4/5]" /><div className="mt-4 h-3 w-3/4 bg-brand-line/60" /><div className="mt-2 h-3 w-1/3 bg-brand-line/60" /></div>)}
              </div>
              <p className="mt-8 text-center text-sm text-brand-muted">Products are being added. Please check back soon.</p>
            </div>
          )}
        </div>
      </section>

      {/* 5. Personalisation */}
      <section className="relative overflow-hidden" aria-labelledby="home-personalise">
        <div className="container-page section grid gap-14 lg:grid-cols-[1fr_1.1fr] lg:items-center lg:gap-24">
          {personalisable ? (
            <Link to={`/product/${personalisable.slug || personalisable.id}`} className="group img-frame relative order-2 block aspect-[4/5] max-h-[40rem] w-full lg:order-1">
              <img src={getImageUrl(personalisable.image_url)} alt={personalisable.name} loading="lazy" onError={onImgError} className="h-full w-full object-cover transition-transform duration-[900ms] ease-out group-hover:scale-[1.03]" />
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-5 pt-14">
                <span className="block text-[10px] font-semibold uppercase tracking-[0.2em] text-brand-accent-ink">Personalisable</span>
                <span className="mt-1 block font-display text-xl font-semibold">{personalisable.name}</span>
                {Number(personalisable.price) > 0 && <span className="mt-1 block text-sm text-white/75">{formatCurrency(Number(personalisable.price))}</span>}
              </span>
            </Link>
          ) : (
            <BrandArt className="order-2 aspect-[4/5] max-h-[40rem] w-full lg:order-1" />
          )}
          <div className="order-1 lg:order-2">
            <p className="eyebrow mb-6">Personalisation</p>
            <h2 id="home-personalise" className="font-display text-4xl font-semibold leading-[1.08] sm:text-5xl">Make it yours</h2>
            <p className="mt-6 max-w-md text-[16px] leading-relaxed text-brand-muted">Choose a personalisable product, add your text and images, and place your order. Look for the Personalisable label on a product.</p>
            <ol className="mt-10 divide-y divide-brand-line border-y border-brand-line">
              {[
                { icon: <PackageCheck className="h-5 w-5" strokeWidth={1.25} aria-hidden="true" />, title: 'Pick a product', text: 'Browse the categories and choose what you like.' },
                { icon: <Upload className="h-5 w-5" strokeWidth={1.25} aria-hidden="true" />, title: 'Add your images', text: 'Upload your photos or artwork on personalisable products.' },
                { icon: <PenLine className="h-5 w-5" strokeWidth={1.25} aria-hidden="true" />, title: 'Add your text', text: 'Write the names, dates or message you want printed.' },
              ].map((step, i) => (
                <li key={step.title} className="flex items-start gap-6 py-6">
                  <span className="font-display text-3xl font-semibold leading-none text-brand-accent" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                  <div className="flex-1"><p className="text-[15px] font-semibold"><span className="sr-only">{i + 1}. </span>{step.title}</p><p className="mt-1 text-[14px] text-brand-muted">{step.text}</p></div>
                  <span className="mt-1 text-brand-accent/70">{step.icon}</span>
                </li>
              ))}
            </ol>
            <div className="mt-10"><ButtonLink to="/products" variant="accent">Explore products</ButtonLink></div>
          </div>
        </div>
      </section>

      {/* 6. Combos / custom combo */}
      <section className="border-t border-brand-line bg-brand-subtle" aria-labelledby="home-combos">
        <div className="container-page section">
          {combos.length > 0 ? (
            <>
              <SectionHeading id="home-combos" title="Combos" eyebrow="Sets" description="Sets of products sold together at one price." action={{ label: 'All combos', to: '/combos' }} />
              <div className="grid grid-cols-2 gap-x-5 gap-y-12 md:grid-cols-4 md:gap-x-7">
                {combos.slice(0, COMBO_COUNT).map((c) => <ComboCard key={c.id} combo={c} />)}
              </div>
            </>
          ) : (
            <h2 id="home-combos" className="sr-only">Build a custom combo</h2>
          )}
          <div className={`relative overflow-hidden border border-brand-accent/30 bg-brand-surface ${combos.length > 0 ? 'mt-20' : ''}`}>
            <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full border border-brand-accent/20" />
            <div aria-hidden="true" className="pointer-events-none absolute -right-10 -top-10 h-72 w-72 rounded-full border border-brand-accent/10" />
            <div className="relative grid gap-8 px-7 py-12 md:grid-cols-[1fr_auto] md:items-center md:px-14 md:py-16">
              <div>
                <p className="eyebrow mb-5">Custom combo</p>
                <p className="font-display text-3xl font-semibold leading-tight sm:text-4xl">Build your own combo</p>
                <p className="mt-4 max-w-md text-[15px] leading-relaxed text-brand-muted">Pick the products you want and see the combo price before you order.</p>
              </div>
              <ButtonLink to="/custom-combo" variant="accent" className="justify-self-start">Start building <ArrowRight className="h-4 w-4" aria-hidden="true" /></ButtonLink>
            </div>
          </div>
        </div>
      </section>

      {/* 7. Numbers: only when configured in the admin */}
      {stats.length > 0 && (
        <section className="container-page section" aria-label="In numbers">
          <ul className="grid grid-cols-2 gap-10 text-center md:grid-cols-4">
            {stats.map((s) => (
              <li key={s.label}><p className="font-display text-4xl font-semibold text-gold">{s.value}</p><p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-brand-muted">{s.label}</p></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

export default Home;
