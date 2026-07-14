export const routerBase = import.meta.env.BASE_URL.replace(/\/+$/, '') || '/'

export const appRoutes = {
  home: '/',
  session: (id: string) => `/${id}`,
} as const

export function getAppPathname(pathname: string) {
  if (routerBase === '/') {
    return pathname || appRoutes.home
  }

  const relativePath =
    pathname === routerBase || pathname.startsWith(`${routerBase}/`)
      ? pathname.slice(routerBase.length)
      : pathname

  return `/${relativePath.replace(/^\/+/, '')}`
}
