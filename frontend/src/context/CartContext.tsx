import React, { createContext, useContext, useState, useEffect } from 'react';
import { CartItem } from '../types';

interface CartContextType {
  items: CartItem[];
  addItem: (item: CartItem) => void;
  removeItem: (id: string) => void;
  updateQuantity: (id: string, quantity: number) => void;
  clearCart: () => void;
  total: number;
  itemCount: number;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

const CART_KEY = 'cart';

// Customization previews used to be saved as full-size base64 data URLs, which can exceed the browser's
// localStorage quota (~5 MB) with a single photo. Nothing reads them back (the server keeps the uploaded
// image URLs in customization.image_urls, which is what orders and the admin use), so drop any data: URL
// from carts written by older versions and from anything added now.
const slimCustomization = (c: any) => {
  if (!c || !Array.isArray(c.preview_urls)) return c;
  const kept = c.preview_urls.filter((u: unknown) => typeof u === 'string' && !u.startsWith('data:'));
  return { ...c, preview_urls: kept.length ? kept : undefined };
};

const slimItem = (item: any) => ({
  ...item,
  ...(item.customization ? { customization: slimCustomization(item.customization) } : {}),
  ...(Array.isArray(item.combo_products)
    ? { combo_products: item.combo_products.map((cp: any) => (cp && cp.customization ? { ...cp, customization: slimCustomization(cp.customization) } : cp)) }
    : {}),
});

/** Never throws: missing, unreadable, corrupt or wrongly-shaped storage just gives an empty cart. */
const loadCart = (): CartItem[] => {
  try {
    const saved = localStorage.getItem(CART_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((i) => i && typeof i === 'object' && typeof i.id === 'string' && Number.isFinite(Number(i.quantity)) && Number.isFinite(Number(i.price)))
      .map(slimItem);
  } catch {
    return [];
  }
};

export const CartProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [items, setItems] = useState<CartItem[]>(loadCart);

  // Persisting is best effort: if storage is full, blocked (private mode) or otherwise failing, the cart
  // keeps working in memory for this visit instead of throwing out of the effect.
  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(items));
    } catch (e) {
      console.warn('Cart could not be saved to this browser; it will be kept in memory only.', e);
    }
  }, [items]);

  const addItem = (item: CartItem) => {
    setItems(prev => {
      const existing = prev.find(i => i.id === item.id);
      if (existing) {
        return prev.map(i =>
          i.id === item.id
            ? { ...i, quantity: i.quantity + item.quantity }
            : i
        );
      }
      return [...prev, slimItem(item) as CartItem];
    });
  };

  const removeItem = (id: string) => {
    setItems(prev => prev.filter(item => item.id !== id));
  };

  const updateQuantity = (id: string, quantity: number) => {
    if (quantity < 1) {
      removeItem(id);
      return;
    }
    setItems(prev =>
      prev.map(item => (item.id === id ? { ...item, quantity } : item))
    );
  };

  const clearCart = () => {
    setItems([]);
  };

  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const itemCount = items.reduce((count, item) => count + item.quantity, 0);

  return (
    <CartContext.Provider
      value={{
        items,
        addItem,
        removeItem,
        updateQuantity,
        clearCart,
        total,
        itemCount,
      }}
    >
      {children}
    </CartContext.Provider>
  );
};

export const useCart = () => {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error('useCart must be used within CartProvider');
  }
  return context;
};