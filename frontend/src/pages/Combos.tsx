import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Combo } from '../types';
import { apiFetch } from '../utils/api';
import ComboCard from '../components/ComboCard';
import { SectionHeading } from '../components/ui/SectionHeading';
import { EmptyState, ErrorState, Skeleton } from '../components/ui/States';
import { ButtonLink } from '../components/ui/Button';

export default function Combos() {
  const navigate = useNavigate();
  const [combos, setCombos] = useState<Combo[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Redirect a shared link /combos?id=UUID to the combo page directly
    const id = new URLSearchParams(window.location.search).get('id');
    if (id) { navigate(`/combo/${id}`, { replace: true }); return; }

    apiFetch<Combo[]>('/api/combos')
      .then((data) => setCombos(data || []))
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="container-page section">
      <SectionHeading as="h1" title="Combos" description="Ready-made sets of products, sold together at one price." />

      {loading ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 lg:grid-cols-4" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}><Skeleton className="aspect-[4/5] w-full" /><Skeleton className="mt-3 h-4 w-3/4" /><Skeleton className="mt-2 h-4 w-1/3" /></div>
          ))}
        </div>
      ) : failed ? (
        <ErrorState title="We couldn't load combos" description="Please check your connection and try again." action={<button type="button" className="btn-primary" onClick={() => window.location.reload()}>Retry</button>} />
      ) : combos.length === 0 ? (
        <EmptyState
          title="No combos yet"
          description="Combos will appear here once they are added. You can also build your own."
          action={<div className="flex flex-wrap justify-center gap-3"><ButtonLink to="/custom-combo">Build a custom combo</ButtonLink><ButtonLink to="/products" variant="secondary">Browse products</ButtonLink></div>}
        />
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 lg:grid-cols-4">
          {combos.map((combo) => <ComboCard key={combo.id} combo={combo} />)}
        </div>
      )}
    </div>
  );
}
