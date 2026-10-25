import React from 'react';
import { AlertTriangle, PackageOpen } from 'lucide-react';

/** Neutral shimmer block for loading placeholders. Size it with className. */
export const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`animate-pulse rounded-sm bg-brand-line/70 ${className}`} aria-hidden="true" />
);

export const Spinner: React.FC<{ label?: string }> = ({ label = 'Loading' }) => (
  <div role="status" className="flex items-center justify-center gap-3 py-16 text-brand-muted">
    <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-line border-t-brand-ink" aria-hidden="true" />
    <span className="text-sm">{label}…</span>
  </div>
);

interface StateProps { title: string; description?: string; action?: React.ReactNode }

export const EmptyState: React.FC<StateProps & { icon?: React.ReactNode }> = ({ title, description, action, icon }) => (
  <div className="flex flex-col items-center justify-center rounded-sm border border-brand-line bg-brand-subtle px-6 py-16 text-center">
    <div className="mb-5 text-brand-accent/80">{icon ?? <PackageOpen className="h-9 w-9" strokeWidth={1.25} aria-hidden="true" />}</div>
    <p className="font-display text-xl font-semibold">{title}</p>
    {description && <p className="mt-2 max-w-md text-sm leading-relaxed text-brand-muted">{description}</p>}
    {action && <div className="mt-5">{action}</div>}
  </div>
);

export const ErrorState: React.FC<StateProps> = ({ title, description, action }) => (
  <div role="alert" className="flex flex-col items-center justify-center rounded-sm border border-brand-danger/40 bg-brand-danger/10 px-6 py-16 text-center">
    <AlertTriangle className="mb-4 h-9 w-9 text-brand-danger" strokeWidth={1.25} aria-hidden="true" />
    <p className="font-display text-xl font-semibold">{title}</p>
    {description && <p className="mt-2 max-w-md text-sm leading-relaxed text-brand-muted">{description}</p>}
    {action && <div className="mt-5">{action}</div>}
  </div>
);
