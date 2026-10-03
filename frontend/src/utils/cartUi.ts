// The cart drawer lives in the storefront layout; any page can ask for it to open without prop drilling.
export const OPEN_CART_EVENT = 'vediqra:open-cart';

export const openCart = () => window.dispatchEvent(new CustomEvent(OPEN_CART_EVENT));
