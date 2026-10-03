import React from 'react';
import { AlertTriangle, PackageOpen } from 'lucide-react';

/** Neutral shimmer block for loading placeholders. Size it with className. */
export const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`animate-pulse rounded-lg bg-brand-line/60 ${className}`} aria-hidden="true" />
);

export const Spinner: React.FC<{ label?: string }> = ({ label = 'Loading' }) => (
  <div role="status" className="flex items-center justify-center gap-3 py-16 text-brand-muted">
    <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-line border-t-brand-ink" aria-hidden="true" />
    <span className="text-sm">{label}…</span>
  </div>
);

interface StateProps { title: string; description?: string; action?: React.ReactNode }

export const EmptyState: React.FC<StateProps & { icon?: React.ReactNode }> = ({ title, description, action, icon }) => (
  <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-brand-line bg-brand-subtle/60 px-6 py-14 text-center">
    <div className="mb-4 text-brand-muted">{icon ?? <PackageOpen className="h-10 w-10" aria-hidden="true" />}</div>
    <p className="text-base font-semibold">{title}</p>
    {description && <p className="mt-1 max-w-md text-sm text-brand-muted">{description}</p>}
    {action && <div className="mt-5">{action}</div>}
  </div>
);

export const ErrorState: React.FC<StateProps> = ({ title, description, action }) => (
  <div role="alert" className="flex flex-col items-center justify-center rounded-xl border border-red-200 bg-red-50/60 px-6 py-14 text-center">
    <AlertTriangle className="mb-4 h-10 w-10 text-brand-danger" aria-hidden="true" />
    <p className="text-base font-semibold">{title}</p>
    {description && <p className="mt-1 max-w-md text-sm text-brand-muted">{description}</p>}
    {action && <div className="mt-5">{action}</div>}
  </div>
);
