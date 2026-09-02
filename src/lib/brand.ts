/**
 * Product naming, in one place. Every user-visible name comes from here so the
 * app can be rebranded with environment variables and never hardcodes one.
 */
export const BRAND = {
  name: process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Workout',
  shortName: process.env.NEXT_PUBLIC_PRODUCT_SHORT_NAME ?? 'Workout',
  tagline: process.env.NEXT_PUBLIC_PRODUCT_TAGLINE ?? 'Train with your agent.',
} as const
