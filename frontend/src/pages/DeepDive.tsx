import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import { ArrowLeft, Plus, Send, Sparkles, Trash2, X } from 'lucide-react'
import { api, type ChatMessage } from '../api/client'

export function DeepDive() {
  const queryClient = useQueryClient()
  const { data: sessions } = useQuery({
    queryKey: ['chat-sessions', 'deepdive'],
    queryFn: () => api.chatSessions('deepdive'),
  })
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [insights, setInsights] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const openSession = async (id: number) => {
    const s = await api.chatGetSession(id)
    setSessionId(id)
    setMessages(s.messages)
    setInsights(null)
  }

  const newSession = useMutation({
    mutationFn: () => api.chatNewSession('deepdive'),
    onSuccess: (s) => {
      setSessionId(s.session_id)
      setMessages(s.messages)
      setInsights(null)
      queryClient.invalidateQueries({ queryKey: ['chat-sessions', 'deepdive'] })
    },
  })

  const send = useMutation({
    mutationFn: (msg: string) => api.chatSend(sessionId!, msg),
    onSuccess: (reply) => {
      setMessages((m) => [...m, reply])
      queryClient.invalidateQueries({ queryKey: ['chat-sessions'] })
    },
  })

  const extract = useMutation({
    mutationFn: () => api.chatExtract(sessionId!),
    onSuccess: (r) => setInsights(r.insights),
  })

  const del = useMutation({
    mutationFn: (id: number) => api.chatDelete(id),
    onSuccess: (_r, id) => {
      queryClient.invalidateQueries({ queryKey: ['chat-sessions'] })
      if (id === sessionId) {
        setSessionId(null)
        setMessages([])
      }
    },
  })

  const submit = () => {
    const msg = input.trim()
    if (!msg || !sessionId || send.isPending) return
    setMessages((m) => [...m, { role: 'user', content: msg }])
    setInput('')
    send.mutate(msg)
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Link to="/" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-lg font-bold">DeepDive</h1>
            <p className="hidden text-xs text-muted-foreground sm:block">
              Chat to mine your experience — it's saved and reusable for applications.
            </p>
          </div>
        </div>
        <button
          onClick={() => newSession.mutate()}
          disabled={newSession.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" /> New interview
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Sessions */}
        <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto border-r border-border p-2 sm:flex">
          {(sessions || []).map((s) => (
            <div
              key={s.id}
              className={`group flex items-center gap-1 rounded-lg px-2 ${s.id === sessionId ? 'bg-muted' : 'hover:bg-muted/60'}`}
            >
              <button onClick={() => openSession(s.id)} className="min-w-0 flex-1 truncate py-2 text-left text-sm">
                {s.title || 'Untitled'}
              </button>
              <button
                onClick={() => del.mutate(s.id)}
                className="rounded p-1 text-muted-foreground opacity-0 hover:text-red-600 group-hover:opacity-100"
                aria-label="Delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {(!sessions || sessions.length === 0) && (
            <p className="p-3 text-xs text-muted-foreground">No interviews yet.</p>
          )}
        </aside>

        {/* Conversation */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!sessionId ? (
            <div className="flex flex-1 items-center justify-center p-8 text-center">
              <div className="max-w-md space-y-3">
                <Sparkles className="mx-auto h-8 w-8 text-primary" />
                <h2 className="text-lg font-semibold">Let's dig into your experience</h2>
                <p className="text-sm text-muted-foreground">
                  A coach-style interview that draws out specific, quantified stories from your work —
                  saved here and reusable to strengthen your profile and application answers.
                </p>
                <button
                  onClick={() => newSession.mutate()}
                  disabled={newSession.isPending}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" /> Start an interview
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
                {messages.map((m, i) => (
                  <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                        m.role === 'user'
                          ? 'bg-primary text-white'
                          : 'border border-border bg-card'
                      }`}
                    >
                      <div className="prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown>{m.content}</ReactMarkdown>
                      </div>
                    </div>
                  </div>
                ))}
                {send.isPending && (
                  <div className="flex justify-start">
                    <div className="rounded-2xl border border-border bg-card px-4 py-2 text-sm text-muted-foreground">
                      thinking…
                    </div>
                  </div>
                )}
                <div ref={endRef} />
              </div>

              <div className="shrink-0 border-t border-border p-3">
                <div className="mb-2 flex justify-end">
                  <button
                    onClick={() => extract.mutate()}
                    disabled={extract.isPending || messages.length < 2}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5 text-xs font-medium hover:bg-muted/80 disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {extract.isPending ? 'Distilling…' : 'Distill into resume/answer material'}
                  </button>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    submit()
                  }}
                  className="flex gap-2"
                >
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        submit()
                      }
                    }}
                    rows={1}
                    placeholder="Type your answer… (Enter to send, Shift+Enter for newline)"
                    className="min-h-0 flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                  <button
                    type="submit"
                    disabled={!input.trim() || send.isPending}
                    className="shrink-0 rounded-lg bg-primary px-4 text-white hover:opacity-90 disabled:opacity-50"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </form>
              </div>
            </>
          )}
        </main>
      </div>

      {/* Insights modal */}
      {insights !== null && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/70 p-3 sm:p-6" onClick={() => setInsights(null)}>
          <div
            className="mx-auto flex h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <h3 className="font-semibold">Distilled material — copy what's useful</h3>
              <button onClick={() => setInsights(null)} className="rounded-md p-1 text-muted-foreground hover:bg-muted">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="prose prose-sm dark:prose-invert min-h-0 max-w-none flex-1 overflow-y-auto p-5">
              <ReactMarkdown>{insights || '_No material extracted._'}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
