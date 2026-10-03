import React, { useEffect } from 'react';
import { ButtonLink } from '../components/ui/Button';
import { BRAND } from '../config/brand';

const NotFound: React.FC = () => {
  useEffect(() => { document.title = `Page not found — ${BRAND.name}`; }, []);
  return (
    <div className="container-page section text-center">
      <p className="eyebrow mb-3">Error 404</p>
      <h1 className="text-3xl font-bold sm:text-4xl">We can't find that page</h1>
      <p className="mx-auto mt-3 max-w-md text-brand-muted">The link may be old or the page may have moved.</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <ButtonLink to="/">Go to the homepage</ButtonLink>
        <ButtonLink to="/products" variant="secondary">Browse products</ButtonLink>
      </div>
    </div>
  );
};

export default NotFound;
