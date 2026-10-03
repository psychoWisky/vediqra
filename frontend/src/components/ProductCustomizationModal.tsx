import React, { useEffect, useId, useRef, useState } from 'react';
import { Camera, Minus, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { CustomizationData, Product, SelectedOption } from '../types';
import { useCart } from '../context/CartContext';
import { getImageUrl } from '../utils/helpers';
import { publicFetch } from '../utils/apiFetch';
import { formatCurrency, formatModifier, fromPaise, lineTotal, toPaise } from '../utils/money';
import { friendlyError } from '../utils/errors';
import { Modal } from './ui/Modal';
import { Badge } from './ui/Badge';

interface ProductCustomizationModalProps {
  product: Product;
  onClose: () => void;
  /** Combo flows: return the customization to the caller instead of adding the product to the cart. */
  onCustomizeComplete?: (customization: CustomizationData) => void;
  selectedImageUrl?: string;
  // The options the shopper already chose on the product page. They are kept on the cart item and their
  // price modifiers are part of the price.
  selectedOptions?: SelectedOption[];
  // Legacy display fields (colour swatch / size label) shown by the cart
  variantFields?: Partial<{ color_id: string; color_name: string; color_code: string; size_id: string; size_name: string; size_code: string }>;
  initialQuantity?: number;
  /** Highest quantity the current stock allows (product page). */
  maxQuantity?: number;
  /** Called after the item was added to the cart (product page uses it for its status message). */
  onAdded?: (message: string) => void;
}

interface ImageSlot { file: File; preview: string; url?: string; uploading?: boolean }

const MAX_FILE_MB = 10;
const ACCEPT = 'image/jpeg,image/png,image/webp';

/**
 * Personalisation dialog. Requirements come only from the product's own settings (lines, characters, images, fee).
 * Personalisation on a personalisable product is always required, so the dialog says so and validates before adding.
 */
const ProductCustomizationModal: React.FC<ProductCustomizationModalProps> = ({
  product, onClose, onCustomizeComplete, selectedImageUrl, selectedOptions = [], variantFields, initialQuantity = 1, maxQuantity = 99, onAdded,
}) => {
  const { addItem } = useCart();
  const uid = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const firstTextRef = useRef<HTMLInputElement>(null);

  const maxLines = Number(product.max_customization_lines) || 0;
  const maxImages = Number(product.max_customization_images) || 0;
  const maxChars = Number(product.max_customization_characters) || 50;
  const forCombo = Boolean(onCustomizeComplete);

  const [textLines, setTextLines] = useState<string[]>(() => (maxLines > 0 ? Array(maxLines).fill('') : []));
  const [images, setImages] = useState<ImageSlot[]>([]);
  const [quantity, setQuantity] = useState(Math.max(1, Math.min(initialQuantity, maxQuantity)));
  const [errors, setErrors] = useState<{ text?: string; images?: string; upload?: string }>({});
  const [busy, setBusy] = useState(false);

  // Display arithmetic in paise. The server recomputes the price (options + fee) when the order is priced.
  const feePaise = toPaise(product.customization_price);
  const unitPaise = toPaise(product.price) + selectedOptions.reduce((s, o) => s + toPaise(o.price_modifier), 0) + feePaise;
  const unit = fromPaise(unitPaise);
  const total = lineTotal(unit, quantity);
  const priced = toPaise(product.price) > 0;

  useEffect(() => { firstTextRef.current?.focus(); }, []);

  const addFiles = (fileList: FileList | null) => {
    if (!fileList?.length) return;
    const files = Array.from(fileList);
    const room = maxImages - images.length;
    if (files.length > room) {
      setErrors((e) => ({ ...e, images: `You can add ${maxImages === 1 ? 'one image' : `up to ${maxImages} images`}${room > 0 ? ` (${room} more)` : ''}.` }));
    }
    files.slice(0, Math.max(room, 0)).forEach((file) => {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { setErrors((e) => ({ ...e, images: `${file.name} is not a JPG, PNG or WebP image.` })); return; }
      if (file.size > MAX_FILE_MB * 1024 * 1024) { setErrors((e) => ({ ...e, images: `${file.name} is larger than ${MAX_FILE_MB} MB.` })); return; }
      const reader = new FileReader();
      reader.onloadend = () => {
        setImages((prev) => [...prev, { file, preview: String(reader.result) }]);
        setErrors((e) => ({ ...e, images: undefined, upload: undefined }));
      };
      reader.readAsDataURL(file);
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const validate = (): boolean => {
    const next: typeof errors = {};
    if (maxLines > 0 && !textLines.some((l) => l.trim())) next.text = `Please add at least one line of text${maxLines > 1 ? ` (up to ${maxLines})` : ''}.`;
    if (maxImages > 0 && images.length === 0) next.images = `Please add at least one image${maxImages > 1 ? ` (up to ${maxImages})` : ''}.`;
    setErrors(next);
    if (next.text) firstTextRef.current?.focus();
    else if (next.images) fileInputRef.current?.focus();
    return !next.text && !next.images;
  };

  // Uploads images that are not uploaded yet. Returns the URLs, or null when something failed.
  const uploadAll = async (): Promise<string[] | null> => {
    const urls: string[] = [];
    let index = 0;
    for (const img of images) {
      if (img.url) { urls.push(img.url); continue; }
      setImages((prev) => prev.map((p) => (p.file === img.file ? { ...p, uploading: true } : p)));
      try {
        const form = new FormData();
        form.append('image', img.file);
        form.append('product_id', product.id);
        form.append('index', String(index++));
        const res = await publicFetch('/api/upload/customization', { method: 'POST', body: form, headers: {} });
        const url = res?.image_url || res?.url;
        if (!url) throw new Error('invalid response');
        urls.push(url);
        setImages((prev) => prev.map((p) => (p.file === img.file ? { ...p, url, uploading: false } : p)));
      } catch (e) {
        setImages((prev) => prev.map((p) => ({ ...p, uploading: false })));
        setErrors((er) => ({ ...er, upload: friendlyError(e, 'Your image could not be uploaded, so nothing was added to your cart. Please try again in a moment.') }));
        return null;
      }
    }
    return urls;
  };

  const submit = async () => {
    if (busy) return;
    if (!validate()) return;
    setBusy(true);
    try {
      const lines = textLines.filter((l) => l.trim());
      const urls = images.length ? await uploadAll() : [];
      if (urls === null) return;
      const customization: CustomizationData = {
        text_lines: lines.length ? lines : undefined,
        image_urls: urls.length ? urls : undefined,
        preview_urls: images.map((i) => i.preview),
        image_paths: urls,
      };
      if (onCustomizeComplete) {
        onCustomizeComplete(customization);
        toast.success('Personalisation saved');
        onClose();
        return;
      }
      addItem({
        id: `${product.id}-${selectedOptions.map((o) => o.value_id).join('-')}-${Date.now()}`,
        product_id: product.id,
        selected_options: selectedOptions,
        name: selectedOptions.length ? `${product.name} (${selectedOptions.map((o) => o.name).join(', ')})` : product.name,
        price: unit,
        quantity,
        image_url: getImageUrl(selectedImageUrl || product.image_url),
        type: 'product',
        category: product.category,
        customization,
        ...variantFields,
      });
      toast.success('Added to cart');
      onAdded?.(`${quantity} × ${product.name} (personalised) added to your cart.`);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const hasFields = maxLines > 0 || maxImages > 0;

  return (
    <Modal isOpen onClose={() => { if (!busy) onClose(); }} title={`Personalise: ${product.name}`} widthClass="max-w-2xl">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="dark">Personalisation required</Badge>
          {feePaise > 0 && <span className="text-sm text-brand-muted">Personalisation fee {formatModifier(fromPaise(feePaise))} per item</span>}
        </div>
        <p className="text-sm text-brand-muted">
          {hasFields
            ? `What you add here is what will be personalised on your ${product.name}. `
            : 'Personalisation details for this product are set when your order is prepared. '}
          {maxLines > 0 && `Up to ${maxLines} ${maxLines === 1 ? 'line' : 'lines'} of text, ${maxChars} characters each. `}
          {maxImages > 0 && `Up to ${maxImages} ${maxImages === 1 ? 'image' : 'images'} (JPG, PNG or WebP, ${MAX_FILE_MB} MB each).`}
        </p>

        {(errors.text || errors.images || errors.upload) && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-brand-danger">
            <p className="font-semibold">Please fix the following</p>
            <ul className="mt-1 list-disc pl-5">{errors.text && <li>{errors.text}</li>}{errors.images && <li>{errors.images}</li>}{errors.upload && <li>{errors.upload}</li>}</ul>
          </div>
        )}

        {maxLines > 0 && (
          <fieldset>
            <legend className="mb-2 flex items-center gap-2 text-sm font-semibold">Text <span className="badge-dark">Required</span></legend>
            <div className="space-y-3">
              {textLines.map((line, i) => (
                <div key={i}>
                  <div className="mb-1 flex items-center justify-between text-xs text-brand-muted">
                    <label htmlFor={`${uid}-line-${i}`} className="font-medium text-brand-ink">Line {i + 1}</label>
                    <span aria-hidden="true">{line.length}/{maxChars}</span>
                  </div>
                  <input
                    id={`${uid}-line-${i}`}
                    ref={i === 0 ? firstTextRef : undefined}
                    type="text"
                    className="input"
                    value={line}
                    maxLength={maxChars}
                    aria-invalid={errors.text && !textLines.some((l) => l.trim()) ? true : undefined}
                    onChange={(e) => { const v = e.target.value; setTextLines((prev) => prev.map((p, k) => (k === i ? v : p))); if (v.trim()) setErrors((er) => ({ ...er, text: undefined })); }}
                    placeholder={`Up to ${maxChars} characters`}
                  />
                </div>
              ))}
            </div>
          </fieldset>
        )}

        {maxImages > 0 && (
          <fieldset>
            <legend className="mb-2 flex items-center gap-2 text-sm font-semibold">Images <span className="badge-dark">Required</span> <span className="font-normal text-brand-muted">{images.length}/{maxImages} added</span></legend>
            {images.length > 0 && (
              <ul className="mb-3 space-y-2">
                {images.map((img, i) => (
                  <li key={i} className="flex items-center gap-3 rounded-lg border border-brand-line p-2">
                    <img src={img.preview} alt={`Selected image ${i + 1}`} className="h-12 w-12 rounded object-cover" />
                    <div className="min-w-0 flex-1 text-sm">
                      <p className="truncate font-medium">{img.file.name}</p>
                      <p className="text-xs text-brand-muted" role="status">{img.uploading ? 'Uploading…' : img.url ? 'Uploaded' : `${(img.file.size / 1024 / 1024).toFixed(2)} MB, uploads when you continue`}</p>
                    </div>
                    <button type="button" onClick={() => setImages((prev) => prev.filter((_, k) => k !== i))} disabled={img.uploading || busy} aria-label={`Remove image ${img.file.name}`} className="btn-ghost btn-sm !px-2 text-brand-danger"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
                  </li>
                ))}
              </ul>
            )}
            {images.length < maxImages && (
              <>
                <input ref={fileInputRef} id={`${uid}-file`} type="file" accept={ACCEPT} multiple={maxImages > 1} onChange={(e) => addFiles(e.target.files)} className="sr-only" aria-describedby={`${uid}-file-help`} />
                <label htmlFor={`${uid}-file`} className="flex min-h-[88px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-brand-line p-4 text-center text-sm hover:border-brand-ink focus-within:outline">
                  <Camera className="h-6 w-6 text-brand-muted" aria-hidden="true" />
                  <span className="font-medium">Choose {maxImages > 1 ? 'images' : 'an image'} to upload</span>
                  <span id={`${uid}-file-help`} className="text-xs text-brand-muted">JPG, PNG or WebP, up to {MAX_FILE_MB} MB each</span>
                </label>
              </>
            )}
          </fieldset>
        )}

        {/* price + quantity */}
        <div className="rounded-xl border border-brand-line p-4 text-sm">
          {priced ? (
            <dl className="space-y-1.5">
              <div className="flex justify-between"><dt className="text-brand-muted">Base price</dt><dd>{formatCurrency(Number(product.price))}</dd></div>
              {selectedOptions.filter((o) => toPaise(o.price_modifier) !== 0).map((o) => (
                <div key={o.value_id} className="flex justify-between"><dt className="text-brand-muted">{o.group_name}: {o.name}</dt><dd>{formatModifier(o.price_modifier)}</dd></div>
              ))}
              {feePaise > 0 && <div className="flex justify-between"><dt className="text-brand-muted">Personalisation</dt><dd>{formatModifier(fromPaise(feePaise))}</dd></div>}
              <div className="flex justify-between border-t border-brand-line pt-2 font-semibold"><dt>Price per item</dt><dd>{formatCurrency(unit)}</dd></div>
            </dl>
          ) : <p className="text-brand-muted">Pricing is shown once the product is available.</p>}
          {!forCombo && (
            <div className="mt-3 flex items-center justify-between">
              <span id={`${uid}-qty`} className="font-medium">Quantity</span>
              <div className="inline-flex items-center rounded-lg border border-brand-line" role="group" aria-labelledby={`${uid}-qty`}>
                <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} disabled={quantity <= 1} aria-label="Decrease quantity" className="flex h-11 w-11 items-center justify-center hover:bg-brand-subtle disabled:opacity-40"><Minus className="h-4 w-4" aria-hidden="true" /></button>
                <output className="w-10 text-center font-semibold" aria-live="polite">{quantity}</output>
                <button type="button" onClick={() => setQuantity((q) => Math.min(maxQuantity, q + 1))} disabled={quantity >= maxQuantity} aria-label="Increase quantity" className="flex h-11 w-11 items-center justify-center hover:bg-brand-subtle disabled:opacity-40"><Plus className="h-4 w-4" aria-hidden="true" /></button>
              </div>
            </div>
          )}
        </div>

        <div className="sticky bottom-0 -mx-5 -mb-5 flex gap-3 border-t border-brand-line bg-white p-4 sm:-mx-6 sm:-mb-5">
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary">Cancel</button>
          <button type="button" onClick={submit} disabled={busy} className="btn-primary flex-1">
            {busy ? 'Uploading…' : forCombo ? 'Save personalisation' : `Add to cart${priced ? ` · ${formatCurrency(total)}` : ''}`}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default ProductCustomizationModal;
