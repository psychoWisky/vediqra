import React from 'react';
import { Mail, MapPin, Phone } from 'lucide-react';
import { BRAND } from '../config/brand';

/** Contact lines from the brand config. Renders nothing until the client supplies real details. */
const SupportContact: React.FC = () => {
  if (!BRAND.supportEmail && !BRAND.supportPhone && !BRAND.address.length) {
    return <p className="text-sm text-brand-muted">Contact details will be added here.</p>;
  }
  return (
    <ul className="space-y-2 text-sm">
      {BRAND.address.length > 0 && (
        <li className="flex items-start gap-2"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand-accent-ink" aria-hidden="true" /><address className="not-italic">{BRAND.address.map((line) => <span key={line} className="block">{line}</span>)}</address></li>
      )}
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
