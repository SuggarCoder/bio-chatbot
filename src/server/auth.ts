import type { FastifyRequest } from 'fastify'

import type { AppConfig } from './config.js'
import { syncUser, type Database } from './db.js'
import type { CurrentUser, Gpas2UserInfo } from './domain.js'

type Gpas2UserInfoResponse = {
  code: number
  message?: string
  data?: Gpas2UserInfo
}

export class AuthenticationError extends Error {
  statusCode: number
  code: string

  constructor(message: string, statusCode = 401, code = 'unauthorized') {
    super(message)
    this.name = 'AuthenticationError'
    this.statusCode = statusCode
    this.code = code
  }
}

export const mockUserInfoResponse: Gpas2UserInfoResponse = {
  code: 200,
  message: 'get user info success',
  data: {
    userId: 'user-69da47c8f6b1f75c2d3855f8ed23d803',
    realName: '郑书发',
    userName: '360001',
    ownteamId: 'team-1f340278f76b47a7a46bb91c466f7742',
    ownteamName: '郑书发团队',
    email: 'zsfzheng@163.com',
    emailBindStatus: 0,
    phone: '15988806416',
    phoneBindStatus: 0,
    status: 0,
    jobTitle: '研究员',
    natureId: '1',
    role: 1,
    sex: 0,
    correspondenceAddress: '',
    mark: '',
    workUnit: '',
    researchField: '',
    lastIP: '10.1.83.101',
    lastUA:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    lastLogin: '2026-07-30T11:15:40+08:00',
    comment: '',
    display: '',
    createTime: '2026-04-15T17:36:32+08:00',
    updateTime: '2026-07-30T11:15:40+08:00',
  },
}

export async function loadProfile(
  request: FastifyRequest,
  config: AppConfig,
): Promise<Gpas2UserInfo> {
  if (config.gpas2AuthMode === 'mock') {
    return mockUserInfoResponse.data as Gpas2UserInfo
  }

  const cookie = request.headers.cookie

  if (!cookie) {
    throw new AuthenticationError('GPAS2 session cookie is missing')
  }

  let response: Response

  try {
    response = await fetch(config.gpas2UserInfoUrl as string, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        cookie,
      },
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new AuthenticationError(
      'GPAS2 user service is unavailable',
      502,
      'identity_upstream_unavailable',
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthenticationError('GPAS2 session is invalid')
  }

  if (!response.ok) {
    throw new AuthenticationError(
      'GPAS2 user service returned an error',
      502,
      'identity_upstream_error',
    )
  }

  let payload: Gpas2UserInfoResponse

  try {
    payload = (await response.json()) as Gpas2UserInfoResponse
  } catch {
    throw new AuthenticationError(
      'GPAS2 user response is invalid',
      502,
      'identity_invalid_response',
    )
  }

  if (payload.code !== 200 || !payload.data?.userId) {
    throw new AuthenticationError('GPAS2 session is invalid')
  }

  return payload.data
}

export async function resolveCurrentUser(
  request: FastifyRequest,
  config: AppConfig,
  database: Database,
): Promise<CurrentUser> {
  const profile = await loadProfile(request, config)
  return syncUser(database, profile)
}
