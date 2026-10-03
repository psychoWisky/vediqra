import React, { useState, useEffect } from 'react';
import { X, Save, Upload, Camera, RefreshCw, Calendar, Edit, Trash2, Download, Film, Zap } from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import { uploadFetch } from '../../utils/api';

interface LogoConfig {
  id: string;
  logo_url: string;
  favicon_url?: string;
  start_date?: string;
  end_date?: string;
  is_active: boolean;
  notes?: string;
  created_at: string;
}

const LogoManager: React.FC = () => {
  const { fetchWithAuth } = useApi();
  const [logos, setLogos] = useState<LogoConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingLogo, setEditingLogo] = useState<LogoConfig | null>(null);
  const [uploading, setUploading] = useState(false);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [faviconPreview, setFaviconPreview] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    logo_file: null as File | null,
    favicon_file: null as File | null,
    logo_url: '',
    favicon_url: '',
    start_date: '',
    end_date: '',
    is_active: true,
    notes: '',
  });

  useEffect(() => {
    fetchLogos();
  }, []);

  const fetchLogos = async () => {
    try {
      setLoading(true);
      const data = await fetchWithAuth('/api/logo/admin');
      setLogos(data || []);
    } catch (error) {
      console.error('Error fetching logos:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, type: 'logo' | 'favicon') => {
    const file = e.target.files?.[0];
    if (file) {
      // Check file size - increased to 5MB for GIFs
      if (file.size > 5 * 1024 * 1024) {
        alert('File size should be less than 5MB');
        return;
      }
      
      // Check if it's a GIF
      if (file.type === 'image/gif') {
        console.log('GIF file detected:', file.name);
      }
      
      const reader = new FileReader();
      reader.onloadend = () => {
        if (type === 'logo') {
          setLogoPreview(reader.result as string);
          setFormData({ ...formData, logo_file: file, logo_url: '' });
        } else {
          setFaviconPreview(reader.result as string);
          setFormData({ ...formData, favicon_file: file, favicon_url: '' });
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const uploadFile = async (file: File, type: 'logo' | 'favicon'): Promise<string | null> => {
    setUploading(true);
    const formData = new FormData();
    formData.append('image', file);
    formData.append('type', type);

    try {
      const data = await uploadFetch('/api/logo/admin/upload-logo', formData);
      return data.url;
    } catch (error) {
      console.error('Upload error:', error);
      return null;
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      let logoUrl = formData.logo_url;
      let faviconUrl = formData.favicon_url;

      if (formData.logo_file) {
        const uploaded = await uploadFile(formData.logo_file, 'logo');
        if (uploaded) logoUrl = uploaded;
      }

      if (formData.favicon_file) {
        const uploaded = await uploadFile(formData.favicon_file, 'favicon');
        if (uploaded) faviconUrl = uploaded;
      }

      const payload = {
        logo_url: logoUrl,
        favicon_url: faviconUrl,
        start_date: formData.start_date || null,
        end_date: formData.end_date || null,
        is_active: formData.is_active,
        notes: formData.notes,
      };

      if (editingLogo) {
        await fetchWithAuth(`/api/logo/admin/${editingLogo.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await fetchWithAuth('/api/logo/admin', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }

      await fetchLogos();
      setShowAddModal(false);
      setEditingLogo(null);
      resetForm();
    } catch (error) {
      console.error('Error saving logo:', error);
      alert('Failed to save logo configuration');
    }
  };

  const toggleStatus = async (logo: LogoConfig) => {
    try {
      await fetchWithAuth(`/api/logo/admin/${logo.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: !logo.is_active }),
      });
      await fetchLogos();
    } catch (error) {
      console.error('Error toggling status:', error);
    }
  };

  const activateNow = async (logo: LogoConfig) => {
    try {
      await fetchWithAuth(`/api/logo/admin/${logo.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: true, start_date: null, end_date: null }),
      });
      await fetchLogos();
    } catch (error) {
      console.error('Error activating logo:', error);
    }
  };

  const deleteLogo = async (id: string) => {
    if (!confirm('Delete this logo configuration?')) return;
    try {
      await fetchWithAuth(`/api/logo/admin/${id}`, { method: 'DELETE' });
      await fetchLogos();
    } catch (error) {
      console.error('Error deleting logo:', error);
    }
  };

  const resetForm = () => {
    setFormData({
      logo_file: null,
      favicon_file: null,
      logo_url: '',
      favicon_url: '',
      start_date: '',
      end_date: '',
      is_active: true,
      notes: '',
    });
    setLogoPreview(null);
    setFaviconPreview(null);
  };

  const isActiveNow = (logo: LogoConfig) => {
    if (!logo.is_active) return false;
    
    const now = new Date();
    if (logo.start_date && new Date(logo.start_date) > now) return false;
    if (logo.end_date && new Date(logo.end_date) < now) return false;
    
    return true;
  };

  // Helper to check if file is GIF
  const isGif = (url: string) => {
    return url.toLowerCase().endsWith('.gif');
  };

  if (loading) {
    return (
      <div className="bg-white rounded-xl p-8 text-center">
        <RefreshCw className="h-8 w-8 animate-spin text-premium-gold mx-auto" />
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow overflow-hidden">
      <div className="px-6 py-4 border-b">
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-serif font-semibold">Logo & Branding</h2>
          <button
            onClick={() => { resetForm(); setShowAddModal(true); }}
            className="flex items-center gap-2 px-4 py-2 bg-premium-gold text-white rounded-lg"
          >
            <Upload className="h-4 w-4" />
            Upload Logo
          </button>
        </div>
      </div>

      {logos.length === 0 ? (
        <div className="p-12 text-center">
          <Camera className="h-16 w-16 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">No logo configurations</p>
          <p className="text-sm text-gray-400 mt-2">Upload your first logo</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-4">Preview</th>
                <th className="text-left p-4">Type</th>
                <th className="text-left p-4">Logo</th>
                <th className="text-left p-4">Favicon</th>
                <th className="text-left p-4">Valid Period</th>
                <th className="text-left p-4">Status</th>
                <th className="text-left p-4">Active Now</th>
                <th className="text-left p-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {logos.map((logo) => {
                const isGifLogo = isGif(logo.logo_url);
                
                return (
                  <tr key={logo.id} className="border-b hover:bg-gray-50">
                    <td className="p-4">
                      {isGifLogo ? (
                        <div className="relative">
                          <img
                            src={logo.logo_url}
                            alt="Logo"
                            className="h-12 w-auto object-contain"
                          />
                          <span className="absolute -top-1 -right-1 bg-purple-600 text-white text-xs px-1 rounded">
                            GIF
                          </span>
                        </div>
                      ) : (
                        <img
                          src={logo.logo_url}
                          alt="Logo"
                          className="h-12 w-auto object-contain"
                        />
                      )}
                    </td>
                    <td className="p-4">
                      {isGifLogo ? (
                        <span className="flex items-center gap-1 text-purple-600">
                          <Film className="h-4 w-4" />
                          <span className="text-xs">Animated</span>
                        </span>
                      ) : (
                        <span className="text-xs text-gray-500">Static</span>
                      )}
                    </td>
                    <td className="p-4">
                      <a
                        href={logo.logo_url}
                        download
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:text-blue-800 flex items-center gap-1"
                      >
                        <Download className="h-4 w-4" />
                        Download
                      </a>
                    </td>
                    <td className="p-4">
                      {logo.favicon_url ? (
                        <a
                          href={logo.favicon_url}
                          download
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:text-blue-800 flex items-center gap-1"
                        >
                          <Download className="h-4 w-4" />
                          Download
                        </a>
                      ) : (
                        <span className="text-gray-400">None</span>
                      )}
                    </td>
                    <td className="p-4">
                      {logo.start_date || logo.end_date ? (
                        <div className="flex items-center gap-1 text-sm">
                          <Calendar className="h-4 w-4 text-gray-400" />
                          <span>
                            {logo.start_date ? new Date(logo.start_date).toLocaleDateString() : 'Any'} 
                            {' - '}
                            {logo.end_date ? new Date(logo.end_date).toLocaleDateString() : 'Any'}
                          </span>
                        </div>
                      ) : (
                        <span className="text-gray-400">Always active</span>
                      )}
                    </td>
                    <td className="p-4">
                      <button
                        onClick={() => toggleStatus(logo)}
                        className={`px-3 py-1 rounded-full text-xs font-medium ${
                          logo.is_active
                            ? 'bg-green-100 text-green-800'
                            : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {logo.is_active ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="p-4">
                      {isActiveNow(logo) ? (
                        <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-xs font-medium">
                          Yes
                        </span>
                      ) : (
                        <button
                          onClick={() => activateNow(logo)}
                          className="flex items-center gap-1 px-3 py-1 bg-orange-500 text-white rounded-full text-xs font-medium hover:bg-orange-600"
                        >
                          <Zap className="h-3 w-3" />
                          Activate Now
                        </button>
                      )}
                    </td>
                    <td className="p-4">
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            setEditingLogo(logo);
                            setFormData({
                              logo_file: null,
                              favicon_file: null,
                              logo_url: logo.logo_url,
                              favicon_url: logo.favicon_url || '',
                              start_date: logo.start_date || '',
                              end_date: logo.end_date || '',
                              is_active: logo.is_active,
                              notes: logo.notes || '',
                            });
                            setLogoPreview(logo.logo_url);
                            setFaviconPreview(logo.favicon_url || null);
                            setShowAddModal(true);
                          }}
                          className="p-2 hover:bg-gray-100 rounded"
                        >
                          <Edit className="h-4 w-4 text-blue-600" />
                        </button>
                        <button
                          onClick={() => deleteLogo(logo.id)}
                          className="p-2 hover:bg-gray-100 rounded"
                        >
                          <Trash2 className="h-4 w-4 text-red-600" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
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
                <h2 className="text-2xl font-serif font-semibold">
                  {editingLogo ? 'Edit Logo' : 'Upload Logo'}
                </h2>
                <button onClick={() => setShowAddModal(false)}>
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-6">
                {/* Logo Upload */}
                <div>
                  <label className="block text-sm font-medium mb-2">
                    Logo (PNG, SVG, JPG, GIF) {formData.logo_file?.type === 'image/gif' && '✓ GIF Selected'}
                  </label>
                  <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                    {logoPreview ? (
                      <div className="relative">
                        {formData.logo_file?.type === 'image/gif' ? (
                          <div className="relative">
                            <img
                              src={logoPreview}
                              alt="Logo preview"
                              className="max-h-32 mx-auto object-contain"
                            />
                            <span className="absolute top-0 right-0 bg-purple-600 text-white text-xs px-2 py-1 rounded-bl-lg">
                              GIF
                            </span>
                          </div>
                        ) : (
                          <img
                            src={logoPreview}
                            alt="Logo preview"
                            className="max-h-32 mx-auto object-contain"
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setLogoPreview(null);
                            setFormData({ ...formData, logo_file: null, logo_url: '' });
                          }}
                          className="absolute top-0 right-0 p-1 bg-red-500 text-white rounded-full"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <label className="cursor-pointer">
                        <Camera className="h-12 w-12 text-gray-400 mx-auto mb-2" />
                        <p className="text-sm text-gray-600">Click to upload logo</p>
                        <p className="text-xs text-gray-500">PNG, SVG, JPG, GIF up to 5MB</p>
                        <input
                          type="file"
                          accept="image/*,.gif"
                          onChange={(e) => handleFileChange(e, 'logo')}
                          className="hidden"
                        />
                      </label>
                    )}
                  </div>
                </div>

                {/* Favicon Upload */}
                <div>
                  <label className="block text-sm font-medium mb-2">Favicon (Optional, ICO, PNG)</label>
                  <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                    {faviconPreview ? (
                      <div className="relative">
                        <img
                          src={faviconPreview}
                          alt="Favicon preview"
                          className="max-h-16 mx-auto object-contain"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            setFaviconPreview(null);
                            setFormData({ ...formData, favicon_file: null, favicon_url: '' });
                          }}
                          className="absolute top-0 right-0 p-1 bg-red-500 text-white rounded-full"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <label className="cursor-pointer">
                        <Camera className="h-8 w-8 text-gray-400 mx-auto mb-2" />
                        <p className="text-sm text-gray-600">Click to upload favicon</p>
                        <p className="text-xs text-gray-500">16x16 or 32x32 PNG/ICO</p>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => handleFileChange(e, 'favicon')}
                          className="hidden"
                        />
                      </label>
                    )}
                  </div>
                </div>

                {/* Date Range */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">Start Date (Optional)</label>
                    <input
                      type="date"
                      value={formData.start_date}
                      onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                      className="w-full px-4 py-2 border rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">End Date (Optional)</label>
                    <input
                      type="date"
                      value={formData.end_date}
                      onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
                      className="w-full px-4 py-2 border rounded-lg"
                    />
                  </div>
                </div>

                {/* Notes */}
                <div>
                  <label className="block text-sm font-medium mb-2">Notes (Optional)</label>
                  <textarea
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                    rows={2}
                    className="w-full px-4 py-2 border rounded-lg"
                    placeholder="e.g., Holi Special Logo"
                  />
                </div>

                {/* Active */}
                <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
                  <input
                    type="checkbox"
                    checked={formData.is_active}
                    onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                    id="is_active"
                  />
                  <label htmlFor="is_active">Active (use this logo when within date range)</label>
                </div>

                <div className="flex justify-end gap-3 pt-4">
                  <button type="button" onClick={() => setShowAddModal(false)} className="px-6 py-2 border rounded-lg">
                    Cancel
                  </button>
                  <button type="submit" className="px-6 py-2 bg-premium-gold text-white rounded-lg" disabled={uploading}>
                    <Save className="h-4 w-4 inline mr-2" />
                    {uploading ? 'Uploading...' : (editingLogo ? 'Update' : 'Save')}
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

export default LogoManager;