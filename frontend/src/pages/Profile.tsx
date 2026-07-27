import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Save, Trash2 } from 'lucide-react'
import { api } from '../api/client'

const CONTACT_KEYS = ['first name', 'last name', 'email', 'phone', 'location', 'linkedin', 'github']

type QA = { key: string; value: string }
type Exp = {
  company: string
  title: string
  start: string
  end: string
  location: string
  bullets: string // newline-separated for editing
  tech: string // comma-separated for editing
}

const input =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary'

export function Profile() {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['profile-raw'], queryFn: api.getProfileRaw })

  const [contact, setContact] = useState<Record<string, string>>({})
  const [qa, setQa] = useState<QA[]>([])
  const [salary, setSalary] = useState('')
  const [remote, setRemote] = useState('')
  const [titles, setTitles] = useState('')
  const [experience, setExperience] = useState<Exp[]>([])
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!data) return
    const personal: Record<string, any> = data.personal || {}
    setContact(Object.fromEntries(CONTACT_KEYS.map((k) => [k, personal[k] ?? ''])))
    setQa(
      Object.entries(personal)
        .filter(([k]) => !CONTACT_KEYS.includes(k))
        .map(([k, v]) => ({ key: k, value: v == null ? '' : String(v) }))
    )
    const prefs = data.preferences || {}
    setSalary(prefs.min_salary_cad != null ? String(prefs.min_salary_cad) : '')
    setRemote(prefs.remote ?? '')
    setTitles(Array.isArray(prefs.target_titles) ? prefs.target_titles.join(', ') : '')
    setExperience(
      (data.experience || []).map((e: any) => ({
        company: e.company ?? '',
        title: e.title ?? '',
        start: e.start ?? '',
        end: e.end ?? '',
        location: e.location ?? '',
        bullets: Array.isArray(e.bullets) ? e.bullets.join('\n') : '',
        tech: Array.isArray(e.tech) ? e.tech.join(', ') : '',
      }))
    )
  }, [data])

  const save = useMutation({
    mutationFn: () => {
      const personal: Record<string, any> = {}
      for (const k of CONTACT_KEYS) if (contact[k]?.trim()) personal[k] = contact[k]
      for (const { key, value } of qa) if (key.trim()) personal[key.trim()] = value
      const preferences = {
        ...(data?.preferences || {}),
        min_salary_cad: salary ? Number(salary) : null,
        remote,
        target_titles: titles.split(',').map((t) => t.trim()).filter(Boolean),
      }
      const experienceOut = experience.map((e) => ({
        company: e.company,
        title: e.title,
        start: e.start,
        end: e.end,
        location: e.location,
        bullets: e.bullets.split('\n').map((b) => b.trim()).filter(Boolean),
        tech: e.tech.split(',').map((t) => t.trim()).filter(Boolean),
      }))
      return api.saveProfileRaw({ ...data, personal, preferences, experience: experienceOut })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile-raw'] })
      queryClient.invalidateQueries({ queryKey: ['profile'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  if (isLoading || !data) {
    return <div className="p-8 text-center text-muted-foreground">Loading profile…</div>
  }

  const education = data.education || []
  const skills = data.skills || {}
  const setExp = (i: number, patch: Partial<Exp>) =>
    setExperience(experience.map((e, j) => (j === i ? { ...e, ...patch } : e)))

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link to="/" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-xl font-bold">Profile</h1>
            <p className="text-xs text-muted-foreground">
              Saved to config/profile.yaml — used by autofill &amp; question answering.
            </p>
          </div>
        </div>
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {save.isPending ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
        </button>
      </div>

      {/* Contact */}
      <section className="mb-5 rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 font-semibold">Contact</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {CONTACT_KEYS.map((k) => (
            <label key={k} className="text-sm">
              <span className="mb-1 block capitalize text-muted-foreground">{k}</span>
              <input className={input} value={contact[k] ?? ''} onChange={(e) => setContact({ ...contact, [k]: e.target.value })} />
            </label>
          ))}
        </div>
      </section>

      {/* Preferences */}
      <section className="mb-5 rounded-xl border border-border bg-card p-5">
        <h2 className="mb-3 font-semibold">Preferences</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Min salary (CAD)</span>
            <input className={input} type="number" value={salary} onChange={(e) => setSalary(e.target.value)} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Remote</span>
            <input className={input} value={remote} onChange={(e) => setRemote(e.target.value)} placeholder="hybrid_ok / remote / onsite" />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="mb-1 block text-muted-foreground">Target titles (comma-separated)</span>
            <input className={input} value={titles} onChange={(e) => setTitles(e.target.value)} />
          </label>
        </div>
      </section>

      {/* Application answers (schema-less Q&A) */}
      <section className="mb-5 rounded-xl border border-border bg-card p-5">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-semibold">Application Answers</h2>
          <button onClick={() => setQa([...qa, { key: '', value: '' }])} className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-xs font-medium hover:bg-muted/80">
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Question → answer pairs used to autofill forms. Add any new company-specific question here — no code changes needed.
        </p>
        <div className="space-y-2">
          {qa.map((row, i) => (
            <div key={i} className="flex gap-2">
              <input className={`${input} flex-1`} placeholder="Question (as it appears on the form)" value={row.key} onChange={(e) => setQa(qa.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))} />
              <input className={`${input} flex-1`} placeholder="Your answer" value={row.value} onChange={(e) => setQa(qa.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))} />
              <button onClick={() => setQa(qa.filter((_, j) => j !== i))} aria-label="Remove" className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-red-600">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          {qa.length === 0 && <p className="text-sm text-muted-foreground">No answers yet — click Add.</p>}
        </div>
      </section>

      {/* Experience (editable) */}
      <section className="mb-5 rounded-xl border border-border bg-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Experience</h2>
          <button
            onClick={() => setExperience([...experience, { company: '', title: '', start: '', end: '', location: '', bullets: '', tech: '' }])}
            className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1 text-xs font-medium hover:bg-muted/80"
          >
            <Plus className="h-3.5 w-3.5" /> Add role
          </button>
        </div>
        <div className="space-y-4">
          {experience.map((e, i) => (
            <div key={i} className="rounded-lg border border-border p-3">
              <div className="mb-2 grid gap-2 sm:grid-cols-2">
                <input className={input} placeholder="Title" value={e.title} onChange={(ev) => setExp(i, { title: ev.target.value })} />
                <input className={input} placeholder="Company" value={e.company} onChange={(ev) => setExp(i, { company: ev.target.value })} />
                <input className={input} placeholder="Start (YYYY-MM)" value={e.start} onChange={(ev) => setExp(i, { start: ev.target.value })} />
                <input className={input} placeholder="End (present / YYYY-MM)" value={e.end} onChange={(ev) => setExp(i, { end: ev.target.value })} />
                <input className={`${input} sm:col-span-2`} placeholder="Location" value={e.location} onChange={(ev) => setExp(i, { location: ev.target.value })} />
              </div>
              <textarea className={`${input} min-h-[80px]`} placeholder="Bullets — one per line" value={e.bullets} onChange={(ev) => setExp(i, { bullets: ev.target.value })} />
              <input className={`${input} mt-2`} placeholder="Tech (comma-separated)" value={e.tech} onChange={(ev) => setExp(i, { tech: ev.target.value })} />
              <div className="mt-2 text-right">
                <button onClick={() => setExperience(experience.filter((_, j) => j !== i))} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-red-600">
                  <Trash2 className="h-3.5 w-3.5" /> Remove role
                </button>
              </div>
            </div>
          ))}
          {experience.length === 0 && <p className="text-sm text-muted-foreground">No experience yet — click Add role.</p>}
        </div>
      </section>

      {/* Cached AI answers */}
      <CachedAnswers />

      {/* Education / Skills (read-only) */}
      <section className="rounded-xl border border-dashed border-border bg-card/50 p-5">
        <h2 className="mb-1 font-semibold text-muted-foreground">
          Education · Skills <span className="text-xs font-normal">(read-only — edit in profile.yaml)</span>
        </h2>
        <div className="mt-3 space-y-2 text-sm">
          {education.map((e: any, i: number) => (
            <div key={`edu-${i}`} className="text-muted-foreground">
              {e.degree}, {e.school} ({e.year})
            </div>
          ))}
          {(skills.languages || skills.frameworks || skills.tools) && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[...(skills.languages || []), ...(skills.frameworks || []), ...(skills.tools || [])].map((s: string, i: number) => (
                <span key={i} className="rounded-md bg-muted px-2 py-0.5 text-xs">
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function CachedAnswers() {
  const queryClient = useQueryClient()
  const { data: answers } = useQuery({ queryKey: ['answers'], queryFn: api.listAnswers })
  const [edits, setEdits] = useState<Record<string, string>>({})

  const del = useMutation({
    mutationFn: (key: string) => api.deleteAnswer(key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['answers'] }),
  })
  const upd = useMutation({
    mutationFn: ({ key, answer }: { key: string; answer: string }) => api.updateAnswer(key, answer),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['answers'] }),
  })

  if (!answers || answers.length === 0) return null

  return (
    <section className="mb-5 rounded-xl border border-border bg-card p-5">
      <h2 className="mb-1 font-semibold">Cached AI Answers</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Answers the AI generated for form questions. Edit to correct them (edited = trusted); delete to regenerate next time.
      </p>
      <div className="space-y-3">
        {answers.map((a) => (
          <div key={a.key} className="rounded-lg border border-border p-3">
            <div className="mb-1 flex items-start justify-between gap-2">
              <p className="text-sm font-medium">{a.question}</p>
              <button onClick={() => del.mutate(a.key)} aria-label="Delete" className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-red-600">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <textarea
              className={`${input} min-h-[56px]`}
              value={edits[a.key] ?? a.answer ?? ''}
              onChange={(e) => setEdits({ ...edits, [a.key]: e.target.value })}
            />
            <div className="mt-1 flex items-center gap-3">
              {!a.reviewed && <span className="text-xs text-amber-600 dark:text-amber-400">needs review</span>}
              <button
                onClick={() => upd.mutate({ key: a.key, answer: edits[a.key] ?? a.answer ?? '' })}
                className="ml-auto text-xs text-primary hover:underline"
              >
                Save answer
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
