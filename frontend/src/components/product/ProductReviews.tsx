import React, { useState } from 'react';
import { MessageCircle, Star } from 'lucide-react';
import { Review } from '../../types';
import { apiFetch } from '../../utils/api';
import { friendlyError } from '../../utils/errors';
import toast from 'react-hot-toast';

interface Props {
  productId: string;
  reviews: Review[];
  loading: boolean;
}

const Stars: React.FC<{ value: number; size?: string }> = ({ value, size = 'h-4 w-4' }) => (
  <span className="inline-flex" aria-hidden="true">
    {[1, 2, 3, 4, 5].map((s) => <Star key={s} className={`${size} ${s <= Math.round(value) ? 'fill-brand-accent text-brand-accent' : 'text-brand-line'}`} />)}
  </span>
);

/** Approved reviews for a product and the form to add one (reviews are moderated before they appear). */
const ProductReviews: React.FC<Props> = ({ productId, reviews, loading }) => {
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ user_name: '', user_email: '', rating: 5, comment: '' });
  const [formError, setFormError] = useState('');

  const average = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
  const sorted = [...reviews].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.user_name.trim() || !form.comment.trim()) { setFormError('Please add your name and a short review.'); return; }
    setFormError('');
    setSubmitting(true);
    try {
      await apiFetch('/api/reviews', { method: 'POST', body: JSON.stringify({ product_id: productId, ...form }) });
      toast.success('Thank you! Your review will appear once it has been approved.');
      setShowForm(false);
      setForm({ user_name: '', user_email: '', rating: 5, comment: '' });
    } catch (err) {
      setFormError(friendlyError(err, 'We could not submit your review. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {reviews.length > 0 && (
        <div className="flex items-center gap-4">
          <p className="text-4xl font-extrabold">{average.toFixed(1)}</p>
          <div>
            <Stars value={average} />
            <p className="mt-1 text-sm text-brand-muted">{reviews.length} {reviews.length === 1 ? 'review' : 'reviews'}</p>
          </div>
        </div>
      )}

      <div>
        <button type="button" onClick={() => setShowForm((v) => !v)} aria-expanded={showForm} className="btn-secondary btn-sm">
          <MessageCircle className="h-4 w-4" aria-hidden="true" /> Write a review
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="card space-y-4 p-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="rv-name" className="mb-1 block text-sm font-medium">Your name <span aria-hidden="true">*</span></label>
              <input id="rv-name" className="input" value={form.user_name} onChange={(e) => setForm({ ...form, user_name: e.target.value })} required />
            </div>
            <div>
              <label htmlFor="rv-email" className="mb-1 block text-sm font-medium">Email (optional)</label>
              <input id="rv-email" type="email" className="input" value={form.user_email} onChange={(e) => setForm({ ...form, user_email: e.target.value })} />
            </div>
          </div>
          <fieldset>
            <legend className="mb-1 text-sm font-medium">Rating</legend>
            <div className="flex gap-1" role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((s) => (
                <button key={s} type="button" role="radio" aria-checked={form.rating === s} aria-label={`${s} ${s === 1 ? 'star' : 'stars'}`} onClick={() => setForm({ ...form, rating: s })} className="rounded p-1">
                  <Star className={`h-6 w-6 ${s <= form.rating ? 'fill-brand-accent text-brand-accent' : 'text-brand-line'}`} aria-hidden="true" />
                </button>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor="rv-comment" className="mb-1 block text-sm font-medium">Your review <span aria-hidden="true">*</span></label>
            <textarea id="rv-comment" rows={3} className="input" value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} required />
          </div>
          {formError && <p role="alert" className="text-sm font-medium text-brand-danger">{formError}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={submitting} className="btn-primary btn-sm">{submitting ? 'Submitting…' : 'Submit review'}</button>
            <button type="button" onClick={() => setShowForm(false)} className="btn-ghost btn-sm">Cancel</button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-brand-muted" role="status">Loading reviews…</p>
      ) : reviews.length === 0 ? (
        <p className="text-sm text-brand-muted">There are no reviews for this product yet.</p>
      ) : (
        <ul className="divide-y divide-brand-line">
          {sorted.map((r) => (
            <li key={r.id} className="py-4">
              <div className="flex flex-wrap items-center gap-2">
                <Stars value={r.rating} size="h-3.5 w-3.5" />
                <span className="sr-only">{r.rating} out of 5</span>
                <span className="text-sm font-semibold">{r.user_name}</span>
                <span className="text-xs text-brand-muted">{new Date(r.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
              </div>
              <p className="mt-2 text-sm text-brand-muted">{r.comment}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default ProductReviews;
