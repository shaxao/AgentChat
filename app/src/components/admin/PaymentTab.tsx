import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  CreditCard,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn, formatDate } from '@/lib/utils'
import {
  paymentApi,
  type AuditLogQueryParams,
  type PayAuditLogVO,
  type PayConfigCreateRequest,
  type PayConfigUpdateRequest,
  type PayConfigVO,
  type PaymentRecordVO,
  type PaymentStatsVO,
  type RefundRecordVO,
} from '@/lib/api'

type TabKey = 'configs' | 'records' | 'refunds' | 'audit' | 'stats'

const providerLabels: Record<string, string> = {
  alipay: '支付宝',
  wechat: '微信支付',
  stripe: 'Stripe',
  ldc: 'LDC / Linux DO Credit',
}

const statusLabels: Record<string, string> = {
  pending: '待处理',
  success: '成功',
  failed: '失败',
  processing: '处理中',
  verified: '已验签',
}

export default function PaymentTab() {
  const [activeTab, setActiveTab] = useState<TabKey>('configs')

  const tabs = [
    { id: 'configs' as const, label: '支付配置', icon: Settings },
    { id: 'records' as const, label: '支付记录', icon: CreditCard },
    { id: 'refunds' as const, label: '退款记录', icon: RotateCcw },
    { id: 'audit' as const, label: '审计日志', icon: FileText },
    { id: 'stats' as const, label: '统计概览', icon: BarChart3 },
  ]

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b px-6 py-3">
        <div className="flex flex-wrap gap-1">
          {tabs.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              size="sm"
              variant={activeTab === id ? 'secondary' : 'ghost'}
              onClick={() => setActiveTab(id)}
              className="gap-1.5"
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {activeTab === 'configs' && <ConfigPanel />}
        {activeTab === 'records' && <PaymentRecordsPanel />}
        {activeTab === 'refunds' && <RefundsPanel />}
        {activeTab === 'audit' && <AuditPanel />}
        {activeTab === 'stats' && <StatsPanel />}
      </div>
    </div>
  )
}

function ConfigPanel() {
  const [configs, setConfigs] = useState<PayConfigVO[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<PayConfigVO | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<PayConfigVO | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setConfigs(await paymentApi.getConfigs())
    } catch (e: any) {
      setError(e?.message || '加载支付配置失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const openCreate = () => {
    setEditing(null)
    setDialogOpen(true)
  }

  const openEdit = (config: PayConfigVO) => {
    setEditing(config)
    setDialogOpen(true)
  }

  const remove = async () => {
    if (!deleteTarget) return
    setSaving(true)
    try {
      await paymentApi.deleteConfig(deleteTarget.id)
      setDeleteTarget(null)
      await load()
    } catch (e: any) {
      setError(e?.message || '删除支付配置失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4 p-6">
      <PanelHeader
        title="支付配置"
        desc="配置支付宝、LDC 等支付渠道。密钥仅保存加密后的值，列表只显示是否已配置。"
        action={(
          <>
            <Button size="icon" variant="ghost" onClick={load} disabled={loading}>
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
            <Button size="sm" onClick={openCreate} className="gap-1.5">
              <Plus className="h-4 w-4" />
              新建配置
            </Button>
          </>
        )}
      />

      {error && <ErrorBox message={error} />}

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-muted/50">
            <tr>
              <Th>配置名称</Th>
              <Th>渠道</Th>
              <Th>应用/商户 ID</Th>
              <Th>密钥状态</Th>
              <Th>环境</Th>
              <Th>状态</Th>
              <Th align="right">操作</Th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <LoadingRow colSpan={7} />
            ) : configs.length === 0 ? (
              <EmptyRow colSpan={7} text="暂无支付配置" />
            ) : configs.map(config => (
              <tr key={config.id} className="border-t">
                <Td className="font-medium">
                  {config.name}
                  {config.isDefault === 1 && <Badge className="ml-2 text-[10px]">默认</Badge>}
                </Td>
                <Td>{providerLabels[config.provider] || config.provider}</Td>
                <Td className="font-mono text-xs text-muted-foreground">{config.appId}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <KeyBadge active={config.hasPrivateKey} label="私钥/Secret" />
                    <KeyBadge active={config.hasPublicKey} label="公钥" />
                    <KeyBadge active={config.hasEncryptKey} label="加密密钥" />
                  </div>
                </Td>
                <Td><Badge variant="outline">{config.sandbox === 1 ? '沙箱' : '生产'}</Badge></Td>
                <Td><Badge variant={config.enabled === 1 ? 'default' : 'secondary'}>{config.enabled === 1 ? '启用' : '禁用'}</Badge></Td>
                <Td align="right">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(config)}>编辑</Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleteTarget(config)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfigDialog
        open={dialogOpen}
        editing={editing}
        onOpenChange={setDialogOpen}
        onSaved={load}
      />

      <Dialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>删除支付配置</DialogTitle>
            <DialogDescription>确认删除“{deleteTarget?.name}”？该操作会逻辑删除配置。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>取消</Button>
            <Button variant="destructive" onClick={remove} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ConfigDialog({
  open,
  editing,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  editing: PayConfigVO | null
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  const [provider, setProvider] = useState(editing?.provider || 'alipay')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setProvider(editing?.provider || 'alipay')
      setError('')
    }
  }, [open, editing])

  const defaultNotifyUrl = useMemo(() => {
    const origin = typeof window === 'undefined' ? 'https://your-domain' : window.location.origin
    return `${origin}/api/payment/callback/${provider === 'ldc' ? 'ldc' : 'alipay'}`
  }, [provider])

  const notifyUrlValue = useMemo(() => {
    const saved = editing?.notifyUrl || ''
    if (provider === 'ldc' && (!saved || saved.includes('/callback/alipay'))) {
      return defaultNotifyUrl
    }
    if (provider !== 'ldc' && (!saved || saved.includes('/callback/ldc'))) {
      return defaultNotifyUrl
    }
    return saved || defaultNotifyUrl
  }, [defaultNotifyUrl, editing?.notifyUrl, provider])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    const form = event.currentTarget
    const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null)?.value?.trim() || ''

    const data: PayConfigCreateRequest = {
      provider,
      name: value('name'),
      appId: value('appId'),
      privateKey: value('privateKey'),
      publicKey: value('publicKey'),
      encryptKey: value('encryptKey'),
      notifyUrl: value('notifyUrl'),
      returnUrl: value('returnUrl'),
      sandbox: (form.elements.namedItem('sandbox') as HTMLInputElement).checked ? 1 : 0,
      enabled: (form.elements.namedItem('enabled') as HTMLInputElement).checked ? 1 : 0,
      isDefault: (form.elements.namedItem('isDefault') as HTMLInputElement).checked ? 1 : 0,
      extraConfig: value('extraConfig') || undefined,
    }

    if (!data.name || !data.appId) {
      setError('配置名称和应用/商户 ID 不能为空')
      setSaving(false)
      return
    }
    if (!editing && provider === 'ldc' && !data.encryptKey && !data.privateKey) {
      setError('LDC 需要配置 client secret，建议填入“加密密钥”字段')
      setSaving(false)
      return
    }
    if (editing && provider === 'ldc') {
      const appIdChanged = data.appId !== editing.appId
      const hasNewSecret = !!data.encryptKey || !!data.privateKey
      const hasStoredSecret = !!editing.hasEncryptKey || !!editing.hasPrivateKey
      if ((appIdChanged || !hasStoredSecret) && !hasNewSecret) {
        setError('LDC 修改 PID 或缺少已保存密钥时，必须重新填写 Client Secret')
        setSaving(false)
        return
      }
    }
    if (!editing && provider !== 'ldc' && (!data.privateKey || !data.publicKey)) {
      setError('新建非 LDC 配置时，商户私钥和平台公钥不能为空')
      setSaving(false)
      return
    }

    try {
      if (editing) {
        const update: PayConfigUpdateRequest = {
          name: data.name,
          appId: data.appId,
          notifyUrl: data.notifyUrl,
          returnUrl: data.returnUrl,
          sandbox: data.sandbox,
          enabled: data.enabled,
          isDefault: data.isDefault,
          extraConfig: data.extraConfig,
        }
        if (data.privateKey) update.privateKey = data.privateKey
        if (data.publicKey) update.publicKey = data.publicKey
        if (data.encryptKey) update.encryptKey = data.encryptKey
        await paymentApi.updateConfig(editing.id, update)
      } else {
        await paymentApi.createConfig(data)
      }
      onOpenChange(false)
      await onSaved()
    } catch (e: any) {
      setError(e?.message || '保存支付配置失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑支付配置' : '新建支付配置'}</DialogTitle>
          <DialogDescription>
            LDC 使用 EasyPay 兼容模式：AppID 填 pid，client secret 建议填“加密密钥”，额外配置可填 {"{\"gateway\":\"https://credit.linux.do/epay\"}"}。
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={submit}>
          {error && <ErrorBox message={error} />}
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="支付渠道">
              <Select value={provider} onValueChange={setProvider} disabled={!!editing}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="alipay">支付宝</SelectItem>
                  <SelectItem value="ldc">LDC / Linux DO Credit</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="配置名称">
              <Input name="name" defaultValue={editing?.name || ''} placeholder="例如：LDC 主渠道" />
            </Field>
          </div>

          <Field label={provider === 'ldc' ? 'PID / 商户 ID' : 'AppID'}>
            <Input name="appId" defaultValue={editing?.appId || ''} placeholder={provider === 'ldc' ? 'LDC pid' : '支付宝 AppID'} />
          </Field>

          <Field label={provider === 'ldc' ? 'Client Secret（可填这里或加密密钥）' : '商户私钥'}>
            <Textarea name="privateKey" rows={3} className="font-mono text-xs" placeholder={editing ? '留空表示不修改' : provider === 'ldc' ? 'LDC client secret' : 'RSA2 商户私钥'} />
          </Field>

          {provider !== 'ldc' && (
            <Field label="平台公钥">
              <Textarea name="publicKey" rows={3} className="font-mono text-xs" placeholder={editing ? '留空表示不修改' : '支付宝公钥'} />
            </Field>
          )}

          <Field label={provider === 'ldc' ? 'Client Secret（推荐）' : 'AES 加密密钥'}>
            <Input name="encryptKey" className="font-mono text-xs" placeholder={editing ? '留空表示不修改' : provider === 'ldc' ? 'LDC client secret' : '可选'} />
          </Field>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="异步通知地址">
              <Input key={`notify-${provider}-${editing?.id || 'new'}`} name="notifyUrl" defaultValue={notifyUrlValue} />
            </Field>
            <Field label="同步返回地址">
              <Input name="returnUrl" defaultValue={editing?.returnUrl || `${typeof window === 'undefined' ? 'https://your-domain' : window.location.origin}/payment/return`} />
            </Field>
          </div>

          <Field label="额外配置 JSON">
            <Textarea
              name="extraConfig"
              rows={2}
              className="font-mono text-xs"
              defaultValue={editing?.extraConfig || (provider === 'ldc' ? '{"gateway":"https://credit.linux.do/epay"}' : '')}
            />
          </Field>

          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2"><input name="enabled" type="checkbox" defaultChecked={editing ? editing.enabled === 1 : true} />启用</label>
            <label className="flex items-center gap-2"><input name="isDefault" type="checkbox" defaultChecked={editing ? editing.isDefault === 1 : true} />设为默认</label>
            <label className="flex items-center gap-2"><input name="sandbox" type="checkbox" defaultChecked={editing ? editing.sandbox === 1 : false} />沙箱</label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PaymentRecordsPanel() {
  const [rows, setRows] = useState<PaymentRecordVO[]>([])
  const [orderNo, setOrderNo] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await paymentApi.getRecords(1, 30, orderNo || undefined)
      setRows(res.list || [])
    } catch (e: any) {
      setError(e?.message || '加载支付记录失败')
    } finally {
      setLoading(false)
    }
  }, [orderNo])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4 p-6">
      <PanelHeader title="支付记录" desc="查看发起支付、回调验签和支付结果。" action={<RefreshButton loading={loading} onClick={load} />} />
      <div className="flex max-w-md gap-2">
        <Input placeholder="按订单号筛选" value={orderNo} onChange={e => setOrderNo(e.target.value)} onKeyDown={e => e.key === 'Enter' && load()} />
        <Button onClick={load}>查询</Button>
      </div>
      {error && <ErrorBox message={error} />}
      <SimpleTable headers={['订单号', '交易号', '金额', '支付状态', '验签', '回调时间']}>
        {loading ? <LoadingRow colSpan={6} /> : rows.length === 0 ? <EmptyRow colSpan={6} text="暂无支付记录" /> : rows.map(row => (
          <tr key={row.id} className="border-t">
            <Td className="font-mono text-xs">{row.orderNo}</Td>
            <Td className="font-mono text-xs">{row.tradeNo || '-'}</Td>
            <Td>¥{Number(row.amount || 0).toFixed(2)}</Td>
            <Td><Badge variant="outline">{statusLabels[row.paymentStatus] || row.paymentStatus}</Badge></Td>
            <Td><Badge variant={row.verifyStatus === 'verified' || row.verifyStatus === 'success' ? 'default' : 'secondary'}>{row.verifyMsg || row.verifyStatus || '-'}</Badge></Td>
            <Td className="text-xs text-muted-foreground">{row.callbackAt ? formatDate(row.callbackAt) : '-'}</Td>
          </tr>
        ))}
      </SimpleTable>
    </div>
  )
}

function RefundsPanel() {
  const [rows, setRows] = useState<RefundRecordVO[]>([])
  const [status, setStatus] = useState('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await paymentApi.getRefunds(1, 30, status === 'all' ? undefined : status)
      setRows(res.list || [])
    } catch (e: any) {
      setError(e?.message || '加载退款记录失败')
    } finally {
      setLoading(false)
    }
  }, [status])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4 p-6">
      <PanelHeader title="退款记录" desc="查看退款处理结果。发起退款仍由订单详情或后续专门入口处理。" action={<RefreshButton loading={loading} onClick={load} />} />
      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部状态</SelectItem>
          <SelectItem value="processing">处理中</SelectItem>
          <SelectItem value="success">成功</SelectItem>
          <SelectItem value="failed">失败</SelectItem>
        </SelectContent>
      </Select>
      {error && <ErrorBox message={error} />}
      <SimpleTable headers={['退款单号', '订单号', '交易号', '金额', '状态', '原因', '时间']}>
        {loading ? <LoadingRow colSpan={7} /> : rows.length === 0 ? <EmptyRow colSpan={7} text="暂无退款记录" /> : rows.map(row => (
          <tr key={row.id} className="border-t">
            <Td className="font-mono text-xs">{row.refundNo}</Td>
            <Td className="font-mono text-xs">{row.orderNo}</Td>
            <Td className="font-mono text-xs">{row.tradeNo || '-'}</Td>
            <Td>¥{Number(row.refundAmount || 0).toFixed(2)}</Td>
            <Td><Badge variant="outline">{statusLabels[row.refundStatus] || row.refundStatus}</Badge></Td>
            <Td>{row.reason || '-'}</Td>
            <Td className="text-xs text-muted-foreground">{formatDate(row.createdAt)}</Td>
          </tr>
        ))}
      </SimpleTable>
    </div>
  )
}

function AuditPanel() {
  const [rows, setRows] = useState<PayAuditLogVO[]>([])
  const [result, setResult] = useState('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params: AuditLogQueryParams = { page: 1, size: 30 }
      if (result !== 'all') params.result = result
      const res = await paymentApi.getAuditLogs(params)
      setRows(res.list || [])
    } catch (e: any) {
      setError(e?.message || '加载审计日志失败')
    } finally {
      setLoading(false)
    }
  }, [result])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4 p-6">
      <PanelHeader title="支付审计日志" desc="记录配置、下单、回调、退款等支付相关操作。" action={<RefreshButton loading={loading} onClick={load} />} />
      <Select value={result} onValueChange={setResult}>
        <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部结果</SelectItem>
          <SelectItem value="success">成功</SelectItem>
          <SelectItem value="failed">失败</SelectItem>
        </SelectContent>
      </Select>
      {error && <ErrorBox message={error} />}
      <SimpleTable headers={['操作', '目标', '说明', '结果', '操作人', 'IP', '时间']}>
        {loading ? <LoadingRow colSpan={7} /> : rows.length === 0 ? <EmptyRow colSpan={7} text="暂无审计日志" /> : rows.map(row => (
          <tr key={row.id} className="border-t">
            <Td>{row.action}</Td>
            <Td className="font-mono text-xs">{row.targetType}:{row.targetId}</Td>
            <Td>{row.description}</Td>
            <Td><Badge variant={row.result === 'success' ? 'default' : 'destructive'}>{statusLabels[row.result] || row.result}</Badge></Td>
            <Td>{row.operatorName || row.operatorId || '-'}</Td>
            <Td className="font-mono text-xs">{row.operatorIp || '-'}</Td>
            <Td className="text-xs text-muted-foreground">{formatDate(row.createdAt)}</Td>
          </tr>
        ))}
      </SimpleTable>
    </div>
  )
}

function StatsPanel() {
  const [stats, setStats] = useState<PaymentStatsVO | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setStats(await paymentApi.getStats())
    } catch (e: any) {
      setError(e?.message || '加载支付统计失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-4 p-6">
      <PanelHeader title="支付统计" desc="订单、支付、退款的基础经营指标。" action={<RefreshButton loading={loading} onClick={load} />} />
      {error && <ErrorBox message={error} />}
      {loading ? (
        <div className="py-12 text-center text-muted-foreground"><Loader2 className="mr-2 inline h-5 w-5 animate-spin" />加载中...</div>
      ) : stats && (
        <>
          <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
            <StatCard label="今日订单" value={stats.todayOrderCount} />
            <StatCard label="今日支付" value={`¥${Number(stats.todayPayAmount || 0).toFixed(2)}`} />
            <StatCard label="总订单" value={stats.totalOrderCount} />
            <StatCard label="总支付" value={`¥${Number(stats.totalPayAmount || 0).toFixed(2)}`} />
            <StatCard label="待退款" value={stats.pendingRefundCount} />
            <StatCard label="已退款" value={`¥${Number(stats.totalRefundAmount || 0).toFixed(2)}`} />
          </div>
          <SimpleTable headers={['支付方式', '订单数', '金额']}>
            {(stats.methodStats || []).map(row => (
              <tr key={row.paymentMethod} className="border-t">
                <Td><Badge variant="outline">{providerLabels[row.paymentMethod] || row.paymentMethod}</Badge></Td>
                <Td>{row.orderCount}</Td>
                <Td>¥{Number(row.totalAmount || 0).toFixed(2)}</Td>
              </tr>
            ))}
          </SimpleTable>
        </>
      )}
    </div>
  )
}

function PanelHeader({ title, desc, action }: { title: string; desc: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{desc}</p>
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <AlertCircle className="h-4 w-4 shrink-0" />
      {message}
    </div>
  )
}

function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <Button size="icon" variant="ghost" onClick={onClick} disabled={loading}>
      <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
    </Button>
  )
}

function KeyBadge({ active, label }: { active: boolean; label: string }) {
  return (
    <Badge variant={active ? 'default' : 'secondary'} className="gap-1">
      {active && <CheckCircle2 className="h-3 w-3" />}
      {label}
    </Badge>
  )
}

function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 text-xl font-semibold">{value}</p>
    </div>
  )
}

function SimpleTable({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/50">
            <tr>{headers.map(header => <Th key={header}>{header}</Th>)}</tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  )
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th className={cn('px-4 py-2.5 font-medium', align === 'right' ? 'text-right' : 'text-left')}>{children}</th>
}

function Td({ children, className, align }: { children: React.ReactNode; className?: string; align?: 'left' | 'right' }) {
  return <td className={cn('px-4 py-2.5', align === 'right' && 'text-right', className)}>{children}</td>
}

function LoadingRow({ colSpan }: { colSpan: number }) {
  return <tr><td colSpan={colSpan} className="py-10 text-center text-muted-foreground"><Loader2 className="mr-2 inline h-5 w-5 animate-spin" />加载中...</td></tr>
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return <tr><td colSpan={colSpan} className="py-10 text-center text-muted-foreground">{text}</td></tr>
}
