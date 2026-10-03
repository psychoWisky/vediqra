/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  // classes assembled at runtime (Button / Badge build `btn-${variant}` / `badge-${tone}`)
  safelist: ['btn-primary', 'btn-accent', 'btn-secondary', 'btn-ghost', 'badge-neutral', 'badge-accent', 'badge-dark', 'badge-danger'],
  theme: {
    extend: {
      colors: {
        // VEDIQRA storefront tokens. The values live in src/styles/globals.css (:root) so the whole
        // storefront can be re-themed in one place. `premium.*` below is kept for the admin panel only.
        brand: {
          ink: 'rgb(var(--brand-ink) / <alpha-value>)',
          'ink-soft': 'rgb(var(--brand-ink-soft) / <alpha-value>)',
          surface: 'rgb(var(--brand-surface) / <alpha-value>)',
          subtle: 'rgb(var(--brand-subtle) / <alpha-value>)',
          line: 'rgb(var(--brand-line) / <alpha-value>)',
          muted: 'rgb(var(--brand-muted) / <alpha-value>)',
          accent: 'rgb(var(--brand-accent) / <alpha-value>)',
          'accent-ink': 'rgb(var(--brand-accent-ink) / <alpha-value>)',
          'accent-soft': 'rgb(var(--brand-accent-soft) / <alpha-value>)',
          danger: 'rgb(var(--brand-danger) / <alpha-value>)',
          success: 'rgb(var(--brand-success) / <alpha-value>)',
        },
        premium: {
          gold: '#D4AF37',
          charcoal: '#1A1A1A',
          cream: '#F5F5F0',
          burgundy: '#800020',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        serif: ['Playfair Display', 'Georgia', 'serif'], // admin panel only
        heading: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgb(17 17 17 / 0.05)',
        pop: '0 12px 32px -8px rgb(17 17 17 / 0.18)',
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-in-out',
        'slide-up': 'slideUp 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}