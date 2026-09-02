'use client'

/**
 * Page → agent context bridge.
 *
 * A page publishes a compact description of what it is showing so an agent
 * asking "what am I looking at?" gets the artifact, not the DOM. The WebMCP
 * tool layer is the consumer; this keeps the publishing side inert until it
 * subscribes.
 */
export type ChatPageContext = Record<string, string>

/** Publish the current page's artifact context while this component is mounted. */
export function useChatPageContext(_context: ChatPageContext | null): void {}
