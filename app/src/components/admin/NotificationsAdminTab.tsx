import { useState, useEffect, useCallback } from 'react'
import { notificationApi, type NotificationAdminVO } from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import {
  Plus, Search, RefreshCw, Edit, Trash2, Bell, Megaphone, CheckCircle2, Info,
  ChevronLeft, ChevronRight, Loader2, Users, Globe,
} from 'lucide-react'

const TYPE_OPTIONS = [
  { value: 'announcement', label: '系统公告', icon: Megaphone, color: 'text-blue-500' },
  { value: 'skill_review', label: '技能审核', icon: CheckCircle2, color: 'text-green-500' },
  { value: 'system', label: '系统通知', icon: Info, color: 'text-purple-500' },
]

const STATUS_OPTIONS = [
  { value: 'draft', label: '草稿', variant: 'secondary' as const },
  { value: 'published', label: '已发布', variant: 'default' as const },
]

function getTypeLabel(type: string): string {
  return TYPE_OPTIONS.find(t => t.value === type)?.label || type
}

function getStatusLabel(status: string): string {
  return STATUS_OPTIONS.find(s => s.value === status)?.label || status
}

function getTypeIcon(type: string) {
  return TYPE_OPTIONS.find(t => t.value === type)?.icon || Bell
}

export default function NotificationsAdminTab() {
  const [notifications, setNotifications] = useState<NotificationAdminVO[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [size] = useState(10)
  const [filterType, setFilterType] = useState<string>('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [editingNotif, setEditingNotif] = useState<NotificationAdminVO | null>(null)
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  const fetchList = useCallback(async () => {
    setLoading(true)
    try {
      const res = await notificationApi.adminList(page, size, filterType || undefined, filterStatus || undefined)
      setNotifications(res.list || [])
      setTotal(res.total)
    } catch {
      // toast handled by request()
    } finally {
      setLoading(false)
    }
  }, [page, size, filterType, filterStatus])

  useEffect(() => {
    fetchList()
  }, [fetchList])

  const handleFilterChange = () => {
    setPage(1)
    fetchList()
  }

  const handleSave = async (data: SaveFormData) => {
    try {
      if (editingNotif) {
        await notificationApi.adminUpdate(editingNotif.id, {
          title: data.title,
          content: data.content,
          type: data.type,
          targetType: data.targetType,
          targetUserIds: data.targetType === 'specific' ? parseUserIds(data.targetUserIdsText) : undefined,
          status: data.status,
        })
      } else {
        await notificationApi.adminCreate({
          title: data.title,
          content: data.content,
          type: data.type,
          targetType: data.targetType,
          targetUserIds: data.targetType === 'specific' ? parseUserIds(data.targetUserIdsText) : undefined,
        })
      }
      setShowEditDialog(false)
      setEditingNotif(null)
      fetchList()
    } catch {
      // toast handled by request()
    }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    setDeleteLoading(true)
    try {
      await notificationApi.adminDelete(deleteId)
      setDeleteId(null)
      fetchList()
    } catch {
      // toast handled by request()
    } finally {
      setDeleteLoading(false)
    }
  }

  const totalPages = Math.ceil(total / size)

  return (
    <div className="space-y-4">
      {/* 工具栏 */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={filterType} onValueChange={(v) => { setFilterType(v === 'all' ? '' : v); handleFilterChange() }}>
            <SelectTrigger className="w-32 h-9">
              <SelectValue placeholder="全部类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              {TYPE_OPTIONS.map(t => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={filterStatus} onValueChange={(v) => { setFilterStatus(v === 'all' ? '' : v); handleFilterChange() }}>
            <SelectTrigger className="w-32 h-9">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              {STATUS_OPTIONS.map(s => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button variant="outline" size="sm" className="gap-1.5 h-9" onClick={fetchList} disabled={loading}>
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />刷新
          </Button>
        </div>

        <Button size="sm" className="gap-1.5 h-9" onClick={() => { setEditingNotif(null); setShowEditDialog(true) }}>
          <Plus className="w-4 h-4" />创建通知
        </Button>
      </div>

      {/* 列表 */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : notifications.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Bell className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">暂无通知记录</p>
        </div>
      ) : (
        <>
          <div className="rounded-lg border divide-y">
            {notifications.map((notif) => {
              const TypeIcon = getTypeIcon(notif.type)
              return (
                <div key={notif.id} className="flex items-start gap-3 p-4 hover:bg-muted/30 transition-colors">
                  {/* 类型图标 */}
                  <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                    <TypeIcon className={cn('w-4 h-4', getTypeIcon(notif.type) === Megaphone ? 'text-blue-500' : getTypeIcon(notif.type) === CheckCircle2 ? 'text-green-500' : 'text-purple-500')} />
                  </div>

                  {/* 内容 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{notif.title}</span>
                      <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                        {getTypeLabel(notif.type)}
                      </Badge>
                      <Badge variant={notif.status === 'published' ? 'default' : 'secondary'} className="text-[10px] py-0 px-1.5">
                        {getStatusLabel(notif.status)}
                      </Badge>
                    </div>
                    {notif.content && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{notif.content}</p>
                    )}
                    <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        {notif.targetType === 'all' ? <Globe className="w-3 h-3" /> : <Users className="w-3 h-3" />}
                        {notif.targetType === 'all' ? '全体用户' : `指定用户(${notif.targetUserIds?.length || 0})`}
                      </span>
                      {notif.totalRecipients != null && notif.totalRecipients > 0 && (
                        <span>送达 {notif.totalRecipients}</span>
                      )}
                      {notif.totalRead != null && notif.totalRead > 0 && (
                        <span>已读 {notif.totalRead}</span>
                      )}
                      <span>{formatDate(notif.createdAt)}</span>
                    </div>
                  </div>

                  {/* 操作 */}
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="w-8 h-8"
                      onClick={() => { setEditingNotif(notif); setShowEditDialog(true) }}
                    >
                      <Edit className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="w-8 h-8 text-destructive hover:text-destructive"
                      onClick={() => setDeleteId(notif.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>

          {/* 分页 */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                共 {total} 条，第 {page}/{totalPages} 页
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage(p => p + 1)}
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* 创建/编辑对话框 */}
      {showEditDialog && (
        <EditNotificationDialog
          notification={editingNotif}
          onClose={() => { setShowEditDialog(false); setEditingNotif(null) }}
          onSave={handleSave}
        />
      )}

      {/* 删除确认 */}
      <Dialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-destructive" />
              确认删除
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            确定要删除这条通知吗？删除后不可恢复，已发送给用户的通知记录也会被清除。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>取消</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteLoading}>
              {deleteLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── 辅助函数 ─────────────────────────────────────
function parseUserIds(text: string): number[] {
  return text.split(/[,\s\n]+/).map(s => s.trim()).filter(Boolean).map(Number).filter(n => !isNaN(n) && n > 0)
}

// ─── 编辑/创建对话框 ─────────────────────────────────────
interface SaveFormData {
  title: string
  content: string
  type: string
  targetType: string
  targetUserIdsText: string
  status: string
}

function EditNotificationDialog({
  notification,
  onClose,
  onSave,
}: {
  notification: NotificationAdminVO | null
  onClose: () => void
  onSave: (data: SaveFormData) => Promise<void>
}) {
  const [title, setTitle] = useState(notification?.title || '')
  const [content, setContent] = useState(notification?.content || '')
  const [type, setType] = useState(notification?.type || 'announcement')
  const [targetType, setTargetType] = useState(notification?.targetType || 'all')
  const [targetUserIdsText, setTargetUserIdsText] = useState(
    notification?.targetUserIds?.join(', ') || ''
  )
  const [status, setStatus] = useState(notification?.status || 'published')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!title.trim() || !content.trim()) return
    setSaving(true)
    try {
      await onSave({ title, content, type, targetType, targetUserIdsText, status })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{notification ? '编辑通知' : '创建通知'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* 标题 */}
          <div className="space-y-2">
            <Label>通知标题 <span className="text-destructive">*</span></Label>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="输入通知标题"
              maxLength={100}
            />
          </div>

          {/* 内容 */}
          <div className="space-y-2">
            <Label>通知内容 <span className="text-destructive">*</span></Label>
            <Textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="输入通知内容..."
              rows={4}
              maxLength={2000}
            />
          </div>

          {/* 类型 */}
          <div className="space-y-2">
            <Label>通知类型</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map(t => (
                  <SelectItem key={t.value} value={t.value}>
                    <span className="flex items-center gap-2">
                      <t.icon className={cn('w-3.5 h-3.5', t.color)} />
                      {t.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 投递目标 */}
          <div className="space-y-2">
            <Label>投递目标</Label>
            <Select value={targetType} onValueChange={setTargetType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  <span className="flex items-center gap-2">
                    <Globe className="w-3.5 h-3.5" />全体用户
                  </span>
                </SelectItem>
                <SelectItem value="specific">
                  <span className="flex items-center gap-2">
                    <Users className="w-3.5 h-3.5" />指定用户
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            {targetType === 'specific' && (
              <div className="space-y-1.5">
                <Input
                  value={targetUserIdsText}
                  onChange={e => setTargetUserIdsText(e.target.value)}
                  placeholder="输入用户 ID，用逗号分隔，如: 1, 2, 3"
                />
                <p className="text-xs text-muted-foreground">用户 ID 可在用户管理中查看</p>
              </div>
            )}
          </div>

          {/* 状态（仅编辑时显示） */}
          {notification && (
            <div className="space-y-2">
              <Label>状态</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map(s => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                设为"草稿"后通知不会推送给用户，设为"已发布"会立即推送
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSave} disabled={saving || !title.trim() || !content.trim()}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {notification ? '保存修改' : '创建并发布'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
