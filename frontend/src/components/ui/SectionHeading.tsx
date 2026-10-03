import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

interface Props {
  title: string;
  eyebrow?: string;
  description?: string;
  /** Optional "view all" style link on the right. */
  action?: { label: string; to: string };
  align?: 'left' | 'center';
  as?: 'h1' | 'h2';
}

/** The one heading style for page sections: eyebrow, title, optional description and action link. */
export const SectionHeading: React.FC<Props> = ({ title, eyebrow, description, action, align = 'left', as: Tag = 'h2' }) => (
  <div className={`mb-8 flex flex-wrap items-end justify-between gap-4 ${align === 'center' ? 'justify-center text-center' : ''}`}>
    <div className={align === 'center' ? 'mx-auto max-w-2xl' : 'max-w-2xl'}>
      {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
      <Tag className="text-2xl font-bold sm:text-3xl">{title}</Tag>
      {description && <p className="mt-2 text-brand-muted">{description}</p>}
    </div>
    {action && (
      <Link to={action.to} className="inline-flex items-center gap-1 text-sm font-semibold text-brand-ink hover:text-brand-accent-ink">
        {action.label} <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    )}
  </div>
);
