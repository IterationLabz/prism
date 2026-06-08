import { create } from 'zustand'
import {
  DEFAULT_ENDPOINT_URL,
  EMPTY_CUSTOM_ENDPOINT_CONFIG,
  EMPTY_DIRECT_CONFIG,
  type ConnectionMode,
  type CustomEndpointConfig,
  type DirectConfig
} from '../../shared/config'
import type { Chat, Message } from './types'

interface AppState {
  chats: Chat[]
  activeChat: Chat | null
  messages: Message[]
  activeStreams: Record<string, { content: string, status: string | null, goalIteration: { current: number; max: number } | null, isStreaming: boolean }>
  connectionMode: ConnectionMode
  directConfig: DirectConfig
  customEndpointConfig: CustomEndpointConfig
  defaultModel: string

  // Dynamic model fetching (custom endpoint mode)
  availableModels: string[]
  modelsLoading: boolean
  modelsError: string | null

  // Dynamic model fetching (direct API mode — per provider)
  directModels: Record<string, string[]>      // provider key → fetched model IDs
  directModelsLoading: Record<string, boolean> // provider key → loading flag

  setChats: (chats: Chat[]) => void
  setActiveChat: (chat: Chat | null) => void
  upsertChat: (chat: Chat) => void
  removeChat: (id: string) => void
  setMessages: (messages: Message[]) => void
  addMessage: (message: Message) => void
  appendToken: (chatId: string, token: string) => void
  setStreaming: (chatId: string, streaming: boolean) => void
  setLlmStatus: (chatId: string, status: string | null) => void
  setGoalIteration: (chatId: string, iteration: { current: number; max: number } | null) => void
  setConnectionMode: (mode: ConnectionMode) => void
  setDirectConfig: (config: DirectConfig) => void
  setCustomEndpointConfig: (config: CustomEndpointConfig) => void
  setDefaultModel: (model: string) => void
  setAvailableModels: (models: string[]) => void
  setModelsLoading: (v: boolean) => void
  setModelsError: (err: string | null) => void
  setDirectModels: (provider: string, models: string[]) => void
  setDirectModelsLoading: (provider: string, v: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  chats: [],
  activeChat: null,
  messages: [],
  activeStreams: {},
  connectionMode: 'direct',
  directConfig: EMPTY_DIRECT_CONFIG,
  customEndpointConfig: EMPTY_CUSTOM_ENDPOINT_CONFIG,
  defaultModel: 'gpt-4o',

  availableModels: [],
  modelsLoading: false,
  modelsError: null,

  directModels: {},
  directModelsLoading: {},

  setChats: (chats) => set({ chats }),
  setActiveChat: (chat) => set({ activeChat: chat }),
  upsertChat: (chat) =>
    set((state) => {
      const chats = state.chats.some((item) => item.id === chat.id)
        ? state.chats.map((item) => (item.id === chat.id ? chat : item))
        : [chat, ...state.chats]
      return {
        chats: [...chats].sort((a, b) => b.updated_at - a.updated_at),
        activeChat: state.activeChat?.id === chat.id ? chat : state.activeChat
      }
    }),
  removeChat: (id) =>
    set((state) => ({
      chats: state.chats.filter((chat) => chat.id !== id),
      activeChat: state.activeChat?.id === id ? null : state.activeChat
    })),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) =>
    set((state) => {
      if (state.activeChat?.id === message.chat_id) {
        return { messages: [...state.messages, message] }
      }
      return state
    }),
  appendToken: (chatId, token) =>
    set((state) => {
      const stream = state.activeStreams[chatId] || { content: '', status: null, goalIteration: null, isStreaming: true }
      return {
        activeStreams: { ...state.activeStreams, [chatId]: { ...stream, content: stream.content + token, isStreaming: true } }
      }
    }),
  setStreaming: (chatId, streaming) =>
    set((state) => {
      if (!streaming) {
        const { [chatId]: _, ...rest } = state.activeStreams
        return { activeStreams: rest }
      }
      const stream = state.activeStreams[chatId] || { content: '', status: null, goalIteration: null, isStreaming: true }
      return { activeStreams: { ...state.activeStreams, [chatId]: { ...stream, isStreaming: streaming } } }
    }),
  setLlmStatus: (chatId, status) =>
    set((state) => {
      if (!state.activeStreams[chatId]) return state
      return { activeStreams: { ...state.activeStreams, [chatId]: { ...state.activeStreams[chatId], status } } }
    }),
  setGoalIteration: (chatId, iteration) =>
    set((state) => {
      if (!state.activeStreams[chatId]) return state
      return { activeStreams: { ...state.activeStreams, [chatId]: { ...state.activeStreams[chatId], goalIteration: iteration } } }
    }),
  setConnectionMode: (mode) => set({ connectionMode: mode }),
  setDirectConfig: (config) => set({ directConfig: config }),
  setCustomEndpointConfig: (config) => set({ customEndpointConfig: config }),
  setDefaultModel: (model) => set({ defaultModel: model }),
  setAvailableModels: (models) => set({ availableModels: models }),
  setModelsLoading: (v) => set({ modelsLoading: v }),
  setModelsError: (err) => set({ modelsError: err }),
  setDirectModels: (provider, models) =>
    set((state) => ({ directModels: { ...state.directModels, [provider]: models } })),
  setDirectModelsLoading: (provider, v) =>
    set((state) => ({ directModelsLoading: { ...state.directModelsLoading, [provider]: v } }))
}))


