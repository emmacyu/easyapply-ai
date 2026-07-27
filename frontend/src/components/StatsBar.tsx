import { useQuery } from '@tanstack/react-query'
import { Briefcase, Clock, Send, TrendingUp } from 'lucide-react'
import { api } from '../api/client'
import { cn } from '../lib/utils'

const cards = [
  { key: 'today_new' as const, label: 'Today New', icon: TrendingUp },
  { key: 'pending' as const, label: 'Pending', icon: Clock },
  { key: 'applied' as const, label: 'Applied', icon: Send },
  { key: 'reply_rate' as const, label: 'Reply Rate', icon: Briefcase, suffix: '%' },
]

export function StatsBar() {
  const { data } = useQuery({
    queryKey: ['stats'],
    queryFn: api.getStats,
    refetchInterval: 30000,
  })

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {cards.map(({ key, label, icon: Icon, suffix }) => (
        <div
          key={key}
          className={cn(
            'rounded-xl border border-border bg-card p-4 shadow-sm'
          )}
        >
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{label}</p>
            <Icon className="h-4 w-4 text-primary" />
          </div>
          <p className="mt-2 text-2xl font-bold">
            {data ? `${data[key]}${suffix || ''}` : '—'}
          </p>
        </div>
      ))}
    </div>
  )
}
