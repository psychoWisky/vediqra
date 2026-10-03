import React, { useState, useEffect } from 'react';
import { 
  X, Plus, Save, Trash2, Edit, Percent, DollarSign, 
  CheckCircle, XCircle, Search, Tag, RefreshCw, Copy, Eye, EyeOff
} from 'lucide-react';
import { apiFetch } from '../../utils/api';

interface Coupon {
  id: string;
  code: string;
  description: string;
  discount_type: 'percentage' | 'fixed';
  discount_value: number;
  min_order_amount: number | null;
  max_discount_amount: number | null;
  usage_limit: number;
  used_count: number;
  per_user_limit: number;
  start_date: string | null;
  end_date: string | null;
  applicable_categories: string[] | null;
  is_active: boolean;
  created_at: string;
  updated_at?: string;
}

interface CouponUsage {
  id: string;
  coupon_id: string;
  order_id: string;
  customer_email: string;
  discount_amount: number;
  used_at: string;
}

const CouponManager: React.FC = () => {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingCoupon, setEditingCoupon] = useState<Coupon | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive' | 'expired'>('all');
  const [selectedCoupon, setSelectedCoupon] = useState<Coupon | null>(null);
  const [showUsageModal, setShowUsageModal] = useState(false);
  const [couponUsage, setCouponUsage] = useState<CouponUsage[]>([]);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [copySuccess, setCopySuccess] = useState<string>('');
  const [categories, setCategories] = useState<string[]>([]);

  const [formData, setFormData] = useState({
    code: '',
    description: '',
    discount_type: 'percentage' as 'percentage' | 'fixed',
    discount_value: '',
    min_order_amount: '',
    max_discount_amount: '',
    usage_limit: '100',
    per_user_limit: '1',
    start_date: '',
    end_date: '',
    applicable_categories: [] as string[],
    is_active: true,
  });

  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchCoupons();
    fetchCategories();
  }, []);

  const fetchCategories = async () => {
    try {
      const data = await apiFetch('/api/categories');
      setCategories((data || []).map((c: any) => c.name));
    } catch {
      // Fallback to common categories
      setCategories(['Birthday', 'Anniversary', 'Valentine', 'Wedding', 'Corporate', 'Christmas']);
    }
  };

  const fetchCoupons = async () => {
    try {
      setLoading(true);
      const data = await apiFetch('/api/coupons');
      setCoupons(data || []);
    } catch (error) {
      console.error('Error fetching coupons:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchCouponUsage = async (couponId: string) => {
    try {
      setLoadingUsage(true);
      const data = await apiFetch(`/api/coupons/${couponId}/usage`);
      setCouponUsage(data || []);
    } catch (error) {
      console.error('Error fetching coupon usage:', error);
    } finally {
      setLoadingUsage(false);
    }
  };

  const validateForm = () => {
    const errors: Record<string, string> = {};
    
    if (!formData.code.trim()) {
      errors.code = 'Coupon code is required';
    } else if (formData.code.length < 3) {
      errors.code = 'Code must be at least 3 characters';
    }
    
    if (!formData.discount_value) {
      errors.discount_value = 'Discount value is required';
    } else {
      const val = parseFloat(formData.discount_value);
      if (formData.discount_type === 'percentage') {
        if (val <= 0 || val > 100) {
          errors.discount_value = 'Percentage must be between 1 and 100';
        }
      } else {
        if (val <= 0) {
          errors.discount_value = 'Discount amount must be greater than 0';
        }
      }
    }
    
    if (formData.min_order_amount && parseFloat(formData.min_order_amount) < 0) {
      errors.min_order_amount = 'Minimum order amount cannot be negative';
    }
    
    if (formData.usage_limit && parseInt(formData.usage_limit) < 1) {
      errors.usage_limit = 'Usage limit must be at least 1';
    }
    
    if (formData.per_user_limit && parseInt(formData.per_user_limit) < 1) {
      errors.per_user_limit = 'Per user limit must be at least 1';
    }
    
    if (formData.start_date && formData.end_date) {
      if (new Date(formData.start_date) > new Date(formData.end_date)) {
        errors.end_date = 'End date must be after start date';
      }
    }
    
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) return;

    try {
      const couponData = {
        ...formData,
        code: formData.code.toUpperCase(),
        discount_value: parseFloat(formData.discount_value),
        min_order_amount: formData.min_order_amount ? parseFloat(formData.min_order_amount) : null,
        max_discount_amount: formData.max_discount_amount ? parseFloat(formData.max_discount_amount) : null,
        usage_limit: parseInt(formData.usage_limit),
        per_user_limit: parseInt(formData.per_user_limit),
        start_date: formData.start_date || null,
        end_date: formData.end_date || null,
      };

      const url = editingCoupon 
        ? `/api/coupons/${editingCoupon.id}`
        : `/api/coupons`;

      await apiFetch(url, {
        method: editingCoupon ? 'PUT' : 'POST',
        body: JSON.stringify(couponData),
      });

      await fetchCoupons();
      setShowAddModal(false);
      setEditingCoupon(null);
      resetForm();
    } catch (error) {
      console.error('Error saving coupon:', error);
      alert('Failed to save coupon');
    }
  };

  const deleteCoupon = async (id: string) => {
    if (!confirm('Are you sure you want to delete this coupon? This action cannot be undone.')) return;
    try {
      await apiFetch(`/api/coupons/${id}`, { method: 'DELETE' });
      await fetchCoupons();
    } catch (error) {
      console.error('Error deleting coupon:', error);
    }
  };

  const toggleCouponStatus = async (coupon: Coupon) => {
    try {
      await apiFetch(`/api/coupons/${coupon.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: !coupon.is_active }),
      });
      await fetchCoupons();
    } catch (error) {
      console.error('Error toggling coupon status:', error);
    }
  };

  const viewUsage = async (coupon: Coupon) => {
    setSelectedCoupon(coupon);
    await fetchCouponUsage(coupon.id);
    setShowUsageModal(true);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopySuccess(text);
    setTimeout(() => setCopySuccess(''), 2000);
  };

  const resetForm = () => {
    setFormData({
      code: '',
      description: '',
      discount_type: 'percentage',
      discount_value: '',
      min_order_amount: '',
      max_discount_amount: '',
      usage_limit: '100',
      per_user_limit: '1',
      start_date: '',
      end_date: '',
      applicable_categories: [],
      is_active: true,
    });
    setFormErrors({});
  };

  const editCoupon = (coupon: Coupon) => {
    setEditingCoupon(coupon);
    setFormData({
      code: coupon.code,
      description: coupon.description || '',
      discount_type: coupon.discount_type,
      discount_value: coupon.discount_value.toString(),
      min_order_amount: coupon.min_order_amount?.toString() || '',
      max_discount_amount: coupon.max_discount_amount?.toString() || '',
      usage_limit: coupon.usage_limit.toString(),
      per_user_limit: coupon.per_user_limit.toString(),
      start_date: coupon.start_date ? coupon.start_date.split('T')[0] : '',
      end_date: coupon.end_date ? coupon.end_date.split('T')[0] : '',
      applicable_categories: coupon.applicable_categories || [],
      is_active: coupon.is_active,
    });
    setShowAddModal(true);
  };

  const filteredCoupons = coupons.filter(coupon => {
    const matchesSearch = 
      coupon.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (coupon.description?.toLowerCase() || '').includes(searchQuery.toLowerCase());

    if (!matchesSearch) return false;

    switch (filterStatus) {
      case 'active':
        return coupon.is_active && !isExpired(coupon.end_date);
      case 'inactive':
        return !coupon.is_active;
      case 'expired':
        return isExpired(coupon.end_date);
      default:
        return true;
    }
  });

  const isExpired = (endDate: string | null) => {
    if (!endDate) return false;
    return new Date(endDate) < new Date();
  };

  const isActive = (coupon: Coupon) => {
    return coupon.is_active && !isExpired(coupon.end_date);
  };

  const getStatusBadge = (coupon: Coupon) => {
    if (!coupon.is_active) {
      return <span className="px-2 py-1 bg-gray-100 text-gray-800 rounded-full text-xs">Inactive</span>;
    }
    if (isExpired(coupon.end_date)) {
      return <span className="px-2 py-1 bg-red-100 text-red-800 rounded-full text-xs">Expired</span>;
    }
    return <span className="px-2 py-1 bg-green-100 text-green-800 rounded-full text-xs">Active</span>;
  };

  const calculateRemainingDays = (endDate: string | null) => {
    if (!endDate) return null;
    const end = new Date(endDate);
    const now = new Date();
    const diffTime = end.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  };

  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow border border-gray-100 p-8">
        <div className="flex items-center justify-center">
          <RefreshCw className="h-8 w-8 animate-spin text-premium-gold" />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 border-b bg-gradient-to-r from-gray-50 to-white">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-serif font-semibold flex items-center">
              <Tag className="h-6 w-6 mr-2 text-premium-gold" />
              Coupon Management
            </h2>
            <p className="text-sm text-gray-600 mt-1">
              Create and manage discount coupons for your customers
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search coupons..."
                className="pl-10 pr-4 py-2 border rounded-lg focus:outline-none focus:border-premium-gold w-full sm:w-64"
              />
            </div>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as any)}
              className="px-4 py-2 border rounded-lg focus:outline-none focus:border-premium-gold"
            >
              <option value="all">All Coupons</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="expired">Expired</option>
            </select>
            <button
              onClick={() => {
                resetForm();
                setEditingCoupon(null);
                setShowAddModal(true);
              }}
              className="flex items-center justify-center space-x-2 px-4 py-2 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy transition-colors"
            >
              <Plus className="h-4 w-4" />
              <span>Create Coupon</span>
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 p-6 bg-gray-50 border-b">
        <div className="bg-white rounded-lg p-4 shadow-sm">
          <p className="text-sm text-gray-600">Total Coupons</p>
          <p className="text-2xl font-bold mt-1">{coupons.length}</p>
        </div>
        <div className="bg-white rounded-lg p-4 shadow-sm">
          <p className="text-sm text-gray-600">Active</p>
          <p className="text-2xl font-bold mt-1 text-green-600">
            {coupons.filter(c => isActive(c)).length}
          </p>
        </div>
        <div className="bg-white rounded-lg p-4 shadow-sm">
          <p className="text-sm text-gray-600">Expired</p>
          <p className="text-2xl font-bold mt-1 text-red-600">
            {coupons.filter(c => isExpired(c.end_date)).length}
          </p>
        </div>
        <div className="bg-white rounded-lg p-4 shadow-sm">
          <p className="text-sm text-gray-600">Total Used</p>
          <p className="text-2xl font-bold mt-1">
            {coupons.reduce((sum, c) => sum + (c.used_count || 0), 0)}
          </p>
        </div>
      </div>

      {filteredCoupons.length === 0 ? (
        <div className="p-12 text-center">
          <Tag className="h-16 w-16 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500 text-lg mb-2">No coupons found</p>
          <p className="text-sm text-gray-400 mb-6">
            {searchQuery || filterStatus !== 'all' 
              ? 'Try adjusting your search or filters' 
              : 'Create your first coupon to start offering discounts'}
          </p>
          {!searchQuery && filterStatus === 'all' && (
            <button
              onClick={() => {
                resetForm();
                setEditingCoupon(null);
                setShowAddModal(true);
              }}
              className="px-6 py-3 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy"
            >
              + Create Your First Coupon
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-4">Code</th>
                <th className="text-left p-4">Description</th>
                <th className="text-left p-4">Discount</th>
                <th className="text-left p-4">Min Order</th>
                <th className="text-left p-4">Usage</th>
                <th className="text-left p-4">Valid Until</th>
                <th className="text-left p-4">Status</th>
                <th className="text-left p-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredCoupons.map((coupon) => {
                const remainingDays = calculateRemainingDays(coupon.end_date);
                return (
                  <tr key={coupon.id} className="border-b hover:bg-gray-50">
                    <td className="p-4">
                      <div className="flex items-center">
                        <span className="font-mono font-bold text-premium-gold bg-premium-gold/10 px-3 py-1 rounded-lg">
                          {coupon.code}
                        </span>
                        <button
                          onClick={() => copyToClipboard(coupon.code)}
                          className="ml-2 p-1 hover:bg-gray-200 rounded"
                          title="Copy code"
                        >
                          <Copy className="h-4 w-4 text-gray-500" />
                        </button>
                        {copySuccess === coupon.code && (
                          <span className="ml-2 text-xs text-green-600">Copied!</span>
                        )}
                      </div>
                    </td>
                    <td className="p-4">
                      <p className="text-sm text-gray-600 line-clamp-2 max-w-xs">
                        {coupon.description || 'No description'}
                      </p>
                    </td>
                    <td className="p-4">
                      <div className="flex items-center">
                        {coupon.discount_type === 'percentage' ? (
                          <>
                            <Percent className="h-4 w-4 text-green-600 mr-1" />
                            <span className="font-semibold text-green-600">{coupon.discount_value}% OFF</span>
                          </>
                        ) : (
                          <>
                            <DollarSign className="h-4 w-4 text-green-600 mr-1" />
                            <span className="font-semibold text-green-600">₹{coupon.discount_value} OFF</span>
                          </>
                        )}
                      </div>
                      {coupon.max_discount_amount && (
                        <p className="text-xs text-gray-500 mt-1">
                          Max discount: ₹{coupon.max_discount_amount}
                        </p>
                      )}
                    </td>
                    <td className="p-4">
                      {coupon.min_order_amount ? (
                        <span>₹{coupon.min_order_amount}</span>
                      ) : (
                        <span className="text-gray-400">No min</span>
                      )}
                    </td>
                    <td className="p-4">
                      <div className="flex items-center">
                        <div className="w-16 bg-gray-200 rounded-full h-2 mr-2">
                          <div 
                            className="bg-premium-gold rounded-full h-2" 
                            style={{ width: `${Math.min((coupon.used_count / coupon.usage_limit) * 100, 100)}%` }}
                          />
                        </div>
                        <span className="text-sm">
                          {coupon.used_count}/{coupon.usage_limit}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        {coupon.per_user_limit} per user
                      </p>
                    </td>
                    <td className="p-4">
                      {coupon.end_date ? (
                        <div>
                          <span className="text-sm">
                            {new Date(coupon.end_date).toLocaleDateString()}
                          </span>
                          {remainingDays && remainingDays > 0 && (
                            <p className="text-xs text-gray-500 mt-1">
                              {remainingDays} days left
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="text-sm text-gray-500">No expiry</span>
                      )}
                    </td>
                    <td className="p-4">
                      {getStatusBadge(coupon)}
                    </td>
                    <td className="p-4">
                      <div className="flex space-x-2">
                        <button
                          onClick={() => viewUsage(coupon)}
                          className="p-2 hover:bg-gray-100 rounded transition-colors"
                          title="View Usage"
                        >
                          <Eye className="h-4 w-4 text-blue-600" />
                        </button>
                        <button
                          onClick={() => toggleCouponStatus(coupon)}
                          className="p-2 hover:bg-gray-100 rounded transition-colors"
                          title={coupon.is_active ? 'Deactivate' : 'Activate'}
                        >
                          {coupon.is_active ? (
                            <EyeOff className="h-4 w-4 text-orange-600" />
                          ) : (
                            <Eye className="h-4 w-4 text-green-600" />
                          )}
                        </button>
                        <button
                          onClick={() => editCoupon(coupon)}
                          className="p-2 hover:bg-gray-100 rounded transition-colors"
                          title="Edit"
                        >
                          <Edit className="h-4 w-4 text-blue-600" />
                        </button>
                        <button
                          onClick={() => deleteCoupon(coupon.id)}
                          className="p-2 hover:bg-gray-100 rounded transition-colors"
                          title="Delete"
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

      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-serif font-semibold flex items-center">
                  <Tag className="h-5 w-5 mr-2 text-premium-gold" />
                  {editingCoupon ? 'Edit Coupon' : 'Create New Coupon'}
                </h2>
                <button 
                  onClick={() => {
                    setShowAddModal(false);
                    setEditingCoupon(null);
                  }}
                  className="p-2 hover:bg-gray-100 rounded-lg"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2">
                      Coupon Code <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={formData.code}
                      onChange={(e) => setFormData({...formData, code: e.target.value.toUpperCase()})}
                      required
                      className={`w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none ${
                        formErrors.code ? 'border-red-500' : ''
                      }`}
                      placeholder="SAVE20"
                    />
                    {formErrors.code && (
                      <p className="text-red-500 text-xs mt-1">{formErrors.code}</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">Discount Type</label>
                    <div className="flex space-x-4">
                      <label className="flex items-center">
                        <input
                          type="radio"
                          value="percentage"
                          checked={formData.discount_type === 'percentage'}
                          onChange={(e) => setFormData({...formData, discount_type: e.target.value as 'percentage'})}
                          className="mr-2"
                        />
                        Percentage (%)
                      </label>
                      <label className="flex items-center">
                        <input
                          type="radio"
                          value="fixed"
                          checked={formData.discount_type === 'fixed'}
                          onChange={(e) => setFormData({...formData, discount_type: e.target.value as 'fixed'})}
                          className="mr-2"
                        />
                        Fixed (₹)
                      </label>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">
                      {formData.discount_type === 'percentage' ? 'Discount %' : 'Discount Amount'} <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="number"
                      value={formData.discount_value}
                      onChange={(e) => setFormData({...formData, discount_value: e.target.value})}
                      required
                      min="0"
                      step={formData.discount_type === 'percentage' ? "1" : "0.01"}
                      max={formData.discount_type === 'percentage' ? "100" : undefined}
                      className={`w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none ${
                        formErrors.discount_value ? 'border-red-500' : ''
                      }`}
                      placeholder={formData.discount_type === 'percentage' ? "20" : "100"}
                    />
                    {formErrors.discount_value && (
                      <p className="text-red-500 text-xs mt-1">{formErrors.discount_value}</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">Max Discount Amount (₹)</label>
                    <input
                      type="number"
                      value={formData.max_discount_amount}
                      onChange={(e) => setFormData({...formData, max_discount_amount: e.target.value})}
                      min="0"
                      step="0.01"
                      className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none"
                      placeholder="500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">Min Order Amount (₹)</label>
                    <input
                      type="number"
                      value={formData.min_order_amount}
                      onChange={(e) => setFormData({...formData, min_order_amount: e.target.value})}
                      min="0"
                      step="0.01"
                      className={`w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none ${
                        formErrors.min_order_amount ? 'border-red-500' : ''
                      }`}
                      placeholder="499"
                    />
                    {formErrors.min_order_amount && (
                      <p className="text-red-500 text-xs mt-1">{formErrors.min_order_amount}</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">Usage Limit</label>
                    <input
                      type="number"
                      value={formData.usage_limit}
                      onChange={(e) => setFormData({...formData, usage_limit: e.target.value})}
                      min="1"
                      className={`w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none ${
                        formErrors.usage_limit ? 'border-red-500' : ''
                      }`}
                      placeholder="100"
                    />
                    {formErrors.usage_limit && (
                      <p className="text-red-500 text-xs mt-1">{formErrors.usage_limit}</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">Per User Limit</label>
                    <input
                      type="number"
                      value={formData.per_user_limit}
                      onChange={(e) => setFormData({...formData, per_user_limit: e.target.value})}
                      min="1"
                      className={`w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none ${
                        formErrors.per_user_limit ? 'border-red-500' : ''
                      }`}
                      placeholder="1"
                    />
                    {formErrors.per_user_limit && (
                      <p className="text-red-500 text-xs mt-1">{formErrors.per_user_limit}</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">Start Date</label>
                    <input
                      type="date"
                      value={formData.start_date}
                      onChange={(e) => setFormData({...formData, start_date: e.target.value})}
                      className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-2">End Date</label>
                    <input
                      type="date"
                      value={formData.end_date}
                      onChange={(e) => setFormData({...formData, end_date: e.target.value})}
                      className={`w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none ${
                        formErrors.end_date ? 'border-red-500' : ''
                      }`}
                    />
                    {formErrors.end_date && (
                      <p className="text-red-500 text-xs mt-1">{formErrors.end_date}</p>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Description</label>
                  <textarea
                    value={formData.description}
                    onChange={(e) => setFormData({...formData, description: e.target.value})}
                    rows={2}
                    className="w-full px-4 py-3 border rounded-lg focus:border-premium-gold focus:outline-none"
                    placeholder="Get 20% off on all products"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">Applicable Categories (Optional)</label>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2 p-4 border rounded-lg bg-gray-50">
                    {categories.map(cat => (
                      <label key={cat} className="flex items-center space-x-2">
                        <input
                          type="checkbox"
                          checked={formData.applicable_categories.includes(cat)}
                          onChange={(e) => {
                            const newCategories = e.target.checked
                              ? [...formData.applicable_categories, cat]
                              : formData.applicable_categories.filter(c => c !== cat);
                            setFormData({...formData, applicable_categories: newCategories});
                          }}
                          className="rounded text-premium-gold focus:ring-premium-gold"
                        />
                        <span>{cat}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="flex items-center space-x-3 p-4 bg-gray-50 rounded-lg">
                  <input
                    type="checkbox"
                    id="is_active"
                    checked={formData.is_active}
                    onChange={(e) => setFormData({...formData, is_active: e.target.checked})}
                    className="h-4 w-4 text-premium-gold rounded focus:ring-premium-gold"
                  />
                  <label htmlFor="is_active" className="text-sm font-medium">
                    Coupon is active (immediately available for customers)
                  </label>
                </div>

                <div className="flex justify-end space-x-3 pt-4 border-t">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddModal(false);
                      setEditingCoupon(null);
                    }}
                    className="px-6 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-6 py-3 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy flex items-center"
                  >
                    <Save className="h-5 w-5 mr-2" />
                    {editingCoupon ? 'Update Coupon' : 'Create Coupon'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {showUsageModal && selectedCoupon && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-2xl font-serif font-semibold">Coupon Usage</h2>
                  <p className="text-sm text-gray-600 mt-1">
                    Coupon: <span className="font-mono font-bold text-premium-gold">{selectedCoupon.code}</span>
                  </p>
                </div>
                <button 
                  onClick={() => {
                    setShowUsageModal(false);
                    setSelectedCoupon(null);
                  }}
                  className="p-2 hover:bg-gray-100 rounded-lg"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {loadingUsage ? (
                <div className="py-12 text-center">
                  <RefreshCw className="h-8 w-8 animate-spin text-premium-gold mx-auto mb-4" />
                  <p className="text-gray-600">Loading usage data...</p>
                </div>
              ) : couponUsage.length === 0 ? (
                <div className="py-12 text-center">
                  <p className="text-gray-500">No usage data available</p>
                  <p className="text-sm text-gray-400 mt-2">This coupon hasn't been used yet</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-4 mb-6">
                    <div className="bg-gray-50 p-4 rounded-lg text-center">
                      <p className="text-sm text-gray-600">Total Used</p>
                      <p className="text-2xl font-bold text-premium-gold">{couponUsage.length}</p>
                    </div>
                    <div className="bg-gray-50 p-4 rounded-lg text-center">
                      <p className="text-sm text-gray-600">Total Discount</p>
                      <p className="text-2xl font-bold text-green-600">
                        ₹{couponUsage.reduce((sum, u) => sum + u.discount_amount, 0).toFixed(2)}
                      </p>
                    </div>
                    <div className="bg-gray-50 p-4 rounded-lg text-center">
                      <p className="text-sm text-gray-600">Avg. Discount</p>
                      <p className="text-2xl font-bold text-blue-600">
                        ₹{(couponUsage.reduce((sum, u) => sum + u.discount_amount, 0) / couponUsage.length).toFixed(2)}
                      </p>
                    </div>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left p-3">Customer Email</th>
                          <th className="text-left p-3">Order ID</th>
                          <th className="text-left p-3">Discount</th>
                          <th className="text-left p-3">Used On</th>
                        </tr>
                      </thead>
                      <tbody>
                        {couponUsage.map((usage) => (
                          <tr key={usage.id} className="border-b hover:bg-gray-50">
                            <td className="p-3">{usage.customer_email}</td>
                            <td className="p-3">
                              <span className="font-mono text-sm">{usage.order_id?.slice(0, 8)}...</span>
                            </td>
                            <td className="p-3 font-semibold text-green-600">
                              ₹{usage.discount_amount}
                            </td>
                            <td className="p-3 text-sm text-gray-600">
                              {new Date(usage.used_at).toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CouponManager;