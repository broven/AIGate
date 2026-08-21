import type { ApiFormat } from '../adapters/registry'

import type { UniversalUsage } from '@aigate/shared'

/**
 * Same disjoint-bucket invariant as UniversalUsage: `inputTokens` excludes
 * cached prompt tokens and `outputTokens` excludes reasoning tokens, so each
 * bucket can be billed at its own rate without double counting.
 */
export type StreamUsage = UniversalUsage

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
  let cachedInputTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  let foundUsage = false
  let lineBuffer = '' // Buffer for incomplete lines split across chunk boundaries
  let settled = false

  function settle() {
    if (settled) return
    settled = true
    // null means "the upstream never told us" — NOT zero. The caller records
    // it as usageMissing so an unmetered request can never be mistaken for a
    // free one (PLAN A2).
    resolveUsage(
      foundUsage
        ? {
            inputTokens,
            outputTokens,
            cachedInputTokens: cachedInputTokens || undefined,
            cacheWriteTokens: cacheWriteTokens || undefined,
            reasoningTokens: reasoningTokens || undefined,
          }
        : null,
    )
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
          // prompt_tokens includes cached; completion_tokens includes reasoning.
          const cached = obj.usage.prompt_tokens_details?.cached_tokens ?? 0
          const reasoning = obj.usage.completion_tokens_details?.reasoning_tokens ?? 0
          inputTokens = Math.max(0, obj.usage.prompt_tokens - cached)
          outputTokens = Math.max(0, (obj.usage.completion_tokens ?? 0) - reasoning)
          cachedInputTokens = cached
          reasoningTokens = reasoning
          foundUsage = true
        }
      } else if (format === 'gemini') {
        // Gemini: usageMetadata in each chunk, last one has final counts
        if (obj.usageMetadata?.promptTokenCount !== undefined) {
          // promptTokenCount includes cached content; candidatesTokenCount
          // excludes thoughts.
          const cached = obj.usageMetadata.cachedContentTokenCount ?? 0
          inputTokens = Math.max(0, obj.usageMetadata.promptTokenCount - cached)
          outputTokens = obj.usageMetadata.candidatesTokenCount ?? 0
          cachedInputTokens = cached
          reasoningTokens = obj.usageMetadata.thoughtsTokenCount ?? 0
          foundUsage = true
        }
      } else if (format === 'claude') {
        // Anthropic message_start: input token count
        if (obj.type === 'message_start' && obj.message?.usage) {
          // Anthropic's input_tokens already excludes cache reads/writes.
          inputTokens = obj.message.usage.input_tokens ?? 0
          cachedInputTokens = obj.message.usage.cache_read_input_tokens ?? 0
          cacheWriteTokens = obj.message.usage.cache_creation_input_tokens ?? 0
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
