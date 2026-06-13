import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChatWindow } from './components/ChatWindow'
import { OnboardingModal } from './components/OnboardingModal'
import { SettingsModal, type SettingsTab } from './components/SettingsModal'
import { Sidebar } from './components/Sidebar'
import { TopBar, providerForModel } from './components/TopBar'
import { useEndpointModels } from './hooks/useEndpointModels'
import { useAppStore } from './store'
import type { AppConfig, Chat, Message, Provider } from './types'

const FALLBACK_MODEL = 'gpt-4o'

export default function App() {
  const {
    chats,
    activeChat,
    messages,
    activeStreams,
    defaultModel,
    setChats,
    setActiveChat,
    upsertChat,
    removeChat,
    setMessages,
    setConnectionMode,
    setDirectConfig,
    setCustomEndpointConfig,
    setDefaultModel
  } = useAppStore()
  const appendToken = useAppStore((state) => state.appendToken)
  const setStreaming = useAppStore((state) => state.setStreaming)
  const setLlmStatus = useAppStore((state) => state.setLlmStatus)
  const setGoalIteration = useAppStore((state) => state.setGoalIteration)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('connection')
  const [preloadReady, setPreloadReady] = useState(() => Boolean(window.api))
  const [bootReady, setBootReady] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const isStreaming = Boolean(activeChat && activeStreams[activeChat.id]?.isStreaming)

  // Auto-fetch models whenever custom endpoint URL/key changes
  useEndpointModels()

  const applyConfig = useCallback(
    (config: AppConfig) => {
      setConnectionMode(config.mode)
      setDirectConfig(config.direct)
      setCustomEndpointConfig(config.customEndpoint)
      setDefaultModel(config.defaultModel)
    },
    [setConnectionMode, setCustomEndpointConfig, setDefaultModel, setDirectConfig]
  )

  const loadChat = useCallback(
    async (chat: Chat | null) => {
      if (!window.api) return
      setActiveChat(chat)
      if (!chat) {
        setMessages([])
        await window.api.settings.set('activeChatId', '')
        return
      }

      const loadedMessages = await window.api.messages.getAll(chat.id)
      setMessages(loadedMessages)
      await window.api.settings.set('activeChatId', chat.id)
    },
    [setActiveChat, setMessages]
  )

  const createNewChat = useCallback(async () => {
    if (!window.api) return
    const model = useAppStore.getState().defaultModel || defaultModel || FALLBACK_MODEL
    const provider = providerForModel(model)
    const chat = await window.api.chats.create({ provider, model })
    const latestChats = await window.api.chats.getAll()
    setChats(latestChats)
    upsertChat(chat)
    await loadChat(chat)
  }, [defaultModel, loadChat, setChats, upsertChat])

  const loadAppData = useCallback(async () => {
    if (!window.api) return
    const config = await window.api.settings.getConfig()
    applyConfig(config)

    const loadedChats = await window.api.chats.getAll()
    setChats(loadedChats)
    const activeChatId = await window.api.settings.get('activeChatId')
    const selected = loadedChats.find((chat) => chat.id === activeChatId) ?? loadedChats[0] ?? null
    if (selected) {
      setActiveChat(selected)
      const loadedMessages = await window.api.messages.getAll(selected.id)
      setMessages(loadedMessages)
      await window.api.settings.set('activeChatId', selected.id)
    } else {
      const model = config.defaultModel || FALLBACK_MODEL
      const chat = await window.api.chats.create({ provider: providerForModel(model), model })
      const latestChats = await window.api.chats.getAll()
      setChats(latestChats)
      upsertChat(chat)
      setActiveChat(chat)
      setMessages([])
      await window.api.settings.set('activeChatId', chat.id)
    }
  }, [applyConfig, setActiveChat, setChats, setMessages, upsertChat])

  useEffect(() => {
    if (!window.api) {
      setPreloadReady(false)
      return
    }

    let cancelled = false

    async function boot(): Promise<void> {
      if (!window.api) return
      try {
        const [connectionMode, onboardingComplete] = await Promise.all([
          window.api.settings.get('connection_mode'),
          window.api.settings.get('onboarding_complete')
        ])
        if (cancelled) return

        const requiresOnboarding = !connectionMode || onboardingComplete !== 'true'
        setShowOnboarding(requiresOnboarding)
        if (!requiresOnboarding) {
          await loadAppData()
        }
        if (!cancelled) {
          setPreloadReady(true)
          setBootReady(true)
        }
      } catch (error) {
        console.error(error)
        if (!cancelled) {
          setPreloadReady(true)
          setBootReady(true)
        }
      }
    }

    void boot()

    return () => {
      cancelled = true
    }
  }, [loadAppData])

  // ── Theme initialisation ──────────────────────────────────────────────
  useEffect(() => {
    if (!window.api) return

    const applyTheme = (mode: string) => {
      if (mode === 'light') {
        document.documentElement.classList.add('light')
      } else if (mode === 'system') {
        const preferLight = window.matchMedia('(prefers-color-scheme: light)').matches
        document.documentElement.classList.toggle('light', preferLight)
      } else {
        document.documentElement.classList.remove('light')
      }
    }

    void (async () => {
      const saved = await window.api!.settings.get('theme') ?? 'dark'
      applyTheme(saved)
    })()

    // Listen for OS changes when in system mode
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = () => {
      void (async () => {
        const current = await window.api!.settings.get('theme') ?? 'dark'
        if (current === 'system') applyTheme('system')
      })()
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    if (!window.api) return

    const tokenBuffers: Record<string, string> = {}
    const flushTimers: Record<string, ReturnType<typeof setTimeout> | null> = {}

    const flushTokens = (chatId: string) => {
      flushTimers[chatId] = null
      if (tokenBuffers[chatId]) {
        const batch = tokenBuffers[chatId]
        tokenBuffers[chatId] = ''
        appendToken(chatId, batch)
      }
    }

    window.api.llm.removeStreamListeners()

    window.api.llm.onToken((chatId, token) => {
      tokenBuffers[chatId] = (tokenBuffers[chatId] || '') + token
      if (!flushTimers[chatId]) {
        flushTimers[chatId] = setTimeout(() => flushTokens(chatId), 16)
      }
    })

    window.api.llm.onDone((chatId) => {
      if (flushTimers[chatId]) {
        clearTimeout(flushTimers[chatId]!)
        flushTimers[chatId] = null
      }
      flushTokens(chatId)
      setStreaming(chatId, false)
      setLlmStatus(chatId, null)
      setGoalIteration(chatId, null)
    })

    window.api.llm.onError((chatId, message) => {
      if (flushTimers[chatId]) {
        clearTimeout(flushTimers[chatId]!)
        flushTimers[chatId] = null
      }
      flushTokens(chatId)
      const errorMessage: Message = {
        id: `error-${Date.now()}`,
        chat_id: chatId,
        role: 'assistant',
        content: message,
        created_at: Date.now(),
        isError: true
      }
      
      // Because we use activeStreams for the streaming bubble, we can just clear it
      // and add the real error message.
      setStreaming(chatId, false)
      setLlmStatus(chatId, null)
      setGoalIteration(chatId, null)
      
      // We can invoke the backend to persist this error message if we want,
      // but for now we just push it to the active UI state if the user is on this chat.
      const addMsg = useAppStore.getState().addMessage
      addMsg(errorMessage)
    })

    window.api.llm.onMessageCreated((message) => {
      if (flushTimers[message.chat_id]) {
        clearTimeout(flushTimers[message.chat_id]!)
        flushTimers[message.chat_id] = null
      }
      flushTokens(message.chat_id)
      
      setStreaming(message.chat_id, false)
      setLlmStatus(message.chat_id, null)
      setGoalIteration(message.chat_id, null)
      
      const addMsg = useAppStore.getState().addMessage
      addMsg(message)
    })

    window.api.llm.onGoalIteration((chatId, iteration) => setGoalIteration(chatId, iteration))
    window.api.llm.onStatus((chatId, status) => setLlmStatus(chatId, status))
    
    window.api.llm.onChatUpdated((chat) => upsertChat(chat))

    return () => {
      for (const timer of Object.values(flushTimers)) {
        if (timer !== null) clearTimeout(timer)
      }
      window.api?.llm.removeStreamListeners()
    }
  }, [appendToken, setStreaming, setLlmStatus, setGoalIteration, upsertChat])

  useEffect(() => {
    document.title = activeChat ? `${activeChat.title} — Prism` : 'Prism'
  }, [activeChat])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void createNewChat()
      }
      if (modifier && event.key === ',') {
        event.preventDefault()
        setSettingsTab('connection')
        setSettingsOpen(true)
      }
      if (event.key === 'Escape') {
        setSettingsOpen(false)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [createNewChat])

  const sendMessage = useCallback(
    async (content: string) => {
      if (!window.api || !activeChat || isStreaming || !content.trim()) return
      setStreaming(activeChat.id, true)
      setLlmStatus(activeChat.id, null)
      
      let text = content.trim()
      
      // Voice trigger interception
      // 1. Specific iterations: "turn on goal mode for 5 iterations"
      const iterRegex = /(?:\b(?:turn on|run|execute)(?: the)? goal mode for (\d+) iterations\b)[.,!?]*/gi
      // 2. Infinite goal mode: "turn on infinite goal mode"
      const infRegex = /(?:\b(?:turn on|run|execute)(?: the)? infinite goal mode\b)[.,!?]*/gi
      // 3. Default goal mode: "turn on goal mode"
      const defaultRegex = /(?:\b(?:turn on|run|execute)(?: the)? goal mode\b)[.,!?]*/gi

      if (iterRegex.test(text)) {
        // Reset lastIndex because test() advances it
        iterRegex.lastIndex = 0
        const match = iterRegex.exec(text)
        const iterations = match ? match[1] : ''
        const textWithoutTrigger = text.replace(iterRegex, '').trim()
        text = `/goal${iterations} ${textWithoutTrigger}`
      } else if (infRegex.test(text)) {
        const textWithoutTrigger = text.replace(infRegex, '').trim()
        text = `/goalinf ${textWithoutTrigger}`
      } else if (defaultRegex.test(text)) {
        const textWithoutTrigger = text.replace(defaultRegex, '').trim()
        text = `/goal ${textWithoutTrigger}`
      }
      
      const infMatch = text.match(/^\/goalinf\s+(.*)/is)
      const goalMatch = text.match(/^\/goal(\d*)\s+(.*)/is)
      
      if (infMatch) {
        const goalText = infMatch[1].trim()
        window.api.llm.streamGoal(activeChat.id, goalText, activeChat.model, Number.MAX_SAFE_INTEGER)
      } else if (goalMatch) {
        const iterations = goalMatch[1] ? parseInt(goalMatch[1], 10) : 10
        const goalText = goalMatch[2].trim()
        window.api.llm.streamGoal(activeChat.id, goalText, activeChat.model, iterations)
      } else {
        window.api.llm.stream(activeChat.id, text, activeChat.model)
      }
    },
    [activeChat, isStreaming, setStreaming, setLlmStatus]
  )

  const deleteChat = useCallback(
    async (chat: Chat) => {
      if (!window.api) return
      await window.api.chats.delete(chat.id)
      removeChat(chat.id)
      const latestChats = await window.api.chats.getAll()
      setChats(latestChats)
      if (activeChat?.id === chat.id) {
        await loadChat(latestChats[0] ?? null)
      }
    },
    [activeChat?.id, loadChat, removeChat, setChats]
  )

  const updateTitle = useCallback(
    async (title: string) => {
      if (!window.api || !activeChat) return
      const updated = await window.api.chats.updateTitle(activeChat.id, title)
      if (updated) upsertChat(updated)
    },
    [activeChat, upsertChat]
  )

  const updateMeta = useCallback(
    async (provider: Provider, model: string) => {
      if (!window.api || !activeChat) return
      const updated = await window.api.chats.updateMeta(activeChat.id, { provider, model })
      if (updated) upsertChat(updated)
    },
    [activeChat, upsertChat]
  )

  const updateFolder = useCallback(
    async (folder: string | null) => {
      if (!window.api || !activeChat) return
      const updated = await window.api.chats.updateFolder(activeChat.id, folder)
      if (updated) upsertChat(updated)
    },
    [activeChat, upsertChat]
  )

  const normalizedActiveChat = useMemo(() => activeChat, [activeChat])

  const openSettings = useCallback((tab: SettingsTab = 'connection') => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }, [])

  const handleOnboardingComplete = useCallback(async () => {
    setShowOnboarding(false)
    await loadAppData()
  }, [loadAppData])

  if (!preloadReady && !window.api) {
    return (
      <div className="preload-error">
        <h1>Prism failed to start</h1>
        <p>The secure preload API did not load. Restart the app after checking the main process logs.</p>
      </div>
    )
  }

  if (showOnboarding) {
    return <OnboardingModal onComplete={() => void handleOnboardingComplete()} />
  }

  if (!bootReady) {
    return (
      <div className="preload-error">
        <h1>Starting Prism</h1>
        <p>Loading chats and connection settings...</p>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <Sidebar
        chats={chats}
        activeChatId={activeChat?.id ?? null}
        onNewChat={createNewChat}
        onSelectChat={loadChat}
        onDeleteChat={deleteChat}
        onOpenSettings={openSettings}
      />
      <main className="chat-main">
        <TopBar chat={normalizedActiveChat} onTitleChange={updateTitle} onMetaChange={updateMeta} onFolderChange={updateFolder} />
        <ChatWindow chat={normalizedActiveChat} messages={messages} onSend={sendMessage} />  </main>
      {settingsOpen && <SettingsModal initialTab={settingsTab} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
