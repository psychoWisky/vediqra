// Storefront dark theme switch. The admin panel (route /admin) stays on the light tokens.
// The regex below must match the router: App.tsx only mounts the admin at exactly /admin (any case, optional
// trailing slash); every other path, including unknown /admin/... URLs, renders inside the storefront Layout.
// index.html contains the same test for first paint (before React runs) — keep the two in sync.
export const isAdminPath = (pathname: string): boolean => /^\/admin\/?$/i.test(pathname);

const THEME_CLASS = 'theme-dark';
const DARK_THEME_COLOR = '#0B0B0B';
const LIGHT_THEME_COLOR = '#D4AF5A';

/** Idempotent: sets the class (and the browser UI colour) to exactly the requested state. */
export function setStorefrontTheme(dark: boolean): void {
  document.documentElement.classList.toggle(THEME_CLASS, dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
}
