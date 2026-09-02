import type { Metadata } from 'next'

import { BRAND } from '@/lib/brand'

import './globals.css'

export const metadata: Metadata = {
  title: BRAND.name,
  description: BRAND.tagline,
}

// Read at request time, not build time, so the origin-trial token can be set
// on the running container without rebuilding the image.
export const dynamic = 'force-dynamic'

/**
 * Chrome origin-trial tokens for WebMCP (developer.chrome.com/origintrials,
 * trial "WebMCP"). One token per origin; several may be comma-separated. The
 * token is public by nature (it ships in the HTML), so it lives in plain env.
 * ChatGPT's browser and Chrome with chrome://flags/#enable-webmcp-testing do
 * not need it; Chrome without the flag does.
 */
function originTrialTokens(): string[] {
  return (process.env.WEBMCP_ORIGIN_TRIAL_TOKEN ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const tokens = originTrialTokens()
  return (
    <html lang="en">
      <head>
        {tokens.map((token) => (
          <meta key={token.slice(0, 16)} httpEquiv="origin-trial" content={token} />
        ))}
      </head>
      <body>{children}</body>
    </html>
  )
}
