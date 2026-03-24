import type { UniversalRequest, UniversalResponse, ContentPart, ToolCall } from '@aigate/shared'

interface OutboundResult {
  response: UniversalResponse
  raw?: unknown
}

function buildMessages(req: UniversalRequest) {
  return req.messages.map((msg) => {
    const out: Record<string, unknown> = { role: msg.role }

    if (typeof msg.content === 'string') {
      out.content = msg.content
    } else if (Array.isArray(msg.content)) {
      out.content = msg.content.map((part: ContentPart) => {
        if (part.type === 'text') return { type: 'text', text: part.text }
        return { type: 'image_url', image_url: { url: part.imageUrl } }
      })
    } else {
      out.content = null
    }

    if (msg.toolCallId) out.tool_call_id = msg.toolCallId
    if (msg.toolCalls) {
      out.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      }))
    }

    return out
  })
}

function buildBody(req: UniversalRequest, upstreamModel: string) {
  const body: Record<string, unknown> = {
    model: upstreamModel,
    messages: buildMessages(req),
  }

  if (req.parameters.temperature !== undefined) body.temperature = req.parameters.temperature
  if (req.parameters.maxTokens !== undefined) body.max_tokens = req.parameters.maxTokens
  if (req.parameters.topP !== undefined) body.top_p = req.parameters.topP
  if (req.parameters.stream) body.stream = true
  if (req.parameters.stop) body.stop = req.parameters.stop
  if (req.parameters.tools) {
    body.tools = req.parameters.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  return body
}

export async function sendToOpenAICompatible(
  req: UniversalRequest,
  endpoint: string,
  apiKey: string,
  upstreamModel: string,
): Promise<Response> {
  const body = buildBody(req, upstreamModel)
  const url = `${endpoint.replace(/\/$/, '')}/v1/chat/completions`

  return fetch(url, {
    method: 'POST',
    headers: {
      ...req.clientHeaders,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
}

export function parseOpenAIResponse(raw: Record<string, unknown>): UniversalResponse {
  const choice = (raw.choices as Array<Record<string, unknown>>)?.[0]
  const message = choice?.message as Record<string, unknown> | undefined
  const usage = raw.usage as Record<string, number> | undefined

  let toolCalls: ToolCall[] | undefined
  if (message?.tool_calls) {
    const tcs = message.tool_calls as Array<Record<string, unknown>>
    toolCalls = tcs.map((tc) => {
      const fn = tc.function as Record<string, string>
      return { id: tc.id as string, name: fn.name, arguments: fn.arguments }
    })
  }

  const finishMap: Record<string, UniversalResponse['finishReason']> = {
    stop: 'stop',
    length: 'length',
    tool_calls: 'tool_calls',
  }

  return {
    id: raw.id as string,
    model: raw.model as string,
    content: (message?.content as string) ?? '',
    finishReason: finishMap[(choice?.finish_reason as string) ?? 'stop'] ?? 'stop',
    toolCalls,
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
    },
  }
}
