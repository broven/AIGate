import type { UniversalRequest, UniversalResponse } from '@aigate/shared'
import {
  parseOpenAIRequest,
  formatOpenAIResponse,
  formatOpenAIError,
} from './inbound/openai'
import { sendToOpenAICompatible, parseOpenAIResponse } from './outbound/openai'
import {
  parseAnthropicRequest,
  formatAnthropicResponse,
  formatAnthropicError,
} from './inbound/anthropic'
import { sendToAnthropic, parseAnthropicResponse } from './outbound/anthropic'
import {
  parseGeminiRequest,
  formatGeminiResponse,
  formatGeminiError,
} from './inbound/gemini'
import { sendToGemini, parseGeminiResponse } from './outbound/gemini'

export type ApiFormat = 'openai' | 'claude' | 'gemini'

export interface InboundAdapter {
  parseRequest(body: any, gatewayKeyName: string, ...extra: any[]): UniversalRequest | Promise<UniversalRequest>
  formatResponse(universal: UniversalResponse): any
  formatError(message: string, type: string, code?: string | number): any
}

export interface OutboundAdapter {
  sendRequest(
    req: UniversalRequest,
    endpoint: string,
    apiKey: string,
    upstreamModel: string,
  ): Promise<Response>
  parseResponse(raw: any): UniversalResponse
  format: ApiFormat
}

const adapters: Record<ApiFormat, { inbound: InboundAdapter; outbound: OutboundAdapter }> = {
  openai: {
    inbound: {
      parseRequest: parseOpenAIRequest,
      formatResponse: (resp: UniversalResponse) =>
        formatOpenAIResponse(
          resp.id, resp.model, resp.content, resp.finishReason, resp.toolCalls, resp.usage,
        ),
      formatError: formatOpenAIError,
    },
    outbound: {
      sendRequest: sendToOpenAICompatible,
      parseResponse: parseOpenAIResponse,
      format: 'openai',
    },
  },
  claude: {
    inbound: {
      parseRequest: parseAnthropicRequest,
      formatResponse: formatAnthropicResponse,
      formatError: formatAnthropicError,
    },
    outbound: {
      sendRequest: sendToAnthropic,
      parseResponse: parseAnthropicResponse,
      format: 'claude',
    },
  },
  gemini: {
    inbound: {
      parseRequest: parseGeminiRequest,
      formatResponse: formatGeminiResponse,
      formatError: formatGeminiError,
    },
    outbound: {
      sendRequest: sendToGemini,
      parseResponse: parseGeminiResponse,
      format: 'gemini',
    },
  },
}

export function getInboundAdapter(format: ApiFormat): InboundAdapter {
  const entry = adapters[format]
  if (!entry) throw new Error(`No inbound adapter for format: ${format}`)
  return entry.inbound
}

export function getOutboundAdapter(format: ApiFormat): OutboundAdapter {
  const entry = adapters[format]
  if (!entry) throw new Error(`No outbound adapter for format: ${format}`)
  return entry.outbound
}
