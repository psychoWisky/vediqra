import React, { useState, useEffect } from 'react';
import {
  X, Plus, Save, Trash2, Edit, Search, RefreshCw,
  MoveUp, MoveDown, Palette, GripVertical,
  Gift, Heart, Star, Sparkles, Cake, Diamond,
  Briefcase, TreePine, Flower2, Baby, Home, ThumbsUp,
  Crown, Gem, Rocket, Award, Zap, Sun, Upload, Image as ImageIcon
} from 'lucide-react';
import { apiFetch, uploadFetch } from '../../utils/api';
import toast from 'react-hot-toast';

interface Category {
  id: string;
  name: string;
  description: string;
  icon: string;
  icon_type: 'emoji' | 'lucide' | 'image';
  image_url?: string;
  slug?: string;
  parent_id?: string | null;
  color: string;
  hover_effect: string;
  display_order: number;
  is_active: boolean;
  created_at: string;
  updated_at?: string;
}

const CategoryManager: React.FC = () => {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [error, setError] = useState<string | null>(null);
  const [uploadingIcon, setUploadingIcon] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    slug: '',
    parent_id: '',
    description: '',
    icon: 'Gift',
    icon_type: 'lucide' as 'emoji' | 'lucide' | 'image',
    image_url: '',
    color: 'from-pink-100 to-pink-50',
    hover_effect: 'scale',
    display_order: 0,
    is_active: true,
  });

  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const colorOptions = [
    { value: 'from-pink-100 to-pink-50', label: 'Pink' },
    { value: 'from-red-100 to-red-50', label: 'Red' },
    { value: 'from-rose-100 to-rose-50', label: 'Rose' },
    { value: 'from-purple-100 to-purple-50', label: 'Purple' },
    { value: 'from-blue-100 to-blue-50', label: 'Blue' },
    { value: 'from-green-100 to-green-50', label: 'Green' },
    { value: 'from-yellow-100 to-yellow-50', label: 'Yellow' },
    { value: 'from-orange-100 to-orange-50', label: 'Orange' },
    { value: 'from-teal-100 to-teal-50', label: 'Teal' },
    { value: 'from-indigo-100 to-indigo-50', label: 'Indigo' },
    { value: 'from-amber-100 to-amber-50', label: 'Amber' },
    { value: 'from-cyan-100 to-cyan-50', label: 'Cyan' },
  ];

  const hoverEffects = [
    { value: 'scale', label: 'Scale', icon: '↗️' },
    { value: 'rotate', label: 'Rotate', icon: '🔄' },
    { value: 'bounce', label: 'Bounce', icon: '⬆️' },
    { value: 'pulse', label: 'Pulse', icon: '✨' },
  ];

  const lucideIcons = [
    { name: 'Gift', component: Gift },
    { name: 'Heart', component: Heart },
    { name: 'Star', component: Star },
    { name: 'Sparkles', component: Sparkles },
    { name: 'Cake', component: Cake },
    { name: 'Diamond', component: Diamond },
    { name: 'Briefcase', component: Briefcase },
    { name: 'TreePine', component: TreePine },
    { name: 'Flower2', component: Flower2 },
    { name: 'Baby', component: Baby },
    { name: 'Home', component: Home },
    { name: 'ThumbsUp', component: ThumbsUp },
    { name: 'Crown', component: Crown },
    { name: 'Gem', component: Gem },
    { name: 'Rocket', component: Rocket },
    { name: 'Award', component: Award },
    { name: 'Zap', component: Zap },
    { name: 'Sun', component: Sun },
  ];

  const commonEmojis = ['🎂', '💝', '❤️', '💍', '💼', '🎄', '🌿', '👶', '🏠', '🙏', '🎁', '✨', '🌟', '🎈', '🎉', '🥂', '🍫', '🌹', '💐', '👔', '🎀', '🎗️', '🌺', '🎊'];

  useEffect(() => { fetchCategories(); }, []);

  const fetchCategories = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiFetch('/api/admin/categories');
      const sorted = (data || []).sort((a: Category, b: Category) => a.display_order - b.display_order);
      setCategories(sorted);
    } catch (error) {
      console.error('Error fetching categories:', error);
      setError(error instanceof Error ? error.message : 'Failed to fetch categories');
    } finally {
      setLoading(false);
    }
  };

  // Upload custom icon image
  const handleIconImageUpload = async (file: File) => {
    setUploadingIcon(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const data = await uploadFetch('/api/upload/upload-image', fd);
      setFormData(prev => ({ ...prev, icon_type: 'image', image_url: data.image_url, icon: data.image_url }));
      toast.success('Icon uploaded!');
    } catch {
      toast.error('Failed to upload icon');
    } finally {
      setUploadingIcon(false);
    }
  };

  const validateForm = () => {
    const errors: Record<string, string> = {};
    if (!formData.name.trim()) errors.name = 'Category name is required';
    if (formData.icon_type !== 'image' && !formData.icon) errors.icon = 'Please select an icon';
    if (formData.icon_type === 'image' && !formData.image_url) errors.icon = 'Please upload an icon image';
    if (!formData.color) errors.color = 'Please select a color';
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) return;

    try {
      setError(null);
      const submitData = {
        ...formData,
        slug: formData.slug.trim() || undefined,
        parent_id: formData.parent_id || null,
        icon: formData.icon_type === 'image' ? formData.image_url : formData.icon,
        display_order: formData.display_order || categories.length,
      };

      if (editingCategory) {
        await apiFetch(`/api/admin/categories/${editingCategory.id}`, {
          method: 'PUT',
          body: JSON.stringify(submitData),
        });
        toast.success('Category updated!');
      } else {
        await apiFetch('/api/admin/categories', {
          method: 'POST',
          body: JSON.stringify(submitData),
        });
        toast.success('Category created!');
      }

      await fetchCategories();
      setShowAddModal(false);
      setEditingCategory(null);
      resetForm();
    } catch (error) {
      console.error('Error saving category:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to save category');
    }
  };

  const deleteCategory = async (id: string) => {
    if (!confirm('Are you sure you want to delete this category?')) return;
    try {
      setError(null);
      await apiFetch(`/api/admin/categories/${id}`, { method: 'DELETE' });
      toast.success('Category deleted');
      await fetchCategories();
    } catch (error) {
      console.error('Error deleting category:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to delete category');
    }
  };

  const toggleStatus = async (category: Category) => {
    try {
      setError(null);
      await apiFetch(`/api/admin/categories/${category.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: !category.is_active }),
      });
      await fetchCategories();
    } catch (error) {
      console.error('Error toggling status:', error);
      toast.error('Failed to update status');
    }
  };

  const moveOrder = async (category: Category, direction: 'up' | 'down') => {
    const index = categories.findIndex(c => c.id === category.id);
    if ((direction === 'up' && index === 0) || (direction === 'down' && index === categories.length - 1)) return;
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    const other = categories[newIndex];
    try {
      setError(null);
      await Promise.all([
        apiFetch(`/api/admin/categories/${category.id}`, { method: 'PUT', body: JSON.stringify({ display_order: other.display_order }) }),
        apiFetch(`/api/admin/categories/${other.id}`, { method: 'PUT', body: JSON.stringify({ display_order: category.display_order }) }),
      ]);
      await fetchCategories();
    } catch (error) {
      console.error('Error reordering:', error);
      toast.error('Failed to reorder');
    }
  };

  const resetForm = () => {
    setFormData({ name: '', slug: '', parent_id: '', description: '', icon: 'Gift', icon_type: 'lucide', image_url: '', color: 'from-pink-100 to-pink-50', hover_effect: 'scale', display_order: categories.length, is_active: true });
    setFormErrors({});
  };

  const editCategory = (category: Category) => {
    setEditingCategory(category);
    const resolvedIconType: 'emoji' | 'lucide' | 'image' = 
      category.icon_type === 'image' || category.icon === 'image' || !!category.image_url
        ? 'image'
        : category.icon_type || (category.icon?.length <= 2 ? 'emoji' : 'lucide');
    const resolvedImageUrl = category.image_url || (category.icon?.startsWith('http') ? category.icon : '');
    setFormData({
      name: category.name,
      slug: category.slug || '',
      parent_id: category.parent_id || '',
      description: category.description || '',
      icon: resolvedIconType === 'image' ? 'image' : category.icon,
      icon_type: resolvedIconType,
      image_url: resolvedImageUrl,
      color: category.color || 'from-pink-100 to-pink-50',
      hover_effect: category.hover_effect || 'scale',
      display_order: category.display_order,
      is_active: category.is_active,
    });
    setShowAddModal(true);
  };

  const filteredCategories = categories.filter(c => {
    if (!c.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (filterStatus === 'active') return c.is_active;
    if (filterStatus === 'inactive') return !c.is_active;
    return true;
  });

  const renderCategoryIcon = (category: Category, size: string = 'w-6 h-6') => {
    const iconType = category.icon_type || (
      category.icon === 'image' ? 'image' :
      category.icon?.startsWith('http') ? 'image' :
      (category.icon?.length <= 2 ? 'emoji' : 'lucide')
    );
    const imgSrc = category.image_url || (category.icon !== 'image' && category.icon?.startsWith('http') ? category.icon : null);
    if (iconType === 'image' && imgSrc) {
      return <img src={imgSrc} alt={category.name} className={`${size} object-contain rounded`} />;
    }
    if (iconType === 'emoji') return <span className="text-2xl">{category.icon}</span>;
    const IconDef = lucideIcons.find(i => i.name === category.icon);
    if (IconDef) return <IconDef.component className={size} />;
    return <Gift className={size} />;
  };

  if (loading) return (
    <div className="bg-white rounded-xl p-8 text-center">
      <RefreshCw className="h-8 w-8 animate-spin text-premium-gold mx-auto" />
    </div>
  );

  return (
    <div className="bg-white rounded-xl shadow overflow-hidden">
      <div className="px-6 py-4 border-b">
        <div className="flex flex-col md:flex-row justify-between gap-4">
          <div>
            <h2 className="text-2xl font-serif font-semibold flex items-center gap-2">
              <Palette className="h-6 w-6 text-premium-gold" />
              Category Management
            </h2>
            <p className="text-sm text-gray-600">Manage product categories and their appearance</p>
          </div>
          <div className="flex gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search..." className="pl-9 pr-4 py-2 border rounded-lg focus:outline-none focus:border-premium-gold" />
            </div>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)} className="px-4 py-2 border rounded-lg">
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            <button onClick={() => { resetForm(); setEditingCategory(null); setShowAddModal(true); }} className="flex items-center gap-2 px-4 py-2 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy">
              <Plus className="h-4 w-4" />Add Category
            </button>
          </div>
        </div>
        {error && <div className="mt-4 p-3 bg-red-50 text-red-700 rounded-lg">Error: {error}</div>}
      </div>

      {filteredCategories.length === 0 ? (
        <div className="p-12 text-center">
          <Palette className="h-16 w-16 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">No categories found</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="p-4 text-left">Order</th>
                <th className="p-4 text-left">Category</th>
                <th className="p-4 text-left">Icon</th>
                <th className="p-4 text-left">Color</th>
                <th className="p-4 text-left">Effect</th>
                <th className="p-4 text-left">Status</th>
                <th className="p-4 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredCategories.map((category, index) => (
                <tr key={category.id} className="border-b hover:bg-gray-50">
                  <td className="p-4">
                    <div className="flex items-center gap-2">
                      <GripVertical className="h-4 w-4 text-gray-400 cursor-move" />
                      <span className="text-sm">{category.display_order}</span>
                    </div>
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-full bg-gradient-to-br ${category.color || 'from-gray-100 to-gray-50'} flex items-center justify-center overflow-hidden`}>
                        {renderCategoryIcon(category, 'w-5 h-5')}
                      </div>
                      <div>
                        <p className="font-medium">{category.name}</p>
                        <p className="text-sm text-gray-500 truncate max-w-[200px]">{category.description}</p>
                      </div>
                    </div>
                  </td>
                  <td className="p-4">{renderCategoryIcon(category, 'w-6 h-6')}</td>
                  <td className="p-4"><div className={`w-8 h-8 rounded-full bg-gradient-to-br ${category.color || 'from-gray-100 to-gray-50'}`} /></td>
                  <td className="p-4"><span className="px-3 py-1 bg-gray-100 rounded-full text-sm">{category.hover_effect}</span></td>
                  <td className="p-4">
                    <button onClick={() => toggleStatus(category)} className={`px-3 py-1 rounded-full text-xs font-medium ${category.is_active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                      {category.is_active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td className="p-4">
                    <div className="flex gap-2">
                      <button onClick={() => moveOrder(category, 'up')} disabled={index === 0} className="p-1 hover:bg-gray-100 rounded disabled:opacity-50" title="Move Up"><MoveUp className="h-4 w-4" /></button>
                      <button onClick={() => moveOrder(category, 'down')} disabled={index === filteredCategories.length - 1} className="p-1 hover:bg-gray-100 rounded disabled:opacity-50" title="Move Down"><MoveDown className="h-4 w-4" /></button>
                      <button onClick={() => editCategory(category)} className="p-1 hover:bg-gray-100 rounded" title="Edit"><Edit className="h-4 w-4 text-blue-600" /></button>
                      <button onClick={() => deleteCategory(category.id)} className="p-1 hover:bg-gray-100 rounded" title="Delete"><Trash2 className="h-4 w-4 text-red-600" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add/Edit Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-2xl font-serif font-semibold">{editingCategory ? 'Edit Category' : 'New Category'}</h2>
                <button onClick={() => { setShowAddModal(false); setEditingCategory(null); resetForm(); }}><X className="h-5 w-5" /></button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">Name *</label>
                    <input type="text" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} className={`w-full px-4 py-3 border rounded-lg ${formErrors.name ? 'border-red-500' : ''}`} placeholder="e.g., Birthday" />
                    {formErrors.name && <p className="text-red-500 text-xs mt-1">{formErrors.name}</p>}
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">Display Order</label>
                    <input type="number" value={formData.display_order} onChange={e => setFormData({ ...formData, display_order: parseInt(e.target.value) || 0 })} className="w-full px-4 py-3 border rounded-lg" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">Parent Category</label>
                    <select value={formData.parent_id} onChange={e => setFormData({ ...formData, parent_id: e.target.value })} className="w-full px-4 py-3 border rounded-lg">
                      <option value="">None (top-level)</option>
                      {categories
                        .filter(c => !c.parent_id && c.id !== editingCategory?.id)
                        .map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <p className="text-xs text-gray-500 mt-1">Two levels: a subcategory sits under a top-level category.</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">URL Slug</label>
                    <input type="text" value={formData.slug} onChange={e => setFormData({ ...formData, slug: e.target.value })} className="w-full px-4 py-3 border rounded-lg" placeholder="auto-generated from the name" />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Description</label>
                  <textarea value={formData.description} onChange={e => setFormData({ ...formData, description: e.target.value })} rows={2} className="w-full px-4 py-3 border rounded-lg" placeholder="Brief description..." />
                </div>

                {/* Icon Type Selection */}
                <div>
                  <label className="block text-sm font-medium mb-3">Icon Type *</label>
                  <div className="flex gap-4 mb-4">
                    {(['lucide', 'emoji', 'image'] as const).map(type => (
                      <label key={type} className={`flex items-center gap-2 px-4 py-2 border rounded-lg cursor-pointer transition-colors ${formData.icon_type === type ? 'border-premium-gold bg-premium-gold/10' : 'border-gray-200 hover:border-gray-300'}`}>
                        <input type="radio" value={type} checked={formData.icon_type === type} onChange={() => setFormData({ ...formData, icon_type: type, icon: type === 'lucide' ? 'Gift' : type === 'emoji' ? '🎁' : '', image_url: '' })} className="hidden" />
                        {type === 'lucide' && <><Star className="h-4 w-4" /> Lucide Icon</>}
                        {type === 'emoji' && <>🎁 Emoji</>}
                        {type === 'image' && <><ImageIcon className="h-4 w-4" /> Custom Image</>}
                      </label>
                    ))}
                  </div>

                  {/* Lucide picker */}
                  {formData.icon_type === 'lucide' && (
                    <div className="grid grid-cols-6 gap-2 p-4 border rounded-lg max-h-48 overflow-y-auto">
                      {lucideIcons.map(icon => {
                        const Icon = icon.component;
                        return (
                          <button key={icon.name} type="button" onClick={() => setFormData({ ...formData, icon: icon.name })} className={`p-3 rounded-lg hover:bg-premium-gold/10 transition-colors ${formData.icon === icon.name ? 'bg-premium-gold/20 ring-2 ring-premium-gold' : ''}`}>
                            <Icon className="w-6 h-6 mx-auto" />
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Emoji picker */}
                  {formData.icon_type === 'emoji' && (
                    <div className="grid grid-cols-8 gap-2 p-4 border rounded-lg max-h-48 overflow-y-auto">
                      {commonEmojis.map(emoji => (
                        <button key={emoji} type="button" onClick={() => setFormData({ ...formData, icon: emoji })} className={`p-3 text-2xl rounded-lg hover:bg-premium-gold/10 transition-colors ${formData.icon === emoji ? 'bg-premium-gold/20 ring-2 ring-premium-gold' : ''}`}>
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Image upload */}
                  {formData.icon_type === 'image' && (
                    <div className="p-4 border rounded-lg">
                      {formData.image_url ? (
                        <div className="flex items-center gap-4">
                          <img src={formData.image_url} alt="Icon preview" className="w-16 h-16 object-contain rounded-lg border" />
                          <div>
                            <p className="text-sm font-medium text-green-700">✓ Icon uploaded</p>
                            <button type="button" onClick={() => setFormData({ ...formData, image_url: '', icon: '' })} className="text-sm text-red-600 hover:underline mt-1">Remove & upload new</button>
                          </div>
                        </div>
                      ) : (
                        <label className="flex flex-col items-center gap-3 py-6 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-premium-gold transition-colors">
                          {uploadingIcon ? (
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-premium-gold" />
                          ) : (
                            <>
                              <Upload className="h-8 w-8 text-gray-400" />
                              <div className="text-center">
                                <p className="text-sm font-medium text-gray-700">Upload icon image</p>
                                <p className="text-xs text-gray-500">PNG, JPG, WebP — shown as category icon everywhere</p>
                              </div>
                            </>
                          )}
                          <input type="file" accept="image/*" onChange={e => { const f = e.target.files?.[0]; if (f) handleIconImageUpload(f); }} className="hidden" disabled={uploadingIcon} />
                        </label>
                      )}
                      {formErrors.icon && <p className="text-red-500 text-xs mt-2">{formErrors.icon}</p>}
                    </div>
                  )}
                </div>

                {/* Color & Hover Effect */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">Background Color</label>
                    <div className="grid grid-cols-3 gap-2 p-3 border rounded-lg max-h-48 overflow-y-auto">
                      {colorOptions.map(color => (
                        <button key={color.value} type="button" onClick={() => setFormData({ ...formData, color: color.value })} className={`flex items-center gap-2 p-2 rounded hover:bg-gray-50 transition-colors ${formData.color === color.value ? 'bg-premium-gold/10 ring-2 ring-premium-gold' : ''}`}>
                          <div className={`w-5 h-5 rounded-full bg-gradient-to-br ${color.value} flex-shrink-0`} />
                          <span className="text-xs">{color.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">Hover Effect</label>
                    <div className="space-y-2">
                      {hoverEffects.map(effect => (
                        <button key={effect.value} type="button" onClick={() => setFormData({ ...formData, hover_effect: effect.value })} className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors ${formData.hover_effect === effect.value ? 'border-premium-gold bg-premium-gold/5' : 'border-gray-200 hover:border-premium-gold'}`}>
                          <span className="text-xl">{effect.icon}</span>
                          <span>{effect.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Preview */}
                <div className="p-4 bg-gray-50 rounded-lg">
                  <p className="text-sm font-medium mb-3">Preview:</p>
                  <div className={`inline-flex flex-col items-center p-4 bg-gradient-to-br ${formData.color} rounded-xl`}>
                    <div className="w-12 h-12 flex items-center justify-center mb-2">
                      {formData.icon_type === 'image' && formData.image_url ? (
                        <img src={formData.image_url} alt="preview" className="w-full h-full object-contain" />
                      ) : formData.icon_type === 'emoji' ? (
                        <span className="text-3xl">{formData.icon}</span>
                      ) : (
                        (() => { const IC = lucideIcons.find(i => i.name === formData.icon)?.component || Gift; return <IC className="w-8 h-8" />; })()
                      )}
                    </div>
                    <span className="font-semibold text-sm">{formData.name || 'Category Name'}</span>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
                  <input type="checkbox" id="is_active_cat" checked={formData.is_active} onChange={e => setFormData({ ...formData, is_active: e.target.checked })} className="rounded text-premium-gold" />
                  <label htmlFor="is_active_cat">Active (visible to customers)</label>
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t">
                  <button type="button" onClick={() => { setShowAddModal(false); setEditingCategory(null); resetForm(); }} className="px-6 py-3 border rounded-lg hover:bg-gray-50">Cancel</button>
                  <button type="submit" disabled={uploadingIcon} className="px-6 py-3 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy disabled:opacity-50">
                    <Save className="h-5 w-5 inline mr-2" />
                    {editingCategory ? 'Update' : 'Create'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CategoryManager;
