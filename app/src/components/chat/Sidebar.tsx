import { useState, useEffect } from 'react'
import { useChatStore, useAuthStore } from '@/store'
import { cn, formatDate, truncate } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Plus, Search, MessageSquare, Pin, Trash2, Edit3, MoreHorizontal,
  Bot, Settings, Shield, LogOut, Sparkles, ChevronLeft, ChevronRight, X, LayoutGrid,
} from 'lucide-react'
import { loadConversations, chatApi, isDemoMode, agentRegistryApi } from '@/lib/api'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  onOpenSettings: () => void
  onOpenAdmin: () => void
  mobileOpen?: boolean
  onMobileClose?: () => void
  onNavigate?: (view: string) => void
}

export default function Sidebar({ collapsed, onToggle, onOpenSettings, onOpenAdmin, mobileOpen = false, onMobileClose, onNavigate }: SidebarProps) {
  const { user, logout } = useAuthStore()
  const {
    conversations, activeConversationId, createConversation,
    setActiveConversation, deleteConversation, updateConversation,
  } = useChatStore()
  const { installedSkillIds, setActiveSkillIds, setInstalledSkillIds } = useChatStore()

  const [installedSkills, setInstalledSkills] = useState<any[]>([])

  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [loadingConversations, setLoadingConversations] = useState(!isDemoMode())

  // 挂载时从后端加载对话列表（Demo 模式跳过）
  useEffect(() => {
    let alive = true
    if (isDemoMode()) {
      setLoadingConversations(false)
      return
    }
    setLoadingConversations(true)
    loadConversations().finally(() => {
      if (alive) setLoadingConversations(false)
    })
    return () => { alive = false }
  }, [])

  // 加载已安装技能
  useEffect(() => {
    if (installedSkillIds.length > 0) return
    agentRegistryApi.listInstalled()
      .then(skills => {
        setInstalledSkills(skills)
        setInstalledSkillIds(skills.map((s: any) => s.agentId))
      })
      .catch(() => {})
  }, [])

  const filtered = conversations.filter((c) =>
    c.title.toLowerCase().includes(search.toLowerCase())
  )
  const pinned = filtered.filter((c) => c.pinned)
  const recent = filtered.filter((c) => !c.pinned)

  const handleNewChat = async () => {
    if (isDemoMode()) {
      const id = createConversation()
      setActiveConversation(id)
      onMobileClose?.()
      return
    }
    try {
      const conv = await chatApi.createConversation({ title: '新对话' })
      const { conversations, setActiveConversation: setActive } = useChatStore.getState()
      const newConv = {
        id: conv.id,
        title: conv.title,
        model: conv.model || 'gpt-4o',
        messages: [],
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        pinned: conv.pinned,
      }
      useChatStore.setState({
        conversations: [newConv, ...conversations],
        activeConversationId: conv.id,
        activeAgent: null,
        activeSkillIds: [],
        activeScenario: null,
      })
    } catch (e) {
      console.warn('创建对话失败，降级到本地:', e)
      const id = createConversation()
      setActiveConversation(id)
    }
    onMobileClose?.()
  }

  const startEdit = (id: string, title: string) => {
    setEditingId(id)
    setEditTitle(title)
  }

  const handleSelectConversation = (id: string) => {
    setActiveConversation(id)
    onMobileClose?.() // 移动端选中后关闭抽屉
    // 消息由 ChatPage 的 useEffect 按需加载
  }

  const saveEdit = async (id: string) => {
    if (editTitle.trim()) {
      updateConversation(id, { title: editTitle.trim() })
      if (!isDemoMode()) {
        try { await chatApi.updateConversation(id, { title: editTitle.trim() }) } catch (e) { console.warn('更新标题失败:', e) }
      }
    }
    setEditingId(null)
  }

  // 收起状态只在桌面端显示
  if (collapsed) {
    return (
      <div className="hidden md:flex flex-col h-full w-14 bg-sidebar border-r border-sidebar-border items-center py-3 gap-2">
        <button onClick={onToggle} className="p-2 rounded-lg hover:bg-sidebar-accent transition-colors">
          <ChevronRight className="w-4 h-4 text-sidebar-foreground" />
        </button>
        <Button size="icon" variant="ghost" className="h-9 w-9" onClick={handleNewChat}>
          <Plus className="w-4 h-4" />
        </Button>
        <Separator className="w-8 bg-sidebar-border" />
        {loadingConversations && conversations.length === 0
          ? Array.from({ length: 6 }).map((_, idx) => (
            <div
              key={idx}
              className="h-9 w-9 animate-pulse rounded-lg bg-sidebar-accent/70"
            />
          ))
          : conversations.slice(0, 6).map((c) => (
            <button
              key={c.id}
              onClick={() => handleSelectConversation(c.id)}
              title={c.title}
              className={cn(
                'w-9 h-9 rounded-lg flex items-center justify-center text-sm transition-colors',
                activeConversationId === c.id
                  ? 'bg-sidebar-primary text-sidebar-primary-foreground'
                  : 'hover:bg-sidebar-accent text-sidebar-foreground'
              )}
            >
              <MessageSquare className="w-4 h-4" />
            </button>
          ))}
        <div className="flex-1" />
        <Avatar className="w-8 h-8 cursor-pointer" onClick={onOpenSettings}>
          <AvatarFallback className="bg-primary text-primary-foreground text-xs">
            {user?.name?.[0] || 'U'}
          </AvatarFallback>
        </Avatar>
      </div>
    )
  }

  // 侧边栏内容（桌面/移动端共用）
  const sidebarContent = (
    <div className="flex flex-col h-full bg-sidebar">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-sidebar-border">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-white dark:bg-sidebar-accent flex items-center justify-center overflow-hidden border border-border/50 shadow-sm shrink-0">
            <img src="/logo.png" alt="木火智能对话" className="w-full h-full object-cover" />
          </div>
          <span className="font-semibold text-sidebar-foreground text-base tracking-tight">木火智能对话</span>
        </div>
        {/* 桌面端收起按钮（md 及以上显示） */}
        <button
          onClick={onToggle}
          className="p-1.5 rounded-md hover:bg-sidebar-accent transition-colors hidden md:block"
        >
          <ChevronLeft className="w-4 h-4 text-sidebar-foreground" />
        </button>
        {/* 移动端关闭按钮（md 以下显示） */}
        <button
          onClick={onMobileClose}
          className="p-1.5 rounded-md hover:bg-sidebar-accent transition-colors md:hidden"
        >
          <X className="w-4 h-4 text-sidebar-foreground" />
        </button>
      </div>

      {/* New Chat */}
      <div className="p-3">
        <Button onClick={handleNewChat} className="w-full gap-2 justify-start" variant="outline" size="sm">
          <Plus className="w-4 h-4" />
          新建对话
        </Button>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索对话..."
            className="pl-8 h-8 text-xs bg-sidebar-accent border-sidebar-border"
          />
        </div>
      </div>

      {/* 开工场景快捷入口 */}
      <div className="px-3 pb-2">
        <p className="text-[11px] font-semibold text-sidebar-foreground/60 uppercase tracking-wide mb-1.5">开工场景</p>
        <button
          onClick={() => { onNavigate?.('scenarios'); onMobileClose?.() }}
          className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors text-left"
        >
          <span className="flex items-center gap-2">
            <LayoutGrid className="w-4 h-4 text-primary" />
            <span>场景广场</span>
          </span>
          <span className="text-[10px] text-sidebar-foreground/40">浏览全部 →</span>
        </button>
      </div>

      {/* My Skills quick access */}
      {installedSkills.length > 0 && (
        <div className="px-3 pb-2">
          <p className="text-[11px] font-semibold text-sidebar-foreground/60 uppercase tracking-wide mb-1.5">我的技能</p>
          <div className="grid grid-cols-3 gap-1">
            {installedSkills.slice(0, 6).map((skill) => (
              <button
                key={skill.agentId}
                className="flex flex-col items-center gap-0.5 p-1.5 rounded-lg hover:bg-sidebar-accent transition-colors"
                onClick={() => { setActiveSkillIds([skill.agentId]); onMobileClose?.() }}
                title={skill.description}
              >
                <span className="text-lg leading-none">
                  {skill.icon && (skill.icon.startsWith('http://') || skill.icon.startsWith('https://') || skill.icon.startsWith('/api/'))
                    ? <img src={skill.icon} alt="" className="w-5 h-5 object-cover rounded" />
                    : (skill.icon || '🤖')
                  }
                </span>
                <span className="text-[10px] text-sidebar-foreground/70 truncate w-full text-center">{skill.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <Separator className="mx-3 bg-sidebar-border" />

      {/* Conversation List */}
      <ScrollArea className="flex-1 px-2 py-2">
        {loadingConversations && conversations.length === 0 ? (
          <ConversationListSkeleton />
        ) : (
          <div className="animate-in fade-in-50 duration-200">
            {pinned.length > 0 && (
              <>
                <p className="text-[11px] font-semibold text-sidebar-foreground/60 uppercase tracking-wide px-2 mb-1">置顶</p>
                {pinned.map((c) => (
                  <ConvItem
                    key={c.id} conv={c} active={activeConversationId === c.id}
                    onSelect={handleSelectConversation} onDelete={deleteConversation}
                    onPin={updateConversation} editingId={editingId} editTitle={editTitle}
                    setEditTitle={setEditTitle} startEdit={startEdit} saveEdit={saveEdit}
                  />
                ))}
                <Separator className="my-2 bg-sidebar-border" />
              </>
            )}
            {recent.length > 0 ? (
              <>
                <p className="text-[11px] font-semibold text-sidebar-foreground/60 uppercase tracking-wide px-2 mb-1">最近对话</p>
                {recent.map((c) => (
                  <ConvItem
                    key={c.id} conv={c} active={activeConversationId === c.id}
                    onSelect={handleSelectConversation} onDelete={deleteConversation}
                    onPin={updateConversation} editingId={editingId} editTitle={editTitle}
                    setEditTitle={setEditTitle} startEdit={startEdit} saveEdit={saveEdit}
                  />
                ))}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-32 text-center">
                <Sparkles className="w-8 h-8 text-muted-foreground/40 mb-2" />
                <p className="text-xs text-muted-foreground">还没有对话记录</p>
                <p className="text-xs text-muted-foreground">点击"新建对话"开始</p>
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      {/* User footer */}
      <div className="p-3 border-t border-sidebar-border">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 w-full p-2 rounded-lg hover:bg-sidebar-accent transition-colors text-left">
              <Avatar className="w-7 h-7 shrink-0">
                <AvatarFallback className="bg-primary text-primary-foreground text-xs font-medium">
                  {user?.name?.[0] || 'U'}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-sidebar-foreground truncate">{user?.name}</p>
                <p className="text-xs text-sidebar-foreground/60 truncate">{user?.plan === 'free' ? '免费版' : user?.plan === 'pro' ? 'Pro 版' : '企业版'}</p>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-52">
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium">{user?.name}</p>
              <p className="text-xs text-muted-foreground">{user?.email}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => { onOpenSettings(); onMobileClose?.() }}>
              <Settings className="w-4 h-4" />设置
            </DropdownMenuItem>
            {user?.role === 'admin' && (
              <DropdownMenuItem onClick={() => { onOpenAdmin(); onMobileClose?.() }}>
                <Shield className="w-4 h-4" />管理后台
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout} className="text-destructive">
              <LogOut className="w-4 h-4" />退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )

  return (
    <>
      {/* 桌面端：固定侧边栏，仅在 md 及以上显示 */}
      <div className="hidden md:flex flex-col h-full w-64 border-r border-sidebar-border shrink-0">
        {sidebarContent}
      </div>

      {/* 移动端：抽屉覆盖层，仅在 md 以下显示 */}
      {/* 遮罩 */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={onMobileClose}
        />
      )}
      {/* 抽屉面板 */}
      <div
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-72 shadow-xl md:hidden transition-transform duration-300',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {sidebarContent}
      </div>
    </>
  )
}

function ConversationListSkeleton() {
  return (
    <div className="space-y-2 px-2 py-1" aria-label="正在加载对话列表">
      <div className="mb-2 h-3 w-16 animate-pulse rounded bg-sidebar-accent/70" />
      {Array.from({ length: 8 }).map((_, idx) => (
        <div key={idx} className="flex items-center gap-2 rounded-lg px-2 py-2">
          <div className="h-3.5 w-3.5 shrink-0 animate-pulse rounded bg-sidebar-accent/80" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-[80%] animate-pulse rounded bg-sidebar-accent/80" />
            <div className="h-2.5 w-[45%] animate-pulse rounded bg-sidebar-accent/50" />
          </div>
        </div>
      ))}
    </div>
  )
}

// Conversation list item
function ConvItem({
  conv, active, onSelect, onDelete, onPin, editingId, editTitle, setEditTitle, startEdit, saveEdit,
}: {
  conv: { id: string; title: string; messages: { content: string }[]; updatedAt: string; pinned?: boolean }
  active: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onPin: (id: string, updates: { pinned: boolean }) => void
  editingId: string | null
  editTitle: string
  setEditTitle: (v: string) => void
  startEdit: (id: string, title: string) => void
  saveEdit: (id: string) => void
}) {
  return (
    <div className={cn(
      'group relative flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors mb-0.5',
      active ? 'bg-sidebar-accent text-sidebar-foreground' : 'hover:bg-sidebar-accent/60 text-sidebar-foreground/80'
    )}>
      <MessageSquare className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0" onClick={() => onSelect(conv.id)}>
        {editingId === conv.id ? (
          <input
            autoFocus
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={() => saveEdit(conv.id)}
            onKeyDown={(e) => e.key === 'Enter' && saveEdit(conv.id)}
            className="w-full text-xs bg-background border rounded px-1 py-0.5 outline-none focus:ring-1 focus:ring-ring"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <p className="text-xs font-medium truncate">{truncate(conv.title, 24)}</p>
            <p className="text-[10px] text-muted-foreground">{formatDate(conv.updatedAt)}</p>
          </>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              'p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted',
              active && 'opacity-100'
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => startEdit(conv.id, conv.title)}>
            <Edit3 className="w-4 h-4" />重命名
          </DropdownMenuItem>
          <DropdownMenuItem onClick={async () => {
            onPin(conv.id, { pinned: !conv.pinned })
            if (!isDemoMode()) { try { await chatApi.togglePin(conv.id) } catch {} }
          }}>
            <Pin className="w-4 h-4" />{conv.pinned ? '取消置顶' : '置顶'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={async () => {
            onDelete(conv.id)
            if (!isDemoMode()) { try { await chatApi.deleteConversation(conv.id) } catch {} }
          }} className="text-destructive">
            <Trash2 className="w-4 h-4" />删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
