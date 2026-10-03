import React, { useState, useEffect } from 'react';
import { ChevronDown, Search, Link, Tag, Package, ExternalLink } from 'lucide-react';
import { apiFetch } from '../../utils/api';

interface LinkPickerProps {
  value: string;
  onChange: (url: string) => void;
  label?: string;
}

type LinkType = 'custom' | 'category' | 'product' | 'combo';

interface CategoryOption { id: string; name: string; }
interface ProductOption  { id: string; name: string; price: number; }
interface ComboOption    { id: string; name: string; discount_price?: number; }

const LinkPicker: React.FC<LinkPickerProps> = ({ value, onChange, label = 'CTA Link' }) => {
  const [linkType, setLinkType] = useState<LinkType>('custom');
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [products, setProducts]     = useState<ProductOption[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [combos, setCombos] = useState<ComboOption[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [open, setOpen] = useState(false);

  // Detect type from existing value on mount
  useEffect(() => {
    if (!value) return;
    if (value.includes('/products?category=')) setLinkType('category');
    else if (value.includes('/products?id=') || value.startsWith('/product/')) setLinkType('product');
    else if (value.includes('/combos?id=')) setLinkType('combo');
    else setLinkType('custom');
  }, []);

  useEffect(() => {
    apiFetch('/api/categories').then(d => setCategories(d || [])).catch(() => {});
    apiFetch('/api/combos').then(d => setCombos((d || []).slice(0, 100))).catch(() => {});
  }, []);

  useEffect(() => {
    if (linkType !== 'product') return;
    setLoadingProducts(true);
    const url = searchTerm.trim()
      ? `/api/products/search?q=${encodeURIComponent(searchTerm)}`
      : '/api/products';
    apiFetch(url)
      .then(d => setProducts((d || []).slice(0, 50)))
      .catch(() => {})
      .finally(() => setLoadingProducts(false));
  }, [linkType, searchTerm]);

  const handleCategoryPick = (cat: CategoryOption) => {
    onChange(`/products?category=${encodeURIComponent(cat.name)}`);
    setOpen(false);
  };

  const handleProductPick = (p: ProductOption) => {
    onChange(`/products?id=${p.id}`);
    setOpen(false);
  };

  const typeLabel: Record<LinkType, string> = {
    custom: 'Custom URL',
    category: 'Category Page',
    product: 'Product Page',
    combo: 'Combo Page',
  };

  const typeIcon: Record<LinkType, React.ReactNode> = {
    custom: <Link className="h-4 w-4" />,
    category: <Tag className="h-4 w-4" />,
    product: <Package className="h-4 w-4" />,
    combo: <Package className="h-4 w-4" />,
  };

  return (
    <div>
      <label className="block text-sm font-medium mb-2">{label}</label>

      {/* Type selector */}
      <div className="flex gap-2 mb-2">
        {(['custom', 'category', 'product', 'combo'] as LinkType[]).map(t => (
          <button
            key={t}
            type="button"
            onClick={() => { setLinkType(t); setOpen(t !== 'custom'); if (t === 'custom') setOpen(false); }}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${
              linkType === t
                ? 'border-premium-gold bg-premium-gold/10 text-premium-gold font-medium'
                : 'border-gray-200 text-gray-600 hover:border-gray-300'
            }`}
          >
            {typeIcon[t]}
            {typeLabel[t]}
          </button>
        ))}
      </div>

      {/* Custom URL input */}
      {linkType === 'custom' && (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          className="w-full px-4 py-2 border rounded-lg focus:border-premium-gold focus:outline-none text-sm"
          placeholder="/products, /combos, https://..."
        />
      )}

      {/* Category picker */}
      {linkType === 'category' && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="w-full flex items-center justify-between px-4 py-2 border rounded-lg hover:border-premium-gold focus:outline-none text-sm bg-white"
          >
            <span className={value ? 'text-gray-900' : 'text-gray-400'}>
              {value
                ? (() => {
                    const name = decodeURIComponent(value.split('category=')[1] || '');
                    return name ? `📂 ${name}` : value;
                  })()
                : 'Select a category…'}
            </span>
            <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          {open && (
            <div className="absolute z-10 mt-1 w-full bg-white border rounded-lg shadow-lg max-h-56 overflow-y-auto">
              {categories.length === 0
                ? <p className="p-4 text-sm text-gray-400">No categories found</p>
                : categories.map(cat => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => handleCategoryPick(cat)}
                      className="w-full text-left px-4 py-2.5 text-sm hover:bg-premium-gold/10 hover:text-premium-gold transition-colors flex items-center gap-2"
                    >
                      <Tag className="h-3.5 w-3.5 flex-shrink-0" />
                      {cat.name}
                    </button>
                  ))
              }
            </div>
          )}
        </div>
      )}

      {/* Product picker */}
      {linkType === 'product' && (
        <div className="relative">
          <div className="relative mb-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={e => { setSearchTerm(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              placeholder="Search products…"
              className="w-full pl-9 pr-4 py-2 border rounded-lg focus:border-premium-gold focus:outline-none text-sm"
            />
          </div>
          {value && value.includes('id=') && (
            <p className="text-xs text-green-600 mb-1 flex items-center gap-1">
              <ExternalLink className="h-3 w-3" />
              {value}
            </p>
          )}
          {open && (
            <div className="absolute z-10 w-full bg-white border rounded-lg shadow-lg max-h-56 overflow-y-auto">
              {loadingProducts
                ? <p className="p-4 text-sm text-gray-400">Loading…</p>
                : products.length === 0
                  ? <p className="p-4 text-sm text-gray-400">No products found</p>
                  : products.map(p => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => handleProductPick(p)}
                        className="w-full text-left px-4 py-2.5 text-sm hover:bg-premium-gold/10 hover:text-premium-gold transition-colors flex items-center gap-2"
                      >
                        <Package className="h-3.5 w-3.5 flex-shrink-0" />
                        <span className="flex-1 truncate">{p.name}</span>
                        <span className="text-xs text-gray-400 flex-shrink-0">₹{p.price?.toLocaleString()}</span>
                      </button>
                    ))
              }
            </div>
          )}
        </div>
      )}

      {/* Combo picker */}
      {linkType === 'combo' && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="w-full flex items-center justify-between px-4 py-2 border rounded-lg hover:border-premium-gold focus:outline-none text-sm bg-white"
          >
            <span className={value ? 'text-gray-900' : 'text-gray-400'}>
              {value && value.includes('id=')
                ? (() => {
                    const id = value.split('id=')[1];
                    const found = combos.find(c => c.id === id);
                    return found ? `🎁 ${found.name}` : value;
                  })()
                : 'Select a combo…'}
            </span>
            <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          {open && (
            <div className="absolute z-10 mt-1 w-full bg-white border rounded-lg shadow-lg max-h-56 overflow-y-auto">
              {combos.length === 0
                ? <p className="p-4 text-sm text-gray-400">No combos found</p>
                : combos.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => { onChange(`/combos?id=${c.id}`); setOpen(false); }}
                      className="w-full text-left px-4 py-2.5 text-sm hover:bg-premium-gold/10 hover:text-premium-gold transition-colors flex items-center gap-2"
                    >
                      <Package className="h-3.5 w-3.5 flex-shrink-0" />
                      <span className="flex-1 truncate">{c.name}</span>
                      {c.discount_price && <span className="text-xs text-gray-400 flex-shrink-0">₹{c.discount_price?.toLocaleString()}</span>}
                    </button>
                  ))
              }
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LinkPicker;
