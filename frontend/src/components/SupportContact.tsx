import React from 'react';
import { Mail, Phone } from 'lucide-react';
import { BRAND } from '../config/brand';

/** Contact lines from the brand config. Renders nothing until the client supplies real details. */
const SupportContact: React.FC = () => {
  if (!BRAND.supportEmail && !BRAND.supportPhone) {
    return <p className="text-sm text-brand-muted">Contact details will be added here.</p>;
  }
  return (
    <ul className="space-y-2 text-sm">
      {BRAND.supportEmail && (
        <li className="flex items-center gap-2"><Mail className="h-4 w-4 text-brand-accent-ink" aria-hidden="true" /><a className="font-medium hover:underline" href={`mailto:${BRAND.supportEmail}`}>{BRAND.supportEmail}</a></li>
      )}
      {BRAND.supportPhone && (
        <li className="flex items-center gap-2"><Phone className="h-4 w-4 text-brand-accent-ink" aria-hidden="true" /><a className="font-medium hover:underline" href={`tel:${BRAND.supportPhone.replace(/\s+/g, '')}`}>{BRAND.supportPhone}</a></li>
      )}
    </ul>
  );
};

export default SupportContact;
