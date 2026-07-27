import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import { ArrowLeft, Mic, Plus, Send, Trash2 } from 'lucide-react'
import { api, type ChatMessage } from '../api/client'

export function FinalRoundAI() {
  const queryClient = useQueryClient()
  const { data: sessions } = useQuery({
    queryKey: ['chat-sessions', 'finalround'],
    queryFn: () => api.chatSessions('finalround'),
  })
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const openSession = async (id: number) => {
    const s = await api.chatGetSession(id)
    setSessionId(id)
    setMessages(s.messages)
  }

  const newSession = useMutation({
    mutationFn: () => api.chatNewSession('finalround'),
    onSuccess: (s) => {
      setSessionId(s.session_id)
      setMessages(s.messages)
      queryClient.invalidateQueries({ queryKey: ['chat-sessions', 'finalround'] })
    },
  })

  const send = useMutation({
    mutationFn: (msg: string) => api.chatSend(sessionId!, msg),
    onSuccess: (reply) => {
      setMessages((m) => [...m, reply])
      queryClient.invalidateQueries({ queryKey: ['chat-sessions', 'finalround'] })
    },
  })

  const del = useMutation({
    mutationFn: (id: number) => api.chatDelete(id),
    onSuccess: (_r, id) => {
      queryClient.invalidateQueries({ queryKey: ['chat-sessions', 'finalround'] })
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
            <h1 className="text-lg font-bold">FinalRoundAI</h1>
            <p className="hidden text-xs text-muted-foreground sm:block">
              Phase 0 (text): paste the interviewer's question → an answer in your voice, from your real background.
            </p>
          </div>
        </div>
        <button
          onClick={() => newSession.mutate()}
          disabled={newSession.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" /> New session
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
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
            <p className="p-3 text-xs text-muted-foreground">No sessions yet.</p>
          )}
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!sessionId ? (
            <div className="flex flex-1 items-center justify-center p-8 text-center">
              <div className="max-w-md space-y-3">
                <Mic className="mx-auto h-8 w-8 text-primary" />
                <h2 className="text-lg font-semibold">Live interview copilot</h2>
                <p className="text-sm text-muted-foreground">
                  Paste (or type) the interviewer's question and get a concise answer in your own
                  voice — grounded only in your real experience and prepared answers. Audio capture
                  comes in a later phase; this validates the answers first.
                </p>
                <button
                  onClick={() => newSession.mutate()}
                  disabled={newSession.isPending}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" /> New session
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
                {messages.length === 0 && (
                  <p className="mt-8 text-center text-sm text-muted-foreground">
                    Paste the interviewer's question below to get your answer.
                  </p>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${
                        m.role === 'user'
                          ? 'bg-muted'
                          : 'border border-primary/40 bg-primary/5'
                      }`}
                    >
                      {m.role === 'user' && (
                        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Interviewer asked
                        </div>
                      )}
                      <div className="prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown>{m.content}</ReactMarkdown>
                      </div>
                      {m.audio_url && (
                        <audio controls src={m.audio_url} className="mt-2 h-8 w-full" />
                      )}
                    </div>
                  </div>
                ))}
                {send.isPending && (
                  <div className="flex justify-start">
                    <div className="rounded-2xl border border-primary/40 bg-primary/5 px-4 py-2 text-sm text-muted-foreground">
                      composing your answer…
                    </div>
                  </div>
                )}
                <div ref={endRef} />
              </div>

              <div className="shrink-0 border-t border-border p-3">
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
                    placeholder="Paste the interviewer's question… (Enter to send)"
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
    </div>
  )
}
