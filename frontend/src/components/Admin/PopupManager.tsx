import React, { useState, useEffect } from 'react';
import {
  X, Plus, Save, Trash2, Edit, RefreshCw,
  Eye, EyeOff, Clock, Gift, Upload, Image as ImageIcon
} from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import { uploadFetch } from '../../utils/api';
import { getImageUrl } from '../../utils/helpers';
import { PopupConfig } from '../../types';
import toast from 'react-hot-toast';
import LinkPicker from './LinkPicker';

const PopupManager: React.FC = () => {
  const { fetchWithAuth } = useApi();
  const [popups, setPopups] = useState<PopupConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingPopup, setEditingPopup] = useState<PopupConfig | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  const [formData, setFormData] = useState({
    title: '',
    description: '',
    image_url: '',
    discount_text: 'Rs {value} off on {collection} Collection',
    discount_value: '100',
    timer_enabled: true,
    timer_hours: 0,
    timer_minutes: 59,
    timer_seconds: 46,
    offer_text: 'Catch your discount before the timer runs out.',
    cta_text: 'Order Now',
    cta_link: '/products',
    cash_on_delivery_text: 'Cash on Delivery',
    prepaid_discount_text: '5% Extra off on Prepaid orders',
    is_active: true,
    display_frequency: 'once_per_session' as 'once_per_session' | 'always' | 'once_per_day',
  });

  useEffect(() => { fetchPopups(); }, []);

  const fetchPopups = async () => {
    try {
      setLoading(true);
      const data = await fetchWithAuth('/api/admin/popups');
      setPopups(data || []);
    } catch (error) {
      console.error('Error fetching popups:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleImageUpload = async (file: File) => {
    // Accept images and GIFs
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.type)) {
      toast.error('Only JPG, PNG, WebP and GIF files are allowed');
      return;
    }
    setUploadingImage(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const data = await uploadFetch('/api/upload/upload-image', fd);
      setFormData(prev => ({ ...prev, image_url: data.image_url }));
      toast.success('Image uploaded!');
    } catch {
      toast.error('Failed to upload image');
    } finally {
      setUploadingImage(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingPopup) {
        await fetchWithAuth(`/api/admin/popups/${editingPopup.id}`, {
          method: 'PUT',
          body: JSON.stringify(formData),
        });
        toast.success('Popup updated!');
      } else {
        await fetchWithAuth('/api/admin/popups', {
          method: 'POST',
          body: JSON.stringify(formData),
        });
        toast.success('Popup created!');
      }
      await fetchPopups();
      setShowAddModal(false);
      setEditingPopup(null);
      resetForm();
    } catch (error) {
      toast.error('Error saving popup');
    }
  };

  const toggleStatus = async (popup: PopupConfig) => {
    try {
      await fetchWithAuth(`/api/admin/popups/${popup.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: !popup.is_active }),
      });
      await fetchPopups();
    } catch (error) {
      toast.error('Error updating status');
    }
  };

  const deletePopup = async (id: string) => {
    if (!confirm('Delete this popup?')) return;
    try {
      await fetchWithAuth(`/api/admin/popups/${id}`, { method: 'DELETE' });
      await fetchPopups();
      toast.success('Popup deleted');
    } catch (error) {
      toast.error('Error deleting popup');
    }
  };

  const resetForm = () => {
    setFormData({
      title: '',
      description: '',
      image_url: '',
      discount_text: 'Rs {value} off on {collection} Collection',
      discount_value: '100',
      timer_enabled: true,
      timer_hours: 0,
      timer_minutes: 59,
      timer_seconds: 46,
      offer_text: 'Catch your discount before the timer runs out.',
      cta_text: 'Order Now',
      cta_link: '/products',
      cash_on_delivery_text: 'Cash on Delivery',
      prepaid_discount_text: '5% Extra off on Prepaid orders',
      is_active: true,
      display_frequency: 'once_per_session',
    });
  };

  const openEdit = (popup: PopupConfig) => {
    setEditingPopup(popup);
    setFormData({
      title: popup.title,
      description: popup.description || '',
      image_url: popup.image_url || '',
      discount_text: popup.discount_text,
      discount_value: popup.discount_value,
      timer_enabled: popup.timer_enabled,
      timer_hours: popup.timer_hours,
      timer_minutes: popup.timer_minutes,
      timer_seconds: popup.timer_seconds,
      offer_text: popup.offer_text,
      cta_text: popup.cta_text,
      cta_link: popup.cta_link || '',
      cash_on_delivery_text: popup.cash_on_delivery_text,
      prepaid_discount_text: popup.prepaid_discount_text,
      is_active: popup.is_active,
      display_frequency: popup.display_frequency,
    });
    setShowAddModal(true);
  };

  if (loading) return (
    <div className="bg-white rounded-xl p-8 text-center">
      <RefreshCw className="h-8 w-8 animate-spin text-premium-gold mx-auto" />
    </div>
  );

  return (
    <div className="bg-white rounded-xl shadow overflow-hidden">
      <div className="px-6 py-4 border-b">
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-serif font-semibold flex items-center gap-2">
            <Gift className="h-6 w-6 text-premium-gold" />
            Popup Manager
          </h2>
          <button
            onClick={() => { resetForm(); setEditingPopup(null); setShowAddModal(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy"
          >
            <Plus className="h-4 w-4" />
            Add Popup
          </button>
        </div>
      </div>

      {popups.length === 0 ? (
        <div className="p-12 text-center">
          <Gift className="h-16 w-16 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">No popups configured</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-4">Preview</th>
                <th className="text-left p-4">Title</th>
                <th className="text-left p-4">Discount</th>
                <th className="text-left p-4">Timer</th>
                <th className="text-left p-4">Frequency</th>
                <th className="text-left p-4">Status</th>
                <th className="text-left p-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {popups.map((popup) => (
                <tr key={popup.id} className="border-b hover:bg-gray-50">
                  <td className="p-4">
                    {popup.image_url ? (
                      <img
                        src={getImageUrl(popup.image_url)}
                        alt={popup.title}
                        className="w-16 h-12 object-cover rounded-lg"
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                      />
                    ) : (
                      <div className="w-16 h-12 bg-gray-100 rounded-lg flex items-center justify-center">
                        <ImageIcon className="h-5 w-5 text-gray-400" />
                      </div>
                    )}
                  </td>
                  <td className="p-4">
                    <p className="font-medium">{popup.title}</p>
                    <p className="text-sm text-gray-500 truncate max-w-[200px]">{popup.description}</p>
                  </td>
                  <td className="p-4">
                    <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm">
                      ₹{popup.discount_value} off
                    </span>
                  </td>
                  <td className="p-4">
                    {popup.timer_enabled ? (
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 text-blue-600" />
                        <span className="text-sm">{popup.timer_hours}h {popup.timer_minutes}m {popup.timer_seconds}s</span>
                      </div>
                    ) : (
                      <span className="text-gray-400 text-sm">No timer</span>
                    )}
                  </td>
                  <td className="p-4">
                    <span className="text-sm capitalize">{popup.display_frequency.replace(/_/g, ' ')}</span>
                  </td>
                  <td className="p-4">
                    <button
                      onClick={() => toggleStatus(popup)}
                      className={`px-3 py-1 rounded-full text-xs font-medium ${
                        popup.is_active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {popup.is_active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td className="p-4">
                    <div className="flex gap-2">
                      <button onClick={() => openEdit(popup)} className="p-2 hover:bg-gray-100 rounded">
                        <Edit className="h-4 w-4 text-blue-600" />
                      </button>
                      <button onClick={() => deletePopup(popup.id)} className="p-2 hover:bg-gray-100 rounded">
                        <Trash2 className="h-4 w-4 text-red-600" />
                      </button>
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[300] p-4">
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-2xl font-serif font-semibold">
                  {editingPopup ? 'Edit Popup' : 'Create Popup'}
                </h2>
                <button onClick={() => { setShowAddModal(false); setEditingPopup(null); }}>
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-5">
                {/* Title */}
                <div>
                  <label className="block text-sm font-medium mb-2">Title *</label>
                  <input
                    type="text"
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    className="w-full px-4 py-2 border rounded-lg focus:border-premium-gold focus:outline-none"
                    required
                    placeholder="Holi Special Offer"
                  />
                </div>

                {/* Image / GIF Upload */}
                <div>
                  <label className="block text-sm font-medium mb-2">Popup Image / GIF</label>
                  <div className="space-y-3">
                    {formData.image_url ? (
                      <div className="relative inline-block">
                        <img
                          src={getImageUrl(formData.image_url)}
                          alt="Popup preview"
                          className="h-40 rounded-xl object-contain border bg-gray-50"
                          onError={(e) => { e.currentTarget.src = '/placeholder.svg'; }}
                        />
                        <button
                          type="button"
                          onClick={() => setFormData({ ...formData, image_url: '' })}
                          className="absolute -top-2 -right-2 p-1 bg-red-500 text-white rounded-full shadow"
                        >
                          <X className="h-3 w-3" />
                        </button>
                        <p className="text-xs text-green-600 mt-1">✓ Image uploaded</p>
                      </div>
                    ) : (
                      <label className={`flex flex-col items-center gap-3 py-8 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${uploadingImage ? 'border-gray-300 bg-gray-50' : 'border-gray-300 hover:border-premium-gold hover:bg-premium-gold/5'}`}>
                        {uploadingImage ? (
                          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-premium-gold" />
                        ) : (
                          <>
                            <Upload className="h-8 w-8 text-gray-400" />
                            <div className="text-center">
                              <p className="text-sm font-medium text-gray-700">Upload image or GIF</p>
                              <p className="text-xs text-gray-500 mt-1">JPG, PNG, WebP, GIF — shown at top of popup</p>
                            </div>
                          </>
                        )}
                        <input
                          type="file"
                          accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageUpload(f); }}
                          className="hidden"
                          disabled={uploadingImage}
                        />
                      </label>
                    )}

                  </div>
                </div>

                {/* Description */}
                <div>
                  <label className="block text-sm font-medium mb-2">Description</label>
                  <textarea
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    rows={2}
                    className="w-full px-4 py-2 border rounded-lg focus:border-premium-gold focus:outline-none"
                    placeholder="Celebrate the festival of colors..."
                  />
                </div>

                {/* Discount */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">Discount Text</label>
                    <input
                      type="text"
                      value={formData.discount_text}
                      onChange={(e) => setFormData({ ...formData, discount_text: e.target.value })}
                      className="w-full px-4 py-2 border rounded-lg focus:border-premium-gold focus:outline-none"
                      placeholder="Rs {value} off on {collection}"
                    />
                    <p className="text-xs text-gray-400 mt-1">Use {'{value}'} as amount placeholder</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">Discount Amount (₹)</label>
                    <input
                      type="text"
                      value={formData.discount_value}
                      onChange={(e) => setFormData({ ...formData, discount_value: e.target.value })}
                      className="w-full px-4 py-2 border rounded-lg focus:border-premium-gold focus:outline-none"
                      placeholder="100"
                    />
                  </div>
                </div>

                {/* Timer */}
                <div className="p-4 bg-gray-50 rounded-xl space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.timer_enabled}
                      onChange={(e) => setFormData({ ...formData, timer_enabled: e.target.checked })}
                      className="rounded text-premium-gold"
                    />
                    <span className="font-medium flex items-center gap-1"><Clock className="h-4 w-4" />Enable Countdown Timer</span>
                  </label>
                  {formData.timer_enabled && (
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { label: 'Hours', key: 'timer_hours', max: 23 },
                        { label: 'Minutes', key: 'timer_minutes', max: 59 },
                        { label: 'Seconds', key: 'timer_seconds', max: 59 },
                      ].map(({ label, key, max }) => (
                        <div key={key}>
                          <label className="block text-xs font-medium mb-1">{label}</label>
                          <input
                            type="number"
                            value={(formData as any)[key] || 0}
                            onChange={(e) => setFormData({ ...formData, [key]: parseInt(e.target.value) || 0 })}
                            className="w-full px-3 py-2 border rounded-lg text-center font-mono text-lg focus:border-premium-gold focus:outline-none"
                            min={0}
                            max={max}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Offer text */}
                <div>
                  <label className="block text-sm font-medium mb-2">Offer Text</label>
                  <input
                    type="text"
                    value={formData.offer_text}
                    onChange={(e) => setFormData({ ...formData, offer_text: e.target.value })}
                    className="w-full px-4 py-2 border rounded-lg focus:border-premium-gold focus:outline-none"
                    placeholder="Catch your discount before the timer runs out."
                  />
                </div>

                {/* CTA */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">Button Text</label>
                    <input
                      type="text"
                      value={formData.cta_text}
                      onChange={(e) => setFormData({ ...formData, cta_text: e.target.value })}
                      className="w-full px-4 py-2 border rounded-lg focus:border-premium-gold focus:outline-none"
                      placeholder="Order Now"
                    />
                  </div>
                  <div>
                    <LinkPicker
                      value={formData.cta_link}
                      onChange={(url) => setFormData({ ...formData, cta_link: url })}
                      label="Button Link"
                    />
                  </div>
                </div>

                {/* Payment texts */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">COD Text</label>
                    <input
                      type="text"
                      value={formData.cash_on_delivery_text}
                      onChange={(e) => setFormData({ ...formData, cash_on_delivery_text: e.target.value })}
                      className="w-full px-4 py-2 border rounded-lg focus:border-premium-gold focus:outline-none"
                      placeholder="Cash on Delivery"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">Prepaid Discount Text</label>
                    <input
                      type="text"
                      value={formData.prepaid_discount_text}
                      onChange={(e) => setFormData({ ...formData, prepaid_discount_text: e.target.value })}
                      className="w-full px-4 py-2 border rounded-lg focus:border-premium-gold focus:outline-none"
                      placeholder="5% Extra off on Prepaid orders"
                    />
                  </div>
                </div>

                {/* Frequency & Active */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">Display Frequency</label>
                    <select
                      value={formData.display_frequency}
                      onChange={(e) => setFormData({ ...formData, display_frequency: e.target.value as any })}
                      className="w-full px-4 py-2 border rounded-lg focus:border-premium-gold focus:outline-none"
                    >
                      <option value="once_per_session">Once per session</option>
                      <option value="always">Always show</option>
                      <option value="once_per_day">Once per day</option>
                    </select>
                  </div>
                  <div className="flex items-end pb-1">
                    <label className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg w-full cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.is_active}
                        onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                        className="rounded text-premium-gold"
                        id="popup_active"
                      />
                      <span className="font-medium">Active (visible to visitors)</span>
                    </label>
                  </div>
                </div>

                {/* Live Preview */}
                <div className="p-4 bg-gray-50 rounded-xl">
                  <p className="text-sm font-medium mb-3">Preview:</p>
                  <div className="bg-white rounded-xl shadow-lg max-w-xs mx-auto overflow-hidden border">
                    <div className="relative h-24 bg-gradient-to-r from-orange-400 to-pink-400">
                      {formData.image_url && (
                        <img src={getImageUrl(formData.image_url)} alt="preview" className="w-full h-full object-cover" onError={() => {}} />
                      )}
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2">
                        <span className="text-white font-bold text-sm">
                          {formData.discount_text.replace('{value}', formData.discount_value).replace('{collection}', 'Special')}
                        </span>
                      </div>
                    </div>
                    <div className="p-3">
                      <p className="font-bold text-sm">{formData.title || 'Popup Title'}</p>
                      <p className="text-xs text-gray-500">{formData.description || 'Description...'}</p>
                      {formData.timer_enabled && (
                        <div className="flex gap-1 mt-2">
                          {['00', String(formData.timer_hours).padStart(2,'0'), String(formData.timer_minutes).padStart(2,'0'), String(formData.timer_seconds).padStart(2,'0')].slice(1).map((v, i) => (
                            <div key={i} className="flex-1 bg-gray-100 rounded text-center py-1">
                              <span className="text-sm font-bold text-orange-500">{v}</span>
                              <span className="text-[9px] text-gray-400 block">{['hrs','min','sec'][i]}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <button className="mt-2 w-full py-1.5 bg-orange-500 text-white rounded-lg text-xs font-medium">
                        {formData.cta_text || 'Order Now'}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t">
                  <button
                    type="button"
                    onClick={() => { setShowAddModal(false); setEditingPopup(null); }}
                    className="px-6 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={uploadingImage}
                    className="px-6 py-2 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy disabled:opacity-50"
                  >
                    <Save className="h-4 w-4 inline mr-2" />
                    {editingPopup ? 'Update' : 'Create'}
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

export default PopupManager;
