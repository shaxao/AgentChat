import { useEffect, useMemo, useState } from 'react'
import { chatApi } from '@/lib/api'
import { getFrontendModels, parseUserModelLimit } from '@/lib/frontendModels'
import { useAdminStore, useAuthStore, type Model } from '@/store'

type Capability = Model['capabilities'][number]

interface UseAvailableModelsOptions {
  requiredCapabilities?: Capability[]
  userModelLimit?: Set<string> | null
}

export function useAvailableModels(options: UseAvailableModelsOptions = {}) {
  const { models, channels, setModels } = useAdminStore()
  const { user } = useAuthStore()
  const [serverModels, setServerModels] = useState<Model[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    chatApi.listModels()
      .then(list => {
        if (cancelled) return
        const safeList = Array.isArray(list) ? list : []
        setServerModels(safeList)
        setModels(safeList)
      })
      .catch(err => {
        if (!cancelled) {
          console.warn('加载用户可用模型失败:', err)
          setServerModels(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [setModels])

  const userModelLimit = options.userModelLimit ?? parseUserModelLimit(user?.modelLimit)

  const availableModels = useMemo(() => {
    const base = serverModels ?? getFrontendModels(models, channels, { userModelLimit })
    let list = base.filter(m => m.enabled !== false)
    if (options.requiredCapabilities?.length) {
      list = list.filter(m =>
        options.requiredCapabilities!.every(cap => m.capabilities?.includes(cap))
      )
    }
    return list
  }, [channels, models, options.requiredCapabilities, serverModels, userModelLimit])

  return { models: availableModels, loading, backendLoaded: serverModels !== null }
}
