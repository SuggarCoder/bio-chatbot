import { z } from 'zod'

import type { CapabilityDescription } from '../capabilities/registry.js'
import type { Gpas2UserInfo } from '../domain.js'
import type { BusinessReply } from '../gpas.js'
import type { GpasClient } from './client.js'

/**
 * Server-side context for a GPAS tool. Identity (profile, cookie) is injected
 * from the authenticated session and never taken from model or user arguments.
 */
export type GpasToolContext = {
  profile: Gpas2UserInfo
  cookie?: string
  client: GpasClient
  signal?: AbortSignal
}

export type GpasToolEffect = 'read' | 'prepare_confirmation'

export type GpasToolSpec<Input extends z.ZodObject = z.ZodObject, Data = unknown> =
  Omit<CapabilityDescription, 'effect'> & {
    effect: GpasToolEffect
    /** Business arguments the model may fill. Must not contain identity fields. */
    input: Input
    /** Fetch and validate data. Build identity parameters from `ctx.profile` only. */
    run: (ctx: GpasToolContext, args: z.infer<Input>) => Promise<Data>
    /** Compact, field-allowlisted view for the model (kept small; see agent limits). */
    toModel: (data: Data) => unknown
    /** Full user-facing reply (markdown table / form part). */
    toReply: (data: Data, ctx: GpasToolContext) => BusinessReply
  }

/**
 * Argument names that identify a user, team or project. Tools derive these from
 * the session; letting a model choose them would allow cross-tenant access.
 */
export const identityFieldPattern =
  /^(user|team|ownteam|project|tenant|account|org|organization)_?(id|code|name)$|^(userid|teamid|ownteamid|projectcode|username|cookie|token|phone|email)$/i

function inputKeys(schema: z.ZodObject): string[] {
  return Object.keys(schema.shape)
}

export function defineGpasTool<Input extends z.ZodObject, Data>(
  spec: GpasToolSpec<Input, Data>,
): GpasToolSpec<Input, Data> {
  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/.test(spec.id)) {
    throw new Error(`Invalid GPAS tool id: ${spec.id}`)
  }
  if (!spec.title || !spec.description || !spec.policy || !spec.examples.length) {
    throw new Error(`GPAS tool ${spec.id} requires title, description, policy and examples`)
  }
  const forbidden = inputKeys(spec.input).filter((key) => identityFieldPattern.test(key))
  if (forbidden.length) {
    throw new Error(`GPAS tool ${spec.id} must not accept identity fields: ${forbidden.join(', ')}`)
  }
  return Object.freeze({ ...spec, examples: Object.freeze([...spec.examples]) })
}

export function assertUniqueToolIds(specs: readonly { id: string }[]): void {
  const seen = new Set<string>()
  for (const { id } of specs) {
    if (seen.has(id)) throw new Error(`Duplicate GPAS tool id: ${id}`)
    seen.add(id)
  }
}
