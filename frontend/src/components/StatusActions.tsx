import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Job } from '../api/client'
import { api } from '../api/client'
import { cn } from '../lib/utils'

const transitions: Record<string, { label: string; next: string; variant?: string }[]> = {
  scored: [
    { label: 'Shortlist', next: 'shortlisted', variant: 'primary' },
    { label: 'Discard', next: 'discarded' },
  ],
  shortlisted: [
    { label: 'Materials Ready', next: 'materials_ready', variant: 'primary' },
    { label: 'Discard', next: 'discarded' },
  ],
  materials_ready: [
    { label: 'Applied', next: 'applied', variant: 'primary' },
    { label: 'Discard', next: 'discarded' },
  ],
  applied: [{ label: 'Interviewing', next: 'interviewing', variant: 'primary' }],
  interviewing: [
    { label: 'Offer', next: 'offer', variant: 'primary' },
    { label: 'Rejected', next: 'rejected' },
  ],
}

interface Props {
  job: Job
  compact?: boolean
}

export function StatusActions({ job, compact }: Props) {
  const queryClient = useQueryClient()
  const [toast, setToast] = useStateToast()

  const mutation = useMutation({
    mutationFn: (status: string) => api.updateStatus(job.id, status),
    onMutate: async (status) => {
      await queryClient.cancelQueries({ queryKey: ['jobs'] })
      await queryClient.cancelQueries({ queryKey: ['job', job.id] })
      const prevJobs = queryClient.getQueryData(['jobs'])
      const prevJob = queryClient.getQueryData(['job', job.id])
      queryClient.setQueryData(['job', job.id], (old: Job | undefined) =>
        old ? { ...old, status } : old
      )
      return { prevJobs, prevJob }
    },
    onError: (_err, _status, ctx) => {
      if (ctx?.prevJob) queryClient.setQueryData(['job', job.id], ctx.prevJob)
      setToast('Failed to update status')
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['job', job.id] })
      queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  const actions = transitions[job.status] || []

  return (
    <>
      <div className={cn('flex flex-wrap gap-2', compact && 'justify-end')}>
        {actions.map((a) => (
          <button
            key={a.next}
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(a.next)}
            className={cn(
              'rounded-lg border border-border px-3 py-1 text-xs font-medium transition',
              a.variant === 'primary'
                ? 'bg-primary text-white border-transparent hover:opacity-90'
                : 'bg-background hover:bg-muted'
            )}
          >
            {a.label}
          </button>
        ))}
      </div>
      {toast && (
        <div className="fixed bottom-4 right-4 rounded-lg bg-red-600 px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
    </>
  )
}

function useStateToast() {
  const [msg, setMsg] = useState<string | null>(null)
  const setter = (m: string) => {
    setMsg(m)
    setTimeout(() => setMsg(null), 3000)
  }
  return [msg, setter] as const
}
