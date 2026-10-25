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
  /** id of the heading element, for aria-labelledby on the section. */
  id?: string;
}

/** The one heading style for page sections: eyebrow, title, optional description and action link. */
export const SectionHeading: React.FC<Props> = ({ title, eyebrow, description, action, align = 'left', as: Tag = 'h2', id }) => (
  <div className={`mb-10 flex flex-wrap items-end justify-between gap-x-6 gap-y-4 md:mb-14 ${align === 'center' ? 'justify-center text-center' : ''}`}>
    <div className={align === 'center' ? 'mx-auto max-w-2xl' : 'max-w-2xl'}>
      {eyebrow && <p className="eyebrow mb-4">{eyebrow}</p>}
      <Tag id={id} className="font-display text-3xl font-semibold leading-[1.1] sm:text-4xl md:text-[2.75rem]">{title}</Tag>
      {description && <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-brand-muted">{description}</p>}
    </div>
    {action && (
      <Link to={action.to} className="group inline-flex items-center gap-2 border-b border-brand-accent/60 pb-1 text-[12px] font-semibold uppercase tracking-[0.14em] text-brand-ink transition-colors hover:border-brand-accent hover:text-brand-accent-ink">
        {action.label} <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" aria-hidden="true" />
      </Link>
    )}
  </div>
);
