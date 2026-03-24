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
  }
  metadata: {
    sourceFormat: 'openai' | 'gemini' | 'claude'
    gatewayKey: string
    timestamp: number
  }
}

// Universal Response — returned from upstream
export interface UniversalResponse {
  id: string
  model: string
  content: string | ContentPart[]
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error'
  toolCalls?: ToolCall[]
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

// Router Decision
export interface RouteAttempt {
  provider: string
  deploymentId: string
  groupName?: string | null
  price: number
  priceInput: number
  priceOutput: number
  status: 'success' | 'failed' | 'skipped_cooldown'
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
  cost: number | null
  savedVsDirect: number | null
  success: boolean
  createdAt: string
}
