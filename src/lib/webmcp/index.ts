/**
 * The WebMCP layer: this app's tools, exposed to whatever agent is driving the
 * browser. See docs/WEBMCP.md for how it works and docs/AGENT_GUIDE.md for the
 * rules an agent is expected to follow here.
 */
export { registerTools, registerDeclarativeFallbacks, getModelContext, type RegisterResult } from './register'
export { agentFetch, query, type AgentFetchResult } from './fetch'
export { useGymWebMCP, type GymWebMcpStatus } from './use-gym-webmcp'
export {
  ALL_TOOLS,
  DECLARATIVE_FALLBACKS,
  declarativeFallbacksForPage,
  toolsForPage,
  type GymPage,
} from './tools'
export { stageForm, settleStagedForm, clearStagedForm, isStaged, STAGED_EVENT } from './staged-form'
export {
  useAgentEventStore,
  recordAgentEvent,
  agentEvents,
  agentTouchedAt,
  agentTouchedRecently,
  AGENT_PULSE_MS,
  ALL_EXERCISES,
  type AgentEvent,
  type AgentRegistration,
} from './agent-events'
export { useAgentPulse } from './use-agent-pulse'
export type {
  JsonSchemaObject,
  ModelContextLike,
  WebMcpTool,
  WebMcpToolAnnotations,
  WebMcpToolResult,
} from './types'
