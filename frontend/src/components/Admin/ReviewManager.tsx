import React, { useState, useEffect } from 'react';
import { getImageUrl } from '../../utils/helpers';
import {
  Star, CheckCircle, XCircle, Trash2, RefreshCw,
  Search, Filter, MessageSquare, ThumbsUp, Calendar
} from 'lucide-react';
import { useApi } from '../../hooks/useApi';

interface Review {
  id: string;
  product_id: string;
  user_name: string;
  user_email?: string;
  rating: number;
  comment: string;
  is_approved: boolean;
  created_at: string;
  products?: {
    name: string;
    image_url: string;
  };
}

const ReviewManager: React.FC = () => {
  const { fetchWithAuth } = useApi();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'approved' | 'pending'>('all');
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    fetchReviews();
    fetchStats();
  }, []);

  const fetchReviews = async () => {
    try {
      setLoading(true);
      const data = await fetchWithAuth('/api/reviews/admin');
      setReviews(data || []);
    } catch (error) {
      console.error('Error fetching reviews:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const data = await fetchWithAuth('/api/reviews/admin/stats');
      setStats(data);
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  };

  const approveReview = async (id: string, approve: boolean) => {
    try {
      await fetchWithAuth(`/api/reviews/admin/${id}/approve`, {
        method: 'PUT',
        body: JSON.stringify({ is_approved: approve }),
      });
      await fetchReviews();
      await fetchStats();
    } catch (error) {
      console.error('Error approving review:', error);
    }
  };

  const deleteReview = async (id: string) => {
    if (!confirm('Delete this review?')) return;
    try {
      await fetchWithAuth(`/api/reviews/admin/${id}`, { method: 'DELETE' });
      await fetchReviews();
      await fetchStats();
    } catch (error) {
      console.error('Error deleting review:', error);
    }
  };

  const filteredReviews = reviews.filter(review => {
    const matchesSearch = 
      review.user_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      review.comment.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (review.products?.name || '').toLowerCase().includes(searchQuery.toLowerCase());

    if (!matchesSearch) return false;

    if (filterStatus === 'approved') return review.is_approved;
    if (filterStatus === 'pending') return !review.is_approved;
    return true;
  });

  const getRatingStars = (rating: number) => {
    return [...Array(5)].map((_, i) => (
      <Star
        key={i}
        className={`h-4 w-4 ${i < rating ? 'text-yellow-400 fill-current' : 'text-gray-300'}`}
      />
    ));
  };

  if (loading) {
    return (
      <div className="bg-white rounded-xl p-8 text-center">
        <RefreshCw className="h-8 w-8 animate-spin text-premium-gold mx-auto" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl p-6 shadow border">
            <p className="text-sm text-gray-600">Total Reviews</p>
            <p className="text-3xl font-bold mt-2">{stats.totalReviews}</p>
          </div>
          <div className="bg-white rounded-xl p-6 shadow border">
            <p className="text-sm text-gray-600">Approved</p>
            <p className="text-3xl font-bold mt-2 text-green-600">{stats.approvedReviews}</p>
          </div>
          <div className="bg-white rounded-xl p-6 shadow border">
            <p className="text-sm text-gray-600">Pending</p>
            <p className="text-3xl font-bold mt-2 text-yellow-600">{stats.pendingReviews}</p>
          </div>
          <div className="bg-white rounded-xl p-6 shadow border">
            <p className="text-sm text-gray-600">Avg Rating</p>
            <p className="text-3xl font-bold mt-2 text-premium-gold">{stats.averageRating} ⭐</p>
          </div>
        </div>
      )}

      {/* Reviews Table */}
      <div className="bg-white rounded-xl shadow overflow-hidden">
        <div className="px-6 py-4 border-b">
          <div className="flex flex-col md:flex-row justify-between gap-4">
            <h2 className="text-2xl font-serif font-semibold flex items-center gap-2">
              <MessageSquare className="h-6 w-6 text-premium-gold" />
              Review Management
            </h2>
            <div className="flex gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search reviews..."
                  className="pl-10 pr-4 py-2 border rounded-lg focus:outline-none focus:border-premium-gold w-64"
                />
              </div>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value as any)}
                className="px-4 py-2 border rounded-lg"
              >
                <option value="all">All Reviews</option>
                <option value="approved">Approved</option>
                <option value="pending">Pending</option>
              </select>
            </div>
          </div>
        </div>

        {filteredReviews.length === 0 ? (
          <div className="p-12 text-center">
            <MessageSquare className="h-16 w-16 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500">No reviews found</p>
          </div>
        ) : (
          <div className="divide-y">
            {filteredReviews.map((review) => (
              <div key={review.id} className="p-6 hover:bg-gray-50">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-start gap-4">
                    {review.products?.image_url && (
                      <img
                        src={getImageUrl(review.products?.image_url)}
                        alt={review.products.name}
                        className="w-16 h-16 object-cover rounded-lg"
                      />
                    )}
                    <div>
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="font-semibold">{review.user_name}</h3>
                        <div className="flex items-center gap-1">
                          {getRatingStars(review.rating)}
                        </div>
                      </div>
                      <p className="text-sm text-gray-500 flex items-center gap-4">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {new Date(review.created_at).toLocaleDateString()}
                        </span>
                        {review.products && (
                          <span className="px-2 py-1 bg-gray-100 rounded text-xs">
                            Product: {review.products.name}
                          </span>
                        )}
                      </p>
                      <p className="text-gray-700 mt-2">{review.comment}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!review.is_approved ? (
                      <button
                        onClick={() => approveReview(review.id, true)}
                        className="p-2 bg-green-100 text-green-600 rounded-lg hover:bg-green-200"
                        title="Approve"
                      >
                        <CheckCircle className="h-4 w-4" />
                      </button>
                    ) : (
                      <button
                        onClick={() => approveReview(review.id, false)}
                        className="p-2 bg-yellow-100 text-yellow-600 rounded-lg hover:bg-yellow-200"
                        title="Unapprove"
                      >
                        <XCircle className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={() => deleteReview(review.id)}
                      className="p-2 bg-red-100 text-red-600 rounded-lg hover:bg-red-200"
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ReviewManager;