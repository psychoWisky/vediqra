import { OptionGroup, OptionValue, Product, SelectedOption } from '../types';

// Colour and size keep their dedicated pickers in the storefront for now; every OTHER group is
// rendered generically. (The API derives product.colors / product.sizes from these two groups.)
export const DEDICATED_GROUP_SLUGS = ['colour', 'size'];

export const getExtraGroups = (product: Pick<Product, 'option_groups'> | null | undefined): OptionGroup[] =>
  (product?.option_groups || []).filter(
    (g) => g.is_active && !DEDICATED_GROUP_SLUGS.includes(g.slug) && g.values.some((v) => v.is_active)
  );

export const toSelectedOption = (group: OptionGroup, value: OptionValue): SelectedOption => ({
  group_id: group.id,
  group_name: group.name,
  value_id: value.id,
  name: value.name,
  price_modifier: Number(value.price_modifier) || 0,
});

/** Selected colour/size (legacy pickers) as generic selections. */
export const variantSelections = (
  product: Pick<Product, 'option_groups'>,
  colorId?: string,
  sizeId?: string
): SelectedOption[] => {
  const out: SelectedOption[] = [];
  for (const g of product.option_groups || []) {
    const wanted = g.slug === 'colour' ? colorId : g.slug === 'size' ? sizeId : undefined;
    const value = wanted ? g.values.find((v) => v.id === wanted) : undefined;
    if (value) out.push(toSelectedOption(g, value));
  }
  return out;
};

export const optionsTotal = (selected: SelectedOption[]): number =>
  selected.reduce((sum, s) => sum + (Number(s.price_modifier) || 0), 0);

/** Required, non-dedicated groups the shopper has not chosen yet (for add-to-cart validation). */
export const missingRequiredGroups = (product: Pick<Product, 'option_groups'>, chosen: Record<string, string>): OptionGroup[] =>
  getExtraGroups(product).filter((g) => g.is_required && !chosen[g.id]);

/** Any required group (dedicated or not) that a quick "add" button cannot satisfy on its own. */
export const hasRequiredExtraGroups = (product: Pick<Product, 'option_groups'>): boolean =>
  getExtraGroups(product).some((g) => g.is_required);

// ---- All option groups (colour and size included): used where no dedicated colour/size picker exists ----

export const getAllGroups = (product: Pick<Product, 'option_groups'> | null | undefined): OptionGroup[] =>
  (product?.option_groups || []).filter((g) => g.is_active && g.values.some((v) => v.is_active));

/** Turn a picker state (option group id -> option value id) into ordered selections. */
export const selectionsFromChoices = (
  product: Pick<Product, 'option_groups'>,
  choices: Record<string, string>
): SelectedOption[] =>
  getAllGroups(product).flatMap((g) => {
    const value = g.values.find((v) => v.is_active && v.id === choices[g.id]);
    return value ? [toSelectedOption(g, value)] : [];
  });

export const missingRequiredAll = (product: Pick<Product, 'option_groups'>, choices: Record<string, string>): OptionGroup[] =>
  getAllGroups(product).filter((g) => g.is_required && !choices[g.id]);

/** Image of the first chosen option value that has one (e.g. a colour), else undefined. */
export const imageForChoices = (product: Pick<Product, 'option_groups'>, choices: Record<string, string>): string | undefined => {
  for (const g of getAllGroups(product)) {
    const value = g.values.find((v) => v.id === choices[g.id]);
    if (value?.image_url) return value.image_url;
  }
  return undefined;
};
