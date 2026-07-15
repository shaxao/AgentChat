/** 从 localStorage 读取认证 token */
export function getToken(): string | null {
  try {
    const raw = localStorage.getItem('auth-store')
    if (!raw) return null
    const store = JSON.parse(raw)
    return store?.state?.token || null
  } catch {
    return null
  }
}
