import type { ApiFormat } from '../adapters/registry'

export interface StreamUsage {
  inputTokens: number
  outputTokens: number
}

/**
 * Intercepts an SSE stream to extract usage (token counts) while passing
 * all data through unchanged to the client.
 *
 * Returns a passthrough ReadableStream and a Promise that resolves with
 * usage data after the stream completes.
 */
export function extractUsageFromStream(
  stream: ReadableStream<Uint8Array>,
  upstreamFormat: ApiFormat,
): { passthrough: ReadableStream<Uint8Array>; usage: Promise<StreamUsage | null> } {
  const decoder = new TextDecoder()
  let resolveUsage: (value: StreamUsage | null) => void
  const usagePromise = new Promise<StreamUsage | null>((resolve) => {
    resolveUsage = resolve
  })

  // Track usage across events (Anthropic splits input/output across events)
  let inputTokens = 0
  let outputTokens = 0
  let foundUsage = false
  let lineBuffer = '' // Buffer for incomplete lines split across chunk boundaries
  let settled = false

  function settle() {
    if (settled) return
    settled = true
    resolveUsage(foundUsage ? { inputTokens, outputTokens } : null)
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Pass chunk through unchanged
      controller.enqueue(chunk)

      // Prepend any buffered incomplete line, then split on newlines
      const text = lineBuffer + decoder.decode(chunk, { stream: true })
      const lines = text.split('\n')
      // Last element may be an incomplete line — save it for next chunk
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        extractFromLine(line, upstreamFormat)
      }
    },
    flush() {
      // Process any remaining buffered text at end of stream
      if (lineBuffer) {
        extractFromLine(lineBuffer, upstreamFormat)
        lineBuffer = ''
      }
      settle()
    },
  })

  // Wrap the transform output in a new ReadableStream so that downstream
  // cancel (e.g. client disconnect) reliably calls settle() regardless of
  // whether Bun fires the TransformStream transformer's cancel hook.
  // pull()-based to respect backpressure; cancel() propagates upstream.
  const transformedStream = stream.pipeThrough(transform)
  let passthroughReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  const passthrough = new ReadableStream<Uint8Array>({
    start() {
      passthroughReader = transformedStream.getReader()
    },
    async pull(controller) {
      try {
        const { done, value } = await passthroughReader!.read()
        if (done) {
          settle()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (e) {
        settle()
        controller.error(e)
      }
    },
    cancel(reason) {
      settle()
      passthroughReader?.cancel(reason).catch(() => {})
    },
  })

  function extractFromLine(line: string, format: ApiFormat) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const jsonStr = trimmed.slice(5).trim()
    if (jsonStr === '[DONE]' || !jsonStr) return

    try {
      const obj = JSON.parse(jsonStr)

      if (format === 'openai') {
        // OpenAI: usage in final chunk when stream_options.include_usage is set
        if (obj.usage?.prompt_tokens !== undefined) {
          inputTokens = obj.usage.prompt_tokens
          outputTokens = obj.usage.completion_tokens ?? 0
          foundUsage = true
        }
      } else if (format === 'gemini') {
        // Gemini: usageMetadata in each chunk, last one has final counts
        if (obj.usageMetadata?.promptTokenCount !== undefined) {
          inputTokens = obj.usageMetadata.promptTokenCount
          outputTokens = obj.usageMetadata.candidatesTokenCount ?? 0
          foundUsage = true
        }
      } else if (format === 'claude') {
        // Anthropic message_start: input token count
        if (obj.type === 'message_start' && obj.message?.usage) {
          inputTokens = obj.message.usage.input_tokens ?? 0
          foundUsage = true
        }
        // Anthropic message_delta: output token count
        if (obj.type === 'message_delta' && obj.usage) {
          outputTokens = obj.usage.output_tokens ?? 0
          foundUsage = true
        }
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  return { passthrough, usage: usagePromise }
}
