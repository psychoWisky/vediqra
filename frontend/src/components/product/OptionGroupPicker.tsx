import React from 'react';
import { Check } from 'lucide-react';
import { formatModifier } from '../../utils/money';
import { getImageUrl } from '../../utils/helpers';

export interface PickerValue {
  id: string;
  label: string;
  price_modifier?: number;
  /** null / undefined = stock not tracked */
  stock?: number | null;
  image_url?: string | null;
  /** CSS colour for a swatch (e.g. a colour value's colour code) */
  swatch?: string | null;
}

interface Props {
  name: string;
  required: boolean;
  values: PickerValue[];
  selectedId?: string | null;
  onSelect: (id: string | null) => void;
  error?: string | null;
  /** DOM id of the fieldset so callers can scroll / focus it. */
  fieldId: string;
}

const isSoldOut = (v: PickerValue) => v.stock !== null && v.stock !== undefined && v.stock <= 0;

/**
 * One option group, rendered from data. Native radio inputs give keyboard (arrow keys) and screen-reader
 * behaviour for free. The presentation follows the data: values with images or colour swatches become visual
 * cards, plain values become text chips. Selected / sold-out / required are never conveyed by colour alone
 * (check mark + heavier border, "Sold out" text, "Required" / "Optional" text).
 */
const OptionGroupPicker: React.FC<Props> = ({ name, required, values, selectedId, onSelect, error, fieldId }) => {
  const visual = values.some((v) => v.image_url || v.swatch);
  const errId = `${fieldId}-error`;
  const selected = values.find((v) => v.id === selectedId);

  return (
    <fieldset id={fieldId} tabIndex={-1} aria-describedby={error ? errId : undefined} aria-invalid={error ? true : undefined} className="min-w-0 focus:outline-none">
      <legend className="mb-2 flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold">
        <span>{name}</span>
        <span className={required ? 'badge-dark' : 'badge-neutral'}>{required ? 'Required' : 'Optional'}</span>
        {selected && <span className="font-normal text-brand-muted">{selected.label}</span>}
        {!required && selected && (
          <button type="button" onClick={() => onSelect(null)} className="ml-auto text-xs font-medium underline underline-offset-2 hover:text-brand-accent-ink">Clear</button>
        )}
      </legend>

      <div className={visual ? 'grid grid-cols-2 gap-2 sm:grid-cols-3' : 'flex flex-wrap gap-2'}>
        {values.map((v) => {
          const soldOut = isSoldOut(v);
          const checked = v.id === selectedId;
          const modifier = formatModifier(v.price_modifier);
          const inputId = `${fieldId}-${v.id}`;
          return (
            <div key={v.id} className="relative">
              <input
                id={inputId}
                type="radio"
                name={fieldId}
                value={v.id}
                checked={checked}
                disabled={soldOut}
                onChange={() => onSelect(v.id)}
                // a radio cannot be un-checked natively: clicking the checked value of an optional group clears it
                onClick={() => { if (checked && !required) onSelect(null); }}
                className="peer sr-only"
              />
              <label
                htmlFor={inputId}
                className={`relative flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl border-2 px-3 py-2 text-sm transition-colors
                  peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-accent-ink
                  ${checked ? 'border-brand-ink bg-brand-subtle font-semibold' : 'border-brand-line hover:border-brand-ink/60'}
                  ${soldOut ? 'cursor-not-allowed bg-brand-subtle/60 text-brand-muted' : ''} ${visual ? 'flex-col justify-center text-center' : ''}`}
              >
                {v.image_url ? (
                  <img src={getImageUrl(v.image_url)} alt="" loading="lazy" className="h-12 w-12 rounded-lg object-cover" onError={(e) => { e.currentTarget.src = '/placeholder.svg'; }} />
                ) : v.swatch ? (
                  <span className="h-8 w-8 rounded-full border border-brand-line" style={{ backgroundColor: v.swatch }} aria-hidden="true" />
                ) : null}
                <span className={soldOut ? 'line-through' : ''}>{v.label}</span>
                {modifier && !soldOut && <span className="text-xs font-medium text-brand-accent-ink">{modifier}</span>}
                {soldOut && <span className="text-xs font-semibold">Sold out</span>}
                {checked && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-brand-ink text-white" aria-hidden="true"><Check className="h-3 w-3" /></span>
                )}
              </label>
            </div>
          );
        })}
      </div>
      {error && <p id={errId} role="alert" className="mt-2 text-sm font-medium text-brand-danger">{error}</p>}
    </fieldset>
  );
};

export default OptionGroupPicker;
