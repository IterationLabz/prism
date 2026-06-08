import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai'
import OpenAI from 'openai'
import type { AppConfig, DirectConfig } from '../shared/config'
import { createMemory, updateChatSummary, type Chat, type Message } from './db'

export interface CompletionMessage {
  role: string
  content: string
}

const SEARCH_TOOL_DEF = {
  type: 'function' as const,
  function: {
    name: 'search_web',
    description: 'Searches the internet using DuckDuckGo to get real-time information or look up facts. Use this whenever the user asks about current events, recent news, or facts you might not know. Only pass a concise search query.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to run on DuckDuckGo (e.g., "latest news today" or "who won the super bowl 2024")'
        }
      },
      required: ['query']
    }
  }
}

async function performWebSearch(query: string, tavilyKey?: string): Promise<string> {
  if (tavilyKey && tavilyKey.trim()) {
    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: tavilyKey.trim(),
          query: query,
          search_depth: 'basic',
          include_answer: false,
          include_images: false,
          include_raw_content: false,
          max_results: 5
        })
      })
      if (!response.ok) throw new Error(`Tavily API error: ${response.status}`)
      const data = await response.json()
      const resultText = data.results.map((r: any) => `Title: ${r.title}\nSnippet: ${r.content}\nURL: ${r.url}`).join('\n\n')
      return `[Web Search Results for '${query}']\n\n${resultText || 'No results found.'}`
    } catch (err: any) {
      console.error('Tavily search failed, falling back to DuckDuckGo:', err)
      // Fall through to DuckDuckGo
    }
  }

  try {
    const { search } = await import('duck-duck-scrape')
    const searchResults = await search(query)
    
    const resultText = searchResults.results
      .slice(0, 5)
      .map((r: any) => `Title: ${r.title}\nSnippet: ${r.description}\nURL: ${r.url}`)
      .join('\n\n')
      
    return `[Web Search Results for '${query}']\n\n${resultText || 'No results found.'}`
  } catch (err: any) {
    console.error('Web search failed:', err)
    let errMsg = 'Search failed.'
    if (err.message && err.message.includes('anomaly')) {
      errMsg = 'DuckDuckGo rate limit reached. The search was blocked.'
    }
    return `[Web Search Results for '${query}']\n\nError: ${errMsg}`
  }
}

// ─── Provider types ───────────────────────────────────────────────────────────

type Provider =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'groq'
  | 'openrouter'
  | 'deepseek'
  | 'moonshot'
  | 'qwen'
  | 'mistral'
  | 'xai'       // xAI — makers of Grok. NOT Xiaomi the phone company.
  | 'cerebras'
  | 'fireworks'

/**
 * Base URLs for all OpenAI-compatible providers.
 * Anthropic and Gemini are excluded — they use their own dedicated SDKs.
 */
export const PROVIDER_CONFIG: Record<Exclude<Provider, 'anthropic' | 'gemini'>, { baseURL: string }> = {
  openai:     { baseURL: 'https://api.openai.com/v1' },
  groq:       { baseURL: 'https://api.groq.com/openai/v1' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1' },
  deepseek:   { baseURL: 'https://api.deepseek.com/v1' },
  moonshot:   { baseURL: 'https://api.moonshot.cn/v1' },
  qwen:       { baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
  mistral:    { baseURL: 'https://api.mistral.ai/v1' },
  xai:        { baseURL: 'https://api.x.ai/v1' },
  cerebras:   { baseURL: 'https://api.cerebras.ai/v1' },
  fireworks:  { baseURL: 'https://api.fireworks.ai/inference/v1' },
}

// ─── Provider detection ───────────────────────────────────────────────────────

export function detectProvider(model: string): Provider {
  const m = model.toLowerCase()
  if (m.startsWith('claude')) return 'anthropic'
  if (m.startsWith('gemini')) return 'gemini'
  if (m.startsWith('deepseek')) return 'deepseek'
  if (m.startsWith('moonshot') || m.startsWith('kimi')) return 'moonshot'
  if (m.startsWith('qwen')) return 'qwen'
  if (m.startsWith('mistral') || m.startsWith('mixtral') || m.startsWith('codestral')) return 'mistral'
  if (m.startsWith('grok')) return 'xai'
  if (m.startsWith('llama') && m.includes('cerebras')) return 'cerebras'
  if (m.includes('fireworks/') || m.startsWith('accounts/fireworks')) return 'fireworks'
  if (m.includes('/')) return 'openrouter' // OpenRouter format: vendor/model
  if (m.startsWith('llama') || m.startsWith('llama3')) return 'groq'
  return 'openai'
}

// Keep legacy alias for backward compat with ipc.ts
export const getProviderFromModel = detectProvider

function getApiKeyForProvider(direct: DirectConfig, provider: Provider): string {
  switch (provider) {
    case 'openai':     return direct.openaiKey
    case 'anthropic':  return direct.anthropicKey
    case 'gemini':     return direct.geminiKey
    case 'groq':       return direct.groqKey
    case 'openrouter': return direct.openrouterKey
    case 'deepseek':   return direct.deepseekKey
    case 'moonshot':   return direct.moonshotKey
    case 'qwen':       return direct.qwenKey
    case 'mistral':    return direct.mistralKey
    case 'xai':        return direct.xaiKey
    case 'cerebras':   return direct.cerebrasKey
    case 'fireworks':  return direct.fireworksKey
    default:           return ''
  }
}

// ─── Streaming helpers ────────────────────────────────────────────────────────

const activeAbortControllers = new Map<string, AbortController>()
const cancelledStreams = new Set<string>()

export function cancelStream(chatId: string): void {
  cancelledStreams.add(chatId)
  const controller = activeAbortControllers.get(chatId)
  if (controller) {
    controller.abort()
    activeAbortControllers.delete(chatId)
  }
}

export function resetCancelled(chatId: string): void {
  cancelledStreams.delete(chatId)
}

export function isStreamCancelled(chatId: string): boolean {
  return cancelledStreams.has(chatId)
}

async function streamOpenAICompatible(
  baseURL: string,
  apiKey: string,
  model: string,
  messages: CompletionMessage[],
  onToken: (t: string) => void,
  onDone: () => void,
  onError: (e: string) => void,
  onToolCallStart?: (name: string, args: string) => void,
  onSystemMessage?: (content: string) => void,
  tavilyKey?: string,
  chatId?: string
): Promise<void> {
  try {
    const client = new OpenAI({ baseURL, apiKey })
    const stream = await client.chat.completions.create({
      model,
      messages: messages.map((msg, idx) => {
        // Convert middle-of-history system messages to user messages to prevent local LLM prompt format crashes
        const role = msg.role === 'system' && idx > 0 ? 'user' : normalizeOpenAIRole(msg.role)
        return { role, content: msg.content }
      }),
      tools: [SEARCH_TOOL_DEF],
      stream: true
    }, { signal: chatId ? activeAbortControllers.get(chatId)?.signal : undefined })
    
    let toolCallName = ''
    let toolCallArgs = ''
    let isToolCalling = false
    let receivedContent = false

    for await (const chunk of stream) {
      if (chatId && cancelledStreams.has(chatId)) break
      
      const delta = chunk.choices?.[0]?.delta
      
      if (delta?.tool_calls?.length) {
        isToolCalling = true
        const tc = delta.tool_calls[0]
        if (tc.function?.name) toolCallName += tc.function.name
        if (tc.function?.arguments) toolCallArgs += tc.function.arguments
      }
      
      const token = delta?.content ?? ''
      if (token) {
        receivedContent = true
        onToken(token)
      }
    }

    if (isToolCalling) {
      if (toolCallName === 'search_web' && toolCallArgs) {
        try {
          const args = JSON.parse(toolCallArgs)
          const query = args.query || args.search || args.q || Object.values(args)[0]
          if (query && typeof query === 'string') {
            if (onToolCallStart) onToolCallStart('search_web', query)
            const sysMsg = await performWebSearch(query, tavilyKey)
            if (onSystemMessage) onSystemMessage(sysMsg)
            
            // Push alternating assistant and user messages to maintain strict prompt formats for local models
            messages.push({ role: 'assistant', content: `*(Searching the web for: "${query}")*` })
            messages.push({ role: 'user', content: `[Web Search Results]\n\n${sysMsg}\n\nPlease use this information to continue.` })
            
            await streamOpenAICompatible(baseURL, apiKey, model, messages, onToken, onDone, onError, onToolCallStart, onSystemMessage, tavilyKey, chatId)
            return
          } else {
            onToken('\n*(Search failed: invalid query from model)*\n')
          }
        } catch (err) {
          onToken('\n*(Search failed: unable to parse arguments)*\n')
        }
      } else {
        onToken(`\n*(Model attempted to call an unknown tool: ${toolCallName})*\n`)
      }
    } else if (!receivedContent) {
      onToken('\n*(Model returned an empty response. This might be due to context length limits or proxy issues.)*\n')
    }

    onDone()
  } catch (err: any) {
    onError(err.message ?? 'Stream failed')
  }
}

async function streamAnthropic(
  model: string,
  apiKey: string,
  messages: CompletionMessage[],
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
  onToolCallStart?: (name: string, args: string) => void,
  onSystemMessage?: (content: string) => void,
  tavilyKey?: string,
  chatId?: string
): Promise<void> {
  const client = new Anthropic({ apiKey })
  const { system, conversation } = toAnthropicMessages(messages)
  const stream = client.messages.stream({
    model,
    max_tokens: 4096,
    system: system || undefined,
    messages: conversation,
    tools: [
      {
        name: 'search_web',
        description: 'Searches the internet using DuckDuckGo to get real-time information or look up facts. Use this whenever the user asks about current events, recent news, or facts you might not know. Only pass a concise search query.',
        input_schema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query to run on DuckDuckGo'
            }
          },
          required: ['query']
        }
      }
    ]
  }, { signal: chatId ? activeAbortControllers.get(chatId)?.signal : undefined })

  let toolCallName = ''
  let toolCallArgs = ''
  let isToolCalling = false

  for await (const event of stream) {
    if (chatId && cancelledStreams.has(chatId)) break
    if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      isToolCalling = true
      toolCallName = event.content_block.name
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
      toolCallArgs += event.delta.partial_json
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      onToken(event.delta.text)
    }
  }

  if (isToolCalling && toolCallName === 'search_web' && toolCallArgs) {
    try {
      const args = JSON.parse(toolCallArgs)
      const query = args.query || args.search || args.q || Object.values(args)[0]
      if (query && typeof query === 'string') {
        if (onToolCallStart) onToolCallStart('search_web', query)
        const sysMsg = await performWebSearch(query, tavilyKey)
        if (onSystemMessage) onSystemMessage(sysMsg)
        
        messages.push({ role: 'assistant', content: `*(Searching the web for: "${query}")*` })
        messages.push({ role: 'user', content: `[Web Search Results]\n\n${sysMsg}\n\nPlease use this information to continue.` })
        
        await streamAnthropic(model, apiKey, messages, onToken, onDone, onError, onToolCallStart, onSystemMessage, tavilyKey, chatId)
        return
      } else {
        onToken('\n*(Search failed: invalid query from model)*\n')
      }
    } catch (err) {
      onToken('\n*(Search failed: unable to parse arguments)*\n')
    }
  }
}

async function streamGemini(
  model: string,
  apiKey: string,
  messages: CompletionMessage[],
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
  onToolCallStart?: (name: string, args: string) => void,
  onSystemMessage?: (content: string) => void,
  tavilyKey?: string,
  chatId?: string
): Promise<void> {
  const client = new GoogleGenerativeAI(apiKey)
  const { systemInstruction, contents } = toGeminiContents(messages)
  const generativeModel = client.getGenerativeModel({ 
    model, 
    systemInstruction: systemInstruction || undefined,
    tools: [{
      functionDeclarations: [{
        name: 'search_web',
        description: 'Searches the internet using DuckDuckGo to get real-time information or look up facts. Use this whenever the user asks about current events, recent news, or facts you might not know. Only pass a concise search query.',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            query: {
              type: SchemaType.STRING,
              description: 'The search query to run on DuckDuckGo'
            }
          },
          required: ['query']
        }
      }]
    }]
  })
  const result = await generativeModel.generateContentStream({ contents }, { signal: chatId ? activeAbortControllers.get(chatId)?.signal : undefined })

  let isToolCalling = false
  let toolCallName = ''
  let toolCallArgs: any = null

  try {
    for await (const chunk of result.stream) {
      if (chatId && cancelledStreams.has(chatId)) break
      
      const calls = chunk.functionCalls()
      if (calls && calls.length > 0) {
        isToolCalling = true
        toolCallName = calls[0].name
        toolCallArgs = calls[0].args
      }
      
      try {
        const token = chunk.text()
        if (token) onToken(token)
      } catch (e) {
        // chunk.text() throws if there is no text part
      }
    }
    
    if (isToolCalling && toolCallName === 'search_web' && toolCallArgs) {
      const query = toolCallArgs.query || toolCallArgs.search || toolCallArgs.q || Object.values(toolCallArgs)[0]
      if (query && typeof query === 'string') {
        if (onToolCallStart) onToolCallStart('search_web', query)
        const sysMsg = await performWebSearch(query, tavilyKey)
        if (onSystemMessage) onSystemMessage(sysMsg)
        
        messages.push({ role: 'assistant', content: `*(Searching the web for: "${query}")*` })
        messages.push({ role: 'user', content: `[Web Search Results]\n\n${sysMsg}\n\nPlease use this information to continue.` })
        
        await streamGemini(model, apiKey, messages, onToken, onDone, onError, onToolCallStart, onSystemMessage, tavilyKey, chatId)
        return
      } else {
        onToken('\n*(Search failed: invalid query from model)*\n')
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError' && (!chatId || !cancelledStreams.has(chatId))) throw err
  }
}

// ─── Main entry points ────────────────────────────────────────────────────────

async function streamViaDirect(
  direct: DirectConfig,
  model: string,
  messages: CompletionMessage[],
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
  onToolCallStart?: (name: string, args: string) => void,
  onSystemMessage?: (content: string) => void,
  tavilyKey?: string,
  chatId?: string
): Promise<void> {
  try {
    const provider = detectProvider(model)
    const apiKey = getApiKeyForProvider(direct, provider)

    if (!apiKey.trim()) {
      onError('No API key set for this provider. Add it in Settings.')
      return
    }

    if (provider === 'anthropic') {
      await streamAnthropic(model, apiKey, messages, onToken, onDone, onError, onToolCallStart, onSystemMessage, tavilyKey, chatId)
      onDone()
    } else if (provider === 'gemini') {
      await streamGemini(model, apiKey, messages, onToken, onDone, onError, onToolCallStart, onSystemMessage, tavilyKey, chatId)
      onDone()
    } else {
      const { baseURL } = PROVIDER_CONFIG[provider]
      await streamOpenAICompatible(baseURL, apiKey, model, messages, onToken, onDone, onError, onToolCallStart, onSystemMessage, tavilyKey, chatId)
    }
  } catch (error) {
    onError(errorToMessage(error))
  }
}

async function streamViaCustomEndpoint(
  endpointUrl: string,
  apiKey: string,
  model: string,
  messages: CompletionMessage[],
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
  onToolCallStart?: (name: string, args: string) => void,
  onSystemMessage?: (content: string) => void,
  tavilyKey?: string,
  chatId?: string
): Promise<void> {
  // Normalize URL — ensure it ends with /v1
  let base = endpointUrl.trim().replace(/\/$/, '')
  if (!base.endsWith('/v1')) base = `${base}/v1`

  await streamOpenAICompatible(base, apiKey || 'dummy-key', model, messages, onToken, onDone, onError, onToolCallStart, onSystemMessage, tavilyKey, chatId)
}

export async function streamCompletion(
  config: AppConfig,
  model: string,
  messages: CompletionMessage[],
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
  onToolCallStart?: (name: string, args: string) => void,
  onSystemMessage?: (content: string) => void,
  chatId?: string
): Promise<void> {
  if (chatId) {
    resetCancelled(chatId)
    activeAbortControllers.set(chatId, new AbortController())
  }

  try {
    if (config.mode === 'custom') {
      await streamViaCustomEndpoint(
        config.customEndpoint.endpointUrl,
        config.customEndpoint.apiKey,
        model,
        messages,
        onToken,
        onDone,
        onError,
        onToolCallStart,
        onSystemMessage,
        config.direct.tavilyKey,
        chatId
      )
    } else {
      await streamViaDirect(
        config.direct,
        model,
        messages,
        onToken,
        onDone,
        onError,
        onToolCallStart,
        onSystemMessage,
        config.direct.tavilyKey,
        chatId
      )
    }
  } catch (error: any) {
    if (error?.name !== 'AbortError') {
      onError(errorToMessage(error))
    } else {
      onDone()
    }
  } finally {
    if (chatId) activeAbortControllers.delete(chatId)
  }
}

// ─── Dynamic model fetching ───────────────────────────────────────────────────

export async function fetchAvailableModels(
  endpointUrl: string,
  apiKey?: string
): Promise<string[]> {
  try {
    // Normalize URL — ensure it ends with /v1
    let base = endpointUrl.trim().replace(/\/$/, '')
    if (!base.endsWith('/v1')) base = `${base}/v1`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (apiKey && apiKey.trim()) {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`
    }

    const res = await fetch(`${base}/models`, { headers })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const data = await res.json()

    if (Array.isArray(data?.data)) {
      return data.data.map((m: any) => m.id || m.name).filter(Boolean)
    }
    if (Array.isArray(data?.models)) {
      return data.models.map((m: any) => m.id || m.name).filter(Boolean)
    }
    if (Array.isArray(data)) {
      return data.map((m: any) => m.id || m.name).filter(Boolean)
    }
    return []
  } catch (err) {
    console.error('Failed to fetch models from endpoint:', err)
    return []
  }
}

// ─── Chat title generation ────────────────────────────────────────────────────

export async function generateChatTitle(config: AppConfig, model: string, firstUserMessage: string): Promise<string> {
  const prompt = `Generate a short, descriptive title (2-5 words) for a chat that begins with the following message. The title should capture the core topic or intent. Output ONLY the title, no quotes, no punctuation.
Message: "${firstUserMessage}"`

  try {
    if (config.mode === 'custom') {
      let base = config.customEndpoint.endpointUrl.trim().replace(/\/$/, '')
      if (!base.endsWith('/v1')) base = `${base}/v1`
      const client = new OpenAI({ baseURL: base, apiKey: config.customEndpoint.apiKey || 'dummy-key' })
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200
      })
      return cleanTitle(response.choices[0]?.message?.content ?? '')
    }

    const provider = detectProvider(model)
    const apiKey = getApiKeyForProvider(config.direct, provider)
    if (!apiKey.trim()) return 'New Chat'

    if (provider === 'anthropic') {
      const client = new Anthropic({ apiKey })
      const response = await client.messages.create({
        model,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
      return cleanTitle(response.content.map((block) => (block.type === 'text' ? block.text : '')).join(''))
    }

    if (provider === 'gemini') {
      const client = new GoogleGenerativeAI(apiKey)
      const generativeModel = client.getGenerativeModel({ model, generationConfig: { maxOutputTokens: 200 } })
      const response = await generativeModel.generateContent(prompt)
      return cleanTitle(response.response.text())
    }

    const { baseURL } = PROVIDER_CONFIG[provider]
    const client = new OpenAI({ apiKey, baseURL })
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200
    })
    return cleanTitle(response.choices[0]?.message?.content ?? '')
  } catch (err) {
    console.error('LLM failed to generate title:', err)
    return 'New Chat'
  }
}

// ─── Memory Extraction ───────────────────────────────────────────────────────

export async function extractMemories(config: AppConfig, model: string, userMessage: string): Promise<void> {
  const prompt = `You are a memory extraction assistant.
Analyze the following message from the user and extract any new, long-term facts, preferences, or details about the user that would be useful to remember for future conversations.
If there is nothing worth remembering, or it is just conversational filler, output EXACTLY the word "NONE".
If there are facts to remember, output them as a concise bulleted list, one fact per line, starting with a hyphen.

User message: "${userMessage}"`

  try {
    let content = ''

    if (config.mode === 'custom') {
      let base = config.customEndpoint.endpointUrl.trim().replace(/\/$/, '')
      if (!base.endsWith('/v1')) base = `${base}/v1`
      const client = new OpenAI({ baseURL: base, apiKey: config.customEndpoint.apiKey || 'dummy-key' })
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }]
      })
      content = response.choices[0]?.message?.content ?? ''
    } else {
      const provider = detectProvider(model)
      const apiKey = getApiKeyForProvider(config.direct, provider)
      if (!apiKey.trim()) return

      if (provider === 'anthropic') {
        const client = new Anthropic({ apiKey })
        const response = await client.messages.create({
          model,
          max_tokens: 150,
          messages: [{ role: 'user', content: prompt }]
        })
        content = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
      } else if (provider === 'gemini') {
        const client = new GoogleGenerativeAI(apiKey)
        const generativeModel = client.getGenerativeModel({ model })
        const response = await generativeModel.generateContent(prompt)
        content = response.response.text()
      } else {
        const { baseURL } = PROVIDER_CONFIG[provider]
        const client = new OpenAI({ apiKey, baseURL })
        const response = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }]
        })
        content = response.choices[0]?.message?.content ?? ''
      }
    }

    if (!content) return
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean)
    
    // Check if the response is just "NONE"
    if (lines.length === 1 && lines[0].replace(/[^\w]/g, '').toUpperCase() === 'NONE') {
      return
    }

    // Save extracted bullet points
    for (const line of lines) {
      if (line.startsWith('- ') || line.startsWith('* ')) {
        const fact = line.substring(2).trim()
        if (fact) createMemory(fact)
      } else if (lines.length === 1 && line.length > 5) {
        // Sometimes the model forgets bullets if it's just one fact
        createMemory(line)
      }
    }
  } catch (err) {
    console.error('LLM failed to extract memory:', err)
  }
}

// ─── Message format converters ────────────────────────────────────────────────

function toAnthropicMessages(messages: CompletionMessage[]): {
  system: string
  conversation: { role: 'user' | 'assistant'; content: string }[]
} {
  return {
    system: messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n'),
    conversation: messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: message.content
      }))
  }
}

function toGeminiContents(messages: CompletionMessage[]): {
  systemInstruction: string
  contents: { role: 'user' | 'model'; parts: { text: string }[] }[]
} {
  return {
    systemInstruction: messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n'),
    contents: messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? ('model' as const) : ('user' as const),
        parts: [{ text: message.content }]
      }))
  }
}

function normalizeOpenAIRole(role: string): 'system' | 'user' | 'assistant' {
  if (role === 'system' || role === 'assistant') return role
  return 'user'
}

function cleanTitle(value: string): string {
  let title = value.replace(/["""]/g, '').replace(/\s+/g, ' ').trim()
  
  // If a local model ignored the "4 words max" instruction and returned a paragraph, truncate it
  if (title.length > 50) {
    title = title.substring(0, 47) + '...'
  }
  
  return title || 'New Chat'
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Unknown LLM error'
}

export async function compactHistory(chat: Chat, allMsgs: Message[], config: AppConfig): Promise<void> {
  try {
    const KEEP_COUNT = 10
    
    let recentIndex = 0
    if (chat.summary_through_id) {
      const idx = allMsgs.findIndex(m => m.id === chat.summary_through_id)
      if (idx !== -1) recentIndex = idx + 1
    }
    
    const unsummarized = allMsgs.slice(recentIndex)
    if (unsummarized.length <= KEEP_COUNT) return
    
    const toSummarize = unsummarized.slice(0, unsummarized.length - KEEP_COUNT)
    const newThroughId = toSummarize[toSummarize.length - 1].id
    
    let textToSummarize = ''
    if (chat.context_summary) {
      textToSummarize += `Previous Summary:\n${chat.context_summary}\n\n`
    }
    
    textToSummarize += `New messages to integrate into the summary:\n`
    for (const msg of toSummarize) {
      textToSummarize += `[${msg.role}]: ${msg.content}\n`
    }
    
    const prompt = `Summarize this conversation so far in 300 words or fewer. Preserve: key decisions made, any code/technical details discussed, the user's current goal, and any commitments or action items. Do not editorialize.
    
${textToSummarize}`

    let content = ''
    const model = chat.model

    if (config.mode === 'custom') {
      let base = config.customEndpoint.endpointUrl.trim().replace(/\/$/, '')
      if (!base.endsWith('/v1')) base = `${base}/v1`
      const client = new OpenAI({ baseURL: base, apiKey: config.customEndpoint.apiKey || 'dummy-key' })
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }]
      })
      content = response.choices[0]?.message?.content ?? ''
    } else {
      const provider = detectProvider(model)
      const apiKey = getApiKeyForProvider(config.direct, provider)
      if (!apiKey.trim()) return

      if (provider === 'anthropic') {
        const client = new Anthropic({ apiKey })
        const response = await client.messages.create({
          model,
          max_tokens: 350,
          messages: [{ role: 'user', content: prompt }]
        })
        content = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
      } else if (provider === 'gemini') {
        const client = new GoogleGenerativeAI(apiKey)
        const generativeModel = client.getGenerativeModel({ model })
        const response = await generativeModel.generateContent(prompt)
        content = response.response.text()
      } else {
        const { baseURL } = PROVIDER_CONFIG[provider]
        const client = new OpenAI({ apiKey, baseURL })
        const response = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }]
        })
        content = response.choices[0]?.message?.content ?? ''
      }
    }

    if (content) {
      updateChatSummary(chat.id, content, newThroughId)
    }
  } catch (err) {
    console.error('LLM failed to compact history:', err)
  }
}
