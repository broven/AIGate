// Universal Message — normalized across all formats
export interface ContentPart {
  type: 'text' | 'image'
  text?: string
  imageUrl?: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: string // JSON string
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema object
}

export interface UniversalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  toolCallId?: string
  toolCalls?: ToolCall[]
}

// Universal Request — the internal lingua franca
export interface UniversalRequest {
  id: string
  model: string // Canonical model name
  messages: UniversalMessage[]
  parameters: {
    temperature?: number
    maxTokens?: number
    topP?: number
    stream?: boolean
    stop?: string[]
    tools?: ToolDefinition[]
    toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; name: string }
  }
  metadata: {
    sourceFormat: 'openai' | 'gemini' | 'claude'
    gatewayKey: string
    timestamp: number
  }
  /** Original client headers to forward upstream (hop-by-hop and auth headers excluded) */
  clientHeaders?: Record<string, string>
}

// Universal Response — returned from upstream
export interface UniversalResponse {
  id: string
  model: string
  content: string | ContentPart[]
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error'
  toolCalls?: ToolCall[]
  usage: UniversalUsage
}

/**
 * Normalized token accounting.
 *
 * `inputTokens` is always the **uncached** prompt token count: providers that
 * report cache hits inside their prompt total (OpenAI, Gemini) have them
 * subtracted here and reported separately, so the fields never double-count.
 */
export interface UniversalUsage {
  inputTokens: number
  outputTokens: number
  /** Prompt tokens served from a provider-side cache (billed at the cache-read rate). */
  cachedInputTokens?: number
  /** Prompt tokens written into a provider-side cache (billed at the cache-write rate). */
  cacheWriteTokens?: number
  /** Reasoning / thinking tokens not included in `outputTokens` (billed at the output rate). */
  reasoningTokens?: number
}

// Router Decision
export interface RouteAttempt {
  provider: string
  deploymentId: string
  groupName?: string | null
  price: number
  priceInput: number
  priceOutput: number
  status: 'success' | 'failed' | 'skipped_cooldown' | 'skipped_no_price' | 'skipped_cost_limit'
  error?: string
  latencyMs?: number
}

export interface RequestLog {
  id: string
  model: string
  gatewayKey: string
  sourceFormat: 'openai' | 'gemini' | 'claude'
  attempts: RouteAttempt[]
  finalProvider: string | null
  totalLatencyMs: number
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  /** True when the upstream never reported usage — distinguishes "unknown" from "genuinely free". */
  usageMissing: boolean
  cost: number | null
  savedVsDirect: number | null
  success: boolean
  createdAt: string
}
