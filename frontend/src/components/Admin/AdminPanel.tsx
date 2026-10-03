import React, { useState, useEffect } from 'react';
import { 
  LogOut, Package, DollarSign, TrendingUp, Eye, 
  RefreshCw, Plus, Edit, Trash2, Download, Search,
  ShoppingBag, MapPin, Phone, Mail, Calendar,
  BarChart3, Shield, Printer, XCircle, Tag, Copy,
  Image as ImageIcon, Star, Video, Gift, ChevronDown,
  ChevronUp, ChevronsLeft, ChevronsRight, ArrowUpDown,
  Loader, Filter, CreditCard, Truck, CheckCircle, X, Users,
  FileText, DownloadCloud, ExternalLink
}
from 'lucide-react';
import { Order, Product, Combo, ComboProduct } from '../../types';
import CategoryManager from './CategoryManager';
import { formatCurrency, getImageUrl, getProductImage } from '../../utils/helpers';
import ProductUpload from './ProductUpload';
import ComboManager from './ComboManager';
import EditProduct from './EditProduct';
import InvoicePDF from './InvoicePDF';
import CouponManager from './CouponManager';
import { useApi } from '../../hooks/useApi';
import { apiFetch } from '../../utils/api';
import ReviewManager from './ReviewManager';
import HeroManager from './HeroManager';
import PopupManager from './PopupManager';
import CloudFileManager from './CloudFileManager';
import LogoManager from './LogoManager';
import toast from 'react-hot-toast';

const AdminPanel: React.FC = () => {
  const { fetchWithAuth } = useApi();
  const [orders, setOrders] = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [combos, setCombos] = useState<Combo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'orders' | 'products' | 'combos' | 'coupons' | 'categories' | 'hero' | 'reviews' | 'popups' | 'logo' | 'storage'>('dashboard');
  const [showProductUpload, setShowProductUpload] = useState(false);
  const [showComboManager, setShowComboManager] = useState(false);
  const [showEditProduct, setShowEditProduct] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [trackingInput, setTrackingInput] = useState<string>('');
  const [showInvoice, setShowInvoice] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingCombo, setEditingCombo] = useState<Combo | null>(null);
  const [copySuccess, setCopySuccess] = useState<string>('');
  const [downloadingAll, setDownloadingAll] = useState(false);

  // Filter dropdown states
  const [showFilters, setShowFilters] = useState(false);
  
  // Order filter states
  const [orderStatusFilter, setOrderStatusFilter] = useState<string>('all');
  const [orderPaymentFilter, setOrderPaymentFilter] = useState<string>('all');
  const [orderCustomizationFilter, setOrderCustomizationFilter] = useState<string>('all');
  
  // Product filter states
  const [productCategoryFilter, setProductCategoryFilter] = useState<string>('all');
  const [productGenderFilter, setProductGenderFilter] = useState<string>('all');
  const [productCustomizableFilter, setProductCustomizableFilter] = useState<string>('all');
  const [productStatusFilter, setProductStatusFilter] = useState<string>('all');
  
  // Combo filter states
  const [comboStatusFilter, setComboStatusFilter] = useState<string>('all');

  // Server-side pagination - orders
  const [orderPage, setOrderPage] = useState(1);
  const ordersPerPage = 25;
  const [orderTotal, setOrderTotal] = useState(0);
  const [orderSortField, setOrderSortField] = useState<'date' | 'status' | 'amount' | 'name' | 'payment' | 'customization'>('date');
  const [orderSortDirection, setOrderSortDirection] = useState<'asc' | 'desc'>('desc');
  const [filteredOrders, setFilteredOrders] = useState<Order[]>([]);
  const [paginatedOrders, setPaginatedOrders] = useState<Order[]>([]);

  // Server-side pagination - products
  const [productPage, setProductPage] = useState(1);
  const productsPerPage = 25;
  const [productTotal, setProductTotal] = useState(0);
  const [productSortField, setProductSortField] = useState<'name' | 'price' | 'stock' | 'category' | 'gender' | 'customizable' | 'status'>('name');
  const [productSortDirection, setProductSortDirection] = useState<'asc' | 'desc'>('asc');
  const [filteredProducts, setFilteredProducts] = useState<Product[]>([]);
  const [paginatedProducts, setPaginatedProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);

  // Server-side pagination - combos
  const [comboPage, setComboPage] = useState(1);
  const combosPerPage = 25;
  const [comboTotal, setComboTotal] = useState(0);
  const [comboSortField, setComboSortField] = useState<'name' | 'price' | 'status' | 'productsCount'>('name');
  const [comboSortDirection, setComboSortDirection] = useState<'asc' | 'desc'>('asc');
  const [filteredCombos, setFilteredCombos] = useState<Combo[]>([]);
  const [paginatedCombos, setPaginatedCombos] = useState<Combo[]>([]);
  const [loadingCombos, setLoadingCombos] = useState(false);

  const [stats, setStats] = useState({
    totalOrders: 0,
    totalRevenue: 0,
    pendingOrders: 0,
    completedOrders: 0,
    totalProducts: 0,
    totalCombos: 0,
    thisMonthRevenue: 0,
    averageOrderValue: 0,
  });

  useEffect(() => {
    fetchDashboardData();
  }, []);

  // Server-side search debounce - triggers API call after 400ms pause
  useEffect(() => {
    const timer = setTimeout(() => {
      if (activeTab === 'orders') fetchOrderPage(1, searchQuery, orderStatusFilter);
      if (activeTab === 'products') fetchProductPage(1, searchQuery);
      if (activeTab === 'combos') fetchComboPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // When status filter changes, refetch orders from server
  useEffect(() => {
    fetchOrderPage(1, searchQuery, orderStatusFilter);
  }, [orderStatusFilter]);

  // When tab changes, ensure data is loaded
  useEffect(() => {
    if (activeTab === 'products' && products.length === 0) fetchProductPage(1);
    if (activeTab === 'combos' && combos.length === 0) fetchComboPage(1);
  }, [activeTab]);

const fetchDashboardData = async () => {
  try {
    setLoading(true);

    // Load first page of orders immediately — powers the dashboard
    const ordersResp = await fetchWithAuth('/api/admin/orders?limit=25&offset=0');
    const ordersData: Order[] = ordersResp.data || ordersResp;
    const ordersTotal: number = ordersResp.total ?? ordersData.length;

    setOrders(ordersData);
    setFilteredOrders(ordersData);
    setPaginatedOrders(ordersData);
    setOrderTotal(ordersTotal);
    setOrderPage(1);

    const totalRevenue = ordersData.reduce(
      (sum: number, o: Order) =>
        ['paid', 'delivered', 'completed'].includes(o.status) ? sum + o.total_amount : sum, 0
    );
    const pendingOrders = ordersData.filter((o: Order) =>
      ['created', 'pending', 'processing'].includes(o.status)
    ).length;
    const completedOrders = ordersData.filter((o: Order) =>
      ['paid', 'delivered', 'completed'].includes(o.status)
    ).length;
    const thisMonth = new Date().getMonth();
    const thisMonthRevenue = ordersData
      .filter((o: Order) => new Date(o.created_at).getMonth() === thisMonth)
      .reduce((sum: number, o: Order) => sum + o.total_amount, 0);

    setStats(prev => ({
      ...prev,
      totalOrders: ordersTotal,
      totalRevenue,
      pendingOrders,
      completedOrders,
      thisMonthRevenue,
      averageOrderValue: ordersData.length ? totalRevenue / ordersData.length : 0,
    }));

    setLoading(false);

    // Background: load first page of products and combos
    fetchWithAuth('/api/admin/products?limit=25&offset=0').then((resp: any) => {
      const data = resp.data || resp;
      const total = resp.total ?? data.length;
      const mapped = data.map((p: any) => ({ ...p, colors: p.colors || [], sizes: p.sizes || [], categories: p.categories || [] }));
      setProducts(mapped);
      setFilteredProducts(mapped);
      setPaginatedProducts(mapped);
      setProductTotal(total);
      setProductPage(1);
      setStats(prev => ({ ...prev, totalProducts: total }));
    }).catch(console.error);

    fetchWithAuth('/api/admin/combos?limit=25&offset=0').then((resp: any) => {
      const data = resp.data || resp;
      const total = resp.total ?? data.length;
      setCombos(data);
      setFilteredCombos(data);
      setPaginatedCombos(data);
      setComboTotal(total);
      setComboPage(1);
      setStats(prev => ({ ...prev, totalCombos: total }));
    }).catch(console.error);

  } catch (err) {
    console.error('Error fetching dashboard data:', err);
    alert('Failed to load dashboard data. Please check your connection.');
    setLoading(false);
  }
};

const fetchOrderPage = async (page: number, search?: string, status?: string) => {
  try {
    const offset = (page - 1) * ordersPerPage;
    const params = new URLSearchParams({ limit: String(ordersPerPage), offset: String(offset) });
    if (search) params.set('search', search);
    if (status && status !== 'all') params.set('status', status);
    const resp = await fetchWithAuth(`/api/admin/orders?${params}`);
    const data: Order[] = resp.data || resp;
    const total: number = resp.total ?? data.length;
    setOrders(data);
    setFilteredOrders(data);
    setPaginatedOrders(data);
    setOrderTotal(total);
    setOrderPage(page);
  } catch (err) { console.error(err); }
};

const fetchProductPage = async (page: number, search?: string) => {
  try {
    setLoadingProducts(true);
    const offset = (page - 1) * productsPerPage;
    const params = new URLSearchParams({ limit: String(productsPerPage), offset: String(offset) });
    if (search) params.set('search', search);
    const resp = await fetchWithAuth(`/api/admin/products?${params}`);
    const data = (resp.data || resp).map((p: any) => ({ ...p, colors: p.colors || [], sizes: p.sizes || [], categories: p.categories || [] }));
    const total: number = resp.total ?? data.length;
    setProducts(data);
    setFilteredProducts(data);
    setPaginatedProducts(data);
    setProductTotal(total);
    setProductPage(page);
  } catch (err) { console.error(err); }
  finally { setLoadingProducts(false); }
};

const fetchComboPage = async (page: number) => {
  try {
    setLoadingCombos(true);
    const offset = (page - 1) * combosPerPage;
    const resp = await fetchWithAuth(`/api/admin/combos?limit=${combosPerPage}&offset=${offset}`);
    const data = resp.data || resp;
    const total: number = resp.total ?? data.length;
    setCombos(data);
    setFilteredCombos(data);
    setPaginatedCombos(data);
    setComboTotal(total);
    setComboPage(page);
  } catch (err) { console.error(err); }
  finally { setLoadingCombos(false); }
};


  const loadMoreData = async () => {
    setLoadingMore(true);
    // Simulate loading more data
    await new Promise(resolve => setTimeout(resolve, 1000));
    setLoadingMore(false);
  };

  const deleteCombo = async (comboId: string) => {
    if (!confirm('Are you sure you want to delete this combo?')) return;
    try {
      await fetchWithAuth(`/api/admin/combos/${comboId}`, { method: 'DELETE' });
      setCombos(prev => prev.filter(c => c.id !== comboId));
      toast.success('Combo deleted successfully!');
    } catch (error) {
      console.error('Error deleting combo:', error);
      alert('Failed to delete combo');
    }
  };

  const toggleComboStatus = async (combo: Combo) => {
    try {
      await fetchWithAuth(`/api/admin/combos/${combo.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: !combo.is_active }),
      });
      setCombos(prev => prev.map(c => c.id === combo.id ? { ...c, is_active: !c.is_active } : c));
      toast.success(`Combo ${!combo.is_active ? 'activated' : 'deactivated'} successfully!`);
    } catch (error) {
      console.error('Error updating combo status:', error);
      alert('Failed to update combo status');
    }
  };

const updateOrderStatus = async (orderId: string, status: string, trackingNumber?: string) => {
  try {
    // Get the current order data before updating
    const currentOrder = orders.find(o => o.id === orderId);
    const oldStatus = currentOrder?.status;
    
    // Don't send email if status hasn't changed AND no tracking update
    if (oldStatus === status && trackingNumber === undefined) {
      return;
    }
    
    const response = await fetchWithAuth(`/api/admin/orders/${orderId}`, {
      method: 'PUT',
      body: JSON.stringify({ 
        status, 
        tracking_number: trackingNumber !== undefined ? trackingNumber : (currentOrder?.tracking_number || '')
      }),
    });
    
    console.log('Order update response:', response);
    
    // After successful update, trigger status email only if status changed
    if (response.success) {
      if (oldStatus !== status) {
        try {
          const emailResponse = await fetchWithAuth('/api/orders/send-status-email', {
            method: 'POST',
            body: JSON.stringify({
              orderId,
              oldStatus,
              newStatus: status,
              trackingNumber
            })
          });
          
          if (emailResponse.success) {
            toast.success(`Order status updated to ${status} and email sent!`);
          } else {
            toast.success(`Order status updated to ${status} (Email notification failed)`);
          }
        } catch (emailError) {
          console.error('Failed to send status email:', emailError);
          toast.success(`Order status updated to ${status} (Email notification failed)`);
        }
      } else {
        toast.success('Tracking number saved!');
      }
      
      // Update local state to avoid full refetch
      setOrders(prev => prev.map(o => o.id === orderId ? { ...o, status, tracking_number: trackingNumber !== undefined ? trackingNumber : o.tracking_number } : o));
      setSelectedOrder(prev => prev ? { ...prev, status, tracking_number: trackingNumber !== undefined ? trackingNumber : prev.tracking_number } : prev);
    }
  } catch (error) {
    console.error('Error updating order:', error);
    alert('Failed to update order status');
  }
};
  const deleteProduct = async (productId: string) => {
  if (!confirm('Are you sure you want to delete this product?')) return;

  // Optimistic update — remove immediately so UI feels instant
  const snapshot = products;
  setProducts(prev => prev.filter(p => p.id !== productId));
  setFilteredProducts(prev => prev.filter(p => p.id !== productId));
  setPaginatedProducts(prev => prev.filter(p => p.id !== productId));
  toast.success('Product deleted successfully!');

  try {
    await fetchWithAuth(`/api/admin/products/${productId}`, { method: 'DELETE' });
  } catch (error: any) {
    // Restore state on failure
    setProducts(snapshot);
    setFilteredProducts(snapshot);
    setPaginatedProducts(snapshot);
    console.error('Error deleting product:', error);

    if (error.message?.includes('Cannot delete product that has existing orders')) {
      toast.error('This product has existing orders and cannot be deleted. You can deactivate it instead.');
    } else if (error.message?.includes('Cannot delete product that is part of a combo')) {
      toast.error('This product is part of a combo. Remove it from combos first.');
    } else {
      toast.error('Failed to delete product');
    }
  }
};

  const toggleProductStatus = async (product: Product) => {
    try {
      await fetchWithAuth(`/api/admin/products/${product.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: !product.is_active }),
      });
      setProducts(prev => prev.map(p => p.id === product.id ? { ...p, is_active: !p.is_active } : p));
      toast.success(`Product ${!product.is_active ? 'activated' : 'deactivated'} successfully!`);
    } catch (error) {
      console.error('Error updating product status:', error);
      alert('Failed to update product status');
    }
  };

  const handleEditProduct = async (product: Product) => {
    // Lazily load colors & sizes only when editing
    let enriched = { ...product };
    const fetches: Promise<void>[] = [];
    if (product.has_colors && (!product.colors || product.colors.length === 0)) {
      fetches.push(
        fetchWithAuth(`/api/admin/products/${product.id}/colors`)
          .then((data: any) => { enriched = { ...enriched, colors: data || [] }; })
          .catch(() => {})
      );
    }
    if (product.has_sizes && (!product.sizes || product.sizes.length === 0)) {
      fetches.push(
        fetchWithAuth(`/api/admin/products/${product.id}/sizes/all`)
          .then((data: any) => { enriched = { ...enriched, sizes: data || [] }; })
          .catch(() => {})
      );
    }
    if (fetches.length > 0) await Promise.all(fetches);
    setEditingProduct(enriched as Product);
    setShowEditProduct(true);
  };

  const handleEditCombo = (combo: Combo) => {
    setEditingCombo(combo);
    setShowComboManager(true);
  };

  const handleLogout = () => {
    localStorage.removeItem('admin_token');
    window.location.href = '/admin';
  };

  const getStatusColor = (status: string) => {
    const statusLower = status.toLowerCase();
    switch (statusLower) {
      case 'paid':
      case 'delivered':
      case 'completed':
        return 'bg-green-100 text-green-800 border-green-200';
      case 'shipped':
      case 'processing':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'pending':
      case 'created':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'cancelled':
      case 'failed':
      case 'refunded':
        return 'bg-red-100 text-red-800 border-red-200';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const copyToClipboard = (text: string, message?: string) => {
    navigator.clipboard.writeText(text);
    setCopySuccess(text);
    toast.success(message || 'Copied to clipboard!');
    setTimeout(() => setCopySuccess(''), 2000);
  };

  const downloadImage = (url: string, filename: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const downloadAllImages = async (imageUrls: string[], orderId: string) => {
    setDownloadingAll(true);
    try {
      for (let i = 0; i < imageUrls.length; i++) {
        const url = imageUrls[i];
        downloadImage(url, `custom-image-${i + 1}.jpg`);
        // Small delay between downloads
        if (i < imageUrls.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      toast.success(`Downloaded ${imageUrls.length} images`);
    } catch (error) {
      console.error('Error downloading images:', error);
      toast.error('Failed to download some images');
    } finally {
      setDownloadingAll(false);
    }
  };

  const exportOrdersCSV = () => {
    const csvData = filteredOrders.map(order => ({
      'Order ID': order.custom_order_id || order.id,
      'Internal ID': order.id,
      'Date': new Date(order.created_at).toLocaleDateString(),
      'Customer Name': order.customer_name,
      'Customer Email': order.customer_email,
      'Customer Phone': order.customer_phone || '',
      'Address': order.shipping_address || '',
      'City': order.shipping_city || '',
      'State': order.shipping_state || '',
      'Pincode': order.shipping_pincode || '',
      'Amount': order.total_amount,
      'Status': order.status,
      'Payment Status': ['paid', 'delivered', 'completed'].includes(order.status) ? 'Paid' : 'Pending',
      'Has Customization': Array.isArray(order.items) 
        ? order.items.some((item: any) => item.customization).toString()
        : 'false',
      'Tracking Number': order.tracking_number || '',
      'Payment ID': order.razorpay_payment_id || '',
      'Items Count': Array.isArray(order.items) ? order.items.length : 0,
    }));

    const headers = Object.keys(csvData[0]).join(',');
    const rows = csvData.map(row => Object.values(row).join(',')).join('\n');
    const csv = `${headers}\n${rows}`;
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orders_export_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  const generateInvoice = (_order: Order) => {
    setShowInvoice(true);
  };


  const clearOrderFilters = () => {
    setOrderStatusFilter('all');
    setOrderPaymentFilter('all');
    setOrderCustomizationFilter('all');
    setSearchQuery('');
    fetchOrderPage(1, '', 'all');
  };

  const clearProductFilters = () => {
    setProductCategoryFilter('all');
    setProductGenderFilter('all');
    setProductCustomizableFilter('all');
    setProductStatusFilter('all');
    setSearchQuery('');
    fetchProductPage(1, '');
  };

  const clearComboFilters = () => {
    setComboStatusFilter('all');
    setSearchQuery('');
    fetchComboPage(1);
  };

  // Sort button component
  const SortButton = ({ field, currentField, direction, onSort, children }: any) => (
    <button
      onClick={() => onSort(field)}
      className="flex items-center gap-1 hover:text-premium-gold transition-colors whitespace-nowrap"
    >
      {children}
      {currentField === field ? (
        direction === 'asc' ? (
          <ChevronUp className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        )
      ) : (
        <ArrowUpDown className="h-4 w-4 opacity-30" />
      )}
    </button>
  );

  // Filter dropdown component
  const FilterDropdown = ({ label, value, options, onChange, icon }: any) => (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pl-8 pr-4 py-2 border rounded-lg text-sm focus:outline-none focus:border-premium-gold appearance-none bg-white"
      >
        <option value="all">{label} - All</option>
        {options.map((opt: any) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      <div className="absolute left-2 top-1/2 transform -translate-y-1/2">
        {icon}
      </div>
    </div>
  );

  // Pagination component
  const Pagination = ({ currentPage, totalItems, itemsPerPage, onPageChange }: any) => {
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    if (totalPages <= 1) return null;

    const pageNumbers = [];
    const maxVisible = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    
    if (endPage - startPage + 1 < maxVisible) {
      startPage = Math.max(1, endPage - maxVisible + 1);
    }

    for (let i = startPage; i <= endPage; i++) {
      pageNumbers.push(i);
    }

    return (
      <div className="flex items-center justify-between px-6 py-4 border-t">
        <div className="text-sm text-gray-600">
          Showing {Math.min((currentPage - 1) * itemsPerPage + 1, totalItems)} to{' '}
          {Math.min(currentPage * itemsPerPage, totalItems)} of {totalItems} results
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onPageChange(1)}
            disabled={currentPage === 1}
            className="p-2 hover:bg-gray-100 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ChevronsLeft className="h-5 w-5" />
          </button>
          {pageNumbers.map(number => (
            <button
              key={number}
              onClick={() => onPageChange(number)}
              className={`px-3 py-1 rounded ${
                currentPage === number
                  ? 'bg-premium-gold text-white'
                  : 'hover:bg-gray-100'
              }`}
            >
              {number}
            </button>
          ))}
          <button
            onClick={() => onPageChange(totalPages)}
            disabled={currentPage === totalPages}
            className="p-2 hover:bg-gray-100 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ChevronsRight className="h-5 w-5" />
          </button>
        </div>
      </div>
    );
  };

  if (loading && activeTab === 'dashboard') {
    return (
      <div className="min-h-screen bg-premium-cream flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="h-12 w-12 animate-spin text-premium-gold mx-auto mb-4" />
          <p className="text-gray-600">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-3">
                <Shield className="h-8 w-8 text-premium-gold" />
                <div>
                  <h1 className="text-2xl font-serif font-bold">Admin Dashboard</h1>
                  <p className="text-sm text-gray-600">Premium Gift Shop Management</p>
                </div>
              </div>
              <div className="hidden md:flex items-center space-x-1 ml-8">
                {/* Dashboard - always visible */}
                <button
                  onClick={() => setActiveTab('dashboard')}
                  className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition-colors ${
                    activeTab === 'dashboard'
                      ? 'bg-premium-gold text-white'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  <BarChart3 className="h-4 w-4" />
                  <span>Dashboard</span>
                </button>

                {/* Orders - always visible */}
                <button
                  onClick={() => setActiveTab('orders')}
                  className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition-colors ${
                    activeTab === 'orders'
                      ? 'bg-premium-gold text-white'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  <Package className="h-4 w-4" />
                  <span>Orders</span>
                </button>

                {/* Products Dropdown */}
                <div className="relative group">
                  <button
                    className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition-colors ${
                      ['products', 'combos', 'categories'].includes(activeTab)
                        ? 'bg-premium-gold text-white'
                        : 'text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    <ShoppingBag className="h-4 w-4" />
                    <span>Products</span>
                    <ChevronDown className="h-4 w-4" />
                  </button>
                  
                  <div className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-xl border py-2 min-w-[180px] opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
                    <button
                      onClick={() => setActiveTab('products')}
                      className={`w-full text-left px-4 py-2 hover:bg-gray-50 flex items-center space-x-2 ${
                        activeTab === 'products' ? 'bg-premium-cream text-premium-gold' : ''
                      }`}
                    >
                      <ShoppingBag className="h-4 w-4" />
                      <span>Products</span>
                    </button>
                    <button
                      onClick={() => setActiveTab('combos')}
                      className={`w-full text-left px-4 py-2 hover:bg-gray-50 flex items-center space-x-2 ${
                        activeTab === 'combos' ? 'bg-premium-cream text-premium-gold' : ''
                      }`}
                    >
                      <Package className="h-4 w-4" />
                      <span>Combos</span>
                    </button>
                    <button
                      onClick={() => setActiveTab('categories')}
                      className={`w-full text-left px-4 py-2 hover:bg-gray-50 flex items-center space-x-2 ${
                        activeTab === 'categories' ? 'bg-premium-cream text-premium-gold' : ''
                      }`}
                    >
                      <Tag className="h-4 w-4" />
                      <span>Categories</span>
                    </button>
                  </div>
                </div>

                {/* Marketing Dropdown */}
                <div className="relative group">
                  <button
                    className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition-colors ${
                      ['coupons', 'reviews', 'hero', 'popups', 'logo'].includes(activeTab)
                        ? 'bg-premium-gold text-white'
                        : 'text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    <Gift className="h-4 w-4" />
                    <span>Marketing</span>
                    <ChevronDown className="h-4 w-4" />
                  </button>
                  
                  <div className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-xl border py-2 min-w-[180px] opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
                    <button
                      onClick={() => setActiveTab('coupons')}
                      className={`w-full text-left px-4 py-2 hover:bg-gray-50 flex items-center space-x-2 ${
                        activeTab === 'coupons' ? 'bg-premium-cream text-premium-gold' : ''
                      }`}
                    >
                      <Tag className="h-4 w-4" />
                      <span>Coupons</span>
                    </button>
                    <button
                      onClick={() => setActiveTab('reviews')}
                      className={`w-full text-left px-4 py-2 hover:bg-gray-50 flex items-center space-x-2 ${
                        activeTab === 'reviews' ? 'bg-premium-cream text-premium-gold' : ''
                      }`}
                    >
                      <Star className="h-4 w-4" />
                      <span>Reviews</span>
                    </button>
                    <button
                      onClick={() => setActiveTab('hero')}
                      className={`w-full text-left px-4 py-2 hover:bg-gray-50 flex items-center space-x-2 ${
                        activeTab === 'hero' ? 'bg-premium-cream text-premium-gold' : ''
                      }`}
                    >
                      <Video className="h-4 w-4" />
                      <span>Hero</span>
                    </button>
                    <button
                      onClick={() => setActiveTab('popups')}
                      className={`w-full text-left px-4 py-2 hover:bg-gray-50 flex items-center space-x-2 ${
                        activeTab === 'popups' ? 'bg-premium-cream text-premium-gold' : ''
                      }`}
                    >
                      <Gift className="h-4 w-4" />
                      <span>Popups</span>
                    </button>
                    <button
                      onClick={() => setActiveTab('logo')}
                      className={`w-full text-left px-4 py-2 hover:bg-gray-50 flex items-center space-x-2 ${
                        activeTab === 'logo' ? 'bg-premium-cream text-premium-gold' : ''
                      }`}
                    >
                      <ImageIcon className="h-4 w-4" />
                      <span>Logo</span>
                    </button>
                    <button
                      onClick={() => setActiveTab('storage')}
                      className={`w-full text-left px-4 py-3 rounded-xl text-sm font-medium transition-colors flex items-center gap-3 ${
                        activeTab === 'storage' ? 'bg-premium-cream text-premium-gold' : ''
                      }`}
                    >
                      ☁️ Cloud Storage
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <button
                onClick={fetchDashboardData}
                className="p-2 hover:bg-gray-100 rounded-lg"
                title="Refresh Data"
              >
                <RefreshCw className="h-5 w-5" />
              </button>
              <button
                onClick={handleLogout}
                className="flex items-center space-x-2 px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg"
              >
                <LogOut className="h-5 w-5" />
                <span className="hidden sm:inline">Logout</span>
              </button>
            </div>
          </div>

          <div className="md:hidden mt-4 overflow-x-auto">
            <div className="flex space-x-2">
              {['dashboard', 'orders', 'products', 'combos', 'coupons', 'categories', 'reviews', 'hero', 'popups', 'logo', 'storage'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab as any)}
                  className={`px-3 py-2 rounded-lg text-sm whitespace-nowrap ${
                    activeTab === tab
                      ? 'bg-premium-gold text-white'
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 py-8">
        {activeTab === 'dashboard' && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
              <div className="bg-white rounded-xl p-6 shadow border border-gray-100">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-600">Total Revenue</p>
                    <p className="text-3xl font-bold mt-2">{formatCurrency(stats.totalRevenue)}</p>
                  </div>
                  <div className="p-3 bg-green-50 rounded-lg">
                    <DollarSign className="h-6 w-6 text-green-600" />
                  </div>
                </div>
                <div className="mt-4 text-sm text-green-600">
                  +{Math.round((stats.thisMonthRevenue / (stats.totalRevenue - stats.thisMonthRevenue)) * 100)}% from last month
                </div>
              </div>

              <div className="bg-white rounded-xl p-6 shadow border border-gray-100">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-600">Total Orders</p>
                    <p className="text-3xl font-bold mt-2">{stats.totalOrders}</p>
                  </div>
                  <div className="p-3 bg-blue-50 rounded-lg">
                    <Package className="h-6 w-6 text-blue-600" />
                  </div>
                </div>
                <div className="mt-4">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${stats.pendingOrders > 0 ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'}`}>
                    {stats.pendingOrders} pending
                  </span>
                </div>
              </div>

              <div className="bg-white rounded-xl p-6 shadow border border-gray-100">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-600">Products</p>
                    <p className="text-3xl font-bold mt-2">{stats.totalProducts}</p>
                  </div>
                  <div className="p-3 bg-purple-50 rounded-lg">
                    <ShoppingBag className="h-6 w-6 text-purple-600" />
                  </div>
                </div>
                <div className="mt-4">
                  <button
                    onClick={() => setShowProductUpload(true)}
                    className="text-sm text-premium-gold hover:text-premium-burgundy font-medium"
                  >
                    + Add Product
                  </button>
                </div>
              </div>

              <div className="bg-white rounded-xl p-6 shadow border border-gray-100">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-gray-600">Avg. Order Value</p>
                    <p className="text-3xl font-bold mt-2">{formatCurrency(stats.averageOrderValue)}</p>
                  </div>
                  <div className="p-3 bg-orange-50 rounded-lg">
                    <TrendingUp className="h-6 w-6 text-orange-600" />
                  </div>
                </div>
                <div className="mt-4 text-sm text-gray-600">
                  This month: {formatCurrency(stats.thisMonthRevenue)}
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow border border-gray-100 p-6 mb-8">
              <h2 className="text-xl font-semibold mb-6">Quick Actions</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <button
                  onClick={() => setShowProductUpload(true)}
                  className="p-4 border rounded-lg hover:border-premium-gold hover:bg-premium-cream transition-colors text-center"
                >
                  <Plus className="h-8 w-8 text-premium-gold mx-auto mb-2" />
                  <span className="font-medium">Add Product</span>
                </button>
                <button
                  onClick={() => setShowComboManager(true)}
                  className="p-4 border rounded-lg hover:border-premium-gold hover:bg-premium-cream transition-colors text-center"
                >
                  <Package className="h-8 w-8 text-premium-gold mx-auto mb-2" />
                  <span className="font-medium">Create Combo</span>
                </button>
                <button
                  onClick={exportOrdersCSV}
                  className="p-4 border rounded-lg hover:border-premium-gold hover:bg-premium-cream transition-colors text-center"
                >
                  <Download className="h-8 w-8 text-premium-gold mx-auto mb-2" />
                  <span className="font-medium">Export Data</span>
                </button>
                <button
                  onClick={() => setActiveTab('orders')}
                  className="p-4 border rounded-lg hover:border-premium-gold hover:bg-premium-cream transition-colors text-center"
                >
                  <Eye className="h-8 w-8 text-premium-gold mx-auto mb-2" />
                  <span className="font-medium">View Orders</span>
                </button>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow border border-gray-100 overflow-hidden">
              <div className="px-6 py-4 border-b flex items-center justify-between">
                <h2 className="text-xl font-semibold">Recent Orders</h2>
                <button
                  onClick={() => setActiveTab('orders')}
                  className="text-premium-gold hover:text-premium-burgundy font-medium"
                >
                  View All →
                </button>
              </div>
              
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left p-4">Order ID</th>
                      <th className="text-left p-4">Customer</th>
                      <th className="text-left p-4">Amount</th>
                      <th className="text-left p-4">Status</th>
                      <th className="text-left p-4">Customization</th>
                      <th className="text-left p-4">Date</th>
                      <th className="text-left p-4">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.slice(0, 5).map((order) => {
                      const hasCustomization = Array.isArray(order.items) 
                        ? order.items.some((item: any) => item.customization)
                        : false;
                      
                      return (
                        <tr key={order.id} className="border-b hover:bg-gray-50">
                          <td className="p-4">
                            <div className="font-mono text-sm font-medium">
                              {order.custom_order_id || order.id.slice(0, 8)}
                              {order.custom_order_id && (
                                <span className="ml-2 text-xs text-gray-500">({order.id.slice(0, 8)}...)</span>
                              )}
                            </div>
                          </td>
                          <td className="p-4">
                            <div>
                              <p className="font-medium">{order.customer_name}</p>
                              <p className="text-sm text-gray-600">{order.customer_email}</p>
                            </div>
                          </td>
                          <td className="p-4 font-semibold">
                            {formatCurrency(order.total_amount)}
                          </td>
                          <td className="p-4">
                            <span className={`px-3 py-1 rounded-full text-xs font-medium border ${getStatusColor(order.status)}`}>
                              {order.status.toUpperCase()}
                            </span>
                          </td>
                          <td className="p-4">
                            {hasCustomization ? (
                              <span className="px-3 py-1 bg-purple-100 text-purple-800 rounded-full text-xs font-medium">
                                Yes
                              </span>
                            ) : (
                              <span className="text-gray-400 text-xs">No</span>
                            )}
                          </td>
                          <td className="p-4 text-sm text-gray-600">
                            {new Date(order.created_at).toLocaleDateString()}
                          </td>
                          <td className="p-4">
                            <button
                              onClick={() => { setSelectedOrder(order); setTrackingInput(order.tracking_number || ''); setShowInvoice(false); }}
                              className="text-blue-600 hover:text-blue-800 font-medium"
                            >
                              View
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {activeTab === 'orders' && (
          <div className="bg-white rounded-xl shadow border border-gray-100 overflow-hidden">
            <div className="px-6 py-4 border-b space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <h2 className="text-xl font-semibold">All Orders ({filteredOrders.length})</h2>
                <div className="flex flex-col md:flex-row items-stretch md:items-center gap-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search orders..."
                      className="pl-10 pr-4 py-2 border rounded-lg focus:outline-none focus:border-premium-gold w-full"
                    />
                  </div>
                  <button
                    onClick={exportOrdersCSV}
                    className="flex items-center justify-center space-x-2 px-4 py-2 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy transition-colors"
                  >
                    <Download className="h-4 w-4" />
                    <span>Export CSV</span>
                  </button>
                </div>
              </div>
              
              {/* Filter Row */}
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <FilterDropdown
                  label="Status"
                  value={orderStatusFilter}
                  onChange={setOrderStatusFilter}
                  icon={<Package className="h-4 w-4 text-gray-400" />}
                  options={[
                    { value: 'pending', label: 'Pending' },
                    { value: 'processing', label: 'Processing' },
                    { value: 'paid', label: 'Paid' },
                    { value: 'shipped', label: 'Shipped' },
                    { value: 'delivered', label: 'Delivered' },
                    { value: 'cancelled', label: 'Cancelled' },
                  ]}
                />
                
                <FilterDropdown
                  label="Payment"
                  value={orderPaymentFilter}
                  onChange={setOrderPaymentFilter}
                  icon={<CreditCard className="h-4 w-4 text-gray-400" />}
                  options={[
                    { value: 'paid', label: 'Paid' },
                    { value: 'pending', label: 'Pending' },
                    { value: 'refunded', label: 'Refunded' },
                  ]}
                />
                
                <FilterDropdown
                  label="Customization"
                  value={orderCustomizationFilter}
                  onChange={setOrderCustomizationFilter}
                  icon={<ImageIcon className="h-4 w-4 text-gray-400" />}
                  options={[
                    { value: 'yes', label: 'Has Customization' },
                    { value: 'no', label: 'No Customization' },
                  ]}
                />
                
                {(orderStatusFilter !== 'all' || orderPaymentFilter !== 'all' || orderCustomizationFilter !== 'all' || searchQuery) && (
                  <button
                    onClick={clearOrderFilters}
                    className="flex items-center gap-1 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    <X className="h-4 w-4" />
                    Clear Filters
                  </button>
                )}
              </div>
            </div>
            
            {filteredOrders.length === 0 ? (
              <div className="p-8 text-center">
                <Package className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                <p className="text-gray-500">No orders found</p>
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="mt-2 text-premium-gold hover:text-premium-burgundy"
                  >
                    Clear search
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left p-4">Order ID</th>
                        <th className="text-left p-4">
                          <SortButton
                            field="name"
                            currentField={orderSortField}
                            direction={orderSortDirection}
                            onSort={(field: string) => {
                              if (orderSortField === field) {
                                setOrderSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                              } else {
                                setOrderSortField(field as any);
                                setOrderSortDirection('asc');
                              }
                            }}
                          >
                            Customer
                          </SortButton>
                        </th>
                        <th className="text-left p-4">
                          <SortButton
                            field="amount"
                            currentField={orderSortField}
                            direction={orderSortDirection}
                            onSort={(field: string) => {
                              if (orderSortField === field) {
                                setOrderSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                              } else {
                                setOrderSortField(field as any);
                                setOrderSortDirection('asc');
                              }
                            }}
                          >
                            Amount
                          </SortButton>
                        </th>
                        <th className="text-left p-4">
                          <SortButton
                            field="status"
                            currentField={orderSortField}
                            direction={orderSortDirection}
                            onSort={(field: string) => {
                              if (orderSortField === field) {
                                setOrderSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                              } else {
                                setOrderSortField(field as any);
                                setOrderSortDirection('asc');
                              }
                            }}
                          >
                            Status
                          </SortButton>
                        </th>
                        <th className="text-left p-4">
                          <SortButton
                            field="payment"
                            currentField={orderSortField}
                            direction={orderSortDirection}
                            onSort={(field: string) => {
                              if (orderSortField === field) {
                                setOrderSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                              } else {
                                setOrderSortField(field as any);
                                setOrderSortDirection('asc');
                              }
                            }}
                          >
                            Payment
                          </SortButton>
                        </th>
                        <th className="text-left p-4">
                          <SortButton
                            field="customization"
                            currentField={orderSortField}
                            direction={orderSortDirection}
                            onSort={(field: string) => {
                              if (orderSortField === field) {
                                setOrderSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                              } else {
                                setOrderSortField(field as any);
                                setOrderSortDirection('asc');
                              }
                            }}
                          >
                            Customization
                          </SortButton>
                        </th>
                        <th className="text-left p-4">Variants</th>
                        <th className="text-left p-4">
                          <SortButton
                            field="date"
                            currentField={orderSortField}
                            direction={orderSortDirection}
                            onSort={(field: string) => {
                              if (orderSortField === field) {
                                setOrderSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                              } else {
                                setOrderSortField(field as any);
                                setOrderSortDirection('desc');
                              }
                            }}
                          >
                            Date
                          </SortButton>
                        </th>
                        <th className="text-left p-4">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedOrders.map((order) => {
                        const hasCustomization = Array.isArray(order.items) 
                          ? order.items.some((item: any) => item.customization)
                          : false;
                        
                        const isPaid = ['paid', 'delivered', 'completed'].includes(order.status);
                        
                        return (
                          <tr key={order.id} className="border-b hover:bg-gray-50">
                            <td className="p-4">
                              <div className="font-mono text-sm font-medium">
                                {order.custom_order_id || order.id.slice(0, 8)}
                                {order.custom_order_id && (
                                  <span className="ml-2 text-xs text-gray-500">({order.id.slice(0, 8)}...)</span>
                                )}
                              </div>
                            </td>
                            <td className="p-4">
                              <div>
                                <p className="font-medium">{order.customer_name}</p>
                                <p className="text-sm text-gray-600 flex items-center">
                                  <MapPin className="h-3 w-3 mr-1" />
                                  {order.shipping_city || 'N/A'}
                                </p>
                              </div>
                            </td>
                            <td className="p-4 font-semibold">
                              {formatCurrency(order.total_amount)}
                            </td>
                            <td className="p-4">
                              <select
                                value={order.status}
                                onChange={(e) => updateOrderStatus(order.id, e.target.value)}
                                className={`px-3 py-1 rounded text-xs font-medium border ${getStatusColor(order.status)} focus:outline-none`}
                              >
                                <option value="pending">PENDING</option>
                                <option value="processing">PROCESSING</option>
                                <option value="paid">PAID</option>
                                <option value="shipped">SHIPPED</option>
                                <option value="delivered">DELIVERED</option>
                                <option value="cancelled">CANCELLED</option>
                              </select>
                            </td>
                            <td className="p-4">
                              <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                                isPaid ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                              }`}>
                                {isPaid ? 'Paid' : 'Pending'}
                              </span>
                            </td>
                            <td className="p-4">
                              {hasCustomization ? (
                                <span className="px-3 py-1 bg-purple-100 text-purple-800 rounded-full text-xs font-medium">
                                  Yes
                                </span>
                              ) : (
                                <span className="text-gray-400 text-xs">No</span>
                              )}
                            </td>
                            <td className="p-4">
                              {(() => {
                                // Collect variants from both top-level items AND combo sub-products
                                const allVariantItems: any[] = [];
                                if (Array.isArray(order.items)) {
                                  order.items.forEach((it: any) => {
                                    if (it.color_name || it.size_name) {
                                      allVariantItems.push({ name: it.name, color_name: it.color_name, color_code: it.color_code, size_name: it.size_name, size_code: it.size_code });
                                    }
                                    // Also check combo sub-products
                                    if (it.combo_products && Array.isArray(it.combo_products)) {
                                      it.combo_products.forEach((cp: any) => {
                                        if (cp.color_name || cp.size_name) {
                                          allVariantItems.push({ name: cp.name, color_name: cp.color_name, color_code: cp.color_code, size_name: cp.size_name, size_code: cp.size_code });
                                        }
                                      });
                                    }
                                  });
                                }
                                if (allVariantItems.length === 0) return <span className="text-gray-400 text-xs">—</span>;
                                return (
                                  <div className="flex flex-col gap-1">
                                    {allVariantItems.slice(0, 2).map((it: any, vi: number) => (
                                      <div key={vi} className="flex items-center gap-1 flex-wrap">
                                        {it.color_code && (
                                          <div
                                            className="w-3 h-3 rounded-full border border-gray-300 flex-shrink-0"
                                            style={{ backgroundColor: it.color_code }}
                                            title={it.color_name}
                                          />
                                        )}
                                        {it.color_name && (
                                          <span className="text-xs text-blue-700 font-medium">{it.color_name}</span>
                                        )}
                                        {it.size_name && (
                                          <span className="text-xs bg-green-50 text-green-700 px-1 rounded">{it.size_name}</span>
                                        )}
                                      </div>
                                    ))}
                                    {allVariantItems.length > 2 && (
                                      <span className="text-xs text-gray-400">+{allVariantItems.length - 2} more</span>
                                    )}
                                  </div>
                                );
                              })()}
                            </td>
                            <td className="p-4 text-sm text-gray-600">
                              <div className="flex items-center">
                                <Calendar className="h-3 w-3 mr-1" />
                                {new Date(order.created_at).toLocaleDateString()}
                              </div>
                            </td>
                            <td className="p-4">
                              <div className="flex space-x-2">
                                <button
                                  onClick={() => { setSelectedOrder(order); setTrackingInput(order.tracking_number || ''); setShowInvoice(false); }}
                                  className="px-3 py-1 bg-blue-100 text-blue-700 rounded text-sm hover:bg-blue-200 transition-colors"
                                >
                                  View
                                </button>
                                <button
                                  onClick={() => copyToClipboard(order.custom_order_id || order.id, 'Order ID copied!')}
                                  className="p-1 hover:bg-gray-100 rounded"
                                  title="Copy Order ID"
                                >
                                  <Copy className="h-4 w-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                
                <Pagination
                  currentPage={orderPage}
                  totalItems={orderTotal}
                  itemsPerPage={ordersPerPage}
                  onPageChange={(page: number) => fetchOrderPage(page, searchQuery, orderStatusFilter)}
                />
              </>
            )}
          </div>
        )}

{activeTab === 'products' && (
  <div className="bg-white rounded-xl shadow border border-gray-100 overflow-hidden">
    <div className="px-6 py-4 border-b space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-xl font-semibold">All Products ({filteredProducts.length})</h2>
        <div className="flex flex-col md:flex-row items-stretch md:items-center gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search products..."
              className="pl-10 pr-4 py-2 border rounded-lg focus:outline-none focus:border-premium-gold w-full"
            />
          </div>
          <button
            onClick={() => setShowProductUpload(true)}
            className="flex items-center justify-center space-x-2 px-4 py-2 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy transition-colors"
          >
            <Plus className="h-4 w-4" />
            <span>Add Product</span>
          </button>
        </div>
      </div>
      
      {/* Filter Row */}
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <FilterDropdown
          label="Category"
          value={productCategoryFilter}
          onChange={setProductCategoryFilter}
          icon={<Tag className="h-4 w-4 text-gray-400" />}
          options={(() => {
            const allCategories = [...new Set(
              products.flatMap(p => p.categories?.map((cat: any) => cat.name) || [])
            )].sort();
            return allCategories.map(cat => ({
              value: cat,
              label: cat
            }));
          })()}
        />
        <FilterDropdown
          label="Gender"
          value={productGenderFilter}
          onChange={setProductGenderFilter}
          icon={<Users className="h-4 w-4 text-gray-400" />}
          options={[
            { value: 'men', label: 'Men' },
            { value: 'women', label: 'Women' },
            { value: 'unisex', label: 'Unisex' },
          ]}
        />
        
        <FilterDropdown
          label="Customizable"
          value={productCustomizableFilter}
          onChange={setProductCustomizableFilter}
          icon={<ImageIcon className="h-4 w-4 text-gray-400" />}
          options={[
            { value: 'yes', label: 'Customizable' },
            { value: 'no', label: 'Not Customizable' },
          ]}
        />
        
        <FilterDropdown
          label="Status"
          value={productStatusFilter}
          onChange={setProductStatusFilter}
          icon={<CheckCircle className="h-4 w-4 text-gray-400" />}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ]}
        />
        
        {(productCategoryFilter !== 'all' || productGenderFilter !== 'all' || productCustomizableFilter !== 'all' || productStatusFilter !== 'all' || searchQuery) && (
          <button
            onClick={clearProductFilters}
            className="flex items-center gap-1 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          >
            <X className="h-4 w-4" />
            Clear Filters
          </button>
        )}
      </div>
    </div>
    
    {filteredProducts.length === 0 ? (
      <div className="p-8 text-center">
        <ShoppingBag className="h-12 w-12 text-gray-300 mx-auto mb-4" />
        <p className="text-gray-500">No products found</p>
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            className="mt-2 text-premium-gold hover:text-premium-burgundy"
          >
            Clear search
          </button>
        )}
      </div>
    ) : (
      <>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-4">Image</th>
                <th className="text-left p-4">
                  <SortButton
                    field="name"
                    currentField={productSortField}
                    direction={productSortDirection}
                    onSort={(field: string) => {
                      if (productSortField === field) {
                        setProductSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                      } else {
                        setProductSortField(field as any);
                        setProductSortDirection('asc');
                      }
                    }}
                  >
                    Name
                  </SortButton>
                </th>
                <th className="text-left p-4">
                  <SortButton
                    field="category"
                    currentField={productSortField}
                    direction={productSortDirection}
                    onSort={(field: string) => {
                      if (productSortField === field) {
                        setProductSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                      } else {
                        setProductSortField(field as any);
                        setProductSortDirection('asc');
                      }
                    }}
                  >
                    Category
                  </SortButton>
                </th>
                <th className="text-left p-4">
                  <SortButton
                    field="gender"
                    currentField={productSortField}
                    direction={productSortDirection}
                    onSort={(field: string) => {
                      if (productSortField === field) {
                        setProductSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                      } else {
                        setProductSortField(field as any);
                        setProductSortDirection('asc');
                      }
                    }}
                  >
                    Gender
                  </SortButton>
                </th>
                <th className="text-left p-4">
                  <SortButton
                    field="price"
                    currentField={productSortField}
                    direction={productSortDirection}
                    onSort={(field: string) => {
                      if (productSortField === field) {
                        setProductSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                      } else {
                        setProductSortField(field as any);
                        setProductSortDirection('asc');
                      }
                    }}
                  >
                    Price
                  </SortButton>
                </th>
                <th className="text-left p-4">
                  <SortButton
                    field="stock"
                    currentField={productSortField}
                    direction={productSortDirection}
                    onSort={(field: string) => {
                      if (productSortField === field) {
                        setProductSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                      } else {
                        setProductSortField(field as any);
                        setProductSortDirection('asc');
                      }
                    }}
                  >
                    Stock
                  </SortButton>
                </th>
                <th className="text-left p-4">
                  <SortButton
                    field="customizable"
                    currentField={productSortField}
                    direction={productSortDirection}
                    onSort={(field: string) => {
                      if (productSortField === field) {
                        setProductSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                      } else {
                        setProductSortField(field as any);
                        setProductSortDirection('asc');
                      }
                    }}
                  >
                    Customizable
                  </SortButton>
                </th>
                <th className="text-left p-4">
                  <div className="flex items-center gap-2">
                    <span>Variants</span>
                  </div>
                </th>
                <th className="text-left p-4">
                  <SortButton
                    field="status"
                    currentField={productSortField}
                    direction={productSortDirection}
                    onSort={(field: string) => {
                      if (productSortField === field) {
                        setProductSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                      } else {
                        setProductSortField(field as any);
                        setProductSortDirection('asc');
                      }
                    }}
                  >
                    Status
                  </SortButton>
                </th>
                <th className="text-left p-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {paginatedProducts.map((product) => (
                <tr key={product.id} className="border-b hover:bg-gray-50">
                  <td className="p-4">
                    <img
                      src={getImageUrl(getProductImage(product))}
                      alt={product.name}
                      className="w-16 h-16 object-cover rounded-lg"
                      onError={(e) => { e.currentTarget.src = "/placeholder.svg"; }}
                    />
                  </td>
                  <td className="p-4">
                    <div>
                      <p className="font-medium">{product.name}</p>
                      <p className="text-sm text-gray-600 line-clamp-1">{product.description}</p>
                    </div>
                  </td>
                  <td className="p-4">
                    <div className="flex flex-wrap gap-1">
                      {product.categories && product.categories.length > 0 ? (
                        product.categories.map((cat: any) => (
                          <span 
                            key={cat.id} 
                            className="px-2 py-1 bg-gray-100 text-gray-800 rounded text-xs whitespace-nowrap"
                          >
                            {cat.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-gray-400 text-xs">No category</span>
                      )}
                    </div>
                  </td>
                  <td className="p-4">
                    <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs capitalize">
                      {product.gender || 'unisex'}
                    </span>
                  </td>
                  <td className="p-4">
                    <div>
                      <p className="font-semibold">{formatCurrency(product.price)}</p>
                      {product.discount_percentage && (
                        <p className="text-sm text-red-600">
                          -{product.discount_percentage}%
                        </p>
                      )}
                    </div>
                  </td>
                  <td className="p-4">
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                      product.stock_quantity > 10 
                        ? 'bg-green-100 text-green-800' 
                        : product.stock_quantity > 0 
                        ? 'bg-yellow-100 text-yellow-800'
                        : 'bg-red-100 text-red-800'
                    }`}>
                      {product.stock_quantity} in stock
                    </span>
                  </td>
                  <td className="p-4">
                    {product.is_customizable ? (
                      <span className="px-3 py-1 bg-purple-100 text-purple-800 rounded-full text-xs font-medium">
                        Yes
                      </span>
                    ) : (
                      <span className="text-gray-400 text-xs">No</span>
                    )}
                  </td>
                  <td className="p-4">
                    <div className="flex flex-col gap-2">
                      {/* Color Variants */}
                      {product.has_colors && product.colors && product.colors.length > 0 && (
                        <div>
                          <div className="flex items-center gap-1 mb-1">
                            <span className="text-xs font-medium text-gray-500">Colors:</span>
                            <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                              {product.colors.filter(c => c.is_active).length} active
                            </span>
                          </div>
                          <div className="flex -space-x-1">
                            {product.colors.filter(c => c.is_active).slice(0, 5).map((color) => (
                              <div
                                key={color.id}
                                className="w-6 h-6 rounded-full border-2 border-white shadow-sm cursor-help"
                                style={{ backgroundColor: color.color_code || '#ccc' }}
                                title={`${color.color_name} (Stock: ${color.stock_quantity})`}
                              />
                            ))}
                            {product.colors.filter(c => c.is_active).length > 5 && (
                              <span className="text-xs text-gray-500 ml-1">
                                +{product.colors.filter(c => c.is_active).length - 5}
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Size Variants */}
                      {product.has_sizes && product.sizes && product.sizes.length > 0 && (
                        <div>
                          <div className="flex items-center gap-1 mb-1">
                            <span className="text-xs font-medium text-gray-500">Sizes:</span>
                            <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                              {product.sizes.filter(s => s.is_active).length} active
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {product.sizes.filter(s => s.is_active).slice(0, 5).map((size) => (
                              <span
                                key={size.id}
                                className="text-xs bg-gray-100 px-2 py-1 rounded cursor-help"
                                title={`${size.size_name} (Stock: ${size.stock_quantity})`}
                              >
                                {size.size_code || size.size_name}
                              </span>
                            ))}
                            {product.sizes.filter(s => s.is_active).length > 5 && (
                              <span className="text-xs text-gray-500">
                                +{product.sizes.filter(s => s.is_active).length - 5}
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      {!product.has_colors && !product.has_sizes && (
                        <span className="text-xs text-gray-400">No variants</span>
                      )}
                    </div>
                  </td>
                  <td className="p-4">
                    <button
                      onClick={() => toggleProductStatus(product)}
                      className={`px-3 py-1 rounded-full text-xs font-medium ${
                        product.is_active 
                          ? 'bg-green-100 text-green-800 hover:bg-green-200' 
                          : 'bg-red-100 text-red-800 hover:bg-red-200'
                      }`}
                    >
                      {product.is_active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td className="p-4">
                    <div className="flex space-x-2">
                      <button 
                        onClick={() => handleEditProduct(product)}
                        className="p-2 hover:bg-gray-100 rounded transition-colors"
                        title="Edit"
                      >
                        <Edit className="h-4 w-4 text-blue-600" />
                      </button>
                      <button 
                        onClick={() => deleteProduct(product.id)}
                        className="p-2 hover:bg-gray-100 rounded transition-colors"
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
        
        <Pagination
          currentPage={productPage}
          totalItems={productTotal}
          itemsPerPage={productsPerPage}
          onPageChange={(page: number) => fetchProductPage(page, searchQuery)}
        />
      </>
    )}
  </div>
)}

        {activeTab === 'combos' && (
          <div className="bg-white rounded-xl shadow border border-gray-100 overflow-hidden">
            <div className="px-6 py-4 border-b space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <h2 className="text-xl font-semibold">All Combos ({filteredCombos.length})</h2>
                <div className="flex flex-col md:flex-row items-stretch md:items-center gap-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search combos..."
                      className="pl-10 pr-4 py-2 border rounded-lg focus:outline-none focus:border-premium-gold w-full"
                    />
                  </div>
                  <button
                    onClick={() => setShowComboManager(true)}
                    className="flex items-center justify-center space-x-2 px-4 py-2 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy transition-colors"
                  >
                    <Plus className="h-4 w-4" />
                    <span>Create Combo</span>
                  </button>
                </div>
              </div>
              
              {/* Filter Row */}
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <FilterDropdown
                  label="Status"
                  value={comboStatusFilter}
                  onChange={setComboStatusFilter}
                  icon={<CheckCircle className="h-4 w-4 text-gray-400" />}
                  options={[
                    { value: 'active', label: 'Active' },
                    { value: 'inactive', label: 'Inactive' },
                  ]}
                />
                
                {(comboStatusFilter !== 'all' || searchQuery) && (
                  <button
                    onClick={clearComboFilters}
                    className="flex items-center gap-1 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    <X className="h-4 w-4" />
                    Clear Filters
                  </button>
                )}
              </div>
            </div>
            
            {filteredCombos.length === 0 ? (
              <div className="p-8 text-center">
                <Package className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                <p className="text-gray-500">No combos created yet</p>
                <button
                  onClick={() => setShowComboManager(true)}
                  className="mt-4 px-4 py-2 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy"
                >
                  Create Your First Combo
                </button>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left p-4">Image</th>
                        <th className="text-left p-4">
                          <SortButton
                            field="name"
                            currentField={comboSortField}
                            direction={comboSortDirection}
                            onSort={(field: string) => {
                              if (comboSortField === field) {
                                setComboSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                              } else {
                                setComboSortField(field as any);
                                setComboSortDirection('asc');
                              }
                            }}
                          >
                            Name
                          </SortButton>
                        </th>
                        <th className="text-left p-4">
                          <SortButton
                            field="productsCount"
                            currentField={comboSortField}
                            direction={comboSortDirection}
                            onSort={(field: string) => {
                              if (comboSortField === field) {
                                setComboSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                              } else {
                                setComboSortField(field as any);
                                setComboSortDirection('asc');
                              }
                            }}
                          >
                            Products
                          </SortButton>
                        </th>
                        <th className="text-left p-4">
                          <SortButton
                            field="price"
                            currentField={comboSortField}
                            direction={comboSortDirection}
                            onSort={(field: string) => {
                              if (comboSortField === field) {
                                setComboSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                              } else {
                                setComboSortField(field as any);
                                setComboSortDirection('asc');
                              }
                            }}
                          >
                            Price
                          </SortButton>
                        </th>
                        <th className="text-left p-4">
                          <SortButton
                            field="status"
                            currentField={comboSortField}
                            direction={comboSortDirection}
                            onSort={(field: string) => {
                              if (comboSortField === field) {
                                setComboSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
                              } else {
                                setComboSortField(field as any);
                                setComboSortDirection('asc');
                              }
                            }}
                          >
                            Status
                          </SortButton>
                        </th>
                        <th className="text-left p-4">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedCombos.map((combo) => {
                        const comboProducts = combo.combo_products || [];
                        const totalValue = comboProducts.reduce(
                          (sum: number, cp: ComboProduct) => 
                            sum + (cp.product?.price || 0) * (cp.quantity || 1), 
                          0
                        );
                        
                        const discountedPrice = combo.discount_percentage 
                          ? totalValue * (1 - combo.discount_percentage / 100)
                          : combo.discount_price || totalValue;

                        // Get unique genders from combo products
                        const genders = [...new Set(
                          comboProducts
                            .map(cp => cp.product?.gender)
                            .filter(Boolean)
                        )];

                        return (
                          <tr key={combo.id} className="border-b hover:bg-gray-50">
                            <td className="p-4">
                              <img
                                src={getImageUrl(combo.image_url)}
                                alt={combo.name}
                                className="w-16 h-16 object-cover rounded-lg"
                                onError={(e) => {
                                  e.currentTarget.src = 'https://images.unsplash.com/photo-1511381939415-e44015466834?w=200&h=200&fit=crop';
                                }}
                              />
                            </td>
                            <td className="p-4">
                              <div>
                                <p className="font-medium">{combo.name}</p>
                                <p className="text-sm text-gray-600 line-clamp-2">{combo.description}</p>
                                {combo.discount_percentage && (
                                  <span className="inline-block mt-1 px-2 py-1 bg-red-100 text-red-800 text-xs rounded">
                                    {combo.discount_percentage}% OFF
                                  </span>
                                )}
                                {genders.length > 0 && (
                                  <div className="flex gap-1 mt-2">
                                    {genders.map(gender => (
                                      <span key={gender} className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs capitalize">
                                        {gender}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="p-4">
                              <div className="flex -space-x-2">
                                {comboProducts.slice(0, 4).map((cp: ComboProduct, idx: number) => (
                                  <div key={idx} className="w-8 h-8 rounded-full border-2 border-white bg-gray-200 overflow-hidden">
                                    <img 
                                      src={getImageUrl(cp.product?.image_url)} 
                                      alt={cp.product?.name}
                                      className="w-full h-full object-cover"
                                      onError={(e) => {
                                        e.currentTarget.src = 'https://images.unsplash.com/photo-1511381939415-e44015466834?w=100&h=100&fit=crop';
                                      }}
                                    />
                                  </div>
                                ))}
                                {comboProducts.length > 4 && (
                                  <div className="w-8 h-8 rounded-full border-2 border-white bg-gray-800 text-white text-xs flex items-center justify-center">
                                    +{comboProducts.length - 4}
                                  </div>
                                )}
                              </div>
                              <p className="text-xs text-gray-500 mt-2">
                                {comboProducts.length} products
                              </p>
                            </td>
                            <td className="p-4">
                              <div>
                                {combo.discount_percentage && (
                                  <p className="text-sm text-gray-500 line-through">
                                    {formatCurrency(totalValue)}
                                  </p>
                                )}
                                <p className="font-semibold text-premium-gold">
                                  {formatCurrency(discountedPrice)}
                                </p>
                              </div>
                            </td>
                            <td className="p-4">
                              <button
                                onClick={() => toggleComboStatus(combo)}
                                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                                  combo.is_active 
                                    ? 'bg-green-100 text-green-800 hover:bg-green-200' 
                                    : 'bg-red-100 text-red-800 hover:bg-red-200'
                                }`}
                              >
                                {combo.is_active ? 'Active' : 'Inactive'}
                              </button>
                            </td>
                            <td className="p-4">
                              <div className="flex space-x-2">
                                <button 
                                  onClick={() => handleEditCombo(combo)}
                                  className="p-2 hover:bg-gray-100 rounded transition-colors"
                                  title="Edit"
                                >
                                  <Edit className="h-4 w-4 text-blue-600" />
                                </button>
                                <button 
                                  onClick={() => deleteCombo(combo.id)}
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
                
                <Pagination
                  currentPage={comboPage}
                  totalItems={comboTotal}
                  itemsPerPage={combosPerPage}
                  onPageChange={(page: number) => fetchComboPage(page)}
                />
              </>
            )}
          </div>
        )}

        {activeTab === 'coupons' && <CouponManager />}
        {activeTab === 'categories' && <CategoryManager />}
        {activeTab === 'reviews' && <ReviewManager />}
        {activeTab === 'hero' && <HeroManager />}
        {activeTab === 'popups' && <PopupManager />}
        {activeTab === 'logo' && <LogoManager />}
      </div>

      {/* Order Details Modal with Enhanced Customization Display */}
      {selectedOrder && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-serif font-semibold">Order Details</h2>
                <button onClick={() => setSelectedOrder(null)} className="p-2 hover:bg-gray-100 rounded-lg">
                  <XCircle className="h-5 w-5" />
                </button>
              </div>

              <div className="grid md:grid-cols-2 gap-8">
                <div>
                  <h3 className="text-lg font-semibold mb-4">Customer Information</h3>
                  <div className="space-y-4">
                    <div>
                      <label className="text-sm text-gray-600">Name</label>
                      <p className="font-medium">{selectedOrder.customer_name}</p>
                    </div>
                    <div>
                      <label className="text-sm text-gray-600">Email</label>
                      <p className="font-medium">{selectedOrder.customer_email}</p>
                    </div>
                    <div>
                      <label className="text-sm text-gray-600">Phone</label>
                      <p className="font-medium">{selectedOrder.customer_phone || 'N/A'}</p>
                    </div>
                    <div>
                      <label className="text-sm text-gray-600">Order Date</label>
                      <p className="font-medium">
                        {new Date(selectedOrder.created_at).toLocaleString()}
                      </p>
                    </div>
                  </div>

                  <h3 className="text-lg font-semibold mt-8 mb-4">Shipping Address</h3>
                  <div className="space-y-2 p-4 bg-gray-50 rounded-lg">
                    <p className="font-medium">{selectedOrder.customer_name}</p>
                    <p>{selectedOrder.shipping_address || 'Address not provided'}</p>
                    <p>{selectedOrder.shipping_city}, {selectedOrder.shipping_state} - {selectedOrder.shipping_pincode}</p>
                    <p>{selectedOrder.shipping_country || 'India'}</p>
                  </div>

                  {/* Special Requests / Gift Message */}
                  {selectedOrder.special_requests && (
                    <div className="mt-6">
                      <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                        <FileText className="h-5 w-5 text-premium-gold" />
                        Special Message / Requests
                      </h3>
                      <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
                        <p className="text-gray-800 whitespace-pre-wrap">{selectedOrder.special_requests}</p>
                        <button
                          onClick={() => copyToClipboard(selectedOrder.special_requests!, 'Message copied!')}
                          className="mt-2 text-xs text-amber-700 hover:text-amber-900 flex items-center gap-1"
                        >
                          <Copy className="h-3 w-3" /> Copy message
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <h3 className="text-lg font-semibold mb-4">Order Information</h3>
                  <div className="space-y-4">
                    <div>
                      <label className="text-sm text-gray-600">Order ID (Customer)</label>
                      <div className="flex items-center gap-2">
                        <p className="font-mono font-medium text-lg">{selectedOrder.custom_order_id || selectedOrder.id}</p>
                        <button
                          onClick={() => copyToClipboard(selectedOrder.custom_order_id || selectedOrder.id, 'Order ID copied!')}
                          className="p-1.5 hover:bg-gray-100 rounded transition-colors"
                          title="Copy Order ID"
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                      </div>
                      {selectedOrder.custom_order_id && (
                        <p className="text-xs text-gray-500 mt-1">Internal ID: {selectedOrder.id}</p>
                      )}
                    </div>
                    <div>
                      <label className="text-sm text-gray-600">Payment ID</label>
                      <p className="font-mono font-medium">{selectedOrder.razorpay_payment_id || 'N/A'}</p>
                    </div>
                    <div>
                      <label className="text-sm text-gray-600">Status</label>
                      <select
                        value={selectedOrder.status}
                        onChange={(e) => updateOrderStatus(selectedOrder.id, e.target.value)}
                        className={`px-4 py-2 rounded-lg border ${getStatusColor(selectedOrder.status)} focus:outline-none`}
                      >
                        <option value="pending">Pending</option>
                        <option value="processing">Processing</option>
                        <option value="paid">Paid</option>
                        <option value="shipped">Shipped</option>
                        <option value="delivered">Delivered</option>
                        <option value="cancelled">Cancelled</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-sm text-gray-600">Tracking Number</label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          placeholder="Enter tracking number"
                          className="flex-1 px-4 py-2 border rounded-lg focus:outline-none focus:border-premium-gold"
                          value={trackingInput}
                          onChange={(e) => setTrackingInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              updateOrderStatus(selectedOrder.id, selectedOrder.status, trackingInput);
                            }
                          }}
                        />
                        {trackingInput !== (selectedOrder.tracking_number || '') ? (
                          <button
                            onClick={() => updateOrderStatus(selectedOrder.id, selectedOrder.status, trackingInput)}
                            className="px-3 py-2 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy text-sm font-medium whitespace-nowrap"
                          >
                            Save
                          </button>
                        ) : selectedOrder.tracking_number ? (
                          <span className="px-3 py-2 bg-green-50 text-green-600 rounded-lg text-sm font-medium flex items-center gap-1 whitespace-nowrap">
                            <CheckCircle className="h-4 w-4" /> Saved
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

{/* Order Items */}
<h3 className="text-lg font-semibold mt-8 mb-4">Order Items</h3>
<div className="space-y-3 max-h-96 overflow-y-auto">
  {Array.isArray(selectedOrder.items) ? (
    selectedOrder.items.map((item: any, idx: number) => (
      <div key={idx} className="p-3 bg-gray-50 rounded-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src={getImageUrl(item.image_url)}
              alt={item.name}
              className="w-12 h-12 object-cover rounded"
            
              onError={(e) => { e.currentTarget.src = "/placeholder.svg"; }}
            />
            <div>
              <p className="font-medium">{item.name}</p>
              <p className="text-sm text-gray-600">
                Qty: {item.quantity} × {formatCurrency(item.price)}
              </p>
              {/* Color and Size variant badges */}
              {(item.color_name || item.size_name) && (
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {item.color_name && (
                    <div className="flex items-center gap-1">
                      {item.color_code && (
                        <div
                          className="w-3 h-3 rounded-full border border-gray-300 flex-shrink-0"
                          style={{ backgroundColor: item.color_code }}
                          title={item.color_name}
                        />
                      )}
                      <span className="text-xs bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded font-medium">
                        {item.color_name}
                      </span>
                    </div>
                  )}
                  {item.size_name && (
                    <span className="text-xs bg-green-50 text-green-700 px-1.5 py-0.5 rounded font-medium">
                      {item.size_name}{item.size_code ? ` (${item.size_code})` : ''}
                    </span>
                  )}
                </div>
              )}
              {item.type === 'combo' && (
                <span className="inline-block mt-1 text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">
                  🎁 Combo
                </span>
              )}
              {item.gender && (
                <p className="text-xs text-gray-500 capitalize mt-1">
                  For: {item.gender}
                </p>
              )}
            </div>
          </div>
          <p className="font-semibold">
            {formatCurrency(item.price * item.quantity)}
          </p>
        </div>
        
        {/* Show combo products if this is a custom combo item */}
        {item.type === 'combo' && item.combo_products && item.combo_products.length > 0 && (
          <div className="mt-4 pt-3 border-t border-gray-200">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-gray-700 flex items-center gap-1">
                <Package className="h-4 w-4" />
                Combo Items ({item.combo_products.length}):
              </p>
              {/* Only show download button if there are any custom images */}
              {item.combo_products.some((cp: any) => 
                cp.customization?.image_urls && cp.customization.image_urls.length > 0
              ) && (
                <button
                  onClick={() => {
                    // Get only custom images (user-uploaded)
                    const allCustomImages = item.combo_products
                      .flatMap((cp: any) => cp.customization?.image_urls || [])
                      .filter(Boolean);
                    if (allCustomImages.length > 0) {
                      downloadAllImages(allCustomImages, selectedOrder.id);
                    }
                  }}
                  disabled={downloadingAll}
                  className="text-xs bg-premium-gold text-white px-3 py-1.5 rounded hover:bg-premium-burgundy flex items-center gap-1.5 disabled:opacity-50 transition-colors"
                >
                  {downloadingAll ? (
                    <Loader className="h-3 w-3 animate-spin" />
                  ) : (
                    <DownloadCloud className="h-3 w-3" />
                  )}
                  <span>Download All Custom Images</span>
                </button>
              )}
            </div>
            
            <div className="space-y-4">
              {item.combo_products.map((cp: any, cpIdx: number) => (
                <div key={cpIdx} className="bg-white rounded-lg p-3 border border-gray-200">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 flex-1">
                      <img
                        src={getImageUrl(cp.image_url)}
                        alt={cp.name}
                        className="w-10 h-10 object-cover rounded"
                      
                        onError={(e) => { e.currentTarget.src = "/placeholder.svg"; }}
                      />
                      <div className="flex-1">
                        <p className="font-medium text-sm">{cp.name}</p>
                        <p className="text-xs text-gray-600">
                          Qty: {cp.quantity} × {formatCurrency(cp.price)}
                        </p>
                        {/* Color and Size variant badges */}
                        {(cp.color_name || cp.size_name) && (
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            {cp.color_name && (
                              <div className="flex items-center gap-1">
                                {cp.color_code && (
                                  <div
                                    className="w-3 h-3 rounded-full border border-gray-300 flex-shrink-0"
                                    style={{ backgroundColor: cp.color_code }}
                                    title={cp.color_name}
                                  />
                                )}
                                <span className="text-xs bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded font-medium">
                                  {cp.color_name}
                                </span>
                              </div>
                            )}
                            {cp.size_name && (
                              <span className="text-xs bg-green-50 text-green-700 px-1.5 py-0.5 rounded font-medium">
                                {cp.size_name}{cp.size_code ? ` (${cp.size_code})` : ''}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <p className="text-sm font-medium">
                        {formatCurrency(cp.price * cp.quantity)}
                      </p>
                    </div>
                  </div>
                  
                  {/* Show customization for this combo product */}
                  {cp.customization && (
                    <div className="mt-3 pt-2 border-t border-gray-100">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium text-gray-500 flex items-center gap-1">
                          <ImageIcon className="h-3 w-3" />
                          Customization Details:
                        </span>
                        {/* Only show download button if there are custom images */}
                        {cp.customization.image_urls && cp.customization.image_urls.length > 0 && (
                          <button
                            onClick={() => downloadAllImages(cp.customization.image_urls, selectedOrder.id)}
                            disabled={downloadingAll}
                            className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700 flex items-center gap-1 disabled:opacity-50"
                          >
                            {downloadingAll ? (
                              <Loader className="h-3 w-3 animate-spin" />
                            ) : (
                              <Download className="h-3 w-3" />
                            )}
                            <span>Download Custom Images</span>
                          </button>
                        )}
                      </div>
                      
                      {/* Text Lines - Show if user added text */}
                      {cp.customization.text_lines && cp.customization.text_lines.length > 0 && (
                        <div className="mb-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs text-gray-500 flex items-center gap-1">
                              <FileText className="h-3 w-3" />
                              Custom Text:
                            </span>
                            <button
                              onClick={() => {
                                const allText = cp.customization.text_lines.join('\n');
                                copyToClipboard(allText, 'Text copied!');
                              }}
                              className="text-xs text-blue-600 hover:text-blue-800"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </div>
                          <div className="space-y-1 bg-gray-50 p-2 rounded">
                            {cp.customization.text_lines.map((line: string, lineIdx: number) => (
                              <div key={lineIdx} className="flex items-start gap-2 text-xs">
                                <span className="text-gray-400 font-medium min-w-[30px]">Line {lineIdx + 1}:</span>
                                <p className="text-gray-700 flex-1 font-mono bg-white p-1.5 rounded border border-gray-200">
                                  {line || <span className="text-gray-400 italic">(empty)</span>}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {/* Custom Images - Only show if user uploaded images */}
                      {cp.customization.image_urls && cp.customization.image_urls.length > 0 && (
                        <div>
                          <span className="text-xs text-gray-500 flex items-center gap-1 mb-2">
                            <ImageIcon className="h-3 w-3" />
                            Custom Images ({cp.customization.image_urls.length}):
                          </span>
                          <div className="grid grid-cols-4 gap-2">
                            {cp.customization.image_urls.map((imgUrl: string, imgIdx: number) => (
                              <div key={imgIdx} className="relative group aspect-square">
                                <img
                                  src={imgUrl}
                                  alt={`Custom ${imgIdx + 1}`}
                                  className="w-full h-full object-cover rounded border"
                                />
                                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1">
                                  <a
                                    href={imgUrl}
                                    download
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="p-1 bg-white rounded hover:bg-gray-100"
                                    title="Download"
                                  >
                                    <Download className="h-3 w-3 text-blue-600" />
                                  </a>
                                  <a
                                    href={imgUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="p-1 bg-white rounded hover:bg-gray-100"
                                    title="View"
                                  >
                                    <Eye className="h-3 w-3 text-gray-600" />
                                  </a>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {/* Show message if no customizations */}
                      {(!cp.customization.text_lines || cp.customization.text_lines.length === 0) && 
                       (!cp.customization.image_urls || cp.customization.image_urls.length === 0) && (
                        <p className="text-xs text-gray-400 italic mt-2">No customizations for this item</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        
        {/* Regular product customization (non-combo) */}
        {item.customization && item.type !== 'combo' && (
          <div className="mt-4 pt-3 border-t border-gray-200">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-gray-700 flex items-center gap-1">
                <ImageIcon className="h-4 w-4" />
                Customization Details:
              </p>
              {/* Only show download button if there are custom images */}
              {item.customization.image_urls && item.customization.image_urls.length > 0 && (
                <button
                  onClick={() => downloadAllImages(item.customization.image_urls, selectedOrder.id)}
                  disabled={downloadingAll}
                  className="text-xs bg-premium-gold text-white px-3 py-1.5 rounded hover:bg-premium-burgundy flex items-center gap-1.5 disabled:opacity-50 transition-colors"
                >
                  {downloadingAll ? (
                    <Loader className="h-3 w-3 animate-spin" />
                  ) : (
                    <DownloadCloud className="h-3 w-3" />
                  )}
                  <span>Download Custom Images</span>
                </button>
              )}
            </div>
            
            {/* Custom Text Lines - Show if user added text */}
            {item.customization.text_lines && item.customization.text_lines.length > 0 && (
              <div className="mb-5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-gray-500 flex items-center gap-1">
                    <FileText className="h-3 w-3" />
                    Custom Text ({item.customization.text_lines.length} line{item.customization.text_lines.length > 1 ? 's' : ''}):
                  </span>
                  <button
                    onClick={() => {
                      const allText = item.customization.text_lines.join('\n');
                      copyToClipboard(allText, 'All text copied!');
                    }}
                    className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
                  >
                    <Copy className="h-3 w-3" />
                    Copy All
                  </button>
                </div>
                <div className="space-y-2 max-h-40 overflow-y-auto pr-2">
                  {item.customization.text_lines.map((line: string, lineIdx: number) => (
                    <div key={lineIdx} className="flex items-start gap-2 bg-white p-2 rounded-lg border hover:border-premium-gold transition-colors">
                      <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2 py-1 rounded min-w-[60px] text-center">
                        Line {lineIdx + 1}
                      </span>
                      <code className="bg-gray-50 px-3 py-1.5 rounded text-sm font-mono flex-1 break-all border-l-2 border-premium-gold">
                        {line || <span className="text-gray-400 italic">(empty)</span>}
                      </code>
                      <button
                        onClick={() => copyToClipboard(line, `Line ${lineIdx + 1} copied!`)}
                        className="p-1.5 hover:bg-gray-100 rounded transition-colors"
                        title="Copy line"
                      >
                        <Copy className="h-4 w-4 text-gray-600" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {/* Custom Images - Only show if user uploaded images */}
            {item.customization.image_urls && item.customization.image_urls.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-gray-500 flex items-center gap-1">
                    <ImageIcon className="h-3 w-3" />
                    Custom Images ({item.customization.image_urls.length}):
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 max-h-80 overflow-y-auto p-2 border rounded-lg">
                  {item.customization.image_urls.map((imgUrl: string, imgIdx: number) => (
                    <div key={imgIdx} className="relative group border rounded-lg overflow-hidden aspect-square">
                      <img 
                        src={imgUrl} 
                        alt={`Custom ${imgIdx + 1}`}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-between p-2">
                        <span className="text-xs text-white font-medium bg-black/50 px-2 py-1 rounded">
                          #{imgIdx + 1}
                        </span>
                        <div className="flex gap-1">
                          <a
                            href={imgUrl}
                            download
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 bg-white rounded hover:bg-gray-100 transition-colors"
                            title="Download"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Download className="h-3 w-3 text-blue-600" />
                          </a>
                          <a
                            href={imgUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 bg-white rounded hover:bg-gray-100 transition-colors"
                            title="Open in new tab"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink className="h-3 w-3 text-gray-600" />
                          </a>
                          <button
                            onClick={() => copyToClipboard(imgUrl, 'Image URL copied!')}
                            className="p-1.5 bg-white rounded hover:bg-gray-100 transition-colors"
                            title="Copy URL"
                          >
                            <Copy className="h-3 w-3 text-gray-600" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            
            {/* Show message if no customizations */}
            {(!item.customization.text_lines || item.customization.text_lines.length === 0) && 
             (!item.customization.image_urls || item.customization.image_urls.length === 0) && (
              <p className="text-xs text-gray-400 italic">No customizations for this item</p>
            )}
          </div>
        )}
      </div>
    ))
  ) : (
    <p className="text-gray-500">No items data</p>
  )}
</div>
                  <div className="mt-6 pt-6 border-t">
                    <div className="flex justify-between text-xl font-bold">
                      <span>Total Amount</span>
                      <span className="text-premium-gold">
                        {formatCurrency(selectedOrder.total_amount)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {showInvoice && (
                <div className="mt-6 border-t pt-4">
                  <InvoicePDF order={selectedOrder} onClose={() => setShowInvoice(false)} />
                </div>
              )}

              <div className="mt-6 pt-4 border-t flex flex-wrap gap-3 justify-end">
                <button
                  onClick={() => setSelectedOrder(null)}
                  className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  Close
                </button>
                <button
                  onClick={() => setShowInvoice(v => !v)}
                  className="px-6 py-2 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy flex items-center"
                >
                  <Printer className="h-4 w-4 mr-2" />
                  {showInvoice ? 'Hide Invoice' : 'Save Invoice'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showProductUpload && (
        <ProductUpload 
          onClose={() => setShowProductUpload(false)} 
          onSuccess={() => {
            setShowProductUpload(false);
            fetchDashboardData();
          }}
        />
      )}

      {showEditProduct && editingProduct && (
        <EditProduct 
          product={editingProduct}
          onClose={() => {
            setShowEditProduct(false);
            setEditingProduct(null);
          }} 
          onSuccess={() => {
            setShowEditProduct(false);
            setEditingProduct(null);
            fetchDashboardData();
          }}
        />
      )}

      {showComboManager && (
        <ComboManager 
          combo={editingCombo}
          onClose={() => {
            setShowComboManager(false);
            setEditingCombo(null);
          }} 
          onSuccess={() => {
            setShowComboManager(false);
            setEditingCombo(null);
            fetchDashboardData();
          }}
        />
      )}
    </div>
  );
};

export default AdminPanel;