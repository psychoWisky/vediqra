import React, { useState, useEffect } from 'react';
import { getImageUrl } from '../../utils/helpers';
import { X, Save, Camera, Users, ImageIcon, FileText, ChevronDown, Plus, Trash2, GripVertical, ChevronUp, Palette, Ruler } from 'lucide-react';
import { Category, Gender, ProductColor, ProductSize } from '../../types';
import { apiFetch, uploadFetch } from '../../utils/api';
import MultiImageUpload from './MultiImageUpload';
import ProductOptionsEditor from './ProductOptionsEditor';
import toast from 'react-hot-toast';

interface ProductUploadProps {
  onClose: () => void;
  onSuccess: () => void;
}

const ProductUpload: React.FC<ProductUploadProps> = ({ onClose, onSuccess }) => {
  const [loading, setLoading] = useState(false);
  // Set once the product exists: step 2 lets the admin set the slug and options straight away
  const [createdProduct, setCreatedProduct] = useState<{ id: string; name: string; slug: string } | null>(null);
  const [slugDraft, setSlugDraft] = useState('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [genders, setGenders] = useState<Gender[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  
  // Variant toggles
  const [hasColors, setHasColors] = useState(false);
  const [hasSizes, setHasSizes] = useState(false);
  
  // Variant data
  const [colors, setColors] = useState<ProductColor[]>([]);
  const [sizes, setSizes] = useState<ProductSize[]>([]);
  
  // Product images
  const [productImages, setProductImages] = useState<{ url: string; is_primary: boolean }[]>([]);
  
  const [formData, setFormData] = useState({
    name: '',
    slug: '',
    track_stock: false,
    description: '',
    gender: 'unisex',
    price: '',
    original_price: '',
    discount_percentage: '',
    sku: `SKU-${Date.now().toString().slice(-8)}`,
    stock_quantity: '10',
    is_customizable: false,
    customization_price: '0',
    max_customization_characters: '50',
    max_customization_images: '10',
    max_customization_lines: '0',
    social_proof_enabled: false,   // off by default: the counters are simulated, not real data
    social_proof_text: '🔺{count} People are Purchasing Right Now',
    social_proof_initial_count: '5',
    social_proof_end_count: '15',
    is_active: true,
  });

  useEffect(() => {
    fetchCategories();
    fetchGenders();
  }, []);

  // Auto-calculate discount
  useEffect(() => {
    const price = parseFloat(formData.price) || 0;
    const originalPrice = parseFloat(formData.original_price) || 0;
    const discountPercent = parseFloat(formData.discount_percentage) || 0;

    if (originalPrice > 0 && price > 0 && originalPrice > price) {
      const calculatedDiscount = Math.round(((originalPrice - price) / originalPrice) * 100);
      if (calculatedDiscount !== discountPercent) {
        setFormData(prev => ({ ...prev, discount_percentage: calculatedDiscount.toString() }));
      }
    } 
    else if (originalPrice > 0 && discountPercent > 0 && discountPercent <= 100) {
      const calculatedPrice = originalPrice - (originalPrice * discountPercent / 100);
      if (Math.abs(calculatedPrice - price) > 0.01) {
        setFormData(prev => ({ ...prev, price: calculatedPrice.toFixed(2) }));
      }
    }
  }, [formData.price, formData.original_price, formData.discount_percentage]);

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
    setSelectedCategories(prev => {
      if (prev.includes(categoryId)) {
        return prev.filter(id => id !== categoryId);
      } else {
        return [...prev, categoryId];
      }
    });
  };

  // Color variant handlers
  const addColor = () => {
    const newColor: ProductColor = {
      id: `temp-${Date.now()}`,
      product_id: '',
      color_name: '',
      color_code: '#000000',
      image_url: '',
      additional_images: [],
      stock_quantity: 10,
      price_modifier: 0,
      is_active: true,
      display_order: colors.length,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    setColors([...colors, newColor]);
  };

  const updateColor = (index: number, field: keyof ProductColor, value: any) => {
    const updated = [...colors];
    updated[index] = { ...updated[index], [field]: value };
    setColors(updated);
  };

  const removeColor = (index: number) => {
    setColors(colors.filter((_, i) => i !== index));
  };

  const moveColor = (index: number, direction: 'up' | 'down') => {
    if (
      (direction === 'up' && index === 0) || 
      (direction === 'down' && index === colors.length - 1)
    ) return;

    const newIndex = direction === 'up' ? index - 1 : index + 1;
    const updated = [...colors];
    [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
    
    updated.forEach((color, i) => {
      color.display_order = i;
    });
    
    setColors(updated);
  };

  const uploadColorImage = async (index: number, file: File) => {
    setUploadingImage(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const data = await uploadFetch('/api/upload/upload-image', fd);
      updateColor(index, 'image_url', data.image_url);
      toast.success('Image uploaded');
    } catch (error) {
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
      const updated = [...colors];
      updated[colorIndex] = {
        ...updated[colorIndex],
        additional_images: [...(updated[colorIndex].additional_images || []), data.image_url],
      };
      setColors(updated);
      toast.success('Additional image uploaded');
    } catch (error) {
      toast.error('Failed to upload additional image');
    } finally {
      setUploadingImage(false);
    }
  };

  const removeColorAdditionalImage = (colorIndex: number, imgIndex: number) => {
    const updated = [...colors];
    updated[colorIndex] = {
      ...updated[colorIndex],
      additional_images: (updated[colorIndex].additional_images || []).filter((_, i) => i !== imgIndex),
    };
    setColors(updated);
  };

  // Size variant handlers
  const addSize = () => {
    const newSize: ProductSize = {
      id: `temp-${Date.now()}`,
      product_id: '',
      size_name: '',
      size_code: '',
      stock_quantity: 10,
      price_modifier: 0,
      is_active: true,
      display_order: sizes.length,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    setSizes([...sizes, newSize]);
  };

  const updateSize = (index: number, field: keyof ProductSize, value: any) => {
    const updated = [...sizes];
    updated[index] = { ...updated[index], [field]: value };
    setSizes(updated);
  };

  const removeSize = (index: number) => {
    setSizes(sizes.filter((_, i) => i !== index));
  };

  const moveSize = (index: number, direction: 'up' | 'down') => {
    if (
      (direction === 'up' && index === 0) || 
      (direction === 'down' && index === sizes.length - 1)
    ) return;

    const newIndex = direction === 'up' ? index - 1 : index + 1;
    const updated = [...sizes];
    [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
    
    updated.forEach((size, i) => {
      size.display_order = i;
    });
    
    setSizes(updated);
  };

  const validateForm = () => {
    if (!formData.name.trim()) {
      toast.error('Product name is required');
      return false;
    }
    if (!formData.price || parseFloat(formData.price) <= 0) {
      toast.error('Valid price is required');
      return false;
    }
    if (selectedCategories.length === 0) {
      toast.error('Please select at least one category');
      return false;
    }
    
    if (!hasColors && !hasSizes && formData.is_active) {
      // A product that customers can see needs a main image. A hidden (inactive) draft may be saved without
      // one and completed later - untick "active" to save a draft.
      const primaryImage = productImages.find(img => img.is_primary);
      if (!primaryImage && productImages.length === 0) {
        toast.error('Main product image is required for an active product (untick "active" to save a draft)');
        return false;
      }
    }
    
    if (hasColors) {
      if (colors.length === 0) {
        toast.error('Please add at least one color variant');
        return false;
      }
      
      for (let i = 0; i < colors.length; i++) {
        const color = colors[i];
        if (!color.color_name.trim()) {
          toast.error(`Color name is required for variant ${i + 1}`);
          return false;
        }
        if (!color.image_url) {
          toast.error(`Image is required for color ${color.color_name || i + 1}`);
          return false;
        }
      }
    }
    
    if (hasSizes && sizes.length === 0) {
      toast.error('Please add at least one size variant');
      return false;
    }
    
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) return;
    
    setLoading(true);
    
    try {
      // Get primary image
      const primaryImage = productImages.find(img => img.is_primary) || productImages[0];
      
      const productData: any = {
        name: formData.name.trim(),
        slug: formData.slug.trim() || undefined,
        track_stock: formData.track_stock,
        description: formData.description.trim(),
        gender: formData.gender,
        price: parseFloat(formData.price),
        stock_quantity: parseInt(formData.stock_quantity),
        sku: formData.sku,
        image_url: primaryImage?.url || '',
        has_colors: hasColors,
        has_sizes: hasSizes,
        social_proof_enabled: formData.social_proof_enabled,
        social_proof_text: formData.social_proof_text,
        social_proof_initial_count: parseInt(formData.social_proof_initial_count),
        social_proof_end_count: parseInt(formData.social_proof_end_count),
        is_active: formData.is_active,
        is_customizable: formData.is_customizable,
      };

      if (formData.original_price) productData.original_price = parseFloat(formData.original_price);
      if (formData.discount_percentage) productData.discount_percentage = parseInt(formData.discount_percentage);
      if (formData.is_customizable) {
        productData.customization_price = parseFloat(formData.customization_price) || 0;
        productData.max_customization_characters = parseInt(formData.max_customization_characters) || 50;
        productData.max_customization_images = parseInt(formData.max_customization_images) || 10;
        productData.max_customization_lines = parseInt(formData.max_customization_lines) || 0;
      }
      
      const additionalImageUrls = productImages.filter(img => !img.is_primary).map(img => img.url);
      if (additionalImageUrls.length > 0) productData.additional_images = additionalImageUrls;
      
      // Create product
      const { product } = await apiFetch('/api/admin/products', {
        method: 'POST',
        body: JSON.stringify(productData),
      });
      
      // Add categories
      if (selectedCategories.length > 0) {
        await apiFetch(`/api/admin/products/${product.id}/categories`, {
          method: 'POST',
          body: JSON.stringify({ categories: selectedCategories.map(id => ({ category_id: id })) }),
        });
      }
      
      // Add color variants
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
      
      // Add size variants
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
      
      toast.success('Product created! Add its options below, then click Done.');
      setSlugDraft(product.slug || '');
      setCreatedProduct({ id: product.id, name: product.name, slug: product.slug });
      
    } catch (error: any) {
      console.error('Create product error:', error);
      toast.error(error.message || 'Failed to create product');
    } finally {
      setLoading(false);
    }
  };

  const savings = parseFloat(formData.original_price) && parseFloat(formData.price) 
    ? (parseFloat(formData.original_price) - parseFloat(formData.price)).toFixed(2)
    : '0';

  // Step 2: the product exists. Slug and options are saved immediately through the option/product APIs
  // (ProductOptionsEditor is the same component used when editing an existing product).
  if (createdProduct) {
    const saveSlug = async () => {
      try {
        const res = await apiFetch(`/api/admin/products/${createdProduct.id}`, {
          method: 'PUT',
          body: JSON.stringify({ slug: slugDraft.trim() }),
        });
        setCreatedProduct({ ...createdProduct, slug: res.product?.slug || slugDraft });
        toast.success('Slug saved');
      } catch (e: any) {
        toast.error(e.message || 'Could not save slug');
      }
    };

    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
          <div className="p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-serif font-semibold">Product created</h2>
                <p className="text-sm text-gray-600 mt-1">{createdProduct.name} - set its link and options now, or later from Edit Product.</p>
              </div>
              <button onClick={onSuccess} className="p-2 hover:bg-gray-100 rounded-lg" title="Done"><X className="h-5 w-5" /></button>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">URL Slug</label>
              <div className="flex gap-2">
                <input type="text" value={slugDraft} onChange={e => setSlugDraft(e.target.value)} className="flex-1 px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none" />
                <button type="button" onClick={saveSlug} disabled={!slugDraft.trim() || slugDraft.trim() === createdProduct.slug} className="px-4 py-3 border rounded-lg disabled:opacity-50">Save slug</button>
              </div>
              <p className="text-xs text-gray-500 mt-1">Categories were saved with the product; change them any time in Edit Product.</p>
            </div>

            <ProductOptionsEditor productId={createdProduct.id} />

            <div className="flex justify-end pt-4 border-t">
              <button type="button" onClick={onSuccess} className="px-6 py-3 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy">Done</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-6xl max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-serif font-semibold">Add New Product</h2>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
              <X className="h-5 w-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Variant Toggles */}
            <div className="grid grid-cols-2 gap-4 bg-gray-50 p-4 rounded-lg">
              <label className="flex items-center space-x-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hasColors}
                  onChange={(e) => setHasColors(e.target.checked)}
                  className="h-5 w-5 text-premium-gold rounded"
                />
                <div>
                  <span className="font-medium flex items-center gap-1">
                    <Palette className="h-4 w-4" />
                    Has Color Variants
                  </span>
                  <p className="text-xs text-gray-500">Different colors with separate images</p>
                </div>
              </label>

              <label className="flex items-center space-x-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hasSizes}
                  onChange={(e) => setHasSizes(e.target.checked)}
                  className="h-5 w-5 text-premium-gold rounded"
                />
                <div>
                  <span className="font-medium flex items-center gap-1">
                    <Ruler className="h-4 w-4" />
                    Has Size Variants
                  </span>
                  <p className="text-xs text-gray-500">Different sizes (S, M, L, XL, etc.)</p>
                </div>
              </label>
            </div>

            {/* Regular Product Images (when no color variants) */}
            {!hasColors && (
              <div>
                <label className="block text-sm font-medium mb-3">Product Images (Max 5)</label>
                <MultiImageUpload
                  onImagesUploaded={handleImagesUploaded}
                  maxImages={5}
                  initialImages={productImages}
                />
              </div>
            )}

            {/* Color Variants Section */}
            {hasColors && (
              <div className="border rounded-lg p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-medium flex items-center gap-2">
                    <Palette className="h-5 w-5" />
                    Color Variants
                  </h3>
                  <button
                    type="button"
                    onClick={addColor}
                    className="px-3 py-1.5 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy flex items-center gap-1 text-sm"
                  >
                    <Plus className="h-4 w-4" />
                    Add Color
                  </button>
                </div>

                <div className="space-y-4 max-h-96 overflow-y-auto">
                  {colors.map((color, index) => (
                    <div key={color.id} className="border rounded-lg p-4 bg-gray-50">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <GripVertical className="h-5 w-5 text-gray-400 cursor-move" />
                          <span className="font-medium">Color Variant {index + 1}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => moveColor(index, 'up')}
                            disabled={index === 0}
                            className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"
                          >
                            <ChevronUp className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveColor(index, 'down')}
                            disabled={index === colors.length - 1}
                            className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeColor(index)}
                            className="p-1 hover:bg-red-100 text-red-500 rounded"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                          <label className="block text-xs font-medium mb-1">Color Name *</label>
                          <input
                            type="text"
                            value={color.color_name}
                            onChange={(e) => updateColor(index, 'color_name', e.target.value)}
                            placeholder="e.g., Red, Blue, Gold"
                            className="w-full px-3 py-2 text-sm border rounded-lg"
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Color Code</label>
                          <div className="flex items-center gap-2">
                            <input
                              type="color"
                              value={color.color_code}
                              onChange={(e) => updateColor(index, 'color_code', e.target.value)}
                              className="w-10 h-9 border rounded"
                            />
                            <input
                              type="text"
                              value={color.color_code}
                              onChange={(e) => updateColor(index, 'color_code', e.target.value)}
                              placeholder="#000000"
                              className="flex-1 px-3 py-2 text-sm border rounded-lg"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Stock</label>
                          <input
                            type="number"
                            value={color.stock_quantity}
                            onChange={(e) => updateColor(index, 'stock_quantity', parseInt(e.target.value))}
                            min="0"
                            className="w-full px-3 py-2 text-sm border rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Price Modifier (₹)</label>
                          <input
                            type="number"
                            value={color.price_modifier}
                            onChange={(e) => updateColor(index, 'price_modifier', parseFloat(e.target.value))}
                            className="w-full px-3 py-2 text-sm border rounded-lg"
                          />
                          <p className="text-xs text-gray-500">+/- from base price</p>
                        </div>
                      </div>

                      <div className="mt-3">
                        <label className="block text-xs font-medium mb-1">Color Image *</label>
                        <div className="flex items-center gap-4">
                          {color.image_url ? (
                            <div className="relative w-20 h-20">
                              <img
                                src={getImageUrl(color.image_url)}
                                alt={color.color_name}
                                className="w-full h-full object-cover rounded-lg border"
                              />
                              <button
                                type="button"
                                onClick={() => updateColor(index, 'image_url', '')}
                                className="absolute -top-2 -right-2 p-1 bg-red-500 text-white rounded-full"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          ) : (
                            <label className="border-2 border-dashed border-gray-300 rounded-lg px-4 py-3 cursor-pointer hover:border-premium-gold">
                              <input
                                type="file"
                                accept="image/*"
                                onChange={async (e) => {
                                  const file = e.target.files?.[0];
                                  if (file) await uploadColorImage(index, file);
                                }}
                                className="hidden"
                              />
                              <span className="text-sm text-gray-600">Upload Image</span>
                            </label>
                          )}
                        </div>
                      </div>

                      {/* Additional images per color */}
                      <div className="mt-3">
                        <label className="block text-xs font-medium mb-1">Additional Images (optional)</label>
                        <div className="flex items-center gap-2 flex-wrap">
                          {(color.additional_images || []).map((imgUrl, imgIdx) => (
                            <div key={imgIdx} className="relative w-16 h-16">
                              <img src={imgUrl} alt={`extra-${imgIdx}`} className="w-full h-full object-cover rounded-lg border" />
                              <button
                                type="button"
                                onClick={() => removeColorAdditionalImage(index, imgIdx)}
                                className="absolute -top-1.5 -right-1.5 p-0.5 bg-red-500 text-white rounded-full"
                              >
                                <X className="h-2.5 w-2.5" />
                              </button>
                            </div>
                          ))}
                          {(color.additional_images || []).length < 5 && (
                            <label className="border-2 border-dashed border-gray-300 rounded-lg w-16 h-16 flex items-center justify-center cursor-pointer hover:border-premium-gold">
                              <input
                                type="file"
                                accept="image/*"
                                onChange={async (e) => {
                                  const file = e.target.files?.[0];
                                  if (file) await uploadColorAdditionalImage(index, file);
                                }}
                                className="hidden"
                              />
                              <Plus className="h-6 w-6 text-gray-400" />
                            </label>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 mt-1">Up to 5 extra images per colour</p>
                      </div>

                      <div className="mt-2 flex items-center gap-2">
                        <input
                          type="checkbox"
                          id={`color-active-${index}`}
                          checked={color.is_active}
                          onChange={(e) => updateColor(index, 'is_active', e.target.checked)}
                          className="rounded text-premium-gold"
                        />
                        <label htmlFor={`color-active-${index}`} className="text-sm">Active</label>
                      </div>
                    </div>
                  ))}

                  {colors.length === 0 && (
                    <div className="text-center py-8 border-2 border-dashed border-gray-300 rounded-lg">
                      <Palette className="h-12 w-12 text-gray-300 mx-auto mb-2" />
                      <p className="text-gray-500">No color variants added yet</p>
                      <button
                        type="button"
                        onClick={addColor}
                        className="mt-2 text-premium-gold hover:underline"
                      >
                        Add your first color
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Size Variants Section */}
            {hasSizes && (
              <div className="border rounded-lg p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-medium flex items-center gap-2">
                    <Ruler className="h-5 w-5" />
                    Size Variants
                  </h3>
                  <button
                    type="button"
                    onClick={addSize}
                    className="px-3 py-1.5 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy flex items-center gap-1 text-sm"
                  >
                    <Plus className="h-4 w-4" />
                    Add Size
                  </button>
                </div>

                <div className="space-y-4 max-h-96 overflow-y-auto">
                  {sizes.map((size, index) => (
                    <div key={size.id} className="border rounded-lg p-4 bg-gray-50">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <GripVertical className="h-5 w-5 text-gray-400 cursor-move" />
                          <span className="font-medium">Size Variant {index + 1}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => moveSize(index, 'up')}
                            disabled={index === 0}
                            className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"
                          >
                            <ChevronUp className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveSize(index, 'down')}
                            disabled={index === sizes.length - 1}
                            className="p-1 hover:bg-gray-200 rounded disabled:opacity-30"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeSize(index)}
                            className="p-1 hover:bg-red-100 text-red-500 rounded"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                          <label className="block text-xs font-medium mb-1">Size Name *</label>
                          <input
                            type="text"
                            value={size.size_name}
                            onChange={(e) => updateSize(index, 'size_name', e.target.value)}
                            placeholder="e.g., Small, Medium, Large"
                            className="w-full px-3 py-2 text-sm border rounded-lg"
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Size Code</label>
                          <input
                            type="text"
                            value={size.size_code || ''}
                            onChange={(e) => updateSize(index, 'size_code', e.target.value)}
                            placeholder="e.g., S, M, L, XL"
                            className="w-full px-3 py-2 text-sm border rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Stock</label>
                          <input
                            type="number"
                            value={size.stock_quantity}
                            onChange={(e) => updateSize(index, 'stock_quantity', parseInt(e.target.value))}
                            min="0"
                            className="w-full px-3 py-2 text-sm border rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">Price Modifier (₹)</label>
                          <input
                            type="number"
                            value={size.price_modifier}
                            onChange={(e) => updateSize(index, 'price_modifier', parseFloat(e.target.value))}
                            className="w-full px-3 py-2 text-sm border rounded-lg"
                          />
                          <p className="text-xs text-gray-500">+/- from base price</p>
                        </div>
                      </div>

                      <div className="mt-2 flex items-center gap-2">
                        <input
                          type="checkbox"
                          id={`size-active-${index}`}
                          checked={size.is_active}
                          onChange={(e) => updateSize(index, 'is_active', e.target.checked)}
                          className="rounded text-premium-gold"
                        />
                        <label htmlFor={`size-active-${index}`} className="text-sm">Active</label>
                      </div>
                    </div>
                  ))}

                  {sizes.length === 0 && (
                    <div className="text-center py-8 border-2 border-dashed border-gray-300 rounded-lg">
                      <Ruler className="h-12 w-12 text-gray-300 mx-auto mb-2" />
                      <p className="text-gray-500">No size variants added yet</p>
                      <button
                        type="button"
                        onClick={addSize}
                        className="mt-2 text-premium-gold hover:underline"
                      >
                        Add your first size
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Basic Info Section */}
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">URL Slug</label>
                <input
                  type="text"
                  value={formData.slug}
                  onChange={(e) => setFormData({...formData, slug: e.target.value})}
                  className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none"
                  placeholder="auto-generated from the name, e.g. magic-mug"
                />
                <p className="text-xs text-gray-500 mt-1">Used in the product link. Must be unique.</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Product Name *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({...formData, name: e.target.value})}
                  required
                  className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none"
                  placeholder="Enter product name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Categories *</label>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowCategoryDropdown(!showCategoryDropdown)}
                    className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none text-left flex items-center justify-between bg-white"
                  >
                    <span className="truncate">
                      {selectedCategories.length === 0 
                        ? 'Select categories' 
                        : `${selectedCategories.length} category${selectedCategories.length > 1 ? 's' : ''} selected`}
                    </span>
                    <ChevronDown className={`h-5 w-5 transition-transform ${showCategoryDropdown ? 'rotate-180' : ''}`} />
                  </button>
                  
                  {showCategoryDropdown && (
                    <div className="absolute z-10 mt-1 w-full bg-white border rounded-lg shadow-lg max-h-60 overflow-y-auto">
                      {categories.map(category => (
                        <label
                          key={category.id}
                          className="flex items-center px-4 py-2 hover:bg-gray-50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={selectedCategories.includes(category.id)}
                            onChange={() => toggleCategory(category.id)}
                            className="h-4 w-4 text-premium-gold rounded border-gray-300 focus:ring-premium-gold"
                          />
                          <span className="ml-3 flex-1">{category.name}</span>
                          {category.icon && (
                            <span className="text-xl">{category.icon}</span>
                          )}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                {selectedCategories.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    {selectedCategories.map(catId => {
                      const category = categories.find(c => c.id === catId);
                      return category ? (
                        <span
                          key={catId}
                          className="inline-flex items-center px-3 py-1 bg-premium-cream text-premium-burgundy rounded-full text-sm"
                        >
                          {category.icon && <span className="mr-1">{category.icon}</span>}
                          {category.name}
                          <button
                            type="button"
                            onClick={() => toggleCategory(catId)}
                            className="ml-2 hover:text-premium-gold"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ) : null;
                    })}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Target Audience</label>
                <select
                  value={formData.gender}
                  onChange={(e) => setFormData({...formData, gender: e.target.value as 'men' | 'women' | 'unisex'})}
                  className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none"
                >
                  {genders.map(gender => (
                    <option key={gender.name} value={gender.name}>
                      {gender.icon} {gender.display_name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">SKU *</label>
                <input
                  type="text"
                  value={formData.sku}
                  onChange={(e) => setFormData({...formData, sku: e.target.value})}
                  required
                  className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none"
                  placeholder="SKU-12345678"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Base Price (₹) *</label>
                <input
                  type="number"
                  value={formData.price}
                  onChange={(e) => setFormData({...formData, price: e.target.value})}
                  required
                  min="0"
                  step="0.01"
                  className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none"
                  placeholder="0.00"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Original Price (₹)</label>
                <input
                  type="number"
                  value={formData.original_price}
                  onChange={(e) => setFormData({...formData, original_price: e.target.value})}
                  min="0"
                  step="0.01"
                  className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none"
                  placeholder="0.00"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Discount %</label>
                <input
                  type="number"
                  value={formData.discount_percentage}
                  onChange={(e) => setFormData({...formData, discount_percentage: e.target.value})}
                  min="0"
                  max="100"
                  className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none bg-gray-50"
                  placeholder="Auto-calculated"
                  readOnly
                />
              </div>

              <div className="md:col-span-2">
                <label className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg cursor-pointer">
                  <input type="checkbox" checked={formData.track_stock} onChange={(e) => setFormData({...formData, track_stock: e.target.checked})} className="h-4 w-4 rounded" />
                  <span>
                    <span className="font-medium">Track stock for this product</span>
                    <span className="block text-xs text-gray-500">On: orders reduce the stock below and are refused when it runs out. Off: made to order, unlimited.</span>
                  </span>
                </label>
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Base Stock *</label>
                <input
                  type="number"
                  value={formData.stock_quantity}
                  onChange={(e) => setFormData({...formData, stock_quantity: e.target.value})}
                  required
                  min="0"
                  className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none"
                />
              </div>
            </div>

            {/* Price Summary */}
            {(parseFloat(formData.original_price) > 0 && parseFloat(formData.price) > 0) && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <h4 className="font-medium text-green-800 mb-2">Price Summary</h4>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <span className="text-green-600">Original:</span>
                    <span className="ml-2 font-semibold">₹{parseFloat(formData.original_price).toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-green-600">Selling:</span>
                    <span className="ml-2 font-semibold">₹{parseFloat(formData.price).toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-green-600">You Save:</span>
                    <span className="ml-2 font-semibold text-premium-burgundy">
                      ₹{parseFloat(savings).toLocaleString()} ({formData.discount_percentage || 0}%)
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Marketing & Social Proof */}
            <div className="border-t pt-4">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Users className="h-5 w-5 text-premium-gold" />
                Marketing & Social Proof
              </h3>
              
              <div className="flex items-center gap-3 mb-4">
                <input
                  type="checkbox"
                  id="social_proof_enabled"
                  checked={formData.social_proof_enabled}
                  onChange={(e) => setFormData({...formData, social_proof_enabled: e.target.checked})}
                  className="rounded text-premium-gold"
                />
                <label htmlFor="social_proof_enabled" className="font-medium">
                  Enable Social Proof (shows live purchase count)
                </label>
              </div>

              {formData.social_proof_enabled && (
                <div className="grid md:grid-cols-3 gap-4">
                  <div className="md:col-span-3">
                    <label className="block text-sm font-medium mb-2">Social Proof Text</label>
                    <input
                      type="text"
                      value={formData.social_proof_text}
                      onChange={(e) => setFormData({...formData, social_proof_text: e.target.value})}
                      className="w-full px-4 py-3 border rounded-lg"
                      placeholder="🔺{count} People are viewing this right now"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Use {'{count}'} as placeholder for the dynamic number
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">Initial Count</label>
                    <input
                      type="number"
                      value={formData.social_proof_initial_count}
                      onChange={(e) => setFormData({...formData, social_proof_initial_count: e.target.value})}
                      min="1"
                      className="w-full px-4 py-3 border rounded-lg"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">End Count</label>
                    <input
                      type="number"
                      value={formData.social_proof_end_count}
                      onChange={(e) => setFormData({...formData, social_proof_end_count: e.target.value})}
                      min="1"
                      className="w-full px-4 py-3 border rounded-lg"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Customization Options */}
            <div className="border-t pt-4">
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <ImageIcon className="h-5 w-5 text-premium-gold" />
                Customization Options
              </h3>
              
              <div className="flex items-center gap-3 mb-4">
                <input
                  type="checkbox"
                  id="is_customizable"
                  checked={formData.is_customizable}
                  onChange={(e) => setFormData({...formData, is_customizable: e.target.checked})}
                  className="rounded text-premium-gold"
                />
                <label htmlFor="is_customizable" className="font-medium">
                  Allow customers to customize this product
                </label>
              </div>

              {formData.is_customizable && (
                <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">Customization Fee (₹)</label>
                    <input
                      type="number"
                      value={formData.customization_price}
                      onChange={(e) => setFormData({...formData, customization_price: e.target.value})}
                      min="0"
                      step="0.01"
                      className="w-full px-4 py-3 border rounded-lg"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">Max Text Lines</label>
                    <input
                      type="number"
                      value={formData.max_customization_lines}
                      onChange={(e) => setFormData({...formData, max_customization_lines: e.target.value})}
                      min="0"
                      className="w-full px-4 py-3 border rounded-lg"
                    />
                    <p className="text-xs text-gray-500">0 = No text allowed</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">Max Characters/Line</label>
                    <input
                      type="number"
                      value={formData.max_customization_characters}
                      onChange={(e) => setFormData({...formData, max_customization_characters: e.target.value})}
                      min="1"
                      className="w-full px-4 py-3 border rounded-lg"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">Max Images</label>
                    <input
                      type="number"
                      value={formData.max_customization_images}
                      onChange={(e) => setFormData({...formData, max_customization_images: e.target.value})}
                      min="0"
                      className="w-full px-4 py-3 border rounded-lg"
                    />
                    <p className="text-xs text-gray-500">0 = No images allowed</p>
                  </div>
                </div>
              )}
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium mb-2">Description *</label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({...formData, description: e.target.value})}
                required
                rows={4}
                className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none"
                placeholder="Describe your product in detail..."
              />
            </div>

            {/* Active Status */}
            <div className="flex items-center space-x-3">
              <input
                type="checkbox"
                id="is_active"
                checked={formData.is_active}
                onChange={(e) => setFormData({...formData, is_active: e.target.checked})}
                className="h-4 w-4 text-premium-gold rounded"
              />
              <label htmlFor="is_active" className="text-sm font-medium">
                Product is active and visible to customers
              </label>
            </div>

            {/* Submit Buttons */}
            <div className="flex justify-end space-x-3 pt-4 border-t">
              <button
                type="button"
                onClick={onClose}
                className="px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="px-6 py-3 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
              >
                {loading ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                    Creating...
                  </>
                ) : (
                  <>
                    <Save className="h-5 w-5 mr-2" />
                    Create Product
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default ProductUpload;