/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  readonly VITE_RAZORPAY_KEY_ID: string
  readonly VITE_SUPPORT_EMAIL?: string
  readonly VITE_SUPPORT_PHONE?: string
  readonly VITE_SOCIAL_INSTAGRAM?: string
  readonly VITE_SOCIAL_FACEBOOK?: string
  readonly VITE_SOCIAL_YOUTUBE?: string
  readonly VITE_SOCIAL_X?: string
  readonly VITE_WEBSITE_URL?: string
  readonly VITE_META_PIXEL_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
