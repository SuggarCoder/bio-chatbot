import { For, Show } from 'solid-js'

const MAX_STARS = 5

/** Hazard level as a row of small theme-colored stars; missing or 0 shows a dash. */
export function HazardStars(props: { level: number | null }) {
  const filled = () => Math.min(MAX_STARS, Math.max(0, Math.round(props.level ?? 0)))
  return (
    <Show when={filled() > 0} fallback={<span class="text-slate-300">—</span>}>
      <span
        class="inline-flex gap-px whitespace-nowrap text-[11px] leading-none"
        role="img"
        aria-label={`危害等级 ${props.level}`}
        title={`危害等级 ${props.level}`}
        data-testid="gpas-hazard-stars"
      >
        <For each={Array.from({ length: MAX_STARS }, (_, index) => index < filled())}>
          {(on) => <span aria-hidden="true" class={on ? 'text-teal-600' : 'text-slate-200'}>★</span>}
        </For>
      </span>
    </Show>
  )
}
