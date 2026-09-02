'use client'

/**
 * `/` — the dashboard. The gym section lives at /gym; this is the page you open
 * (or point an agent at) to see where training stands right now.
 */
import Dashboard from '@/components/gym/dashboard/Dashboard'

export default function HomePage() {
  return <Dashboard />
}
