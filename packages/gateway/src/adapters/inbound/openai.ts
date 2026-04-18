import type { UniversalRequest, UniversalMessage, ContentPart, ToolCall, ToolDefinition } from '@aigate/shared'
import { nanoid } from '../../utils'

export const STRUCTURED_OUTPUT_SENTINEL = '__aigate_structured_output__'

type OpenAIToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'function'; function: { name: string } }

interface OpenAIResponseFormat {
  type: 'text' | 'json_object' | 'json_schema'
  json_schema?: {
    name: string
    schema: Record<string, unknown>
    strict?: boolean
  }
}

interface OpenAIMessage {
  role: string
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

interface OpenAIChatRequest {
  model: string
  messages: OpenAIMessage[]
  temperature?: number
  max_tokens?: number
  max_completion_tokens?: number
  top_p?: number
  stream?: boolean
  stop?: string | string[]
  tools?: Array<{
    type: 'function'
    function: { name: string; description: string; parameters: Record<string, unknown> }
  }>
  tool_choice?: OpenAIToolChoice
  response_format?: OpenAIResponseFormat
}

function parseMessage(msg: OpenAIMessage): UniversalMessage {
  let content: string | ContentPart[]

  if (msg.content === null || msg.content === undefined) {
    content = ''
  } else if (typeof msg.content === 'string') {
    content = msg.content
  } else {
    content = msg.content.map((part): ContentPart => {
      if (part.type === 'text') {
        return { type: 'text', text: part.text }
      }
      return { type: 'image', imageUrl: part.image_url?.url }
    })
  }

  // Map OpenAI-specific roles to universal roles (e.g. "developer" → "system")
  const roleMap: Record<string, UniversalMessage['role']> = { developer: 'system' }
  const role = roleMap[msg.role] ?? (msg.role as UniversalMessage['role'])

  const universal: UniversalMessage = {
    role,
    content,
  }

  if (msg.tool_call_id) {
    universal.toolCallId = msg.tool_call_id
  }

  if (msg.tool_calls) {
    universal.toolCalls = msg.tool_calls.map((tc): ToolCall => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }))
  }

  return universal
}

export function parseOpenAIRequest(
  body: OpenAIChatRequest,
  gatewayKeyName: string,
): UniversalRequest {
  const tools: ToolDefinition[] = body.tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  })) ?? []

  let toolChoice: UniversalRequest['parameters']['toolChoice']
  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === 'string') {
      toolChoice = body.tool_choice
    } else if (body.tool_choice.type === 'function') {
      toolChoice = { type: 'function', name: body.tool_choice.function.name }
    }
  }

  if (body.response_format?.type === 'json_schema') {
    if (body.stream) {
      throw new Error('response_format: json_schema is not supported with stream: true')
    }
    const schema = body.response_format.json_schema?.schema
    if (!schema || typeof schema !== 'object') {
      throw new Error('response_format.json_schema.schema is required')
    }
    if (tools.some((t) => t.name === STRUCTURED_OUTPUT_SENTINEL)) {
      throw new Error(`Tool name "${STRUCTURED_OUTPUT_SENTINEL}" is reserved`)
    }
    if (body.response_format.json_schema?.strict) {
      console.debug('structured_output.strict_downgraded', {
        gatewayKey: gatewayKeyName,
        model: body.model,
      })
    }
    tools.push({
      name: STRUCTURED_OUTPUT_SENTINEL,
      description: 'Return the structured response matching the requested schema.',
      parameters: schema,
    })
    toolChoice = { type: 'function', name: STRUCTURED_OUTPUT_SENTINEL }
  }

  return {
    id: nanoid(),
    model: body.model,
    messages: body.messages.map(parseMessage),
    parameters: {
      temperature: body.temperature,
      maxTokens: body.max_tokens ?? body.max_completion_tokens,
      topP: body.top_p,
      stream: body.stream ?? false,
      stop: typeof body.stop === 'string' ? [body.stop] : body.stop,
      tools: tools.length > 0 ? tools : undefined,
      toolChoice,
    },
    metadata: {
      sourceFormat: 'openai',
      gatewayKey: gatewayKeyName,
      timestamp: Date.now(),
    },
  }
}

export function formatOpenAIResponse(
  id: string,
  model: string,
  content: string | ContentPart[],
  finishReason: string,
  toolCalls?: ToolCall[],
  usage?: { inputTokens: number; outputTokens: number },
) {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: typeof content === 'string' ? content : null,
  }

  const sentinelCall = toolCalls?.find((tc) => tc.name === STRUCTURED_OUTPUT_SENTINEL)
  const isStructuredOutput = sentinelCall !== undefined

  if (isStructuredOutput) {
    message.content = sentinelCall.arguments
  } else if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments },
    }))
  }

  const finishMap: Record<string, string> = {
    stop: 'stop',
    length: 'length',
    tool_calls: 'tool_calls',
    error: 'stop',
  }

  return {
    id: `chatcmpl-${id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: isStructuredOutput ? 'stop' : (finishMap[finishReason] || 'stop'),
      },
    ],
    usage: usage
      ? {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          total_tokens: usage.inputTokens + usage.outputTokens,
        }
      : undefined,
  }
}

export function formatOpenAIStreamChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
) {
  return {
    id: `chatcmpl-${id}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  }
}

export function formatOpenAIError(message: string, type: string, code?: string | number) {
  return {
    error: { message, type, code },
  }
}
