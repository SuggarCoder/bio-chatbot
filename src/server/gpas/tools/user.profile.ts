import { z } from 'zod'

import { profileReply } from '../../gpas.js'
import type { Gpas2UserInfo } from '../../domain.js'
import type { ProfileCard } from '../../gpasContracts.js'
import { defineGpasTool } from '../defineTool.js'

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null

/** The card fields shown to the user; internal ids stay out. */
export function profileCard(profile: Gpas2UserInfo): ProfileCard {
  return {
    realName: text(profile.realName), userName: text(profile.userName), teamName: text(profile.ownteamName),
    jobTitle: text(profile.jobTitle), researchField: text(profile.researchField), email: text(profile.email), phone: text(profile.phone),
  }
}

export const userProfileTool = defineGpasTool({
  id: 'user.profile', domain: 'user', title: '当前用户与团队信息', effect: 'read',
  description: '读取当前登录者的姓名、账号、联系方式、邮箱及所属团队，不查询其他人。',
  examples: ['我是谁', '我的用户信息', '我属于哪个团队', '我的邮箱是多少', '能告诉我现在登录的是谁吗', '我在这里用的是哪个账户', '我的联系方式和邮箱是什么'],
  policy: '可以查询当前登录账号的用户信息和所属团队信息；不支持访问其他用户或其他团队的资料。',
  input: z.object({}),
  // The session profile is already authoritative; no GPAS round trip.
  run: async ({ profile }) => profile,
  toModel: (profile) => ({
    realName: profile.realName ?? null, userName: profile.userName ?? null,
    teamName: profile.ownteamName ?? null, jobTitle: profile.jobTitle ?? null,
    email: profile.email ?? null, phone: profile.phone ?? null,
  }),
  toReply: (profile) => ({ content: profileReply(profile), part: { type: 'gpas', order: 1, profile: profileCard(profile) } }),
})
