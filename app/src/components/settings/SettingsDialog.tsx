import { useEffect, useState } from 'react'
import { useAuthStore, useThemeStore, ThemeColor } from '@/store'
import { authApi, notificationApi, userApiKeyApi, type PrivacySettingVO, type UserApiKeyVO } from '@/lib/api'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import ModelPreferencesTab from './ModelPreferencesTab'
import {
  Bell,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  Monitor,
  Moon,
  Palette,
  Save,
  Shield,
  SlidersHorizontal,
  Sun,
  Trash2,
  User,
} from 'lucide-react'
import { toast } from 'sonner'

const NOTIF_KEY = 'user-notifications'

type NotificationPrefs = {
  taskComplete: boolean
  operationApproval: boolean
  systemAnnouncement: boolean
  usageWarning: boolean
}

const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  taskComplete: true,
  operationApproval: true,
  systemAnnouncement: true,
  usageWarning: true,
}

const THEME_COLORS: { id: ThemeColor; label: string; color: string }[] = [
  { id: 'blue', label: '默认蓝', color: '#3b82f6' },
  { id: 'green', label: '清新绿', color: '#22c55e' },
  { id: 'purple', label: '优雅紫', color: '#a855f7' },
  { id: 'orange', label: '活力橙', color: '#f97316' },
  { id: 'rose', label: '玫瑰红', color: '#f43f5e' },
]

function loadNotificationPrefs(): NotificationPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTIF_KEY) || '{}')
    return { ...DEFAULT_NOTIFICATION_PREFS, ...raw }
  } catch {
    return DEFAULT_NOTIFICATION_PREFS
  }
}

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  onOpenSubscription?: () => void
}

export default function SettingsDialog({ open, onClose, onOpenSubscription }: SettingsDialogProps) {
  const { user, logout, updateUser } = useAuthStore()
  const { mode, color, setMode, setColor, setCustomCss } = useThemeStore()
  const [nameInput, setNameInput] = useState(user?.name || '')
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileMsg, setProfileMsg] = useState('')
  const [notifPrefs, setNotifPrefs] = useState<NotificationPrefs>(loadNotificationPrefs)
  const [privacySettings, setPrivacySettings] = useState<PrivacySettingVO | null>(null)
  const [privacyLoading, setPrivacyLoading] = useState(false)
  const [privacySaving, setPrivacySaving] = useState(false)
  const [apiKeyInfo, setApiKeyInfo] = useState<UserApiKeyVO | null>(null)
  const [newApiKey, setNewApiKey] = useState('')
  const [apiKeyLoading, setApiKeyLoading] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'success' | 'error'>('idle')

  useEffect(() => {
    if (!open) return
    setNameInput(user?.name || '')
    setProfileMsg('')
    authApi.getMe().then(u => {
      updateUser({
        tokensUsed: u.tokensUsed,
        tokensLimit: u.tokensLimit,
        costUsed: u.costUsed,
        costLimit: u.costLimit,
        plan: u.plan,
        modelLimit: (u as any).modelLimit,
      })
    }).catch(() => undefined)

    setPrivacyLoading(true)
    notificationApi.getPrivacySettings()
      .then(settings => setPrivacySettings(settings))
      .catch(() => setPrivacySettings({ saveHistory: true, dataImprovement: false, twoFactorAuth: false }))
      .finally(() => setPrivacyLoading(false))

    setNewApiKey('')
    setApiKeyLoading(true)
    userApiKeyApi.current()
      .then(key => setApiKeyInfo(key))
      .catch(() => setApiKeyInfo(null))
      .finally(() => setApiKeyLoading(false))
  }, [open, user?.name, updateUser])

  const handleSaveProfile = async () => {
    if (!nameInput.trim()) return
    setSavingProfile(true)
    setProfileMsg('')
    try {
      const updated = await authApi.updateProfile(nameInput.trim())
      updateUser({ name: (updated as any).name || nameInput.trim() })
      setProfileMsg('保存成功')
      setTimeout(() => setProfileMsg(''), 2000)
    } catch (e: any) {
      setProfileMsg(e.message || '保存失败')
    } finally {
      setSavingProfile(false)
    }
  }

  const toggleNotif = (key: keyof NotificationPrefs) => {
    const next = { ...notifPrefs, [key]: !notifPrefs[key] }
    setNotifPrefs(next)
    localStorage.setItem(NOTIF_KEY, JSON.stringify(next))
  }

  const togglePrivacy = async (field: keyof PrivacySettingVO) => {
    if (!privacySettings || privacySaving) return
    const previous = privacySettings
    const updated = { ...privacySettings, [field]: !privacySettings[field] }
    setPrivacySettings(updated)
    setPrivacySaving(true)
    try {
      setPrivacySettings(await notificationApi.updatePrivacySettings({ [field]: updated[field] }))
    } catch (e: any) {
      setPrivacySettings(previous)
      toast.error(e.message || '保存失败')
    } finally {
      setPrivacySaving(false)
    }
  }

  const regenerateApiKey = async () => {
    if (apiKeyInfo && !window.confirm('重新生成后，旧 API Key 会立即失效。确定继续吗？')) return
    setApiKeyLoading(true)
    try {
      const resp = await userApiKeyApi.regenerate()
      setApiKeyInfo(resp.apiKey)
      setNewApiKey(resp.key)
      toast.success('API Key 已生成，请立即复制保存')
    } catch (e: any) {
      toast.error(e.message || '生成 API Key 失败')
    } finally {
      setApiKeyLoading(false)
    }
  }

  const revokeApiKey = async () => {
    if (!apiKeyInfo || !window.confirm('撤销后，外部程序将无法继续使用当前 API Key。确定撤销吗？')) return
    setApiKeyLoading(true)
    try {
      await userApiKeyApi.revoke()
      setApiKeyInfo(null)
      setNewApiKey('')
      toast.success('API Key 已撤销')
    } catch (e: any) {
      toast.error(e.message || '撤销 API Key 失败')
    } finally {
      setApiKeyLoading(false)
    }
  }

  const copyApiKey = async () => {
    if (!newApiKey) return
    try {
      await copyText(newApiKey)
      setCopyState('success')
      toast.success('API Key 已复制')
    } catch {
      setCopyState('error')
      toast.error('复制失败，请手动选择复制')
    } finally {
      window.setTimeout(() => setCopyState('idle'), 1400)
    }
  }

  const costUsed = Number(user?.costUsed ?? 0)
  const costLimit = Number(user?.costLimit ?? 0)
  const costPercent = costLimit > 0 ? Math.min(Math.round((costUsed / costLimit) * 100), 100) : 0

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col p-0">
        <DialogHeader className="px-6 py-4 border-b shrink-0">
          <DialogTitle>设置</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="appearance" className="flex-1 flex overflow-hidden">
          <TabsList className="flex-col h-full w-44 rounded-none border-r bg-muted/30 p-2 justify-start gap-1">
            {[
              { value: 'appearance', icon: Palette, label: '外观' },
              { value: 'account', icon: User, label: '账号' },
              { value: 'preferences', icon: SlidersHorizontal, label: '模型偏好' },
              { value: 'api-key', icon: KeyRound, label: 'API Key' },
              { value: 'notifications', icon: Bell, label: '通知' },
              { value: 'privacy', icon: Shield, label: '隐私' },
            ].map(({ value, icon: Icon, label }) => (
              <TabsTrigger key={value} value={value} className="w-full justify-start gap-2 data-[state=active]:bg-background data-[state=active]:shadow-sm">
                <Icon className="w-4 h-4" />{label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="appearance" className="flex-1 overflow-y-auto p-6 mt-0 space-y-8">
            <section>
              <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><Monitor className="w-4 h-4 text-primary" />颜色模式</h3>
              <div className="grid grid-cols-3 gap-3">
                {([{ value: 'light', icon: Sun, label: '浅色' }, { value: 'dark', icon: Moon, label: '深色' }, { value: 'system', icon: Monitor, label: '跟随系统' }] as const).map(({ value, icon: Icon, label }) => (
                  <button key={value} onClick={() => setMode(value)} className={cn('flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all', mode === value ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40')}>
                    <Icon className={cn('w-5 h-5', mode === value ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="text-xs font-medium">{label}</span>
                    {mode === value && <Check className="w-3.5 h-3.5 text-primary" />}
                  </button>
                ))}
              </div>
            </section>
            <Separator />
            <section>
              <h3 className="text-sm font-semibold mb-4">主题颜色</h3>
              <div className="grid grid-cols-3 gap-3">
                {THEME_COLORS.map(theme => (
                  <button key={theme.id} onClick={() => { setColor(theme.id); setCustomCss('') }} className={cn('flex items-center gap-3 p-3 rounded-xl border-2 transition-all', color === theme.id ? 'border-primary' : 'border-border hover:border-muted-foreground/50')}>
                    <div className="w-6 h-6 rounded-full shrink-0" style={{ background: theme.color }} />
                    <span className="text-sm font-medium">{theme.label}</span>
                    {color === theme.id && <Check className="w-4 h-4 text-primary ml-auto" />}
                  </button>
                ))}
              </div>
            </section>
          </TabsContent>

          <TabsContent value="account" className="flex-1 overflow-y-auto p-6 mt-0 space-y-6">
            <section>
              <h3 className="text-sm font-semibold mb-4">个人信息</h3>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>用户名</Label>
                  <Input value={nameInput} onChange={e => setNameInput(e.target.value)} placeholder="输入用户名" />
                </div>
                <div className="space-y-2">
                  <Label>邮箱</Label>
                  <Input value={user?.email || ''} disabled className="bg-muted" />
                </div>
                <div className="flex items-center gap-3">
                  <Button size="sm" className="gap-1.5" onClick={handleSaveProfile} disabled={savingProfile || !nameInput.trim() || nameInput === user?.name}>
                    {savingProfile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    保存修改
                  </Button>
                  {profileMsg && <span className={cn('text-xs', profileMsg.includes('成功') ? 'text-green-500' : 'text-destructive')}>{profileMsg}</span>}
                </div>
              </div>
            </section>
            <Separator />
            <section>
              <h3 className="text-sm font-semibold mb-4">订阅与用量</h3>
              <div className="p-4 rounded-xl border bg-muted/30 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">当前套餐</p>
                    <p className="text-xs text-muted-foreground">每月重置消费额度</p>
                  </div>
                  <Badge variant="default">{user?.plan === 'free' ? '免费版' : user?.plan === 'pro' ? 'Pro' : '企业版'}</Badge>
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">消费额度</span>
                    <span className="font-medium">¥{costUsed.toFixed(4)} / {costLimit > 0 ? `¥${costLimit.toFixed(2)}` : '不限'}</span>
                  </div>
                  <Progress value={costPercent} className={cn(costPercent > 80 && '[&>div]:bg-orange-500')} />
                </div>
              </div>
              <Button className="mt-3 gap-1.5" size="sm" onClick={() => { onClose(); onOpenSubscription?.() }}>
                <ChevronRight className="w-3.5 h-3.5" />查看所有套餐
              </Button>
            </section>
            <Separator />
            <section>
              <h3 className="text-sm font-semibold mb-4 text-destructive">危险区域</h3>
              <Button variant="outline" size="sm" onClick={logout} className="border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground">
                退出登录
              </Button>
            </section>
          </TabsContent>

          <TabsContent value="notifications" className="flex-1 overflow-y-auto p-6 mt-0">
            <h3 className="text-sm font-semibold mb-1">通知偏好</h3>
            <p className="text-xs text-muted-foreground mb-4">
              通知消息可通过左侧导航栏的铃铛图标查看，以下设置控制浏览器通知行为。
            </p>
            <div className="space-y-1">
              {[
                { key: 'taskComplete' as const, label: '任务完成通知', desc: '任务执行完成、失败或停止时通知。' },
                { key: 'operationApproval' as const, label: '操作审批通知', desc: '自动批准不通过、必须手动点击批准时通知。' },
                { key: 'systemAnnouncement' as const, label: '系统公告', desc: '接收平台更新和公告。' },
                { key: 'usageWarning' as const, label: '用量警告', desc: '消费额度超过 80% 时提醒。' },
              ].map(({ key, label, desc }) => (
                <div key={key} className="flex items-center justify-between py-3 border-b last:border-0">
                  <div><p className="text-sm font-medium">{label}</p><p className="text-xs text-muted-foreground">{desc}</p></div>
                  <Switch checked={notifPrefs[key]} onCheckedChange={() => toggleNotif(key)} />
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="api-key" className="flex-1 overflow-y-auto p-6 mt-0 space-y-5">
            <div>
              <h3 className="text-sm font-semibold mb-1">OpenAI 兼容 API Key</h3>
              <p className="text-xs text-muted-foreground">
                用于外部程序按 OpenAI 官方格式调用模型接口。每个账号仅保留一个有效 API Key，重新生成后旧 Key 立即失效。
              </p>
            </div>

            <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">当前 Key</p>
                  <p className="text-xs text-muted-foreground">
                    {apiKeyLoading
                      ? '加载中...'
                      : apiKeyInfo
                        ? `${apiKeyInfo.keyPrefix} · ${apiKeyInfo.expiresAt ? `有效至 ${apiKeyInfo.expiresAt}` : '永久有效'}`
                        : '尚未生成'}
                  </p>
                  {apiKeyInfo?.lastUsedAt && (
                    <p className="text-xs text-muted-foreground mt-1">最近使用：{apiKeyInfo.lastUsedAt}</p>
                  )}
                </div>
                <Badge variant={apiKeyInfo ? 'default' : 'secondary'}>{apiKeyInfo ? '已启用' : '未生成'}</Badge>
              </div>

              {newApiKey && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
                  <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                    这是唯一一次显示完整 API Key，请立即复制保存。
                  </p>
                  <div className="flex items-center gap-2">
                    <Input value={newApiKey} readOnly className="font-mono text-xs" />
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      onClick={copyApiKey}
                      className={cn(
                        'transition-all duration-200',
                        copyState === 'success' && 'scale-105 border-emerald-500 bg-emerald-500/10 text-emerald-600 shadow-sm shadow-emerald-500/20',
                        copyState === 'error' && 'scale-105 border-destructive bg-destructive/10 text-destructive shadow-sm shadow-destructive/20'
                      )}
                    >
                      {copyState === 'success' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
              )}

              <div className="rounded-md bg-background p-3 text-xs text-muted-foreground space-y-1">
                <p>Base URL: <span className="font-mono">{window.location.origin}/v1</span></p>
                <p>Chat: <span className="font-mono">POST /v1/chat/completions</span></p>
                <p>Responses: <span className="font-mono">POST /v1/responses</span></p>
                <p>Balance: <span className="font-mono">GET /v1/balance</span></p>
                <p>Audio/Image: <span className="font-mono">/v1/audio/*</span>、<span className="font-mono">/v1/images/generations</span></p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={regenerateApiKey} disabled={apiKeyLoading}>
                  {apiKeyLoading ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5 mr-1.5" />}
                  {apiKeyInfo ? '重新生成' : '生成 API Key'}
                </Button>
                {apiKeyInfo && (
                  <Button type="button" size="sm" variant="outline" className="text-destructive" onClick={revokeApiKey} disabled={apiKeyLoading}>
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />撤销
                  </Button>
                )}
                <Button type="button" size="sm" variant="outline" onClick={() => window.open('/api-docs', '_blank', 'noopener,noreferrer')}>
                  <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                  API 文档
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="privacy" className="flex-1 overflow-y-auto p-6 mt-0">
            <h3 className="text-sm font-semibold mb-1">隐私与安全</h3>
            <p className="text-xs text-muted-foreground mb-4">
              设置同步到云端，更换设备后保持一致。{privacySaving && <span className="text-primary ml-1">保存中...</span>}
            </p>
            {privacyLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : privacySettings ? (
              <div className="space-y-1">
                {([
                  { field: 'saveHistory' as const, label: '保存对话历史', desc: '在云端保存聊天记录。' },
                  { field: 'dataImprovement' as const, label: '数据用于改进', desc: '允许使用匿名数据改进服务质量。' },
                  { field: 'twoFactorAuth' as const, label: '两步验证', desc: '登录时需要邮箱验证码。' },
                ]).map(({ field, label, desc }) => (
                  <div key={field} className="flex items-center justify-between py-3 border-b last:border-0">
                    <div><p className="text-sm font-medium">{label}</p><p className="text-xs text-muted-foreground">{desc}</p></div>
                    <Switch checked={!!privacySettings[field]} onCheckedChange={() => togglePrivacy(field)} disabled={privacySaving} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-4">加载隐私设置失败，请稍后重试</p>
            )}
          </TabsContent>

          <TabsContent value="preferences" className="flex-1 overflow-y-auto p-6 mt-0">
            <ModelPreferencesTab />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
