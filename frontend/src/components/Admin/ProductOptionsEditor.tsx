import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Layers } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiFetch } from '../../utils/api';
import { OptionGroup, OptionValue } from '../../types';

/**
 * Product option groups (Finish, Print Type, Frame Type ...) and their values.
 * Every change is saved immediately through the option admin API, so this works on a saved product.
 * Colour and size keep their dedicated sections in the product form and are not listed here.
 */

interface LibraryGroup { id: string; name: string; slug: string; is_active: boolean; product_count: number }

const HIDDEN_SLUGS = ['colour', 'size'];

const ValueRow: React.FC<{ value: OptionValue; onChanged: () => void }> = ({ value, onChanged }) => {
  const [draft, setDraft] = useState({
    name: value.name,
    price_modifier: String(value.price_modifier ?? 0),
    stock_quantity: value.stock_quantity === null || value.stock_quantity === undefined ? '' : String(value.stock_quantity),
    display_order: String(value.display_order ?? 0),
  });

  const save = async (patch: Record<string, unknown>) => {
    try {
      await apiFetch(`/api/admin/product-option-values/${value.id}`, { method: 'PUT', body: JSON.stringify(patch) });
      onChanged();
    } catch (e: any) {
      toast.error(e.message || 'Could not save option value');
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${value.name}"? Past orders keep their own copy of what was bought.`)) return;
    try {
      await apiFetch(`/api/admin/product-option-values/${value.id}`, { method: 'DELETE' });
      onChanged();
    } catch (e: any) {
      toast.error(e.message || 'Could not delete option value');
    }
  };

  return (
    <div className="grid grid-cols-12 gap-2 items-center py-1.5">
      <input className="col-span-4 px-2 py-1.5 border rounded" value={draft.name}
        onChange={e => setDraft({ ...draft, name: e.target.value })}
        onBlur={() => draft.name.trim() && draft.name !== value.name && save({ name: draft.name.trim() })} />
      <input type="number" step="0.01" className="col-span-2 px-2 py-1.5 border rounded" value={draft.price_modifier}
        onChange={e => setDraft({ ...draft, price_modifier: e.target.value })}
        onBlur={() => save({ price_modifier: draft.price_modifier === '' ? 0 : Number(draft.price_modifier) })} />
      <input type="number" min="0" className="col-span-2 px-2 py-1.5 border rounded" placeholder="not tracked" value={draft.stock_quantity}
        onChange={e => setDraft({ ...draft, stock_quantity: e.target.value })}
        onBlur={() => save({ stock_quantity: draft.stock_quantity === '' ? null : Number(draft.stock_quantity) })} />
      <input type="number" className="col-span-1 px-2 py-1.5 border rounded" value={draft.display_order}
        onChange={e => setDraft({ ...draft, display_order: e.target.value })}
        onBlur={() => save({ display_order: Number(draft.display_order) || 0 })} />
      <label className="col-span-2 flex items-center gap-1 text-sm">
        <input type="checkbox" checked={value.is_active} onChange={e => save({ is_active: e.target.checked })} /> Active
      </label>
      <button type="button" onClick={remove} className="col-span-1 p-1.5 text-red-600 hover:bg-red-50 rounded justify-self-end" title="Delete value">
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
};

const GroupCard: React.FC<{ group: OptionGroup; onChanged: () => void }> = ({ group, onChanged }) => {
  const [newValue, setNewValue] = useState('');

  const patchGroup = async (patch: Record<string, unknown>) => {
    try {
      await apiFetch(`/api/admin/product-option-groups/${group.id}`, { method: 'PUT', body: JSON.stringify(patch) });
      onChanged();
    } catch (e: any) {
      toast.error(e.message || 'Could not save option group');
    }
  };

  const detach = async () => {
    if (!confirm(`Remove "${group.name}" and all its values from this product?`)) return;
    try {
      await apiFetch(`/api/admin/product-option-groups/${group.id}`, { method: 'DELETE' });
      onChanged();
    } catch (e: any) {
      toast.error(e.message || 'Could not remove option group');
    }
  };

  const addValue = async () => {
    if (!newValue.trim()) return;
    try {
      await apiFetch(`/api/admin/product-option-groups/${group.id}/values`, {
        method: 'POST',
        body: JSON.stringify({ name: newValue.trim(), display_order: group.values.length }),
      });
      setNewValue('');
      onChanged();
    } catch (e: any) {
      toast.error(e.message || 'Could not add option value');
    }
  };

  return (
    <div className="border rounded-lg p-4 bg-white">
      <div className="flex flex-wrap items-center gap-4 mb-3">
        <h4 className="font-semibold text-base flex-1 min-w-[8rem]">{group.name}</h4>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={group.is_required} onChange={e => patchGroup({ is_required: e.target.checked })} />
          Required
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={group.is_active} onChange={e => patchGroup({ is_active: e.target.checked })} />
          Active
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          Order
          <input type="number" defaultValue={group.display_order} className="w-16 px-2 py-1 border rounded"
            onBlur={e => Number(e.target.value) !== group.display_order && patchGroup({ display_order: Number(e.target.value) || 0 })} />
        </label>
        <button type="button" onClick={detach} className="p-1.5 text-red-600 hover:bg-red-50 rounded" title="Remove group from product">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {group.values.length > 0 && (
        <div className="grid grid-cols-12 gap-2 text-xs text-gray-500 px-0.5">
          <span className="col-span-4">Value</span>
          <span className="col-span-2">Price +/- (₹)</span>
          <span className="col-span-2">Stock</span>
          <span className="col-span-1">Order</span>
        </div>
      )}
      {group.values.map(v => <ValueRow key={v.id} value={v} onChanged={onChanged} />)}

      <div className="flex gap-2 mt-2">
        <input className="flex-1 px-3 py-2 border rounded-lg" placeholder={`Add a ${group.name.toLowerCase()} value, e.g. Holographic`} value={newValue}
          onChange={e => setNewValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addValue(); } }} />
        <button type="button" onClick={addValue} className="px-3 py-2 bg-premium-gold text-white rounded-lg flex items-center gap-1">
          <Plus className="h-4 w-4" /> Add
        </button>
      </div>
    </div>
  );
};

const ProductOptionsEditor: React.FC<{ productId: string }> = ({ productId }) => {
  const [groups, setGroups] = useState<OptionGroup[]>([]);
  const [library, setLibrary] = useState<LibraryGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [pick, setPick] = useState('');
  const [newName, setNewName] = useState('');

  const load = async () => {
    try {
      const [g, lib] = await Promise.all([
        apiFetch<OptionGroup[]>(`/api/admin/products/${productId}/options`),
        apiFetch<LibraryGroup[]>('/api/admin/option-groups'),
      ]);
      setGroups(g);
      setLibrary(lib);
    } catch (e: any) {
      toast.error(e.message || 'Could not load options');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [productId]);

  const attach = async (body: Record<string, unknown>) => {
    try {
      await apiFetch(`/api/admin/products/${productId}/option-groups`, {
        method: 'POST',
        body: JSON.stringify({ display_order: groups.length + 2, ...body }),
      });
      setPick('');
      setNewName('');
      load();
    } catch (e: any) {
      toast.error(e.message || 'Could not add option group');
    }
  };

  const shown = groups.filter(g => !HIDDEN_SLUGS.includes(g.slug));
  const attachedIds = new Set(groups.map(g => g.option_group_id));
  const available = library.filter(l => l.is_active && !attachedIds.has(l.id) && !HIDDEN_SLUGS.includes(l.slug));

  return (
    <div className="border-2 border-dashed border-gray-200 rounded-lg p-4 space-y-4">
      <div>
        <h3 className="font-semibold flex items-center gap-2"><Layers className="h-5 w-5 text-premium-gold" />Product Options</h3>
        <p className="text-xs text-gray-500">
          Choices the customer makes (Finish, Print Type, Frame Type ...). Each value can add to the price. Changes here save immediately.
          Colour and size are managed in the sections above.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading options…</p>
      ) : (
        <>
          {shown.length === 0 && <p className="text-sm text-gray-500">No extra options yet.</p>}
          {shown.map(g => <GroupCard key={g.id} group={g} onChanged={load} />)}

          <div className="flex flex-wrap gap-2 items-center">
            <select className="px-3 py-2 border rounded-lg" value={pick} onChange={e => setPick(e.target.value)}>
              <option value="">Attach an existing group…</option>
              {available.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <button type="button" disabled={!pick} onClick={() => attach({ option_group_id: pick })}
              className="px-3 py-2 border rounded-lg disabled:opacity-50">Attach</button>
            <span className="text-gray-400 text-sm">or</span>
            <input className="px-3 py-2 border rounded-lg" placeholder="New group name, e.g. Finish" value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (newName.trim()) attach({ name: newName.trim() }); } }} />
            <button type="button" disabled={!newName.trim()} onClick={() => attach({ name: newName.trim() })}
              className="px-3 py-2 bg-premium-gold text-white rounded-lg disabled:opacity-50 flex items-center gap-1"><Plus className="h-4 w-4" />Create</button>
          </div>
        </>
      )}
    </div>
  );
};

export default ProductOptionsEditor;
