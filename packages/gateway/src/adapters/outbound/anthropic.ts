import type { UniversalRequest, UniversalResponse, ToolCall } from '@aigate/shared'
import { getTransformer, buildContext, universalToUnified, safeJsonParse } from '../llms-bridge'

/**
 * Build Anthropic Messages API request body from UniversalRequest.
 * Uses llms AnthropicTransformer.transformRequestIn (Unified→Anthropic) if available,
 * otherwise does manual conversion.
 */
export async function buildAnthropicBody(
  req: UniversalRequest,
  upstreamModel: string,
): Promise<any> {
  const transformer = getTransformer('Anthropic')

  // Convert AIGate UniversalRequest → llms UnifiedChatRequest (OpenAI-shaped)
  const unified = universalToUnified(req)
  unified.model = upstreamModel

  // Check if transformer has transformRequestIn
  if (transformer.transformRequestIn) {
    const provider = { name: 'anthropic', api_base_url: '', apiKey: '' }
    const ctx = buildContext({ stream: req.parameters.stream ?? false, model: upstreamModel, provider })
    return await transformer.transformRequestIn(unified, provider, ctx)
  }

  // Manual conversion fallback
  return manualBuildAnthropicBody(req, upstreamModel)
}

function manualBuildAnthropicBody(req: UniversalRequest, upstreamModel: string): any {
  // Extract system messages
  const systemMessages = req.messages.filter((m) => m.role === 'system')
  const nonSystemMessages = req.messages.filter((m) => m.role !== 'system')

  let system: any = undefined
  if (systemMessages.length > 0) {
    const systemText = systemMessages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n')
    system = systemText
  }

  // Convert messages
  const messages = nonSystemMessages.map((msg) => {
    if (msg.role === 'assistant' && msg.toolCalls) {
      // Assistant with tool calls → content blocks
      const content: any[] = []
      if (msg.content && typeof msg.content === 'string' && msg.content.length > 0) {
        content.push({ type: 'text', text: msg.content })
      }
      for (const tc of msg.toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: safeJsonParse(tc.arguments),
        })
      }
      return { role: 'assistant', content }
    }

    if (msg.role === 'tool') {
      // Tool results → user message with tool_result content block
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.toolCallId,
            content: msg.content,
          },
        ],
      }
    }

    // Regular messages
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content }
    }

    // Content parts
    const content = Array.isArray(msg.content)
      ? msg.content.map((p) => {
          if (p.type === 'text') return { type: 'text', text: p.text }
          if (p.type === 'image' && p.imageUrl) {
            return {
              type: 'image',
              source: { type: 'url', url: p.imageUrl },
            }
          }
          return p
        })
      : msg.content
    return { role: msg.role, content }
  })

  const body: any = {
    model: upstreamModel,
    messages,
    max_tokens: req.parameters.maxTokens ?? 4096,
  }

  if (system) body.system = system
  if (req.parameters.temperature !== undefined) body.temperature = req.parameters.temperature
  if (req.parameters.topP !== undefined) body.top_p = req.parameters.topP
  if (req.parameters.stream) body.stream = true
  if (req.parameters.stop) body.stop_sequences = req.parameters.stop

  if (req.parameters.tools) {
    body.tools = req.parameters.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
  }

  return body
}

/**
 * Send request to Anthropic Messages API
 */
export async function sendToAnthropic(
  req: UniversalRequest,
  endpoint: string,
  apiKey: string,
  upstreamModel: string,
): Promise<Response> {
  const body = await buildAnthropicBody(req, upstreamModel)
  const url = `${endpoint.replace(/\/$/, '')}/v1/messages`

  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })
}

/**
 * Parse Anthropic Messages API response → UniversalResponse
 */
export function parseAnthropicResponse(raw: any): UniversalResponse {
  const content = raw.content ?? []

  // Extract text content
  const textParts = content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
  const textContent = textParts.join('')

  // Extract tool calls
  let toolCalls: ToolCall[] | undefined
  const toolUseBlocks = content.filter((b: any) => b.type === 'tool_use')
  if (toolUseBlocks.length > 0) {
    toolCalls = toolUseBlocks.map((b: any): ToolCall => ({
      id: b.id,
      name: b.name,
      arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input),
    }))
  }

  // Map stop_reason
  const reasonMap: Record<string, UniversalResponse['finishReason']> = {
    end_turn: 'stop',
    max_tokens: 'length',
    tool_use: 'tool_calls',
    stop_sequence: 'stop',
  }

  return {
    id: raw.id ?? '',
    model: raw.model ?? '',
    content: textContent,
    finishReason: reasonMap[raw.stop_reason] ?? 'stop',
    toolCalls,
    usage: {
      inputTokens: raw.usage?.input_tokens ?? 0,
      outputTokens: raw.usage?.output_tokens ?? 0,
    },
  }
}
