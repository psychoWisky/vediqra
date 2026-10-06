import React, { useState, useEffect } from 'react';
import { getImageUrl } from '../../utils/helpers';
import { X, Save, Users, Image as ImageIcon, ChevronDown, Plus, Trash2, GripVertical, ChevronUp, Palette, Ruler } from 'lucide-react';
import { Product, Gender, Category, ProductColor, ProductSize } from '../../types';
import { apiFetch, uploadFetch } from '../../utils/api';
import MultiImageUpload from './MultiImageUpload';
import ProductOptionsEditor from './ProductOptionsEditor';
import toast from 'react-hot-toast';

interface EditProductProps {
  product: Product;
  onClose: () => void;
  onSuccess: () => void;
}

const EditProduct: React.FC<EditProductProps> = ({ product, onClose, onSuccess }) => {
  const [loading, setLoading] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [genders, setGenders] = useState<Gender[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);

  const [hasColors, setHasColors] = useState(product.has_colors || false);
  const [hasSizes, setHasSizes] = useState(product.has_sizes || false);
  const [colors, setColors] = useState<ProductColor[]>(product.colors || []);
  const [sizes, setSizes] = useState<ProductSize[]>(product.sizes || []);
  const [loadingVariants, setLoadingVariants] = useState(false);

  // Built synchronously so MultiImageUpload (which copies initialImages only once, on mount) receives the
  // complete list on its first render. image_url is the primary; additional_images are the rest.
  const [productImages, setProductImages] = useState<{ url: string; is_primary: boolean }[]>(() => {
    const urls = Array.from(new Set([product.image_url, ...(product.additional_images || [])].filter(Boolean) as string[]));
    return urls.map((url, i) => ({ url, is_primary: i === 0 }));
  });

  useEffect(() => {
    if (product.categories && product.categories.length > 0) {
      setSelectedCategories(product.categories.map(c => c.id));
    } else if (product.category) {
      const category = categories.find(c => c.name === product.category);
      if (category) setSelectedCategories([category.id]);
    }
  }, [product, categories]);

  type GenderType = 'men' | 'women' | 'unisex';

  const [formData, setFormData] = useState({
    name: product.name,
    slug: product.slug || '',
    track_stock: product.track_stock === true,
    description: product.description,
    gender: (product.gender || 'unisex') as GenderType,
    price: product.price.toString(),
    original_price: product.original_price?.toString() || '',
    discount_percentage: product.discount_percentage?.toString() || '',
    sku: product.sku || `SKU-${Date.now().toString().slice(-8)}`,
    stock_quantity: product.stock_quantity.toString(),
    is_customizable: product.is_customizable || false,
    customization_price: product.customization_price?.toString() || '0',
    max_customization_characters: product.max_customization_characters?.toString() || '50',
    max_customization_images: product.max_customization_images?.toString() || '10',
    max_customization_lines: product.max_customization_lines?.toString() || '10',
    social_proof_enabled: product.social_proof_enabled !== false,
    social_proof_text: product.social_proof_text || '🔺{count} People are Purchasing Right Now',
    social_proof_initial_count: product.social_proof_initial_count?.toString() || '5',
    social_proof_end_count: product.social_proof_end_count?.toString() || '15',
    is_active: product.is_active,
  });

  useEffect(() => {
    const price = parseFloat(formData.price) || 0;
    const originalPrice = parseFloat(formData.original_price) || 0;
    const discountPercent = parseFloat(formData.discount_percentage) || 0;
    if (originalPrice > 0 && price > 0 && originalPrice > price) {
      const calc = Math.round(((originalPrice - price) / originalPrice) * 100);
      if (calc !== discountPercent) setFormData(p => ({ ...p, discount_percentage: calc.toString() }));
    } else if (originalPrice > 0 && discountPercent > 0 && discountPercent <= 100) {
      const calcPrice = originalPrice - (originalPrice * discountPercent / 100);
      if (Math.abs(calcPrice - price) > 0.01) setFormData(p => ({ ...p, price: calcPrice.toFixed(2) }));
    }
  }, [formData.price, formData.original_price, formData.discount_percentage]);

  useEffect(() => {
    fetchCategories();
    fetchGenders();
    fetchVariants();
  }, []);

  // ── Fetch variants using correct /api/ paths ──────────────────────────────
  const fetchVariants = async () => {
    if (!product.has_colors && !product.has_sizes) return;
    setLoadingVariants(true);
    try {
      if (product.has_colors) {
        try {
          const data = await apiFetch(`/api/admin/products/${product.id}/colors`);
          setColors(data || []);
        } catch (err) {
          console.error('Error fetching colors:', err);
        }
      }
      if (product.has_sizes) {
        try {
          const data = await apiFetch(`/api/admin/products/${product.id}/sizes/all`);
          setSizes(data || []);
        } catch (err) {
          console.error('Error fetching sizes:', err);
        }
      }
    } finally {
      setLoadingVariants(false);
    }
  };

  const fetchCategories = async () => {
    try {
      const data = await apiFetch('/api/admin/categories');
      setCategories(data || []);
    } catch (error) {
      console.error('Error fetching categories:', error);
    }
  };

  const fetchGenders = async () => {
    try {
      const data = await apiFetch('/api/genders');
      setGenders(data);
    } catch (error) {
      console.error('Error fetching genders:', error);
    }
  };

  const handleImagesUploaded = (images: { url: string; is_primary: boolean }[]) => {
    setProductImages(images);
  };

  const toggleCategory = (categoryId: string) => {
    setSelectedCategories(prev =>
      prev.includes(categoryId) ? prev.filter(id => id !== categoryId) : [...prev, categoryId]
    );
  };

  // ── Color handlers ─────────────────────────────────────────────────────────
  const addColor = () => {
    setColors(prev => [...prev, {
      id: `temp-${Date.now()}`,
      product_id: product.id,
      color_name: '',
      color_code: '#000000',
      image_url: '',
      additional_images: [],
      stock_quantity: 10,
      price_modifier: 0,
      is_active: true,
      display_order: prev.length,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }]);
  };

  const updateColor = (index: number, field: keyof ProductColor, value: any) => {
    setColors(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const removeColor = (index: number) => setColors(prev => prev.filter((_, i) => i !== index));

  const moveColor = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= colors.length) return;
    setColors(prev => {
      const updated = [...prev];
      [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
      updated.forEach((c, i) => { c.display_order = i; });
      return updated;
    });
  };

  const uploadColorImage = async (index: number, file: File) => {
    setUploadingImage(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const data = await uploadFetch('/api/upload/upload-image', fd);
      updateColor(index, 'image_url', data.image_url);
      toast.success('Image uploaded');
    } catch {
      toast.error('Failed to upload image');
    } finally {
      setUploadingImage(false);
    }
  };

  const uploadColorAdditionalImage = async (colorIndex: number, file: File) => {
    setUploadingImage(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const data = await uploadFetch('/api/upload/upload-image', fd);
      setColors(prev => {
        const updated = [...prev];
        updated[colorIndex] = {
          ...updated[colorIndex],
          additional_images: [...(updated[colorIndex].additional_images || []), data.image_url],
        };
        return updated;
      });
      toast.success('Additional image uploaded');
    } catch {
      toast.error('Failed to upload additional image');
    } finally {
      setUploadingImage(false);
    }
  };

  const removeColorAdditionalImage = (colorIndex: number, imgIndex: number) => {
    setColors(prev => {
      const updated = [...prev];
      updated[colorIndex] = {
        ...updated[colorIndex],
        additional_images: (updated[colorIndex].additional_images || []).filter((_, i) => i !== imgIndex),
      };
      return updated;
    });
  };

  // ── Size handlers ──────────────────────────────────────────────────────────
  const addSize = () => {
    setSizes(prev => [...prev, {
      id: `temp-${Date.now()}`,
      product_id: product.id,
      size_name: '',
      size_code: '',
      stock_quantity: 10,
      price_modifier: 0,
      is_active: true,
      display_order: prev.length,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }]);
  };

  const updateSize = (index: number, field: keyof ProductSize, value: any) => {
    setSizes(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const removeSize = (index: number) => setSizes(prev => prev.filter((_, i) => i !== index));

  const moveSize = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= sizes.length) return;
    setSizes(prev => {
      const updated = [...prev];
      [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
      updated.forEach((s, i) => { s.display_order = i; });
      return updated;
    });
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedCategories.length === 0) { toast.error('Please select at least one category'); return; }
    if (hasColors && colors.length === 0) { toast.error('Please add at least one color variant'); return; }
    if (hasSizes && sizes.length === 0) { toast.error('Please add at least one size variant'); return; }

    setLoading(true);
    try {
      const primaryImage = productImages.find(img => img.is_primary) || productImages[0];
      const additionalImageUrls = productImages.filter(img => !img.is_primary).map(img => img.url);

      const productData: any = {
        name: formData.name.trim(),
        slug: formData.slug.trim() || undefined,
        track_stock: formData.track_stock,
        description: formData.description.trim(),
        gender: formData.gender,
        price: parseFloat(formData.price),
        stock_quantity: parseInt(formData.stock_quantity),
        sku: formData.sku,
        image_url: primaryImage?.url || product.image_url,
        additional_images: additionalImageUrls,
        has_colors: hasColors,
        has_sizes: hasSizes,
        social_proof_enabled: formData.social_proof_enabled,
        social_proof_text: formData.social_proof_text,
        social_proof_initial_count: parseInt(formData.social_proof_initial_count),
        social_proof_end_count: parseInt(formData.social_proof_end_count),
        is_active: formData.is_active,
        is_customizable: formData.is_customizable,
        updated_at: new Date().toISOString(),
      };

      if (formData.original_price) productData.original_price = parseFloat(formData.original_price);
      if (formData.discount_percentage) productData.discount_percentage = parseInt(formData.discount_percentage);
      if (formData.is_customizable) {
        productData.customization_price = parseFloat(formData.customization_price);
        productData.max_customization_characters = parseInt(formData.max_customization_characters);
        productData.max_customization_images = parseInt(formData.max_customization_images);
        productData.max_customization_lines = parseInt(formData.max_customization_lines);
      }

      // 1. Update product
      await apiFetch(`/api/admin/products/${product.id}`, {
        method: 'PUT',
        body: JSON.stringify(productData),
      });

      // 2. Replace categories
      await apiFetch(`/api/admin/products/${product.id}/categories`, { method: 'DELETE' });
      if (selectedCategories.length > 0) {
        await apiFetch(`/api/admin/products/${product.id}/categories`, {
          method: 'POST',
          body: JSON.stringify({ categories: selectedCategories.map(id => ({ category_id: id })) }),
        });
      }

      // 3. Replace colors
      if (hasColors || product.has_colors) await apiFetch(`/api/admin/products/${product.id}/colors`, { method: 'DELETE' });
      if (hasColors && colors.length > 0) {
        for (const color of colors) {
          await apiFetch(`/api/admin/products/${product.id}/colors`, {
            method: 'POST',
            body: JSON.stringify({
              color_name: color.color_name,
              color_code: color.color_code,
              image_url: color.image_url,
              additional_images: color.additional_images || [],
              stock_quantity: color.stock_quantity,
              price_modifier: color.price_modifier,
              is_active: color.is_active,
              display_order: color.display_order,
            }),
          });
        }
      }

      // 4. Replace sizes
      if (hasSizes || product.has_sizes) await apiFetch(`/api/admin/products/${product.id}/sizes`, { method: 'DELETE' });
      if (hasSizes && sizes.length > 0) {
        for (const size of sizes) {
          await apiFetch(`/api/admin/products/${product.id}/sizes`, {
            method: 'POST',
            body: JSON.stringify({
              size_name: size.size_name,
              size_code: size.size_code,
              stock_quantity: size.stock_quantity,
              price_modifier: size.price_modifier,
              is_active: size.is_active,
              display_order: size.display_order,
            }),
          });
        }
      }

      toast.success('Product updated successfully!');
      onSuccess();
      onClose();
    } catch (error: any) {
      console.error('Update error:', error);
      toast.error(`Error: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const savings = parseFloat(formData.original_price) && parseFloat(formData.price)
    ? (parseFloat(formData.original_price) - parseFloat(formData.price)).toFixed(2)
    : '0';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-6xl max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-serif font-semibold">Edit Product</h2>
            <div className="flex items-center gap-3">
              {loadingVariants && (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-premium-gold" />
                  Loading variants…
                </div>
              )}
              <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Variant Toggles */}
            <div className="grid grid-cols-2 gap-4 bg-gray-50 p-4 rounded-lg">
              <label className="flex items-center space-x-3 cursor-pointer">
                <input type="checkbox" checked={hasColors} onChange={e => setHasColors(e.target.checked)} className="h-5 w-5 text-premium-gold rounded" />
                <div>
                  <span className="font-medium flex items-center gap-1"><Palette className="h-4 w-4" />Has Color Variants</span>
                  <p className="text-xs text-gray-500">Different colors with separate images</p>
                </div>
              </label>
              <label className="flex items-center space-x-3 cursor-pointer">
                <input type="checkbox" checked={hasSizes} onChange={e => setHasSizes(e.target.checked)} className="h-5 w-5 text-premium-gold rounded" />
                <div>
                  <span className="font-medium flex items-center gap-1"><Ruler className="h-4 w-4" />Has Size Variants</span>
                  <p className="text-xs text-gray-500">Different sizes (S, M, L, XL, etc.)</p>
                </div>
              </label>
            </div>

            {/* Product Images (when no color variants) */}
            {!hasColors && (
              <div>
                <label className="block text-sm font-medium mb-3">Product Images (Max 5)</label>
                <MultiImageUpload onImagesUploaded={handleImagesUploaded} maxImages={5} initialImages={productImages} />
              </div>
            )}

            {/* Color Variants */}
            {hasColors && (
              <div className="border rounded-lg p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-medium flex items-center gap-2"><Palette className="h-5 w-5" />Color Variants</h3>
                  <button type="button" onClick={addColor} className="px-3 py-1.5 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy flex items-center gap-1 text-sm">
                    <Plus className="h-4 w-4" />Add Color
                  </button>
                </div>
                <div className="space-y-4">
                  {colors.map((color, index) => (
                    <div key={color.id} className="border rounded-lg p-4 bg-gray-50">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <GripVertical className="h-5 w-5 text-gray-400 cursor-move" />
                          <span className="font-medium">Color Variant {index + 1}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button type="button" onClick={() => moveColor(index, 'up')} disabled={index === 0} className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button>
                          <button type="button" onClick={() => moveColor(index, 'down')} disabled={index === colors.length - 1} className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button>
                          <button type="button" onClick={() => removeColor(index)} className="p-1 hover:bg-red-100 text-red-500 rounded"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                          <label className="block text-xs font-medium mb-1">Color Name</label>
                          <input type="text" value={color.color_name} onChange={e => updateColor(index, 'color_name', e.target.value)} placeholder="e.g., Red, Blue" className="w-full px-3 py-2 text-sm border rounded-lg" required />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Color Code</label>
                          <div className="flex items-center gap-2">
                            <input type="color" value={color.color_code || '#000000'} onChange={e => updateColor(index, 'color_code', e.target.value)} className="w-10 h-9 border rounded" />
                            <input type="text" value={color.color_code || ''} onChange={e => updateColor(index, 'color_code', e.target.value)} placeholder="#000000" className="flex-1 px-3 py-2 text-sm border rounded-lg" />
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Stock</label>
                          <input type="number" value={color.stock_quantity} onChange={e => updateColor(index, 'stock_quantity', parseInt(e.target.value))} min="0" className="w-full px-3 py-2 text-sm border rounded-lg" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Price Modifier (₹)</label>
                          <input type="number" value={color.price_modifier} onChange={e => updateColor(index, 'price_modifier', parseFloat(e.target.value))} className="w-full px-3 py-2 text-sm border rounded-lg" />
                          <p className="text-xs text-gray-500">+/- from base</p>
                        </div>
                      </div>
                      <div className="mt-3">
                        <label className="block text-xs font-medium mb-1">Color Image</label>
                        <div className="flex items-center gap-4">
                          {color.image_url ? (
                            <div className="relative w-16 h-16">
                              <img src={getImageUrl(color.image_url)} alt={color.color_name} className="w-full h-full object-cover rounded border" onError={e => { e.currentTarget.src = "/placeholder.svg"; }} />
                              <button type="button" onClick={() => updateColor(index, 'image_url', '')} className="absolute -top-2 -right-2 p-1 bg-red-500 text-white rounded-full"><X className="h-3 w-3" /></button>
                            </div>
                          ) : (
                            <label className="border-2 border-dashed border-gray-300 rounded-lg px-4 py-2 cursor-pointer hover:border-premium-gold">
                              <input type="file" accept="image/*" onChange={async e => { const f = e.target.files?.[0]; if (f) await uploadColorImage(index, f); }} className="hidden" />
                              <span className="text-sm text-gray-600">Upload Image</span>
                            </label>
                          )}
                        </div>
                      </div>
                      <div className="mt-3">
                        <label className="block text-xs font-medium mb-1">Additional Images (optional)</label>
                        <div className="flex items-center gap-2 flex-wrap">
                          {(color.additional_images || []).map((imgUrl, imgIdx) => (
                            <div key={imgIdx} className="relative w-14 h-14">
                              <img src={imgUrl} alt={`extra-${imgIdx}`} className="w-full h-full object-cover rounded border" />
                              <button type="button" onClick={() => removeColorAdditionalImage(index, imgIdx)} className="absolute -top-1.5 -right-1.5 p-0.5 bg-red-500 text-white rounded-full"><X className="h-2.5 w-2.5" /></button>
                            </div>
                          ))}
                          {(color.additional_images || []).length < 5 && (
                            <label className="border-2 border-dashed border-gray-300 rounded-lg w-14 h-14 flex items-center justify-center cursor-pointer hover:border-premium-gold">
                              <input type="file" accept="image/*" onChange={async e => { const f = e.target.files?.[0]; if (f) await uploadColorAdditionalImage(index, f); }} className="hidden" />
                              <Plus className="h-5 w-5 text-gray-400" />
                            </label>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 mt-1">Up to 5 extra images per colour</p>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <input type="checkbox" id={`color-active-${index}`} checked={color.is_active} onChange={e => updateColor(index, 'is_active', e.target.checked)} className="rounded text-premium-gold" />
                        <label htmlFor={`color-active-${index}`} className="text-sm">Active</label>
                      </div>
                    </div>
                  ))}
                  {colors.length === 0 && (
                    <div className="text-center py-8 border-2 border-dashed border-gray-300 rounded-lg">
                      <p className="text-gray-500">No color variants added yet</p>
                      <button type="button" onClick={addColor} className="mt-2 text-premium-gold hover:underline">Add your first color</button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Size Variants */}
            {hasSizes && (
              <div className="border rounded-lg p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-medium flex items-center gap-2"><Ruler className="h-5 w-5" />Size Variants</h3>
                  <button type="button" onClick={addSize} className="px-3 py-1.5 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy flex items-center gap-1 text-sm">
                    <Plus className="h-4 w-4" />Add Size
                  </button>
                </div>
                <div className="space-y-4">
                  {sizes.map((size, index) => (
                    <div key={size.id} className="border rounded-lg p-4 bg-gray-50">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2"><GripVertical className="h-5 w-5 text-gray-400 cursor-move" /><span className="font-medium">Size Variant {index + 1}</span></div>
                        <div className="flex items-center gap-1">
                          <button type="button" onClick={() => moveSize(index, 'up')} disabled={index === 0} className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button>
                          <button type="button" onClick={() => moveSize(index, 'down')} disabled={index === sizes.length - 1} className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button>
                          <button type="button" onClick={() => removeSize(index)} className="p-1 hover:bg-red-100 text-red-500 rounded"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                          <label className="block text-xs font-medium mb-1">Size Name</label>
                          <input type="text" value={size.size_name} onChange={e => updateSize(index, 'size_name', e.target.value)} placeholder="e.g., Small, Medium" className="w-full px-3 py-2 text-sm border rounded-lg" required />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Size Code</label>
                          <input type="text" value={size.size_code || ''} onChange={e => updateSize(index, 'size_code', e.target.value)} placeholder="e.g., S, M, L" className="w-full px-3 py-2 text-sm border rounded-lg" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Stock</label>
                          <input type="number" value={size.stock_quantity} onChange={e => updateSize(index, 'stock_quantity', parseInt(e.target.value))} min="0" className="w-full px-3 py-2 text-sm border rounded-lg" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Price Modifier (₹)</label>
                          <input type="number" value={size.price_modifier} onChange={e => updateSize(index, 'price_modifier', parseFloat(e.target.value))} className="w-full px-3 py-2 text-sm border rounded-lg" />
                          <p className="text-xs text-gray-500">+/- from base</p>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <input type="checkbox" id={`size-active-${index}`} checked={size.is_active} onChange={e => updateSize(index, 'is_active', e.target.checked)} className="rounded text-premium-gold" />
                        <label htmlFor={`size-active-${index}`} className="text-sm">Active</label>
                      </div>
                    </div>
                  ))}
                  {sizes.length === 0 && (
                    <div className="text-center py-8 border-2 border-dashed border-gray-300 rounded-lg">
                      <p className="text-gray-500">No size variants added yet</p>
                      <button type="button" onClick={addSize} className="mt-2 text-premium-gold hover:underline">Add your first size</button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Generic options (Finish, Print Type, Frame Type ...) */}
            <ProductOptionsEditor productId={product.id} />

            {/* Core Fields */}
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">Product Name *</label>
                <input type="text" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} required className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">URL Slug</label>
                <input type="text" value={formData.slug} onChange={e => setFormData({ ...formData, slug: e.target.value })} className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none" placeholder="auto-generated from the name, e.g. magic-mug" />
                <p className="text-xs text-gray-500 mt-1">Used in the product link. Must be unique.</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Categories *</label>
                <div className="relative">
                  <button type="button" onClick={() => setShowCategoryDropdown(!showCategoryDropdown)} className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none text-left flex items-center justify-between bg-white">
                    <span className="truncate">{selectedCategories.length === 0 ? 'Select categories' : `${selectedCategories.length} category${selectedCategories.length > 1 ? 's' : ''} selected`}</span>
                    <ChevronDown className={`h-5 w-5 transition-transform ${showCategoryDropdown ? 'rotate-180' : ''}`} />
                  </button>
                  {showCategoryDropdown && (
                    <div className="absolute z-10 mt-1 w-full bg-white border rounded-lg shadow-lg max-h-60 overflow-y-auto">
                      {categories.map(category => (
                        <label key={category.id} className="flex items-center px-4 py-2 hover:bg-gray-50 cursor-pointer">
                          <input type="checkbox" checked={selectedCategories.includes(category.id)} onChange={() => toggleCategory(category.id)} className="h-4 w-4 text-premium-gold rounded border-gray-300" />
                          <span className="ml-3 flex-1">{category.name}</span>
                          {category.icon && category.icon_type !== 'image' && <span className="text-xl">{category.icon}</span>}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                {selectedCategories.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    {selectedCategories.map(catId => {
                      const cat = categories.find(c => c.id === catId);
                      return cat ? (
                        <span key={catId} className="inline-flex items-center px-3 py-1 bg-premium-cream text-premium-burgundy rounded-full text-sm">
                          {cat.icon && cat.icon_type !== 'image' && <span className="mr-1">{cat.icon}</span>}
                          {cat.name}
                          <button type="button" onClick={() => toggleCategory(catId)} className="ml-2 hover:text-premium-gold"><X className="h-3 w-3" /></button>
                        </span>
                      ) : null;
                    })}
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Target Audience</label>
                <select value={formData.gender} onChange={e => setFormData({ ...formData, gender: e.target.value as GenderType })} className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none">
                  {genders.length > 0 ? genders.map(g => <option key={g.name} value={g.name}>{g.display_name}</option>) : (
                    <>
                      <option value="unisex">Unisex</option>
                      <option value="men">Men</option>
                      <option value="women">Women</option>
                    </>
                  )}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">SKU *</label>
                <input type="text" value={formData.sku} onChange={e => setFormData({ ...formData, sku: e.target.value })} required className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none" placeholder="SKU-12345678" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Price (₹) *</label>
                <input type="number" value={formData.price} onChange={e => setFormData({ ...formData, price: e.target.value })} required min="0" step="0.01" className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Original Price (₹)</label>
                <input type="number" value={formData.original_price} onChange={e => setFormData({ ...formData, original_price: e.target.value })} min="0" step="0.01" className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Discount %</label>
                <input type="number" value={formData.discount_percentage} onChange={e => setFormData({ ...formData, discount_percentage: e.target.value })} min="0" max="100" className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none bg-gray-50" placeholder="Auto-calculated" />
              </div>
              <div className="md:col-span-2">
                <label className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg cursor-pointer">
                  <input type="checkbox" checked={formData.track_stock} onChange={e => setFormData({ ...formData, track_stock: e.target.checked })} className="h-4 w-4 rounded" />
                  <span>
                    <span className="font-medium">Track stock for this product</span>
                    <span className="block text-xs text-gray-500">On: orders reduce the stock and are refused when it runs out. Off: made to order, unlimited.</span>
                  </span>
                </label>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Stock Quantity *</label>
                <input type="number" value={formData.stock_quantity} onChange={e => setFormData({ ...formData, stock_quantity: e.target.value })} required min="0" className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none" />
              </div>
            </div>

            {(parseFloat(formData.original_price) > 0 && parseFloat(formData.price) > 0) && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <h4 className="font-medium text-green-800 mb-2">Price Summary</h4>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div><span className="text-green-600">Original:</span><span className="ml-2 font-semibold">₹{parseFloat(formData.original_price).toLocaleString()}</span></div>
                  <div><span className="text-green-600">Selling:</span><span className="ml-2 font-semibold">₹{parseFloat(formData.price).toLocaleString()}</span></div>
                  <div><span className="text-green-600">You Save:</span><span className="ml-2 font-semibold text-premium-burgundy">₹{parseFloat(savings).toLocaleString()} ({formData.discount_percentage || 0}%)</span></div>
                </div>
              </div>
            )}

            {/* Social Proof */}
            <div className="border-t pt-4 mt-4">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2"><Users className="h-5 w-5 text-premium-gold" />Marketing & Social Proof</h3>
              <div className="flex items-center gap-3 mb-4">
                <input type="checkbox" id="social_proof_enabled" checked={formData.social_proof_enabled} onChange={e => setFormData({ ...formData, social_proof_enabled: e.target.checked })} className="rounded text-premium-gold" />
                <label htmlFor="social_proof_enabled" className="font-medium">Enable Social Proof</label>
              </div>
              {formData.social_proof_enabled && (
                <div className="grid md:grid-cols-3 gap-4">
                  <div className="md:col-span-3">
                    <label className="block text-sm font-medium mb-2">Social Proof Text</label>
                    <input type="text" value={formData.social_proof_text} onChange={e => setFormData({ ...formData, social_proof_text: e.target.value })} className="w-full px-4 py-3 border rounded-lg" placeholder="🔺{count} People are viewing this right now" />
                    <p className="text-xs text-gray-500 mt-1">Use {'{count}'} as placeholder</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">Initial Count</label>
                    <input type="number" value={formData.social_proof_initial_count} onChange={e => setFormData({ ...formData, social_proof_initial_count: e.target.value })} min="1" className="w-full px-4 py-3 border rounded-lg" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">End Count</label>
                    <input type="number" value={formData.social_proof_end_count} onChange={e => setFormData({ ...formData, social_proof_end_count: e.target.value })} min="1" className="w-full px-4 py-3 border rounded-lg" />
                  </div>
                </div>
              )}
            </div>

            {/* Customization */}
            <div className="border-t pt-4 mt-4">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2"><ImageIcon className="h-5 w-5 text-premium-gold" />Customization Options</h3>
              <div className="flex items-center gap-3 mb-4">
                <input type="checkbox" id="is_customizable" checked={formData.is_customizable} onChange={e => setFormData({ ...formData, is_customizable: e.target.checked })} className="rounded text-premium-gold" />
                <label htmlFor="is_customizable" className="font-medium">This product can be customized</label>
              </div>
              {formData.is_customizable && (
                <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">Customization Price (₹)</label>
                    <input type="number" value={formData.customization_price} onChange={e => setFormData({ ...formData, customization_price: e.target.value })} min="0" step="0.01" className="w-full px-4 py-3 border rounded-lg" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">Max Lines</label>
                    <input type="number" value={formData.max_customization_lines} onChange={e => setFormData({ ...formData, max_customization_lines: e.target.value })} min="0" className="w-full px-4 py-3 border rounded-lg" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">Max Characters/Line</label>
                    <input type="number" value={formData.max_customization_characters} onChange={e => setFormData({ ...formData, max_customization_characters: e.target.value })} min="1" className="w-full px-4 py-3 border rounded-lg" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">Max Images</label>
                    <input type="number" value={formData.max_customization_images} onChange={e => setFormData({ ...formData, max_customization_images: e.target.value })} min="0" className="w-full px-4 py-3 border rounded-lg" />
                  </div>
                </div>
              )}
            </div>

            {/* Active status */}
            <div className="flex items-center space-x-3">
              <input type="checkbox" id="is_active" checked={formData.is_active} onChange={e => setFormData({ ...formData, is_active: e.target.checked })} className="h-4 w-4 text-premium-gold rounded" />
              <label htmlFor="is_active" className="text-sm font-medium">Product is active and visible to customers</label>
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium mb-2">Description *</label>
              <textarea value={formData.description} onChange={e => setFormData({ ...formData, description: e.target.value })} required rows={4} className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none" />
            </div>

            <div className="flex justify-end space-x-3 pt-4 border-t">
              <button type="button" onClick={onClose} className="px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={loading || uploadingImage} className="px-6 py-3 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy disabled:opacity-50 disabled:cursor-not-allowed flex items-center">
                {loading ? <><div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2" />Saving...</> : <><Save className="h-5 w-5 mr-2" />Save Changes</>}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default EditProduct;
