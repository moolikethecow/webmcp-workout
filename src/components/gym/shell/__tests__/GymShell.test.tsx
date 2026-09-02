import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
  push: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.params,
  useRouter: () => ({ replace: nav.replace, push: nav.push }),
  usePathname: () => '/gym',
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))
vi.mock('../TrainTab', () => ({ default: () => <div>Train panel</div> }))
vi.mock('../TemplatesTab', () => ({ default: () => <div>Templates panel</div> }))
vi.mock('../HistoryTab', () => ({ default: () => <div>History panel</div> }))
vi.mock('../GymSettingsSheet', () => ({ default: () => null }))
vi.mock('@/components/gym/plans/PlansTab', () => ({ default: () => <div>Plans panel</div> }))
vi.mock('@/components/gym/exercises', () => ({ ExercisesTab: () => <div>Exercises panel</div> }))
vi.mock('@/components/health/MuscleMap', () => ({ MuscleMap: () => <div>Body map panel</div> }))

import GymShell from '../GymShell'

beforeEach(() => {
  nav.params = new URLSearchParams()
  nav.replace.mockReset()
  nav.push.mockReset()
})

describe('GymShell', () => {
  it('deep-links the Body map with accessible tab semantics', () => {
    nav.params = new URLSearchParams('tab=body')
    render(<GymShell />)

    const gymTabs = screen.getByRole('tablist', { name: 'Gym sections' })
    expect(gymTabs).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Body' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Body map panel')
    // Scope to the gym tablist — the Health section strip (Overview/Gym/Food)
    // also renders tabs above it.
    const tabs = within(gymTabs).getAllByRole('tab').map((item) => item.textContent)
    expect(tabs).toEqual(['Train', 'Plans', 'Templates', 'Body', 'Exercises', 'History'])
  })

  it('deep-links the plan builder', () => {
    nav.params = new URLSearchParams('tab=plans')
    render(<GymShell />)

    expect(screen.getByRole('tab', { name: 'Plans' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Plans panel')
  })

  it('changes the URL on tab click', () => {
    render(<GymShell />)

    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(nav.replace).toHaveBeenCalledWith('/gym?tab=history')
  })
})
