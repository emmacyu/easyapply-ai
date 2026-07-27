import { MousePointerClick } from 'lucide-react'

export function EmptyDetail() {
  return (
    <div className="flex h-full items-center justify-center p-10 text-center">
      <div className="max-w-sm space-y-2 text-muted-foreground">
        <MousePointerClick className="mx-auto h-8 w-8 opacity-60" />
        <p className="text-lg font-medium text-foreground">Select a job</p>
        <p className="text-sm">
          Choose a posting from the list to see its full description, score
          breakdown, red flags, and generated materials.
        </p>
      </div>
    </div>
  )
}
