import { useState, useEffect } from 'react'
import { ossApi, type OssConfigVO, isDemoMode } from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Plus, Trash2, Edit, HardDrive, Server, CheckCircle2, XCircle, RefreshCw, Settings } from 'lucide-react'

const PROVIDERS = [
  { value: 'aliyun', label: '阿里云 OSS' },
  { value: 'tencent', label: '腾讯云 COS' },
  { value: 'minio', label: 'MinIO (S3 兼容)' },
]

const PROVIDER_TIPS: Record<string, string> = {
  aliyun: 'Endpoint 格式: oss-cn-hangzhou.aliyuncs.com，Region 格式: cn-hangzhou，需在 RAM 中创建 AccessKey',
  tencent: 'Endpoint 格式: cos.ap-guangzhou.myqcloud.com，Region 格式: ap-guangzhou，在访问管理获取 SecretId/Key',
  minio: 'Endpoint 格式: http://127.0.0.1:9000，自建或 S3 兼容皆可，需先创建 Bucket',
}

interface FormData {
  name: string; provider: string; endpoint: string; region: string
  bucket: string; accessKey: string; secretKey: string; basePath: string
}

const emptyForm: FormData = { name: '', provider: 'aliyun', endpoint: '', region: '', bucket: '', accessKey: '', secretKey: '', basePath: 'tool_results' }

export default function StorageTab() {
  const [configs, setConfigs] = useState<OssConfigVO[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<FormData>({ ...emptyForm })
  const [testing, setTesting] = useState<string | null>(null)
  const [error, setError] = useState('')

  const loadConfigs = async () => {
    setLoading(true)
    try {
      if (isDemoMode()) {
        setConfigs([])
      } else {
        const list = await ossApi.list()
        setConfigs(list)
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadConfigs() }, [])

  const openCreate = () => {
    setEditing(null)
    setForm({ ...emptyForm })
    setDialogOpen(true)
  }

  const openEdit = (cfg: OssConfigVO) => {
    setEditing(cfg.uuid)
    setForm({ name: cfg.name, provider: cfg.provider, endpoint: cfg.endpoint, region: cfg.region || '', bucket: cfg.bucket, accessKey: cfg.accessKey, secretKey: cfg.secretKey, basePath: cfg.basePath || 'tool_results' })
    setDialogOpen(true)
  }

  const handleSave = async () => {
    if (!form.name || !form.endpoint || !form.bucket || !form.accessKey || !form.secretKey) {
      setError('请填写必填字段'); return
    }
    setError('')
    try {
      if (editing) {
        await ossApi.update(editing, form as any)
      } else {
        await ossApi.create(form as any)
      }
      setDialogOpen(false)
      loadConfigs()
    } catch (e: any) {
      setError(e.message)
    }
  }

  const handleDelete = async (uuid: string) => {
    if (!confirm('确定删除此配置？')) return
    try { await ossApi.delete(uuid); loadConfigs() } catch (e: any) { setError(e.message) }
  }

  const handleToggle = async (uuid: string, currentStatus: string) => {
    const newStatus = currentStatus === 'active' ? 'disabled' : 'active'
    try { await ossApi.toggle(uuid, newStatus); loadConfigs() } catch (e: any) { setError(e.message) }
  }

  const handleSetDefault = async (uuid: string) => {
    try { await ossApi.setDefault(uuid); loadConfigs() } catch (e: any) { setError(e.message) }
  }

  const handleTest = async (uuid: string) => {
    setTesting(uuid)
    try {
      const result = await ossApi.test(uuid)
      alert(result === 'ok' ? '连接成功' : '连接失败: ' + result)
      loadConfigs()
    } catch (e: any) {
      alert('测试失败: ' + e.message)
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">OSS 存储配置</h2>
          <p className="text-sm text-muted-foreground mt-1">
            配置对象存储服务，用于自动外化大型工具结果。支持阿里云 OSS、腾讯云 COS、MinIO（S3 兼容）。
          </p>
        </div>
        <Button onClick={openCreate} className="gap-1.5" disabled={isDemoMode()}>
          <Plus className="w-4 h-4" />新增配置
        </Button>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-center gap-2">
          <XCircle className="w-4 h-4 shrink-0" />{error}
          <Button variant="ghost" size="sm" className="h-6 px-2 ml-auto" onClick={() => setError('')}>关闭</Button>
        </div>
      )}

      {isDemoMode() ? (
        <div className="text-center py-16 text-muted-foreground">
          <Server className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Demo 模式下不可配置存储，请连接后端使用</p>
        </div>
      ) : loading ? (
        <div className="text-center py-12 text-muted-foreground">
          <RefreshCw className="w-6 h-6 mx-auto mb-2 animate-spin opacity-40" />
          <p className="text-sm">加载中...</p>
        </div>
      ) : configs.length === 0 ? (
        <div className="text-center py-16 border rounded-xl bg-muted/10">
          <HardDrive className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm text-muted-foreground mb-3">暂无存储配置</p>
          <Button variant="outline" size="sm" onClick={openCreate}>
            <Plus className="w-3.5 h-3.5 mr-1" />添加第一个 OSS 配置
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {configs.map(cfg => (
            <div key={cfg.uuid}
              className={cn(
                'p-4 rounded-xl border transition-colors',
                cfg.isDefault ? 'bg-primary/5 border-primary/30' : 'bg-card',
                cfg.status === 'error' && 'border-destructive/30'
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="font-medium text-sm">{cfg.name}</span>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5">
                      {PROVIDERS.find(p => p.value === cfg.provider)?.label || cfg.provider}
                    </Badge>
                    {cfg.isDefault && <Badge className="text-[10px] px-1.5 py-0 h-5 bg-primary/20 text-primary border-primary/30">默认</Badge>}
                    {cfg.status === 'error' && <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-5">异常</Badge>}
                    {cfg.status === 'disabled' && <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5">已禁用</Badge>}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>Bucket: {cfg.bucket}</span>
                    <span>Endpoint: {cfg.endpoint}</span>
                    {cfg.region && <span>Region: {cfg.region}</span>}
                    <span>路径: {cfg.basePath || 'tool_results'}</span>
                  </div>
                  {cfg.testResult && (
                    <p className={cn('text-xs mt-1.5', cfg.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                      {cfg.lastTestAt && `测试时间: ${formatDate(cfg.lastTestAt)} — `}
                      {cfg.testResult}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="icon" className="h-7 w-7" title="测试连接"
                    onClick={() => handleTest(cfg.uuid)} disabled={testing === cfg.uuid}>
                    <RefreshCw className={cn('w-3.5 h-3.5', testing === cfg.uuid && 'animate-spin')} />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" title="编辑"
                    onClick={() => openEdit(cfg)}>
                    <Edit className="w-3.5 h-3.5" />
                  </Button>
                  {!cfg.isDefault && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-primary" title="设为默认"
                      onClick={() => handleSetDefault(cfg.uuid)}>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" title="删除"
                    onClick={() => handleDelete(cfg.uuid)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 编辑/新增对话框 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings className="w-5 h-5" />
              {editing ? '编辑存储配置' : '新增存储配置'}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">配置名称 *</Label>
                <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="如：生产环境 OSS" className="h-9 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">提供商</Label>
                <Select value={form.provider} onValueChange={v => setForm({ ...form, provider: v })}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {PROVIDER_TIPS[form.provider] && (
              <p className="text-[11px] text-muted-foreground bg-muted/50 px-3 py-2 rounded-md">{PROVIDER_TIPS[form.provider]}</p>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Endpoint *</Label>
              <Input value={form.endpoint} onChange={e => setForm({ ...form, endpoint: e.target.value })}
                placeholder="oss-cn-hangzhou.aliyuncs.com" className="h-9 text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Region</Label>
                <Input value={form.region} onChange={e => setForm({ ...form, region: e.target.value })}
                  placeholder={form.provider === 'minio' ? '无需填写' : 'cn-hangzhou'} className="h-9 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Bucket *</Label>
                <Input value={form.bucket} onChange={e => setForm({ ...form, bucket: e.target.value })}
                  placeholder="my-bucket" className="h-9 text-sm" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">存储路径前缀</Label>
              <Input value={form.basePath} onChange={e => setForm({ ...form, basePath: e.target.value })}
                placeholder="tool_results" className="h-9 text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">AccessKey / SecretId *</Label>
              <Input value={form.accessKey} onChange={e => setForm({ ...form, accessKey: e.target.value })}
                placeholder="LTAI5t..." className="h-9 text-sm font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">SecretKey *</Label>
              <Input type="password" value={form.secretKey} onChange={e => setForm({ ...form, secretKey: e.target.value })}
                placeholder="输入密钥" className="h-9 text-sm" />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button size="sm" onClick={handleSave}>{editing ? '保存' : '创建'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
