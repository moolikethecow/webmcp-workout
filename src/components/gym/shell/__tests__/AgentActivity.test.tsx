import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { recordAgentEvent, useAgentEventStore } from '@/lib/webmcp/agent-events'
import AgentActivity from '../AgentActivity'

beforeEach(() => {
  useAgentEventStore.getState().clear()
})

describe('AgentActivity', () => {
  it('renders nothing when there is no agent activity', () => {
    const { container } = render(<AgentActivity />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the last event', () => {
    recordAgentEvent('edit_active_workout', 'Replaced Chest Fly with Cable Press.', ['Chest Fly'])
    render(<AgentActivity />)

    expect(screen.getByLabelText('Agent activity')).toBeInTheDocument()
    expect(screen.getByText(/Agent: Replaced Chest Fly with Cable Press\./)).toBeInTheDocument()
    expect(screen.getByText(/ago/)).toBeInTheDocument()
  })

  it('expands to the recent list', () => {
    recordAgentEvent('edit_active_workout', 'Removed Leg Press.')
    recordAgentEvent('edit_active_workout', 'Added Face Pull.')
    render(<AgentActivity />)

    // Newest first: the strip shows the latest, the list shows both.
    fireEvent.click(screen.getByRole('button', { name: /recent/ }))
    expect(screen.getAllByText(/Agent: Removed Leg Press\./).length).toBe(1)
    expect(screen.getAllByText(/Agent: Added Face Pull\./).length).toBe(2)
  })

  it('says WebMCP is unavailable rather than reporting zero tools', () => {
    useAgentEventStore.getState().setRegistration({ checked: true, supported: false, registered: [] })
    render(<AgentActivity showStatus />)

    expect(screen.getByText('WebMCP: not available in this browser')).toBeInTheDocument()
  })

  it('reports the registered tool count when the browser supports WebMCP', () => {
    useAgentEventStore
      .getState()
      .setRegistration({ checked: true, supported: true, registered: ['get_active_workout', 'draft_workout'] })
    render(<AgentActivity showStatus />)

    expect(screen.getByText('WebMCP: 2 tools registered')).toBeInTheDocument()
  })
})
