/**
 * Product naming, in one place. Every user-visible name comes from here so the
 * app can be rebranded with environment variables and never hardcodes one.
 */
export const BRAND = {
  name: process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Spot',
  shortName: process.env.NEXT_PUBLIC_PRODUCT_SHORT_NAME ?? 'Spot',
  tagline: process.env.NEXT_PUBLIC_PRODUCT_TAGLINE ?? 'Your agent spots you.',
} as const
