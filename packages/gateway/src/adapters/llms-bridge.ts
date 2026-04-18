// @ts-expect-error — no type declarations available
import Server from '@musistudio/llms'
import type { UniversalRequest, UniversalMessage, ContentPart, ToolCall, ToolDefinition } from '@aigate/shared'
import { nanoid } from '../utils'

/** Safely parse JSON, returning fallback on failure */
export function safeJsonParse(str: string, fallback: any = {}): any {
  try {
    return JSON.parse(str)
  } catch {
    return fallback
  }
}

// llms uses OpenAI format as its internal "UnifiedChatRequest"
// We bridge between AIGate's UniversalRequest (camelCase) and llms's format (snake_case/OpenAI-shaped)

interface LlmsTransformer {
  name?: string
  endPoint?: string
  transformRequestOut?: (request: any, context: any) => Promise<any>
  transformRequestIn?: (request: any, provider: any, context: any) => Promise<any>
  transformResponseIn?: (response: Response, context?: any) => Promise<Response>
  transformResponseOut?: (response: Response, context?: any) => Promise<Response>
  auth?: (request: any, provider: any, context: any) => Promise<any>
  convertOpenAIStreamToAnthropic?: (response: Response, context?: any) => Response
  convertOpenAIResponseToAnthropic?: (response: any, context?: any) => any
  [key: string]: any
}

let server: any
let transformerService: any
let initialized = false

export function initLlmsBridge(): void {
  if (initialized) return
  server = new Server({ initialConfig: { providers: [] } })
  // TransformerService registers built-in transformers synchronously in the constructor.
  // Custom transformers from config are loaded async, but we don't use those.
  transformerService = server.transformerService
  if (!transformerService?.getTransformer('Anthropic')) {
    throw new Error('llms TransformerService failed to initialize — Anthropic transformer not found')
  }
  initialized = true
}

export function getTransformer(name: string): LlmsTransformer {
  if (!initialized) throw new Error('llms bridge not initialized. Call initLlmsBridge() first.')
  const t = transformerService.getTransformer(name)
  if (!t) throw new Error(`Transformer "${name}" not found`)
  return t
}

export function buildContext(opts: {
  stream: boolean
  model: string
  provider?: { name: string; api_base_url: string; apiKey: string; [key: string]: any }
}): any {
  return {
    req: { id: nanoid(), body: {} },
    stream: opts.stream,
    model: opts.model,
    provider: opts.provider ?? { name: 'default', api_base_url: '', apiKey: '' },
  }
}

// --- Type bridge: AIGate UniversalRequest ↔ llms UnifiedChatRequest (OpenAI-shaped) ---

interface UnifiedMessage {
  role: string
  content: string | null | any[]
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

interface UnifiedChatRequest {
  model: string
  messages: UnifiedMessage[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  stop?: string[]
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: any } }>
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }
  [key: string]: any
}

/**
 * Convert AIGate UniversalRequest → llms UnifiedChatRequest (OpenAI-shaped)
 */
export function universalToUnified(req: UniversalRequest): UnifiedChatRequest {
  const messages: UnifiedMessage[] = req.messages.map((msg) => {
    const out: UnifiedMessage = {
      role: msg.role,
      content: convertContentToUnified(msg.content),
    }

    if (msg.toolCalls) {
      out.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }))
    }

    if (msg.toolCallId) {
      out.tool_call_id = msg.toolCallId
    }

    return out
  })

  const unified: UnifiedChatRequest = {
    model: req.model,
    messages,
    stream: req.parameters.stream ?? false,
  }

  if (req.parameters.temperature !== undefined) unified.temperature = req.parameters.temperature
  if (req.parameters.maxTokens !== undefined) unified.max_tokens = req.parameters.maxTokens
  if (req.parameters.topP !== undefined) unified.top_p = req.parameters.topP
  if (req.parameters.stop) unified.stop = req.parameters.stop

  if (req.parameters.tools) {
    unified.tools = req.parameters.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
  if (req.parameters.toolChoice !== undefined) {
    const tc = req.parameters.toolChoice
    unified.tool_choice = typeof tc === 'string'
      ? tc
      : { type: 'function', function: { name: tc.name } }
  }

  return unified
}

function convertContentToUnified(content: string | ContentPart[]): string | null | any[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null

  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (part.type === 'image') return { type: 'image_url', image_url: { url: part.imageUrl } }
    return part
  })
}

/**
 * Convert llms UnifiedChatRequest (OpenAI-shaped) → AIGate UniversalRequest
 */
export function unifiedToUniversal(
  unified: UnifiedChatRequest,
  metadata: { sourceFormat: 'openai' | 'gemini' | 'claude'; gatewayKey: string },
): UniversalRequest {
  const messages: UniversalMessage[] = unified.messages.map((msg) => {
    const out: UniversalMessage = {
      role: msg.role as UniversalMessage['role'],
      content: convertContentFromUnified(msg.content),
    }

    if (msg.tool_calls) {
      out.toolCalls = msg.tool_calls.map((tc): ToolCall => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }))
    }

    if (msg.tool_call_id) {
      out.toolCallId = msg.tool_call_id
    }

    return out
  })

  const tools: ToolDefinition[] | undefined = unified.tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }))

  let toolChoice: UniversalRequest['parameters']['toolChoice']
  if (unified.tool_choice !== undefined) {
    toolChoice = typeof unified.tool_choice === 'string'
      ? unified.tool_choice
      : { type: 'function', name: unified.tool_choice.function.name }
  }

  return {
    id: nanoid(),
    model: unified.model,
    messages,
    parameters: {
      temperature: unified.temperature,
      maxTokens: unified.max_tokens,
      topP: unified.top_p,
      stream: unified.stream ?? false,
      stop: unified.stop,
      tools,
      toolChoice,
    },
    metadata: {
      sourceFormat: metadata.sourceFormat,
      gatewayKey: metadata.gatewayKey,
      timestamp: Date.now(),
    },
  }
}

function convertContentFromUnified(content: string | null | any[]): string | ContentPart[] {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content.map((part): ContentPart => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (part.type === 'image_url') return { type: 'image', imageUrl: part.image_url?.url }
    return part
  })
}
