import { contextBridge, ipcRenderer } from 'electron'
import type { Provider, Role } from './main/db'
import type { AppConfig } from './shared/config'

export interface Chat {
  id: string
  title: string
  provider: Provider
  model: string
  created_at: number
  updated_at: number
  context_summary?: string
  summary_through_id?: string
  folder?: string
}

export interface Message {
  id: string
  chat_id: string
  role: Role
  content: string
  created_at: number
}

export interface Memory {
  id: string
  content: string
  created_at: number
}

type IpcResult<T> = { success: true; data: T } | { success: false; error: string }

export interface Api {
  chats: {
    getAll: () => Promise<Chat[]>
    search: (query: string) => Promise<Chat[]>
    create: (meta?: Partial<Pick<Chat, 'provider' | 'model'>>) => Promise<Chat>
    delete: (id: string) => Promise<void>
    updateTitle: (id: string, title: string) => Promise<Chat | null>
    updateMeta: (id: string, meta: Pick<Chat, 'provider' | 'model'>) => Promise<Chat | null>
    updateFolder: (id: string, folder: string | null) => Promise<Chat | null>
    getFolders: () => Promise<string[]>
  }
  messages: {
    getAll: (chatId: string) => Promise<Message[]>
    create: (input: { chatId: string; role: Role; content: string }) => Promise<Message>
  }
  memories: {
    getAll: () => Promise<Memory[]>
    delete: (id: string) => Promise<void>
  }
  llm: {
    stream: (chatId: string, userMessage: string, model: string) => void
    streamGoal: (chatId: string, userMessage: string, model: string, maxIterations?: number) => void
    cancel: (chatId: string) => void
    onToken: (callback: (chatId: string, token: string) => void) => void
    onDone: (callback: (chatId: string) => void) => void
    onError: (callback: (chatId: string, message: string) => void) => void
    onMessageCreated: (callback: (message: Message) => void) => void
    onChatUpdated: (callback: (chat: Chat) => void) => void
    onGoalIteration: (callback: (chatId: string, iteration: { current: number; max: number }) => void) => void
    onStatus: (callback: (chatId: string, status: string) => void) => void
    removeStreamListeners: () => void
  }
  settings: {
    get: (key: string) => Promise<string | null>
    set: (key: string, value: string) => Promise<void>
    getConfig: () => Promise<AppConfig>
  }
  endpoint: {
    fetchModels: (url: string, apiKey: string) => Promise<{ success: boolean; models: string[]; error?: string }>
  }
  direct: {
    fetchModels: (provider: string, apiKey: string) => Promise<{ success: boolean; models: string[]; error?: string }>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
  }
  voice: {
    transcribe: (audioBytes: number[]) => Promise<{ success: boolean; text: string; error: string | null }>
  }
  debug: {
    saveFile: (filename: string, buffer: ArrayBuffer) => Promise<{ success: boolean; error?: string }>
  }
  export: {
    chat: (chatId: string, format: 'markdown' | 'json') => Promise<{ success: boolean; error?: string }>
  }
}

const api: Api = {
  chats: {
    getAll: () => invoke('chats:getAll'),
    search: (query) => invoke('chats:search', query),
    create: (meta) => invoke('chats:create', meta),
    delete: (id) => invoke('chats:delete', id),
    updateTitle: (id, title) => invoke('chats:updateTitle', id, title),
    updateMeta: (id, meta) => invoke('chats:updateMeta', id, meta),
    updateFolder: (id, folder) => invoke('chats:updateFolder', id, folder),
    getFolders: () => invoke('chats:getFolders'),
  },
  messages: {
    getAll: (chatId) => invoke('messages:getAll', chatId),
    create: (input) => invoke('messages:create', input)
  },
  memories: {
    getAll: () => invoke('memories:getAll'),
    delete: (id) => invoke('memories:delete', id)
  },
  llm: {
    stream: (chatId, userMessage, model) => ipcRenderer.send('llm:stream', chatId, userMessage, model),
    streamGoal: (chatId, userMessage, model, maxIterations = 10) => {
      ipcRenderer.send('llm:stream-goal', chatId, userMessage, model, maxIterations)
    },
    cancel: (chatId) => ipcRenderer.send('llm:cancel', chatId),
    onToken: (callback) => {
      ipcRenderer.on('llm:token', (_event, chatId: string, token: string) => callback(chatId, token))
    },
    onDone: (callback) => {
      ipcRenderer.on('llm:done', (_event, chatId: string) => callback(chatId))
    },
    onError: (callback) => {
      ipcRenderer.on('llm:error', (_event, chatId: string, message: string) => callback(chatId, message))
    },
    onMessageCreated: (callback) => {
      ipcRenderer.on('messages:created', (_event, message: Message) => callback(message))
    },
    onChatUpdated: (callback) => {
      ipcRenderer.on('chats:updated', (_event, chat: Chat) => callback(chat))
    },
    onGoalIteration: (callback) => {
      ipcRenderer.on('llm:goal-iteration', (_event, chatId: string, iteration) => callback(chatId, iteration))
    },
    onStatus: (callback) => {
      ipcRenderer.on('llm:status', (_event, chatId: string, status: string) => callback(chatId, status))
    },
    removeStreamListeners: () => {
      ipcRenderer.removeAllListeners('llm:token')
      ipcRenderer.removeAllListeners('llm:done')
      ipcRenderer.removeAllListeners('llm:error')
      ipcRenderer.removeAllListeners('messages:created')
      ipcRenderer.removeAllListeners('chats:updated')
      ipcRenderer.removeAllListeners('llm:goal-iteration')
      ipcRenderer.removeAllListeners('llm:status')
    }
  },
  settings: {
    get: (key) => invoke('settings:get', key),
    set: (key, value) => invoke('settings:set', key, value),
    getConfig: () => invoke('settings:getConfig')
  },
  endpoint: {
    fetchModels: (url, apiKey) => ipcRenderer.invoke('endpoint:fetchModels', url, apiKey)
  },
  direct: {
    fetchModels: (provider, apiKey) => ipcRenderer.invoke('direct:fetchModels', provider, apiKey)
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
  },
  voice: {
    transcribe: (audioBytes) => ipcRenderer.invoke('voice:transcribe', audioBytes)
  },
  debug: {
    saveFile: (filename, buffer) => ipcRenderer.invoke('debug:saveFile', filename, buffer)
  },
  export: {
    chat: (chatId, format) => ipcRenderer.invoke('export:chat', chatId, format)
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.success) throw new Error(result.error)
  return result.data
}

contextBridge.exposeInMainWorld('api', api)

declare global {
  interface Window {
    api: Api
  }
}
