import React, { useState, useEffect } from 'react';
import {
  X, Plus, Save, Trash2, Edit, Search, RefreshCw,
  MoveUp, MoveDown, Eye, EyeOff, Video, Image,
  Upload, Play, Pause, Volume2, VolumeX, ChevronUp, ChevronDown,
  AlignCenter, AlignLeft, AlignRight
} from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import LinkPicker from './LinkPicker';
import { uploadFetch } from '../../utils/api';

interface HeroContent {
  id: string;
  title: string;
  subtitle: string;
  media_type: 'image' | 'video';
  media_url: string;
  video_poster_url?: string;
  autoplay: boolean;
  loop: boolean;
  muted: boolean;
  cta_text?: string;
  cta_link?: string;
  content_alignment?: 'left' | 'center' | 'right';
  is_active: boolean;
  display_order: number;
  created_at: string;
}

const HeroManager: React.FC = () => {
  const { fetchWithAuth } = useApi();
  const [heroes, setHeroes] = useState<HeroContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingHero, setEditingHero] = useState<HeroContent | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive'>('all');

  const [formData, setFormData] = useState({
    title: '',
    subtitle: '',
    media_type: 'image' as 'image' | 'video',
    media_url: '',
    video_poster_url: '',
    media_file: null as File | null,
    poster_file: null as File | null,
    autoplay: true,
    loop: true,
    muted: true,
    cta_text: '',
    cta_link: '',
    content_alignment: 'center' as 'left' | 'center' | 'right',
    is_active: true,
    display_order: 0,
  });

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    fetchHeroes();
  }, []);

  const fetchHeroes = async () => {
    try {
      setLoading(true);
      const data = await fetchWithAuth('/api/admin/hero');
      const sorted = (data || []).sort((a: HeroContent, b: HeroContent) => a.display_order - b.display_order);
      setHeroes(sorted);
    } catch (error) {
      console.error('Error fetching heroes:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleMediaUpload = async (file: File, type: 'media' | 'poster'): Promise<string | null> => {
    setUploading(true);
    setUploadProgress(0);

    const formData = new FormData();
    formData.append('media', file);

    try {
      const interval = setInterval(() => {
        setUploadProgress(prev => Math.min(prev + 10, 90));
      }, 200);

      const data = await uploadFetch('/api/upload/hero', formData);

      clearInterval(interval);
      setUploadProgress(100);

      if (type === 'media') {
        setFormData(prev => ({ 
          ...prev, 
          media_url: data.image_url || data.media_url,
          media_type: data.media_type || 'image'
        }));
      } else {
        setFormData(prev => ({ ...prev, video_poster_url: data.image_url || data.media_url }));
      }

      return data.image_url || data.media_url;
    } catch (error) {
      console.error('Upload error:', error);
      return null;
    } finally {
      setTimeout(() => {
        setUploading(false);
        setUploadProgress(0);
      }, 500);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, type: 'media' | 'poster') => {
    const file = e.target.files?.[0];
    if (file) {
      if (type === 'media') {
        setFormData({ ...formData, media_file: file });
        const url = URL.createObjectURL(file);
        setPreviewUrl(url);
        // Detect media type from file
        const isVideo = file.type.startsWith('video/');
        setFormData(prev => ({ ...prev, media_type: isVideo ? 'video' : 'image' }));
      } else {
        setFormData({ ...formData, poster_file: file });
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      let mediaUrl = formData.media_url;
      let posterUrl = formData.video_poster_url;

      // Upload media file if selected
      if (formData.media_file) {
        const uploadedUrl = await handleMediaUpload(formData.media_file, 'media');
        if (uploadedUrl) mediaUrl = uploadedUrl;
      }

      // Upload poster if selected
      if (formData.poster_file) {
        const uploadedUrl = await handleMediaUpload(formData.poster_file, 'poster');
        if (uploadedUrl) posterUrl = uploadedUrl;
      }

      const heroData = {
        title: formData.title,
        subtitle: formData.subtitle,
        media_type: formData.media_type,
        media_url: mediaUrl,
        video_poster_url: posterUrl,
        autoplay: formData.autoplay,
        loop: formData.loop,
        muted: formData.muted,
        cta_text: formData.cta_text,
        cta_link: formData.cta_link,
        content_alignment: formData.content_alignment,
        is_active: formData.is_active,
        display_order: formData.display_order,
      };

      if (editingHero) {
        await fetchWithAuth(`/api/admin/hero/${editingHero.id}`, {
          method: 'PUT',
          body: JSON.stringify(heroData),
        });
      } else {
        await fetchWithAuth('/api/admin/hero', {
          method: 'POST',
          body: JSON.stringify(heroData),
        });
      }

      await fetchHeroes();
      setShowAddModal(false);
      setEditingHero(null);
      resetForm();
    } catch (error) {
      console.error('Error saving hero:', error);
      alert('Failed to save hero section');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this hero section?')) return;
    
    try {
      await fetchWithAuth(`/api/admin/hero/${id}`, { method: 'DELETE' });
      await fetchHeroes();
    } catch (error) {
      console.error('Error deleting hero:', error);
      alert('Failed to delete hero section');
    }
  };

  const handleToggleStatus = async (hero: HeroContent) => {
    try {
      await fetchWithAuth(`/api/admin/hero/${hero.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: !hero.is_active }),
      });
      await fetchHeroes();
    } catch (error) {
      console.error('Error toggling status:', error);
      alert('Failed to update status');
    }
  };

  const handleMoveOrder = async (hero: HeroContent, direction: 'up' | 'down') => {
    const index = heroes.findIndex(h => h.id === hero.id);
    if (
      (direction === 'up' && index === 0) || 
      (direction === 'down' && index === heroes.length - 1)
    ) return;

    const newIndex = direction === 'up' ? index - 1 : index + 1;
    const otherHero = heroes[newIndex];

    try {
      await Promise.all([
        fetchWithAuth(`/api/admin/hero/${hero.id}`, {
          method: 'PUT',
          body: JSON.stringify({ display_order: otherHero.display_order }),
        }),
        fetchWithAuth(`/api/admin/hero/${otherHero.id}`, {
          method: 'PUT',
          body: JSON.stringify({ display_order: hero.display_order }),
        }),
      ]);
      await fetchHeroes();
    } catch (error) {
      console.error('Error reordering:', error);
      alert('Failed to reorder');
    }
  };

  const handleEdit = (hero: HeroContent) => {
    setEditingHero(hero);
    setFormData({
      title: hero.title,
      subtitle: hero.subtitle || '',
      media_type: hero.media_type,
      media_url: hero.media_url,
      video_poster_url: hero.video_poster_url || '',
      media_file: null,
      poster_file: null,
      autoplay: hero.autoplay,
      loop: hero.loop,
      muted: hero.muted,
      cta_text: hero.cta_text || '',
      cta_link: hero.cta_link || '',
      content_alignment: hero.content_alignment || 'center',
      is_active: hero.is_active,
      display_order: hero.display_order,
    });
    setPreviewUrl(hero.media_url);
    setShowAddModal(true);
  };

  const resetForm = () => {
    setFormData({
      title: '',
      subtitle: '',
      media_type: 'image',
      media_url: '',
      video_poster_url: '',
      media_file: null,
      poster_file: null,
      autoplay: true,
      loop: true,
      muted: true,
      cta_text: '',
      cta_link: '',
      content_alignment: 'center',
      is_active: true,
      display_order: heroes.length,
    });
    setPreviewUrl(null);
    setEditingHero(null);
  };

  const filteredHeroes = heroes.filter(hero => {
    const matchesSearch = hero.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         hero.subtitle?.toLowerCase().includes(searchTerm.toLowerCase());
    if (!matchesSearch) return false;
    if (filterStatus === 'active') return hero.is_active;
    if (filterStatus === 'inactive') return !hero.is_active;
    return true;
  });

  const getMediaIcon = (type: string) => {
    return type === 'video' ? <Video className="h-4 w-4" /> : <Image className="h-4 w-4" />;
  };

  const getAlignmentIcon = (alignment: string) => {
    switch(alignment) {
      case 'left': return <AlignLeft className="h-4 w-4" />;
      case 'right': return <AlignRight className="h-4 w-4" />;
      default: return <AlignCenter className="h-4 w-4" />;
    }
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
      {/* Header with Search and Filters */}
      <div className="px-6 py-4 border-b">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <h2 className="text-2xl font-serif font-semibold">Hero Sections</h2>
          
          <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search heroes..."
                className="pl-10 pr-4 py-2 border rounded-lg w-full sm:w-64"
              />
            </div>
            
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as any)}
              className="px-4 py-2 border rounded-lg"
            >
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>

            <button
              onClick={() => { resetForm(); setShowAddModal(true); }}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy"
            >
              <Plus className="h-4 w-4" />
              Add Hero
            </button>
          </div>
        </div>
      </div>

      {/* Heroes Table */}
      {filteredHeroes.length === 0 ? (
        <div className="p-12 text-center">
          <Video className="h-16 w-16 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500 text-lg mb-2">No hero sections found</p>
          <p className="text-sm text-gray-400 mb-6">
            {searchTerm || filterStatus !== 'all' 
              ? 'Try adjusting your search or filters' 
              : 'Add your first hero section to get started'}
          </p>
          {!searchTerm && filterStatus === 'all' && (
            <button
              onClick={() => { resetForm(); setShowAddModal(true); }}
              className="px-6 py-3 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy"
            >
              + Add Your First Hero
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-4 w-16">Order</th>
                <th className="text-left p-4">Preview</th>
                <th className="text-left p-4">Title</th>
                <th className="text-left p-4">Type</th>
                <th className="text-left p-4">Alignment</th>
                <th className="text-left p-4">CTA</th>
                <th className="text-left p-4">Status</th>
                <th className="text-left p-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredHeroes.map((hero, index) => (
                <tr key={hero.id} className="border-b hover:bg-gray-50">
                  <td className="p-4">
                    <div className="flex items-center gap-1">
                      <span className="text-sm text-gray-500">{hero.display_order}</span>
                      <div className="flex flex-col">
                        <button
                          onClick={() => handleMoveOrder(hero, 'up')}
                          disabled={index === 0}
                          className="p-0.5 hover:bg-gray-200 rounded disabled:opacity-30"
                        >
                          <ChevronUp className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => handleMoveOrder(hero, 'down')}
                          disabled={index === heroes.length - 1}
                          className="p-0.5 hover:bg-gray-200 rounded disabled:opacity-30"
                        >
                          <ChevronDown className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  </td>
                  <td className="p-4">
                    <div className="w-20 h-12 bg-gray-100 rounded overflow-hidden">
                      {hero.media_type === 'video' ? (
                        <video 
                          src={hero.media_url} 
                          className="w-full h-full object-cover"
                          muted
                          loop
                        />
                      ) : (
                        <img 
                          src={hero.media_url} 
                          alt={hero.title}
                          className="w-full h-full object-cover"
                        />
                      )}
                    </div>
                  </td>
                  <td className="p-4">
                    <div>
                      <p className="font-medium">{hero.title}</p>
                      <p className="text-sm text-gray-600 line-clamp-1">{hero.subtitle}</p>
                    </div>
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-2">
                      {getMediaIcon(hero.media_type)}
                      <span className="text-sm capitalize">{hero.media_type}</span>
                    </div>
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-2">
                      {getAlignmentIcon(hero.content_alignment || 'center')}
                      <span className="text-sm capitalize">{hero.content_alignment || 'center'}</span>
                    </div>
                  </td>
                  <td className="p-4">
                    {hero.cta_text ? (
                      <div>
                        <p className="text-sm font-medium">{hero.cta_text}</p>
                        <p className="text-xs text-gray-500">{hero.cta_link}</p>
                      </div>
                    ) : (
                      <span className="text-sm text-gray-400">None</span>
                    )}
                  </td>
                  <td className="p-4">
                    <button
                      onClick={() => handleToggleStatus(hero)}
                      className={`px-3 py-1 rounded-full text-xs font-medium ${
                        hero.is_active
                          ? 'bg-green-100 text-green-800 hover:bg-green-200'
                          : 'bg-red-100 text-red-800 hover:bg-red-200'
                      }`}
                    >
                      {hero.is_active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleEdit(hero)}
                        className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                        title="Edit"
                      >
                        <Edit className="h-4 w-4 text-blue-600" />
                      </button>
                      <button
                        onClick={() => handleDelete(hero.id)}
                        className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                        title="Delete"
                      >
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-2xl font-serif font-semibold">
                  {editingHero ? 'Edit Hero Section' : 'Add New Hero Section'}
                </h2>
                <button onClick={() => { setShowAddModal(false); setEditingHero(null); }}>
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">Title *</label>
                    <input
                      type="text"
                      value={formData.title}
                      onChange={(e) => setFormData({...formData, title: e.target.value})}
                      className="w-full px-4 py-2 border rounded-lg"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">Display Order</label>
                    <input
                      type="number"
                      value={formData.display_order}
                      onChange={(e) => setFormData({...formData, display_order: parseInt(e.target.value) || 0})}
                      className="w-full px-4 py-2 border rounded-lg"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Subtitle</label>
                  <textarea
                    value={formData.subtitle}
                    onChange={(e) => setFormData({...formData, subtitle: e.target.value})}
                    rows={2}
                    className="w-full px-4 py-2 border rounded-lg"
                  />
                </div>

                {/* Content Alignment */}
                <div>
                  <label className="block text-sm font-medium mb-2">Content Alignment</label>
                  <div className="flex gap-4">
                    <button
                      type="button"
                      onClick={() => setFormData({...formData, content_alignment: 'left'})}
                      className={`flex-1 flex items-center justify-center gap-2 p-3 border rounded-lg transition-colors ${
                        formData.content_alignment === 'left'
                          ? 'border-premium-gold bg-premium-gold/5 ring-2 ring-premium-gold/20'
                          : 'border-gray-200 hover:border-premium-gold'
                      }`}
                    >
                      <AlignLeft className="h-5 w-5" />
                      <span>Left</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormData({...formData, content_alignment: 'center'})}
                      className={`flex-1 flex items-center justify-center gap-2 p-3 border rounded-lg transition-colors ${
                        formData.content_alignment === 'center'
                          ? 'border-premium-gold bg-premium-gold/5 ring-2 ring-premium-gold/20'
                          : 'border-gray-200 hover:border-premium-gold'
                      }`}
                    >
                      <AlignCenter className="h-5 w-5" />
                      <span>Center</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormData({...formData, content_alignment: 'right'})}
                      className={`flex-1 flex items-center justify-center gap-2 p-3 border rounded-lg transition-colors ${
                        formData.content_alignment === 'right'
                          ? 'border-premium-gold bg-premium-gold/5 ring-2 ring-premium-gold/20'
                          : 'border-gray-200 hover:border-premium-gold'
                      }`}
                    >
                      <AlignRight className="h-5 w-5" />
                      <span>Right</span>
                    </button>
                  </div>
                </div>

                {/* Media Upload */}
                <div>
                  <label className="block text-sm font-medium mb-2">Media (Image/Video) *</label>
                  <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                    {previewUrl ? (
                      <div className="relative">
                        {formData.media_type === 'video' ? (
                          <video 
                            src={previewUrl} 
                            className="max-h-48 mx-auto" 
                            controls 
                            loop 
                            muted
                          />
                        ) : (
                          <img src={previewUrl} alt="Preview" className="max-h-48 mx-auto" />
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setPreviewUrl(null);
                            setFormData({
                              ...formData, 
                              media_file: null, 
                              media_url: '',
                              media_type: 'image'
                            });
                          }}
                          className="absolute top-2 right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <label className="cursor-pointer block">
                        <Upload className="h-8 w-8 text-gray-400 mx-auto mb-2" />
                        <p className="text-sm text-gray-600">Click to upload image or video</p>
                        <p className="text-xs text-gray-500">MP4, WebM, JPEG, PNG up to 50MB</p>
                        <input
                          type="file"
                          accept="image/*,video/*"
                          onChange={(e) => handleFileChange(e, 'media')}
                          className="hidden"
                          required={!editingHero}
                        />
                      </label>
                    )}
                  </div>
                  {uploading && (
                    <div className="mt-2">
                      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-premium-gold transition-all duration-300"
                          style={{ width: `${uploadProgress}%` }}
                        />
                      </div>
                      <p className="text-sm text-gray-600 mt-1 text-center">Uploading... {uploadProgress}%</p>
                    </div>
                  )}
                </div>

                {/* Video Options */}
                {formData.media_type === 'video' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-2">Video Poster (Optional)</label>
                      {formData.video_poster_url ? (
                        <div className="relative inline-block">
                          <img 
                            src={formData.video_poster_url} 
                            alt="Poster" 
                            className="h-20 rounded"
                          />
                          <button
                            type="button"
                            onClick={() => setFormData({...formData, video_poster_url: '', poster_file: null})}
                            className="absolute -top-2 -right-2 p-1 bg-red-500 text-white rounded-full"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ) : (
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => handleFileChange(e, 'poster')}
                          className="w-full"
                        />
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-4">
                      <label className="flex items-center justify-center gap-2 p-2 border rounded-lg hover:bg-gray-50">
                        <input
                          type="checkbox"
                          checked={formData.autoplay}
                          onChange={(e) => setFormData({...formData, autoplay: e.target.checked})}
                        />
                        Autoplay
                      </label>
                      <label className="flex items-center justify-center gap-2 p-2 border rounded-lg hover:bg-gray-50">
                        <input
                          type="checkbox"
                          checked={formData.loop}
                          onChange={(e) => setFormData({...formData, loop: e.target.checked})}
                        />
                        Loop
                      </label>
                      <label className="flex items-center justify-center gap-2 p-2 border rounded-lg hover:bg-gray-50">
                        <input
                          type="checkbox"
                          checked={formData.muted}
                          onChange={(e) => setFormData({...formData, muted: e.target.checked})}
                        />
                        Muted
                      </label>
                    </div>
                  </>
                )}

                {/* CTA */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">CTA Text</label>
                    <input
                      type="text"
                      value={formData.cta_text}
                      onChange={(e) => setFormData({...formData, cta_text: e.target.value})}
                      className="w-full px-4 py-2 border rounded-lg"
                      placeholder="Shop Now"
                    />
                  </div>
                  <div>
                    <LinkPicker
                      value={formData.cta_link}
                      onChange={(url) => setFormData({...formData, cta_link: url})}
                      label="CTA Link"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
                  <input
                    type="checkbox"
                    checked={formData.is_active}
                    onChange={(e) => setFormData({...formData, is_active: e.target.checked})}
                    id="is_active"
                  />
                  <label htmlFor="is_active">Active (visible on homepage)</label>
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t">
                  <button 
                    type="button" 
                    onClick={() => { setShowAddModal(false); setEditingHero(null); }} 
                    className="px-6 py-2 border rounded-lg hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit" 
                    className="px-6 py-2 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy flex items-center justify-center gap-2"
                    disabled={uploading}
                  >
                    {uploading ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                        Uploading...
                      </>
                    ) : (
                      <>
                        <Save className="h-4 w-4" />
                        {editingHero ? 'Update Hero' : 'Create Hero'}
                      </>
                    )}
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

export default HeroManager;