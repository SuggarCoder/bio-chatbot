import type { Component } from 'solid-js'
import { artifactStore } from './artifactStore'
import type { ArtifactMimeType } from './types'

export const ArtifactCard: Component<{
  artifactId: string
  logicalId: string
  title?: string
  type?: ArtifactMimeType
  version: number
}> = (props) => (
  <button
    type="button"
    class="my-3 flex w-full max-w-xl items-center gap-3 rounded-2xl border border-gray-300 bg-gray-50/60 p-4 text-left transition hover:border-gray-300 hover:bg-gray-50"
    onClick={() => void artifactStore.open(props.artifactId, props.version)}
  >
    <span class="i-lucide-panels-top-left h-5 w-5 shrink-0 text-teal-700" />
    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm font-semibold text-slate-800">{props.title ?? props.logicalId}</span>
      <span class="block truncate text-xs text-slate-500">
        {props.type ? `${props.type} · ` : ''}Artifact v{props.version}
      </span>
    </span>
    <span class="i-lucide-chevron-right h-4 w-4 text-slate-400" />
  </button>
)
