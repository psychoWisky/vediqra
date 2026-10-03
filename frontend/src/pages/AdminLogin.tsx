import React, { useState, useEffect } from 'react';
import { Lock, Eye, EyeOff, User } from 'lucide-react';
import AdminPanel from '../components/Admin/AdminPanel';
import { apiFetch } from '../utils/api';

const AdminLogin: React.FC = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');

  // Resume an existing session if the stored token is still valid.
  useEffect(() => {
    const token = localStorage.getItem('admin_token');
    if (!token) {
      setChecking(false);
      return;
    }
    apiFetch('/api/admin/auth/me')
      .then(() => setIsAuthenticated(true))
      .catch(() => localStorage.removeItem('admin_token'))
      .finally(() => setChecking(false));
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      const data = await apiFetch('/api/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      localStorage.setItem('admin_token', data.token);
      setIsAuthenticated(true);
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (checking) {
    return null;
  }

  if (isAuthenticated) {
    return <AdminPanel />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-premium-cream to-white flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-premium-gold rounded-full mb-4">
              <Lock className="h-8 w-8 text-white" />
            </div>
            <h1 className="text-3xl font-serif font-bold text-premium-charcoal">
              Admin Portal
            </h1>
            <p className="text-gray-600 mt-2">
              Sign in to access the dashboard
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label className="block text-sm font-medium mb-2">
                Username
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setError('');
                  }}
                  autoComplete="username"
                  className="w-full px-4 py-3 pl-12 border rounded-lg focus:border-premium-gold focus:outline-none"
                  placeholder="Enter admin username"
                />
                <User className="absolute left-4 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                Admin Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError('');
                  }}
                  autoComplete="current-password"
                  className="w-full px-4 py-3 pl-12 border rounded-lg focus:border-premium-gold focus:outline-none"
                  placeholder="Enter admin password"
                />
                <Lock className="absolute left-4 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 transform -translate-y-1/2"
                >
                  {showPassword ? (
                    <EyeOff className="h-5 w-5 text-gray-400" />
                  ) : (
                    <Eye className="h-5 w-5 text-gray-400" />
                  )}
                </button>
              </div>
              {error && (
                <p className="text-red-500 text-sm mt-2">{error}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={submitting || !username || !password}
              className="w-full py-3 bg-premium-gold text-white rounded-lg hover:bg-premium-burgundy transition-colors font-medium disabled:opacity-50"
            >
              {submitting ? 'Signing in...' : 'Login to Dashboard'}
            </button>
          </form>

          <div className="mt-8 pt-6 border-t text-center">
            <p className="text-sm text-gray-500">
              This is a protected admin area. Unauthorized access is prohibited.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminLogin;
