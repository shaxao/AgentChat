import type { Model, ModelChannel } from '@/store'

type Capability = Model['capabilities'][number]

export interface FrontendModelOptions {
  requiredCapabilities?: Capability[]
  userModelLimit?: Set<string> | null
  includeUnpricedChannelModels?: boolean
}

export function parseUserModelLimit(modelLimit?: string | null): Set<string> | null {
  if (!modelLimit || modelLimit.trim() === '') return null
  return new Set(modelLimit.split(',').map(s => s.trim()).filter(Boolean))
}

export function getFrontendModels(
  models: Model[],
  channels: ModelChannel[],
  options: FrontendModelOptions = {},
): Model[] {
  const enabledModelMap = new Map(models.filter(m => m.enabled).map(m => [m.id, m]))
  const activeChatChannels = channels.filter(ch =>
    ch.status === 'active' && (!ch.channelType || ch.channelType === 'chat')
  )
  const channelModelIds = new Set<string>()
  activeChatChannels.forEach(ch => {
    ch.models.filter(Boolean).forEach(id => channelModelIds.add(id))
  })

  let list: Model[]
  if (channelModelIds.size > 0) {
    list = Array.from(channelModelIds)
      .map(id => {
        const meta = enabledModelMap.get(id)
        if (meta) return meta
        if (!options.includeUnpricedChannelModels) return null

        const channel = activeChatChannels.find(ch => ch.models.includes(id))
        const tags = activeChatChannels
          .filter(ch => ch.models.includes(id) && ch.tags?.length)
          .flatMap(ch => ch.tags || [])
        const capabilities = [...new Set(tags)] as Capability[]
        return {
          id,
          name: id,
          provider: channel?.provider || '',
          description: '',
          contextLength: 128000,
          inputPrice: 0,
          outputPrice: 0,
          capabilities: capabilities.length > 0 ? capabilities : ['text'],
          enabled: true,
        }
      })
      .filter((m): m is Model => Boolean(m))
  } else {
    list = Array.from(enabledModelMap.values())
  }

  if (options.userModelLimit) {
    list = list.filter(m => options.userModelLimit!.has(m.id))
  }

  if (options.requiredCapabilities?.length) {
    list = list.filter(m =>
      options.requiredCapabilities!.every(cap => m.capabilities.includes(cap))
    )
  }

  return list
}
