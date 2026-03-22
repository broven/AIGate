import type { UniversalRequest, UniversalResponse, ToolCall } from '@aigate/shared'
import { getTransformer, buildContext, unifiedToUniversal, safeJsonParse } from '../llms-bridge'

/**
 * Parse Anthropic Messages API request → UniversalRequest
 * Uses llms AnthropicTransformer.transformRequestOut to convert Anthropic → OpenAI-shaped unified format
 */
export async function parseAnthropicRequest(
  body: any,
  gatewayKeyName: string,
): Promise<UniversalRequest> {
  const transformer = getTransformer('Anthropic')
  const ctx = buildContext({ stream: body.stream ?? false, model: body.model })

  // transformRequestOut converts Anthropic native → OpenAI-shaped UnifiedChatRequest
  const unified = await transformer.transformRequestOut!(body, ctx)

  // Convert from llms UnifiedChatRequest → AIGate UniversalRequest
  return unifiedToUniversal(unified, {
    sourceFormat: 'claude',
    gatewayKey: gatewayKeyName,
  })
}

/**
 * Format UniversalResponse → Anthropic Messages API response
 */
export function formatAnthropicResponse(resp: UniversalResponse): any {
  const content: any[] = []

  // Add text content block if there's text
  if (resp.content) {
    const text = typeof resp.content === 'string'
      ? resp.content
      : resp.content.filter((p) => p.type === 'text').map((p) => p.text).join('')
    if (text) {
      content.push({ type: 'text', text })
    }
  }

  // Add tool_use blocks
  if (resp.toolCalls) {
    for (const tc of resp.toolCalls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: typeof tc.arguments === 'string' ? safeJsonParse(tc.arguments) : tc.arguments,
      })
    }
  }

  // If no content at all, add empty text
  if (content.length === 0) {
    content.push({ type: 'text', text: '' })
  }

  const stopReasonMap: Record<string, string> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    error: 'end_turn',
  }

  return {
    id: `msg_${resp.id}`,
    type: 'message',
    role: 'assistant',
    content,
    model: resp.model,
    stop_reason: stopReasonMap[resp.finishReason] ?? 'end_turn',
    stop_sequence: null,
    usage: resp.usage
      ? { input_tokens: resp.usage.inputTokens, output_tokens: resp.usage.outputTokens }
      : { input_tokens: 0, output_tokens: 0 },
  }
}

/**
 * Format error in Anthropic Messages API format
 */
export function formatAnthropicError(message: string, type: string): any {
  return {
    type: 'error',
    error: {
      type,
      message,
    },
  }
}
