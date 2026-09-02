import type { Metadata } from 'next'

import { BRAND } from '@/lib/brand'

import './globals.css'

export const metadata: Metadata = {
  title: BRAND.name,
  description: BRAND.tagline,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
