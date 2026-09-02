import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['pg', 'drizzle-orm'],
  poweredByHeader: false,
  compress: true,
  experimental: { optimizePackageImports: ['lucide-react'] },
}

export default nextConfig
