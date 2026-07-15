import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Plus, X, Search, Sparkles, Star, ChevronDown,
  Loader2, Zap, Bot, Wrench, FileText, Wand2,
  Download, PackageOpen, PackageCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentRegistryApi, AgentRegistryItem } from '@/lib/api'
import { useChatStore } from '@/store'

interface SkillChipsProps {
  selectedSkillIds: string[]
  onSkillsChange: (ids: string[]) => void
  disabled?: boolean
  onQuickCreate?: () => void
  onOpenStore?: () => void
}

export default function SkillChips({ selectedSkillIds, onSkillsChange, disabled, onQuickCreate, onOpenStore }: SkillChipsProps) {
  const [selectorOpen, setSelectorOpen] = useState(false)
  const [skills, setSkills] = useState<AgentRegistryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeTab, setActiveTab] = useState<'all' | 'installed'>('all')
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set())
  const selectorRef = useRef<HTMLDivElement>(null)
  const { installedSkillIds, addInstalledSkill, removeInstalledSkill } = useChatStore()

  // 加载技能列表
  useEffect(() => {
    if (!selectorOpen) return
    setLoading(true)
    if (activeTab === 'installed') {
      // 加载已安装技能
      agentRegistryApi.listInstalled()
        .then(list => setSkills(list || []))
        .catch(() => setSkills([]))
        .finally(() => setLoading(false))
    } else {
      agentRegistryApi.list({ page: 1, size: 30, category: '' })
        .then(result => {
          const list = result.list || result.content || []
          // 只显示已激活的技能
          setSkills(list.filter((s: AgentRegistryItem) => s.status === 'active' || s.status === 'approved'))
        })
        .catch(() => {})
        .finally(() => setLoading(false))
    }
  }, [selectorOpen, activeTab])

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setSelectorOpen(false)
      }
    }
    if (selectorOpen) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [selectorOpen])

  const selectedSkills = skills.filter(s => selectedSkillIds.includes(s.agentId))

  const toggleSkill = (agentId: string) => {
    if (selectedSkillIds.includes(agentId)) {
      onSkillsChange(selectedSkillIds.filter(id => id !== agentId))
    } else {
      onSkillsChange([...selectedSkillIds, agentId])
    }
  }

  const removeSkill = (agentId: string) => {
    onSkillsChange(selectedSkillIds.filter(id => id !== agentId))
  }

  const handleInstall = async (e: React.MouseEvent, agentId: string, name: string) => {
    e.stopPropagation()
    setInstallingIds(prev => new Set(prev).add(agentId))
    try {
      await agentRegistryApi.install(agentId)
      addInstalledSkill(agentId)
    } catch (err) {
      console.warn('安装技能失败:', err)
    } finally {
      setInstallingIds(prev => {
        const next = new Set(prev)
        next.delete(agentId)
        return next
      })
    }
  }

  const handleUninstall = async (e: React.MouseEvent, agentId: string) => {
    e.stopPropagation()
    setInstallingIds(prev => new Set(prev).add(agentId))
    try {
      await agentRegistryApi.uninstall(agentId)
      removeInstalledSkill(agentId)
      // 如果在"我的技能"tab，从列表中移除
      if (activeTab === 'installed') {
        setSkills(prev => prev.filter(s => s.agentId !== agentId))
      }
    } catch (err) {
      console.warn('卸载技能失败:', err)
    } finally {
      setInstallingIds(prev => {
        const next = new Set(prev)
        next.delete(agentId)
        return next
      })
    }
  }

  const handleDownload = (e: React.MouseEvent, agentId: string) => {
    e.stopPropagation()
    agentRegistryApi.download(agentId).catch(err => console.warn('下载失败:', err))
  }

  const filteredSkills = searchQuery
    ? skills.filter(s =>
        s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (s.categories && s.categories.some((c: string) => c.toLowerCase().includes(searchQuery.toLowerCase())))
      )
    : skills

  // 技能图标映射
  const skillIcon = (item: AgentRegistryItem) => {
    if (item.icon && item.icon.trim() && item.icon.length <= 4) {
      return <span className="text-base">{item.icon}</span>
    }
    const name = item.name.toLowerCase()
    if (name.includes('排班') || name.includes('schedule')) return <Bot className="w-3.5 h-3.5" />
    if (name.includes('台账') || name.includes('ledger')) return <FileText className="w-3.5 h-3.5" />
    if (name.includes('翻译') || name.includes('transl')) return <Sparkles className="w-3.5 h-3.5" />
    return <Wrench className="w-3.5 h-3.5" />
  }

  const getCategoryColor = (cat: string) => {
    const map: Record<string, string> = {
      '金融': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
      '法律': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
      '教育': 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
      '医疗': 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
      '办公': 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
      '开发': 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
      '台账': 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
      'OCR': 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
      '工具': 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
      '开发助手': 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
    }
    return map[cat] || 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
  }

  return (
    <div className="relative">
      {/* 技能操作栏：已选标签 + 固定按钮 */}
      <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2 pb-0">
        {selectedSkills.map(skill => (
          <Badge
            key={skill.agentId}
            variant="secondary"
            className="gap-1.5 pl-2 pr-1 py-1 cursor-pointer hover:bg-secondary/80 transition-colors text-xs font-medium"
          >
            {skillIcon(skill)}
            <span className="max-w-[100px] truncate">{skill.name}</span>
            <button
              onClick={() => removeSkill(skill.agentId)}
              className="ml-0.5 p-0.5 rounded-full hover:bg-destructive/20 hover:text-destructive transition-colors"
              title="移除"
            >
              <X className="w-3 h-3" />
            </button>
          </Badge>
        ))}
        <button
          onClick={() => setSelectorOpen(true)}
          disabled={disabled}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors py-1 px-1"
          title="浏览所有技能"
        >
          <Plus className="w-3 h-3" />
          <span>{selectedSkills.length === 0 ? '添加技能' : ''}</span>
        </button>

        {/* 分隔 */}
        <span className="w-px h-3.5 bg-border mx-0.5 shrink-0" />

        {onQuickCreate && (
          <button
            onClick={onQuickCreate}
            disabled={disabled}
            className="inline-flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300 transition-colors py-1 px-1 font-medium"
            title="一键创建新技能"
          >
            <Wand2 className="w-3 h-3" />
            <span>快速创建</span>
          </button>
        )}

        <button
          onClick={() => onOpenStore?.()}
          disabled={disabled}
          className="inline-flex items-center gap-1 text-xs text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 transition-colors py-1 px-1 font-medium"
          title="浏览技能商店"
        >
          <Star className="w-3 h-3" />
          <span>技能商店</span>
        </button>
      </div>

      {/* 技能选择器弹窗 */}
      {selectorOpen && (
        <div className="absolute left-0 right-0 bottom-full mb-2 z-50 mx-4" ref={selectorRef}>
          <div className="bg-card border rounded-2xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-2">
            {/* 搜索栏 */}
            <div className="p-3 border-b flex items-center gap-2">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <Input
                placeholder="搜索技能..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="border-0 shadow-none h-8 text-sm focus-visible:ring-0 p-0"
                autoFocus
              />
              <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => setSelectorOpen(false)}>
                <X className="w-4 h-4" />
              </Button>
            </div>

            {/* Tab 切换 */}
            <div className="flex border-b">
              <button
                onClick={() => { setActiveTab('all'); setSearchQuery('') }}
                className={cn(
                  'flex-1 py-2 text-xs font-medium transition-colors border-b-2',
                  activeTab === 'all'
                    ? 'text-primary border-primary'
                    : 'text-muted-foreground border-transparent hover:text-foreground'
                )}
              >
                全部技能
              </button>
              <button
                onClick={() => { setActiveTab('installed'); setSearchQuery('') }}
                className={cn(
                  'flex-1 py-2 text-xs font-medium transition-colors border-b-2',
                  activeTab === 'installed'
                    ? 'text-primary border-primary'
                    : 'text-muted-foreground border-transparent hover:text-foreground'
                )}
              >
                我的技能
                {installedSkillIds.length > 0 && (
                  <span className="ml-1 text-[10px] text-primary/70">({installedSkillIds.length})</span>
                )}
              </button>
            </div>

            {/* 列表 */}
            <div className="max-h-[300px] overflow-y-auto p-2">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : filteredSkills.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  {searchQuery ? '未找到匹配的技能' : '暂无可用技能'}
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredSkills.map(skill => {
                    const isSelected = selectedSkillIds.includes(skill.agentId)
                    const isInstalled = installedSkillIds.includes(skill.agentId)
                    const isInstalling = installingIds.has(skill.agentId)
                    return (
                      <div
                        key={skill.agentId}
                        className={cn(
                          'group flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all',
                          isSelected
                            ? 'bg-primary/8 ring-1 ring-primary/20'
                            : 'hover:bg-muted/60'
                        )}
                      >
                        <button
                          onClick={() => toggleSkill(skill.agentId)}
                          className="flex items-center gap-3 flex-1 min-w-0 text-left"
                        >
                          <div className={cn(
                            'w-9 h-9 rounded-xl flex items-center justify-center shrink-0',
                            isSelected ? 'bg-primary/15' : 'bg-muted'
                          )}>
                            {skillIcon(skill)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold truncate">{skill.name}</span>
                              {isSelected && (
                                <span className="text-[10px] text-primary font-medium">已选</span>
                              )}
                              {isInstalled && (
                                <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">已安装</span>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                              {skill.description}
                            </p>
                          </div>
                        </button>
                        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          {isInstalled ? (
                            <button
                              onClick={(e) => handleUninstall(e, skill.agentId)}
                              disabled={isInstalling}
                              className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                              title="卸载"
                            >
                              {isInstalling ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <PackageCheck className="w-3.5 h-3.5" />
                              )}
                            </button>
                          ) : (
                            <button
                              onClick={(e) => handleInstall(e, skill.agentId, skill.name)}
                              disabled={isInstalling}
                              className="p-1.5 rounded-lg hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                              title="安装"
                            >
                              {isInstalling ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <PackageOpen className="w-3.5 h-3.5" />
                              )}
                            </button>
                          )}
                          <button
                            onClick={(e) => handleDownload(e, skill.agentId)}
                            className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                            title="下载"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {skill.categories && skill.categories.length > 0 && (
                          <span className={cn(
                            'text-[9px] px-1.5 py-0.5 rounded-full font-medium shrink-0',
                            getCategoryColor(skill.categories[0].trim())
                          )}>
                            {skill.categories[0].trim()}
                          </span>
                        )}
                        {skill.totalUsage !== undefined && skill.totalUsage > 0 && (
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {skill.totalUsage > 1000
                              ? (skill.totalUsage / 1000).toFixed(1) + 'k'
                              : skill.totalUsage} 次
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* 底部导航 */}
            <div className="border-t px-3 py-2 flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">
                {activeTab === 'installed'
                  ? `已安装 ${installedSkillIds.length} 个技能`
                  : `共 ${filteredSkills.length} 个技能`
                }
              </span>
              <div className="flex items-center gap-1">
                {onQuickCreate && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950"
                    onClick={() => {
                      setSelectorOpen(false)
                      onQuickCreate()
                    }}
                  >
                    <Wand2 className="w-3 h-3" /> 快速创建
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={() => {
                    setSelectorOpen(false)
                    onOpenStore?.()
                  }}
                >
                  <Star className="w-3 h-3" /> 技能商店
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
