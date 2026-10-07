import type { GpasService } from '../../gpas.js'
import { assertUniqueToolIds, type GpasToolSpec } from '../defineTool.js'
import { fileListTool } from './file.js'
import { createProjectTools } from './project.js'
import { userProfileTool } from './user.profile.js'

/**
 * Every GPAS tool is registered here. To add a GPAS API: create one spec file
 * with `defineGpasTool` (calling `ctx.client.read`), add it to this list, and
 * add a contract test. The loop, queue and isolation rules need no change.
 */
export function createGpasTools(service: GpasService): readonly GpasToolSpec<any, any>[] {
  const tools = [userProfileTool, ...createProjectTools(service), fileListTool]
  assertUniqueToolIds(tools)
  return tools
}
