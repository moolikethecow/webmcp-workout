import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams('tab=plans'),
  push: vi.fn(),
  replace: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  useSearchParams: () => navigation.params,
  usePathname: () => '/gym',
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))
vi.mock('@/lib/chat/page-context', () => ({
  openChatRail: vi.fn(),
  useChatPageContext: vi.fn(),
}))
vi.mock('@/components/gym/shell/TrainTab', () => ({ default: () => <div>Train panel</div> }))
vi.mock('@/components/gym/shell/TemplatesTab', () => ({ default: () => <div>Templates panel</div> }))
vi.mock('@/components/gym/shell/HistoryTab', () => ({ default: () => <div>History panel</div> }))
vi.mock('@/components/gym/shell/GymSettingsSheet', () => ({ default: () => null }))
vi.mock('@/components/gym/exercises', () => ({ ExercisesTab: () => <div>Exercises panel</div> }))
vi.mock('@/components/health/MuscleMap', () => ({ MuscleMap: () => <div>Body map panel</div> }))

import GymShell from '@/components/gym/shell/GymShell'

function response(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as Response
}

beforeEach(() => {
  navigation.params = new URLSearchParams('tab=plans')
  navigation.push.mockReset()
  navigation.replace.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GymShell × PlansTab', () => {
  it('mounts the real plan surface at ?tab=plans in the intended tab order', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/gym/templates') {
        return response({ templates: [{ id: 'template-1', name: 'Upper A' }] })
      }
      if (url === '/api/gym/plans') return response({ plans: [] })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<GymShell />)

    expect(screen.getByRole('tab', { name: 'Plans' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('No training plans yet.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Training plans' })).not.toBeInTheDocument()
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No training plans yet.')
    // Scope to the gym tablist — the Health section strip also renders tabs.
    const gymTabs = within(screen.getByRole('tablist', { name: 'Gym sections' }))
    expect(gymTabs.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Train',
      'Plans',
      'Templates',
      'Body',
      'Exercises',
      'History',
    ])
  })
})
