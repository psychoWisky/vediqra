import React, { useState, useEffect } from 'react';
import { TrendingUp, Users, Eye, ShoppingCart, RefreshCw } from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import { formatCurrency } from '../../utils/helpers';

interface ProductStats {
  product_id: string;
  product_name: string;
  view_count: number;
  purchase_count: number;
  conversion_rate: number;
}

const SocialProofStats: React.FC = () => {
  const { fetchWithAuth } = useApi();
  const [stats, setStats] = useState<ProductStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      setLoading(true);
      const data = await fetchWithAuth('/api/admin/social-proof/stats');
      setStats(data || []);
    } catch (error) {
      console.error('Error fetching stats:', error);
    } finally {
      setLoading(false);
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
      <div className="px-6 py-4 border-b">
        <h2 className="text-2xl font-serif font-semibold flex items-center gap-2">
          <TrendingUp className="h-6 w-6 text-premium-gold" />
          Social Proof Analytics
        </h2>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-4">Product</th>
              <th className="text-left p-4">
                <div className="flex items-center gap-1">
                  <Eye className="h-4 w-4" /> Views
                </div>
              </th>
              <th className="text-left p-4">
                <div className="flex items-center gap-1">
                  <ShoppingCart className="h-4 w-4" /> Purchases
                </div>
              </th>
              <th className="text-left p-4">Conversion Rate</th>
              <th className="text-left p-4">Status</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((stat) => (
              <tr key={stat.product_id} className="border-b hover:bg-gray-50">
                <td className="p-4 font-medium">{stat.product_name}</td>
                <td className="p-4">{stat.view_count.toLocaleString()}</td>
                <td className="p-4">{stat.purchase_count.toLocaleString()}</td>
                <td className="p-4">
                  <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm">
                    {stat.conversion_rate.toFixed(1)}%
                  </span>
                </td>
                <td className="p-4">
                  <span className="flex items-center gap-1 text-green-600">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                    </span>
                    Active
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default SocialProofStats;