import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { notificationApi, type UserNotificationVO } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Bell, CheckCheck, BellOff, Info, AlertCircle, CheckCircle2, Megaphone, X, Loader2 } from 'lucide-react'

interface NotificationBellProps {
  compact?: boolean
  onOpen?: () => void
}

type ReadTab = 'unread' | 'read'

const PAGE_SIZE = 10

const TYPE_CONFIG: Record<string, { icon: typeof Info; color: string; bg: string }> = {
  announcement: { icon: Megaphone, color: 'text-blue-500', bg: 'bg-blue-500/10' },
  skill_review: { icon: CheckCircle2, color: 'text-green-500', bg: 'bg-green-500/10' },
  system: { icon: Info, color: 'text-purple-500', bg: 'bg-purple-500/10' },
  warning: { icon: AlertCircle, color: 'text-orange-500', bg: 'bg-orange-500/10' },
  default: { icon: Bell, color: 'text-muted-foreground', bg: 'bg-muted' },
}

function getTypeConfig(type: string) {
  return TYPE_CONFIG[type] || TYPE_CONFIG.default
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days < 7) return `${days} 天前`
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

export default function NotificationBell({ compact = false, onOpen }: NotificationBellProps) {
  const [unreadCount, setUnreadCount] = useState(0)
  const [notifications, setNotifications] = useState<UserNotificationVO[]>([])
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<ReadTab>('unread')
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await notificationApi.getUnreadCount()
      setUnreadCount(res.count)
    } catch {
      // ignore anonymous/session-expired polling errors
    }
  }, [])

  const fetchNotifications = useCallback(async (nextPage = 1, append = false, nextTab: ReadTab = tab) => {
    append ? setLoadingMore(true) : setLoading(true)
    try {
      const res = await notificationApi.listPaged(nextPage, PAGE_SIZE, nextTab === 'read')
      setNotifications(prev => append ? [...prev, ...res.list] : res.list)
      setPage(res.page)
      setHasMore(Boolean(res.hasMore))
    } catch {
      if (!append) setNotifications([])
      setHasMore(false)
    } finally {
      append ? setLoadingMore(false) : setLoading(false)
    }
  }, [tab])

  useEffect(() => {
    fetchUnreadCount()
    const timer = window.setInterval(fetchUnreadCount, 30000)
    return () => window.clearInterval(timer)
  }, [fetchUnreadCount])

  useEffect(() => {
    if (!open) return
    onOpen?.()
    fetchNotifications(1, false, tab)
  }, [open, tab, onOpen, fetchNotifications])

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])

  const handleScroll = () => {
    const el = listRef.current
    if (!el || loading || loadingMore || !hasMore) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
      fetchNotifications(page + 1, true, tab)
    }
  }

  const handleMarkRead = async (notif: UserNotificationVO) => {
    if (notif.isRead) return
    try {
      await notificationApi.markAsRead(notif.id)
      setUnreadCount(prev => Math.max(0, prev - 1))
      setNotifications(prev => tab === 'unread'
        ? prev.filter(n => n.id !== notif.id)
        : prev.map(n => n.id === notif.id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n))
      fetchUnreadCount()
    } catch {
      // keep current UI if backend rejects the state change
    }
  }

  const handleMarkAllRead = async () => {
    if (unreadCount === 0) return
    try {
      await notificationApi.markAllAsRead()
      setUnreadCount(0)
      if (tab === 'unread') {
        setNotifications([])
        setHasMore(false)
      } else {
        fetchNotifications(1, false, tab)
      }
    } catch {
      // ignore
    }
  }

  const button = (
    <button
      ref={buttonRef}
      onClick={() => setOpen(v => !v)}
      className={compact
        ? 'w-10 h-10 rounded-xl flex items-center justify-center transition-all text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground relative'
        : 'relative p-2 rounded-lg hover:bg-muted transition-colors'
      }
      title="通知"
    >
      <Bell className="w-5 h-5" />
      {unreadCount > 0 && (
        <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center leading-none">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  )

  const panelContent = (
    <div
      ref={panelRef}
      className={cn(
        'fixed left-1/2 top-3 z-[99999] flex max-h-[min(82vh,720px)] w-[min(720px,calc(100vw-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl'
      )}
    >
      <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
        <div className="flex items-center gap-2">
          <Bell className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">通知</span>
          {unreadCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {unreadCount > 0 && (
            <button
              onClick={handleMarkAllRead}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-primary hover:bg-primary/10"
            >
              <CheckCheck className="w-3.5 h-3.5" />全部已读
            </button>
          )}
          <button onClick={() => setOpen(false)} className="p-1 rounded-full hover:bg-muted transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1 border-b bg-muted/30 p-2 shrink-0">
        <button
          onClick={() => setTab('unread')}
          className={cn('rounded-lg px-3 py-2 text-sm font-medium transition-colors', tab === 'unread' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:bg-background/70')}
        >
          未读
        </button>
        <button
          onClick={() => setTab('read')}
          className={cn('rounded-lg px-3 py-2 text-sm font-medium transition-colors', tab === 'read' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:bg-background/70')}
        >
          已读
        </button>
      </div>

      <div ref={listRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />加载中...
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <BellOff className="w-8 h-8 mb-2 opacity-50" />
            <span className="text-sm">{tab === 'unread' ? '暂无未读通知' : '暂无已读通知'}</span>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {notifications.map((notif) => {
              const config = getTypeConfig(notif.type)
              const Icon = config.icon
              return (
                <button
                  key={notif.id}
                  onClick={() => handleMarkRead(notif)}
                  className={cn(
                    'w-full flex items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50',
                    !notif.isRead && 'bg-primary/5'
                  )}
                >
                  <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0', config.bg)}>
                    <Icon className={cn('w-4 h-4', config.color)} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className={cn('text-sm leading-snug', !notif.isRead ? 'font-semibold' : 'font-medium text-muted-foreground')}>
                        {notif.title}
                      </span>
                      {!notif.isRead && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-500" />}
                    </div>
                    {notif.content && (
                      <p className="mt-1 line-clamp-4 text-xs leading-relaxed text-muted-foreground">
                        {notif.content}
                      </p>
                    )}
                    <span className="mt-1 block text-[10px] text-muted-foreground/70">
                      {formatTime(notif.createdAt)}
                    </span>
                  </div>
                </button>
              )
            })}
            {loadingMore && (
              <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />加载更多...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )

  return (
    <div className="relative">
      {button}
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[99998] bg-black/20 backdrop-blur-[1px]" onClick={() => setOpen(false)} />
          {panelContent}
        </>,
        document.body
      )}
    </div>
  )
}
