# GFTD Gift Shop — Fix Summary & Deployment Guide

> **Historical document.** This records fixes made to the original GFTD codebase before the VEDIQRA rebuild
> (Phases 1–4D). The `gftd.in` domain, R2 storage and other details below are retained as-is for historical
> accuracy; they do not reflect the current VEDIQRA configuration. See `docs/` for current deployment guidance.

---

## What Was Fixed

### 1. `api/api` Double-Prefix Bug (Root Cause)
**Problem:** Some components used `${VITE_API_URL}/admin/...` where `VITE_API_URL` was set to `https://gftd.in/api`, producing `https://gftd.in/api/admin/...`. Others used `apiFetch('/api/admin/...')` which with the same base URL produced `https://gftd.in/api/api/admin/...`.

**Fix:** Created `frontend/src/utils/api.ts` — a single unified API utility. **`VITE_API_URL` must be empty string** in both local and production. Nginx and Vite's proxy both handle `/api/*` routing.

Files fixed:
- `src/utils/api.ts` — NEW unified utility (`apiFetch`, `publicFetch`, `uploadFetch`)
- `src/config.ts` — re-exports from api.ts for backward compatibility
- `src/hooks/useApi.ts` — uses api.ts
- `src/utils/apiFetch.ts` — re-exports from api.ts
- Every admin component and page that had raw `fetch(${baseUrl}/...)` calls

### 2. Edit Product — Variants (Colors/Sizes) Not Loading
**Problem:** `fetchVariants` in `EditProduct.tsx` called `${baseUrl}/admin/products/...` — missing `/api/` prefix entirely, so it always 404'd.

**Fix:** All variant fetch/save calls in `EditProduct.tsx` now use `apiFetch('/api/admin/products/${id}/colors')` etc.

### 3. Special Message Not Shown in Admin Orders
**Problem:** `selectedOrder.special_requests` was stored in DB but never rendered in the order detail modal.

**Fix:** Added a highlighted "Special Message / Requests" section in the order detail modal in `AdminPanel.tsx`, with a copy button. Also added `special_requests` field to the `Order` TypeScript type.

### 4. Category Custom Image Upload
**Problem:** `CategoryManager.tsx` only supported emoji and Lucide icons. No way to upload a custom image as the category icon.

**Fix:**
- `CategoryManager.tsx` — Added "Custom Image" as a third icon type option with full upload flow
- `CategoryCard.tsx` — Now renders `<img>` when `icon_type === 'image'` or icon starts with `http`
- `backend/src/routes/admin.ts` — Category POST/PUT now handles `icon_type: 'image'` correctly
- `backend/migration_fixes.sql` — Adds `image_url` column to categories table

### 5. HeroManager Hardcoded External URL
**Problem:** Hero media upload was pointing to `https://clickntrend.onrender.com/api/hero/upload` (an old/wrong server).

**Fix:** Now uses `/api/upload/upload-image` — the same R2 upload endpoint used everywhere else.

### 6. CouponManager, ComboManager, LogoManager
All had inconsistent URL patterns (`/coupons/...` missing `/api/`, `${baseUrl}/admin/...` missing `/api/`). All fixed to use `apiFetch('/api/...')`.

---

## Deployment Steps

### Step 1 — Run the SQL migration (once)
In your Supabase SQL editor, run `backend/migration_fixes.sql`. This:
- Adds `image_url` column to `categories`
- Ensures `special_requests` column exists in `orders`
- Fixes RLS policies

### Step 2 — Backend (.env)
No changes needed to backend `.env`. Backend runs on port 5000 as before.

```bash
cd backend
npm install
npm run build
# Production: pm2 restart all (or however you manage the process)
```

### Step 3 — Frontend (CRITICAL: env files)
Both `.env` and `.env.production` have `VITE_API_URL=` (empty). **Do not set it to anything.**

```bash
cd frontend
npm install
npm run build
# Copy dist/ to nginx html root
sudo cp -r dist/* /usr/share/nginx/html/
```

### Step 4 — Nginx config (no changes needed)
Your existing nginx config is correct:
```nginx
location /api/ {
    proxy_pass http://127.0.0.1:5000;   # backend strips nothing, gets /api/...
    ...
}
```
The backend Express app mounts all routes at `/api/...` so this works perfectly.

---

## Local Development

```bash
# Terminal 1: Backend
cd backend && npm run dev

# Terminal 2: Frontend  
cd frontend && npm run dev
# → http://localhost:5173
# Vite proxies /api/* → http://localhost:5000
```
No proxy config needed — `vite.config.ts` already has:
```ts
proxy: { '/api': { target: 'http://localhost:5000', changeOrigin: true } }
```

---

## Architecture (How API Calls Work)

```
LOCAL DEV:
Browser → localhost:5173/api/products
       → Vite proxy → localhost:5000/api/products
       → Express handles /api/products ✓

PRODUCTION:
Browser → gftd.in/api/products
       → nginx proxy_pass → 127.0.0.1:5000/api/products
       → Express handles /api/products ✓

KEY RULE: Frontend always calls /api/... with no base prefix.
VITE_API_URL = "" (empty) in all environments.
```

---

## Files Changed

### New Files
- `frontend/src/utils/api.ts` — unified API utility
- `frontend/.env` — local dev env (VITE_API_URL empty)  
- `frontend/.env.production` — production env (VITE_API_URL empty)
- `backend/migration_fixes.sql` — DB migration

### Modified Frontend Files
- `src/config.ts`
- `src/hooks/useApi.ts`
- `src/utils/apiFetch.ts`
- `src/types.ts` — added `special_requests` to Order
- `src/components/CategoryCard.tsx` — image icon support
- `src/components/Admin/AdminPanel.tsx` — special_requests display
- `src/components/Admin/CategoryManager.tsx` — image upload + unified api
- `src/components/Admin/EditProduct.tsx` — fixed variant fetch + unified api
- `src/components/Admin/ProductUpload.tsx` — unified api
- `src/components/Admin/MultiImageUpload.tsx` — unified api
- `src/components/Admin/ComboManager.tsx` — unified api
- `src/components/Admin/CouponManager.tsx` — unified api
- `src/components/Admin/HeroManager.tsx` — fixed hardcoded URL
- `src/components/Admin/LogoManager.tsx` — unified api
- `src/pages/Checkout.tsx` — fixed `/coupons/validate` → `/api/coupons/validate`
- All pages — imports updated to use api.ts

### Modified Backend Files
- `src/routes/admin.ts` — category POST/PUT handle image_url/icon_type
