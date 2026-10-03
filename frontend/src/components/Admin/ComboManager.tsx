import React, { useState, useEffect } from 'react';
import { X, Plus, Minus, Search, Package, Trash2, Save, Upload, Camera, Filter, Tag, ChevronDown, Check } from 'lucide-react';
import { Product, Combo, Category } from '../../types';
import { formatCurrency, getImageUrl,getProductImage  } from '../../utils/helpers';
import { apiFetch, uploadFetch } from '../../utils/api';
import toast from 'react-hot-toast';

interface ComboManagerProps {
  combo?: Combo | null;
  onClose: () => void;
  onSuccess: () => void;
}

interface ComboProduct extends Product {
  quantity: number;
}

const ComboManager: React.FC<ComboManagerProps> = ({ combo, onClose, onSuccess }) => {
  const [loading, setLoading] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>('all');
  const [selectedGender, setSelectedGender] = useState<string>('all');
  const [genders, setGenders] = useState<{name: string, display_name: string}[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<ComboProduct[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [additionalImages, setAdditionalImages] = useState<string[]>([]);
  const [uploadingAdditional, setUploadingAdditional] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  
  const [comboData, setComboData] = useState({
    name: '',
    description: '',
    discount_percentage: '',
    discount_price: '',
    image_url: '',
    is_active: true,
  });

  useEffect(() => {
    fetchProducts();
    fetchCategories();
    fetchGenders();
    if (combo) {
      loadComboForEdit();
    }
  }, [combo]);

  const fetchProducts = async () => {
    try {
      const data = await apiFetch('/api/admin/products', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('admin_token')}` },
      });
      setProducts(data || []);
    } catch (error) {
      console.error('Error fetching products:', error);
    }
  };

  const fetchCategories = async () => {
    try {
      const data = await apiFetch('/api/admin/categories', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('admin_token')}` },
      });
      // Filter only active categories
      const activeCategories = (data || []).filter((cat: Category) => cat.is_active !== false);
      setCategories(activeCategories);
    } catch (error) {
      console.error('Error fetching categories:', error);
    }
  };

  const fetchGenders = async () => {
    try {
      const data = await apiFetch('/api/genders');
      setGenders(data || []);
    } catch (error) {
      console.error('Error fetching genders:', error);
      setGenders([
        { name: 'men', display_name: 'Men' },
        { name: 'women', display_name: 'Women' },
        { name: 'unisex', display_name: 'Unisex' }
      ]);
    }
  };

  const loadComboForEdit = () => {
    if (!combo) return;
    
    setComboData({
      name: combo.name || '',
      description: combo.description || '',
      discount_percentage: combo.discount_percentage?.toString() || '',
      discount_price: combo.discount_price?.toString() || '',
      image_url: combo.image_url || '',
      is_active: combo.is_active !== undefined ? combo.is_active : true,
    });

    // Load categories
    if (combo.categories && combo.categories.length > 0) {
      setSelectedCategories(combo.categories.map(c => c.id));
    } else if (combo.category) {
      // For backward compatibility, find category ID by name
      const category = categories.find(c => c.name === combo.category);
      if (category) {
        setSelectedCategories([category.id]);
      }
    }

    if (combo.image_url) {
      setImagePreview(combo.image_url);
    }
    setAdditionalImages(combo.additional_images || []);

    // Load selected products
    if (combo.combo_products && combo.combo_products.length > 0) {
      const productsWithQuantity = combo.combo_products.map((cp: any) => ({
        ...cp.product,
        quantity: cp.quantity || 1
      }));
      setSelectedProducts(productsWithQuantity);
    }
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        toast.error('Image size should be less than 5MB');
        return;
      }
      setImageFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const uploadImage = async (): Promise<string | null> => {
    if (!imageFile) return comboData.image_url || null;

    setUploadingImage(true);
    const formData = new FormData();
    formData.append('image', imageFile);

    try {
      const data = await uploadFetch('/api/admin/upload-image', formData);
      return data.image_url;
    } catch (error) {
      console.error('Upload error:', error);
      toast.error('Failed to upload image');
      return null;
    } finally {
      setUploadingImage(false);
    }
  };

  const addToCombo = (product: Product) => {
    setSelectedProducts(prev => {
      const existing = prev.find(p => p.id === product.id);
      if (existing) {
        return prev.map(p =>
          p.id === product.id ? { ...p, quantity: p.quantity + 1 } : p
        );
      }
      return [...prev, { ...product, quantity: 1 }];
    });
    toast.success(`Added ${product.name} to combo`);
  };

  const removeFromCombo = (productId: string) => {
    setSelectedProducts(prev => prev.filter(p => p.id !== productId));
  };

  const updateQuantity = (productId: string, quantity: number) => {
    if (quantity < 1) {
      removeFromCombo(productId);
      return;
    }
    setSelectedProducts(prev =>
      prev.map(p => (p.id === productId ? { ...p, quantity } : p))
    );
  };

  const calculateTotal = () => {
    return selectedProducts.reduce(
      (sum, product) => sum + product.price * product.quantity,
      0
    );
  };

  const calculateDiscountedPrice = () => {
    const total = calculateTotal();
    // If admin entered a manual price, use that
    if (comboData.discount_price && comboData.discount_price.toString().trim() !== '') {
      return parseFloat(comboData.discount_price);
    }
    return total;
  };

  // Auto-calculate discount percentage from manual price
  const calculateAutoDiscountPct = () => {
    const total = calculateTotal();
    if (!comboData.discount_price || total === 0) return null;
    const manualPrice = parseFloat(comboData.discount_price);
    if (isNaN(manualPrice) || manualPrice >= total) return null;
    return Math.round(((total - manualPrice) / total) * 100);
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

  // Filter products by multiple categories, gender, and search term
  const filteredProducts = products.filter(product => {
    // Handle category filter - if 'all' or if product has any of the selected filter categories
    const matchesCategory = selectedCategoryFilter === 'all' || 
      (product.categories && product.categories.some(c => c.id === selectedCategoryFilter)) ||
      product.category === selectedCategoryFilter; // For backward compatibility
    
    const matchesGender = selectedGender === 'all' || product.gender === selectedGender;
    const matchesSearch = 
      product.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      product.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (product.categories && product.categories.some(c => c.name.toLowerCase().includes(searchTerm.toLowerCase()))) ||
      product.category?.toLowerCase().includes(searchTerm.toLowerCase());
    
    return matchesCategory && matchesGender && matchesSearch;
  });

  // Use all fetched categories for filtering
  const filterCategories = categories;
const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  
  // Validation
  if (selectedProducts.length === 0) {
    toast.error('Please add at least one product to the combo');
    return;
  }

  if (selectedCategories.length === 0) {
    toast.error('Please select at least one category for this combo');
    return;
  }

  setLoading(true);
  
  try {
    // Upload image if selected
    let imageUrl = comboData.image_url;
    if (imageFile) {
      const uploadedUrl = await uploadImage();
      if (uploadedUrl) {
        imageUrl = uploadedUrl;
      } else {
        throw new Error('Failed to upload image');
      }
    }

    // MRP = sum of all selected products
    const totalFromProducts = selectedProducts.reduce(
      (sum, product) => sum + (product.price * product.quantity), 0
    );

    // Admin enters the final selling price; discount % is auto-calculated
    let discountPrice: number | null = null;
    let discountPct: number | null = null;
    if (comboData.discount_price && comboData.discount_price.toString().trim() !== '') {
      discountPrice = parseFloat(comboData.discount_price);
      if (totalFromProducts > 0 && discountPrice < totalFromProducts) {
        discountPct = Math.round(((totalFromProducts - discountPrice) / totalFromProducts) * 100);
      }
    }

    // Prepare combo payload
    const comboPayload = {
      name: comboData.name.trim(),
      description: comboData.description.trim(),
      discount_percentage: discountPct,
      discount_price: discountPrice,
      additional_images: additionalImages.length > 0 ? additionalImages : null,
      image_url: imageUrl || '',
      is_active: comboData.is_active
    };

    console.log('Saving combo:', comboPayload);
    console.log('Total from products:', totalFromProducts);

    let comboId: string;

    if (combo) {
      // UPDATE EXISTING COMBO
      const updateData = await apiFetch(`/api/admin/combos/${combo.id}`, {
        method: 'PUT',
        body: JSON.stringify(comboPayload),
      });
      comboId = combo.id;
      console.log('Combo updated successfully:', comboId);
      
    } else {
      // CREATE NEW COMBO
      const result = await apiFetch(`/api/admin/combos`, {
        method: 'POST',
        body: JSON.stringify(comboPayload),
      });
      comboId = result.combo?.id || result.id;
      console.log('Combo created successfully:', comboId);
    }

    // ========== ADD PRODUCTS TO COMBO ==========
    if (selectedProducts.length > 0) {
      await apiFetch(`/api/admin/combos/${comboId}/products`, { method: 'DELETE' });

      const productsPayload = {
        products: selectedProducts.map(p => ({ product_id: p.id, quantity: p.quantity }))
      };
      console.log('Adding products to combo:', productsPayload);

      const productsResult = await apiFetch(`/api/admin/combos/${comboId}/products`, {
        method: 'POST',
        body: JSON.stringify(productsPayload),
      });
      console.log('Products added successfully:', productsResult);
    }

    // ========== ADD CATEGORIES TO COMBO ==========
    if (selectedCategories.length > 0) {
      await apiFetch(`/api/admin/combos/${comboId}/categories`, { method: 'DELETE' });

      const categoriesPayload = {
        categories: selectedCategories.map(categoryId => ({ category_id: categoryId }))
      };
      console.log('Adding categories to combo:', categoriesPayload);

      const categoriesResult = await apiFetch(`/api/admin/combos/${comboId}/categories`, {
        method: 'POST',
        body: JSON.stringify(categoriesPayload),
      });
      console.log('Categories added successfully:', categoriesResult);
    }

    toast.success(combo ? 'Combo updated successfully!' : 'Combo created successfully!');
    onSuccess();
    onClose();

  } catch (error: any) {
    console.error('Save combo error:', error);
    toast.error(`Error: ${error.message}`);
  } finally {
    setLoading(false);
  }
};
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-6xl max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-serif font-semibold">
              {combo ? 'Edit Combo' : 'Create New Combo'}
            </h2>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
              <X className="h-5 w-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Image Upload Section */}
            <div>
              <label className="block text-sm font-medium mb-3">Combo Image</label>
              <div className="border-2 border-dashed border-gray-300 rounded-2xl p-6 text-center hover:border-premium-gold transition-colors">
                {imagePreview ? (
                  <div className="relative">
                    <img 
                      src={imagePreview} 
                      alt="Preview" 
                      className="mx-auto max-h-48 rounded-lg"
                    />
                    <div className="absolute bottom-2 right-2">
                      <label className="p-2 bg-white shadow-md rounded-full hover:bg-gray-50 cursor-pointer">
                        <Camera className="h-4 w-4" />
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handleImageChange}
                          className="hidden"
                        />
                      </label>
                    </div>
                  </div>
                ) : (
                  <div>
                    <Camera className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                    <p className="text-gray-600 mb-2">Click to upload combo image</p>
                    <p className="text-sm text-gray-500 mb-4">JPEG, PNG, WebP (Max 5MB)</p>
                    <label className="inline-flex items-center px-4 py-2 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy cursor-pointer">
                      <Upload className="h-4 w-4 mr-2" />
                      Choose Image
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleImageChange}
                        className="hidden"
                      />
                    </label>
                  </div>
                )}
                {uploadingImage && (
                  <div className="mt-2 text-sm text-blue-600">Uploading...</div>
                )}
              </div>
            </div>

            {/* Additional Images (up to 10) */}
            <div>
              <label className="block text-sm font-medium mb-2">
                Additional Photos ({additionalImages.length}/10)
              </label>
              <div className="flex flex-wrap gap-2">
                {additionalImages.map((url, idx) => (
                  <div key={idx} className="relative w-20 h-20">
                    <img src={url} alt={`img-${idx}`} className="w-20 h-20 object-cover rounded-lg border" />
                    <button
                      type="button"
                      onClick={() => setAdditionalImages(prev => prev.filter((_, i) => i !== idx))}
                      className="absolute -top-1.5 -right-1.5 p-0.5 bg-red-500 text-white rounded-full shadow"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                {additionalImages.length < 10 && (
                  <label className={`w-20 h-20 flex flex-col items-center justify-center border-2 border-dashed rounded-lg cursor-pointer transition-colors ${uploadingAdditional ? 'border-gray-200 bg-gray-50' : 'border-gray-300 hover:border-premium-gold'}`}>
                    {uploadingAdditional
                      ? <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-premium-gold" />
                      : <>
                          <Upload className="h-5 w-5 text-gray-400" />
                          <span className="text-xs text-gray-400 mt-1">Add photo</span>
                        </>
                    }
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      disabled={uploadingAdditional}
                      onChange={async (e) => {
                        const files = Array.from(e.target.files || []);
                        const remaining = 10 - additionalImages.length;
                        const toUpload = files.slice(0, remaining);
                        if (toUpload.length === 0) return;
                        setUploadingAdditional(true);
                        try {
                          const urls: string[] = [];
                          for (const file of toUpload) {
                            const fd = new FormData();
                            fd.append('image', file);
                            const data = await uploadFetch('/api/upload/upload-image', fd);
                            if (data.image_url) urls.push(data.image_url);
                          }
                          setAdditionalImages(prev => [...prev, ...urls].slice(0, 10));
                          toast.success(`${urls.length} photo(s) uploaded`);
                        } catch {
                          toast.error('Failed to upload photos');
                        } finally {
                          setUploadingAdditional(false);
                          e.target.value = '';
                        }
                      }}
                    />
                  </label>
                )}
              </div>
              <p className="text-xs text-gray-400 mt-1">Upload up to 10 additional photos for this combo</p>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Combo Information</h3>
                
                <div>
                  <label className="block text-sm font-medium mb-2">Combo Name *</label>
                  <input
                    type="text"
                    value={comboData.name}
                    onChange={(e) => setComboData({...comboData, name: e.target.value})}
                    required
                    className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none"
                    placeholder="Premium Anniversary Combo"
                  />
                </div>

                {/* Multiple Categories Selection */}
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
                            {category.icon && category.icon !== 'image' && category.icon_type !== 'image' && (
                              <span className="text-xl">{category.icon}</span>
                            )}
                            {(category.icon_type === 'image' || category.icon === 'image') && (category as any).image_url && (
                              <img src={(category as any).image_url} className="w-5 h-5 object-contain" alt="" />
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
                            {category.icon && category.icon !== 'image' && category.icon_type !== 'image' && <span className="mr-1">{category.icon}</span>}
                            {(category.icon_type === 'image' || category.icon === 'image') && (category as any).image_url && <img src={(category as any).image_url} className="w-4 h-4 object-contain mr-1" alt="" />}
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
                  <label className="block text-sm font-medium mb-2">Description</label>
                  <textarea
                    value={comboData.description}
                    onChange={(e) => setComboData({...comboData, description: e.target.value})}
                    rows={3}
                    className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none"
                    placeholder="Describe this combo..."
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">
                      Combo Price (₹) *
                    </label>
                    <input
                      type="number"
                      value={comboData.discount_price}
                      onChange={(e) => setComboData({...comboData, discount_price: e.target.value})}
                      min="0"
                      className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none"
                      placeholder="Enter selling price"
                    />
                    <p className="text-xs text-gray-400 mt-1">MRP: {formatCurrency(calculateTotal())}</p>
                  </div>
                  <div className="flex flex-col justify-center">
                    {calculateAutoDiscountPct() !== null && (
                      <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-center">
                        <p className="text-xs text-gray-500">Auto discount</p>
                        <p className="text-2xl font-bold text-green-600">{calculateAutoDiscountPct()}% OFF</p>
                        <p className="text-xs text-gray-500">
                          Save {formatCurrency(calculateTotal() - parseFloat(comboData.discount_price || '0'))}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
                  <input
                    type="checkbox"
                    id="is_active"
                    checked={comboData.is_active}
                    onChange={(e) => setComboData({...comboData, is_active: e.target.checked})}
                    className="h-4 w-4 text-premium-gold rounded"
                  />
                  <label htmlFor="is_active" className="text-sm font-medium">
                    Combo is active (visible to customers)
                  </label>
                </div>
              </div>

              <div>
                <h3 className="text-lg font-semibold mb-4">Selected Products ({selectedProducts.length})</h3>
                
                {selectedProducts.length === 0 ? (
                  <div className="text-center py-8 border-2 border-dashed border-gray-300 rounded-lg">
                    <Package className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                    <p className="text-gray-600">No products selected yet</p>
                  </div>
                ) : (
                  <div className="space-y-3 max-h-64 overflow-y-auto">
                    {selectedProducts.map(product => (
                      <div key={product.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                        <div className="flex items-center space-x-3">
                          <img
                            src={getImageUrl(getProductImage(product))}
                            alt={product.name}
                            className="w-12 h-12 object-cover rounded"
                            onError={(e) => { e.currentTarget.src = '/placeholder.svg'; }}
                          />
                          <div>
                            <h4 className="font-medium line-clamp-1">{product.name}</h4>
                            <p className="text-sm text-gray-600">
                              {formatCurrency(product.price)} × {product.quantity}
                            </p>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {product.categories?.map(cat => (
                                <span key={cat.id} className="px-2 py-0.5 bg-gray-100 text-xs rounded">
                                  {cat.name}
                                </span>
                              ))}
                              {product.category && !product.categories && (
                                <span className="px-2 py-0.5 bg-gray-100 text-xs rounded">
                                  {product.category}
                                </span>
                              )}
                              {product.gender && (
                                <span className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded capitalize">
                                  {product.gender}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center space-x-3">
                          <div className="flex items-center space-x-2">
                            <button
                              type="button"
                              onClick={() => updateQuantity(product.id, product.quantity - 1)}
                              className="p-1 hover:bg-white rounded"
                            >
                              <Minus className="h-4 w-4" />
                            </button>
                            <span className="w-8 text-center font-medium">{product.quantity}</span>
                            <button
                              type="button"
                              onClick={() => updateQuantity(product.id, product.quantity + 1)}
                              className="p-1 hover:bg-white rounded"
                            >
                              <Plus className="h-4 w-4" />
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeFromCombo(product.id)}
                            className="p-2 hover:bg-white rounded-lg text-red-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {selectedProducts.length > 0 && (
                  <div className="mt-6 p-4 border rounded-lg bg-gray-50">
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-600">MRP (sum of products):</span>
                        <span className="line-through text-gray-400">{formatCurrency(calculateTotal())}</span>
                      </div>
                      {calculateAutoDiscountPct() !== null && (
                        <div className="flex justify-between text-sm">
                          <span className="text-green-600">You save ({calculateAutoDiscountPct()}% off):</span>
                          <span className="text-green-600">
                            -{formatCurrency(calculateTotal() - parseFloat(comboData.discount_price || '0'))}
                          </span>
                        </div>
                      )}
                      <div className="border-t pt-2">
                        <div className="flex justify-between font-bold text-lg">
                          <span>Combo Price:</span>
                          <span className="text-premium-gold">
                            {comboData.discount_price ? formatCurrency(parseFloat(comboData.discount_price)) : formatCurrency(calculateTotal())}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">Available Products</h3>
                <div className="flex flex-wrap gap-2">
                  {/* Category Filter */}
                  <div className="relative">
                    <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <select
                      value={selectedCategoryFilter}
                      onChange={(e) => setSelectedCategoryFilter(e.target.value)}
                      className="pl-10 pr-8 py-2 border rounded-lg focus:border-premium-gold focus:outline-none appearance-none bg-white min-w-[180px]"
                    >
                      <option value="all">All Categories</option>
                      {filterCategories.map(cat => (
                        <option key={cat.id} value={cat.id}>
                          {cat.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Gender Filter */}
                  <div className="relative">
                    <Tag className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <select
                      value={selectedGender}
                      onChange={(e) => setSelectedGender(e.target.value)}
                      className="pl-10 pr-8 py-2 border rounded-lg focus:border-premium-gold focus:outline-none appearance-none bg-white min-w-[150px]"
                    >
                      <option value="all">All Genders</option>
                      {genders.map(g => (
                        <option key={g.name} value={g.name}>{g.display_name}</option>
                      ))}
                    </select>
                  </div>
                  
                  {/* Search Input */}
                  <div className="relative w-64">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                      type="text"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      placeholder="Search products..."
                      className="w-full pl-10 pr-4 py-2 border rounded-lg focus:border-premium-gold focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Products Grid */}
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 max-h-96 overflow-y-auto p-2">
                {filteredProducts.length === 0 ? (
                  <div className="col-span-full text-center py-8 text-gray-500">
                    No products found matching your filters
                  </div>
                ) : (
                  filteredProducts.map(product => (
                    <div
                      key={product.id}
                      className="border rounded-lg p-4 hover:border-premium-gold transition-colors"
                    >
                      <div className="flex items-start space-x-3">
                        <img
                          src={getImageUrl(getProductImage(product))}
                          alt={product.name}
                          className="w-16 h-16 object-cover rounded"
                          onError={(e) => { e.currentTarget.src = '/placeholder.svg'; }}
                        />
                        <div className="flex-1">
                          <h4 className="font-medium line-clamp-1">{product.name}</h4>
                          <p className="text-premium-gold font-semibold">
                            {formatCurrency(product.price)}
                          </p>
                          <p className="text-xs text-gray-600 line-clamp-2 mt-1">
                            {product.description}
                          </p>
                          <div className="flex flex-wrap items-center gap-1 mt-2">
                            {product.categories?.map(cat => (
                              <span key={cat.id} className="px-2 py-0.5 bg-gray-100 text-gray-800 rounded text-xs">
                                {cat.icon && cat.icon !== 'image' && (cat as any).icon_type !== 'image' && <span className="mr-1">{cat.icon}</span>}
                                {cat.name}
                              </span>
                            ))}
                            {product.category && !product.categories && (
                              <span className="px-2 py-0.5 bg-gray-100 text-gray-800 rounded text-xs">
                                {product.category}
                              </span>
                            )}
                            {product.gender && (
                              <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs capitalize">
                                {product.gender}
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => addToCombo(product)}
                            className="mt-3 w-full px-3 py-1.5 bg-premium-gold text-white text-sm rounded hover:bg-premium-burgundy transition-colors"
                          >
                            Add to Combo
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex justify-end space-x-3 pt-6 border-t">
              <button
                type="button"
                onClick={onClose}
                className="px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || selectedProducts.length === 0 || selectedCategories.length === 0}
                className="px-6 py-3 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
              >
                {loading ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
                    {combo ? 'Updating...' : 'Creating...'}
                  </>
                ) : (
                  <>
                    <Save className="h-5 w-5 mr-2" />
                    {combo ? 'Update Combo' : 'Create Combo'}
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

export default ComboManager;