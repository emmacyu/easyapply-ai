import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  Download,
  Github,
  Loader2,
  Presentation as PresentationIcon,
  Sparkles,
  ExternalLink,
} from 'lucide-react'
import { api, type Deck } from '../api/client'

export function Presentation() {
  const [repoUrl, setRepoUrl] = useState('')
  const [refUrl, setRefUrl] = useState('')
  const [refText, setRefText] = useState('')
  const [targetSlides, setTargetSlides] = useState(10)
  const [deck, setDeck] = useState<Deck | null>(null)
  const [slidesUrl, setSlidesUrl] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const { data: google } = useQuery({
    queryKey: ['google-status'],
    queryFn: api.googleStatus,
  })
  const googleConnected = !!google?.connected

  const generate = useMutation({
    mutationFn: () =>
      api.generatePresentation({
        repo_url: repoUrl.trim(),
        reference_slides_url: refUrl.trim() || undefined,
        reference_text: refText.trim() || undefined,
        target_slides: targetSlides,
      }),
    onMutate: () => {
      setErr(null)
      setSlidesUrl(null)
    },
    onSuccess: (d) => setDeck(d),
    onError: (e: any) => setErr(e.message || 'Generation failed'),
  })

  const pptx = useMutation({
    mutationFn: () => api.downloadPptx(deck!),
    onError: (e: any) => setErr(e.message || 'PPTX export failed'),
  })

  const gslides = useMutation({
    mutationFn: () => api.createGoogleSlides(deck!),
    onMutate: () => setErr(null),
    onSuccess: (r) => setSlidesUrl(r.url),
    onError: (e: any) => setErr(e.message || 'Google Slides export failed'),
  })

  return (
    <div className="mx-auto flex h-screen max-w-4xl flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <Link to="/" className="rounded-lg p-1.5 hover:bg-muted" title="Back to JobPilot">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <PresentationIcon className="h-5 w-5 text-primary" />
        <div>
          <h1 className="font-bold leading-tight">Presentation</h1>
          <p className="text-xs text-muted-foreground">
            Turn a GitHub repo into a slide deck (.pptx, or Google Slides)
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {/* Input form */}
        <div className="space-y-4 rounded-xl border border-border p-4">
          <label className="block">
            <span className="mb-1 flex items-center gap-1.5 text-sm font-medium">
              <Github className="h-4 w-4" /> GitHub repository URL
            </span>
            <input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">
              Reference Google Slides link{' '}
              <span className="font-normal text-muted-foreground">
                (optional — match its style/structure)
              </span>
            </span>
            <input
              value={refUrl}
              onChange={(e) => setRefUrl(e.target.value)}
              disabled={!googleConnected}
              placeholder={
                googleConnected
                  ? 'https://docs.google.com/presentation/d/…'
                  : 'Connect Google first to read a reference deck'
              }
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
            />
            {!googleConnected && (
              <span className="mt-1 block text-xs text-amber-600 dark:text-amber-500">
                Google not connected — run{' '}
                <code className="rounded bg-muted px-1">python main.py gslides-auth</code> to
                enable reading a reference deck and exporting to Google Slides. You can still use
                the pasted outline below and download .pptx.
              </span>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">
              …or paste a reference outline{' '}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <textarea
              value={refText}
              onChange={(e) => setRefText(e.target.value)}
              placeholder="Slide 1: Title…&#10;Slide 2: Problem…"
              rows={3}
              className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>

          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm">
              Slides:
              <input
                type="number"
                min={4}
                max={20}
                value={targetSlides}
                onChange={(e) => setTargetSlides(Number(e.target.value))}
                className="w-16 rounded-lg border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary"
              />
            </label>
            <button
              onClick={() => generate.mutate()}
              disabled={generate.isPending || !repoUrl.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {generate.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {generate.isPending ? 'Reading repo & generating…' : 'Generate deck'}
            </button>
          </div>
        </div>

        {err && (
          <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {err}
          </p>
        )}

        {/* Deck preview */}
        {deck && (
          <div className="mt-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">{deck.title}</h2>
                {deck.subtitle && (
                  <p className="text-sm text-muted-foreground">{deck.subtitle}</p>
                )}
                {deck.repo && (
                  <p className="text-xs text-muted-foreground">
                    from {deck.repo.full_name} · {deck.slides.length} slides
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => pptx.mutate()}
                  disabled={pptx.isPending}
                  className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                >
                  {pptx.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  .pptx
                </button>
                <button
                  onClick={() => gslides.mutate()}
                  disabled={gslides.isPending || !googleConnected}
                  title={
                    googleConnected
                      ? 'Create a Google Slides deck'
                      : 'Connect Google (gslides-auth) to enable'
                  }
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {gslides.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <PresentationIcon className="h-4 w-4" />
                  )}
                  Google Slides
                </button>
              </div>
            </div>

            {slidesUrl && (
              <a
                href={slidesUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
              >
                <ExternalLink className="h-4 w-4" /> Open the created Google Slides deck
              </a>
            )}

            <div className="space-y-3">
              {deck.slides.map((s, i) => (
                <div key={i} className="rounded-xl border border-border bg-card p-4">
                  <div className="mb-2 flex items-baseline gap-2">
                    <span className="text-xs font-semibold text-muted-foreground">
                      {i + 1}
                    </span>
                    <h3 className="font-semibold">{s.title}</h3>
                  </div>
                  <ul className="ml-4 list-disc space-y-1 text-sm">
                    {s.bullets.map((b, j) => (
                      <li key={j}>{b}</li>
                    ))}
                  </ul>
                  {s.notes && (
                    <p className="mt-2 border-t border-border pt-2 text-xs italic text-muted-foreground">
                      🗣 {s.notes}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
