import type { UniversalRequest, UniversalResponse, UniversalMessage, ToolCall, ToolDefinition } from '@aigate/shared'
import { safeJsonParse } from '../llms-bridge'
import { nanoid } from '../../utils'

/**
 * Parse Gemini generateContent request → UniversalRequest
 * Uses llms GeminiTransformer.transformRequestOut if available, otherwise manual conversion.
 */
export async function parseGeminiRequest(
  body: any,
  gatewayKeyName: string,
  modelName: string,
  stream: boolean = false,
): Promise<UniversalRequest> {
  // llms GeminiTransformer.transformRequestOut doesn't handle functionCall/functionResponse well,
  // so we use manual conversion which handles all Gemini content types correctly.
  return manualParseGeminiRequest(body, gatewayKeyName, modelName, stream)
}

function manualParseGeminiRequest(body: any, gatewayKeyName: string, modelName: string, stream: boolean = false): UniversalRequest {
  const messages: UniversalMessage[] = []

  // systemInstruction → system message
  if (body.systemInstruction) {
    const parts = body.systemInstruction.parts ?? []
    const text = parts.map((p: any) => p.text ?? '').join('')
    if (text) {
      messages.push({ role: 'system', content: text })
    }
  }

  // contents → messages
  if (body.contents) {
    for (const content of body.contents) {
      const role = content.role === 'model' ? 'assistant' : 'user'
      const parts = content.parts ?? []

      // Check for functionCall parts
      const functionCalls = parts.filter((p: any) => p.functionCall)
      const functionResponses = parts.filter((p: any) => p.functionResponse)
      const textParts = parts.filter((p: any) => p.text !== undefined)

      if (functionCalls.length > 0) {
        // Assistant message with tool calls
        const toolCalls: ToolCall[] = functionCalls.map((p: any) => ({
          id: p.functionCall.id ?? nanoid(12),
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args ?? {}),
        }))
        const text = textParts.map((p: any) => p.text).join('')
        messages.push({ role: 'assistant', content: text, toolCalls })
      } else if (functionResponses.length > 0) {
        // Tool response messages
        for (const p of functionResponses) {
          messages.push({
            role: 'tool',
            content: JSON.stringify(p.functionResponse.response ?? {}),
            toolCallId: p.functionResponse.name, // Gemini uses function name as ID
          })
        }
      } else {
        // Regular text message
        const text = textParts.map((p: any) => p.text).join('')
        messages.push({ role: role as UniversalMessage['role'], content: text })
      }
    }
  }

  // Extract tools
  let tools: ToolDefinition[] | undefined
  if (body.tools) {
    tools = []
    for (const toolGroup of body.tools) {
      if (toolGroup.functionDeclarations) {
        for (const decl of toolGroup.functionDeclarations) {
          tools.push({
            name: decl.name,
            description: decl.description ?? '',
            parameters: decl.parameters ?? decl.parametersJsonSchema ?? {},
          })
        }
      }
    }
  }

  const genConfig = body.generationConfig ?? {}

  return {
    id: nanoid(),
    model: modelName,
    messages,
    parameters: {
      temperature: genConfig.temperature,
      maxTokens: genConfig.maxOutputTokens,
      topP: genConfig.topP,
      stream,
      tools,
    },
    metadata: {
      sourceFormat: 'gemini',
      gatewayKey: gatewayKeyName,
      timestamp: Date.now(),
    },
  }
}

/**
 * Format UniversalResponse → Gemini generateContent response
 */
export function formatGeminiResponse(resp: UniversalResponse): any {
  const parts: any[] = []

  // Add text parts
  if (resp.content) {
    const text = typeof resp.content === 'string'
      ? resp.content
      : resp.content.filter((p) => p.type === 'text').map((p) => p.text).join('')
    if (text) {
      parts.push({ text })
    }
  }

  // Add functionCall parts
  if (resp.toolCalls) {
    for (const tc of resp.toolCalls) {
      parts.push({
        functionCall: {
          name: tc.name,
          args: typeof tc.arguments === 'string' ? safeJsonParse(tc.arguments) : tc.arguments,
        },
      })
    }
  }

  if (parts.length === 0) {
    parts.push({ text: '' })
  }

  const finishReasonMap: Record<string, string> = {
    stop: 'STOP',
    length: 'MAX_TOKENS',
    tool_calls: 'STOP',
    error: 'OTHER',
  }

  return {
    candidates: [
      {
        content: { parts, role: 'model' },
        finishReason: finishReasonMap[resp.finishReason] ?? 'STOP',
      },
    ],
    usageMetadata: resp.usage
      ? {
          promptTokenCount: resp.usage.inputTokens,
          candidatesTokenCount: resp.usage.outputTokens,
          totalTokenCount: resp.usage.inputTokens + resp.usage.outputTokens,
        }
      : { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
  }
}

/**
 * Format error in Gemini API format
 */
export function formatGeminiError(message: string, type: string): any {
  return {
    error: {
      code: 400,
      message,
      status: type,
    },
  }
}
