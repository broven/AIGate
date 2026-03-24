import type { UniversalRequest, UniversalResponse, ToolCall } from '@aigate/shared'
import { safeJsonParse } from '../llms-bridge'

/**
 * Build Gemini generateContent request body from UniversalRequest.
 * Uses llms GeminiTransformer.transformRequestIn (Unified→Gemini).
 */
export async function buildGeminiBody(
  req: UniversalRequest,
  upstreamModel: string,
): Promise<any> {
  // llms GeminiTransformer.transformRequestIn requires a valid baseUrl for URL construction.
  // Since AIGate handles URL construction separately, we use manual conversion.
  return manualBuildGeminiBody(req, upstreamModel)
}

function manualBuildGeminiBody(req: UniversalRequest, upstreamModel: string): any {
  const contents: any[] = []
  let systemInstruction: any = undefined

  for (const msg of req.messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : ''
      systemInstruction = { parts: [{ text }] }
      continue
    }

    const role = msg.role === 'assistant' ? 'model' : 'user'

    if (msg.toolCalls) {
      const parts = msg.toolCalls.map((tc) => ({
        functionCall: {
          name: tc.name,
          args: safeJsonParse(tc.arguments),
        },
      }))
      contents.push({ role, parts })
    } else if (msg.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: msg.toolCallId ?? '',
            response: safeJsonParse(typeof msg.content === 'string' ? msg.content : '{}'),
          },
        }],
      })
    } else {
      // Handle both string and ContentPart[] content
      if (typeof msg.content === 'string') {
        contents.push({ role, parts: [{ text: msg.content }] })
      } else if (Array.isArray(msg.content)) {
        const parts = msg.content.map((p) => {
          if (p.type === 'text') return { text: p.text ?? '' }
          if (p.type === 'image' && p.imageUrl) {
            if (p.imageUrl.startsWith('data:')) {
              // Base64 data URL
              const [header, data] = p.imageUrl.split(',')
              const mimeType = header?.match(/data:([^;]+)/)?.[1] ?? 'image/png'
              return { inlineData: { mimeType, data } }
            }
            return { fileData: { mimeType: 'image/png', fileUri: p.imageUrl } }
          }
          return { text: '' }
        })
        contents.push({ role, parts })
      } else {
        contents.push({ role, parts: [{ text: '' }] })
      }
    }
  }

  const body: any = { contents }
  if (systemInstruction) body.systemInstruction = systemInstruction

  const genConfig: any = {}
  if (req.parameters.temperature !== undefined) genConfig.temperature = req.parameters.temperature
  if (req.parameters.maxTokens !== undefined) genConfig.maxOutputTokens = req.parameters.maxTokens
  if (req.parameters.topP !== undefined) genConfig.topP = req.parameters.topP
  if (Object.keys(genConfig).length > 0) body.generationConfig = genConfig

  if (req.parameters.tools) {
    body.tools = [{
      functionDeclarations: req.parameters.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    }]
  }

  return body
}

/**
 * Send request to Gemini API
 */
export async function sendToGemini(
  req: UniversalRequest,
  endpoint: string,
  apiKey: string,
  upstreamModel: string,
): Promise<Response> {
  const body = await buildGeminiBody(req, upstreamModel)
  const action = req.parameters.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
  const url = `${endpoint.replace(/\/$/, '')}/v1beta/models/${upstreamModel}:${action}?key=${apiKey}`

  return fetch(url, {
    method: 'POST',
    headers: {
      ...req.clientHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

/**
 * Parse Gemini generateContent response → UniversalResponse
 */
export function parseGeminiResponse(raw: any): UniversalResponse {
  const candidate = raw.candidates?.[0]
  const parts = candidate?.content?.parts ?? []

  // Extract text
  const textParts = parts.filter((p: any) => p.text !== undefined)
  const textContent = textParts.map((p: any) => p.text).join('')

  // Extract function calls
  let toolCalls: ToolCall[] | undefined
  const fcParts = parts.filter((p: any) => p.functionCall)
  if (fcParts.length > 0) {
    toolCalls = fcParts.map((p: any): ToolCall => ({
      id: p.functionCall.id ?? `call_${p.functionCall.name}`,
      name: p.functionCall.name,
      arguments: JSON.stringify(p.functionCall.args ?? {}),
    }))
  }

  // Map finish reason
  const reasonMap: Record<string, UniversalResponse['finishReason']> = {
    STOP: 'stop',
    MAX_TOKENS: 'length',
    SAFETY: 'stop',
    RECITATION: 'stop',
    OTHER: 'error',
  }

  const usage = raw.usageMetadata ?? {}

  return {
    id: raw.id ?? '',
    model: raw.model ?? '',
    content: textContent,
    finishReason: reasonMap[candidate?.finishReason] ?? 'stop',
    toolCalls,
    usage: {
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
    },
  }
}
