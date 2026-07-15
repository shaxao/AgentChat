import { useState, useMemo, useEffect, useRef } from 'react'
import { useAdminStore, useAuthStore, User, ModelChannel, Model, Subscription, LogEntry } from '@/store'
import { useCallback } from 'react'
import { adminApi, isDemoMode, planApi, agentRegistryApi, walletApi, ttsApi, translateApi, rbacApi, type SysRoleVO, type AgentRegistryDetail, type AgentFileNode } from '@/lib/api'
import type { SubscriptionPlanVO } from '@/lib/api'
import { DEMO_PLANS } from '@/pages/SubscriptionPage'
import { cn, formatDate, formatNumber } from '@/lib/utils'
import { ossApi, type OssConfigVO } from '@/lib/api'
import StorageTab from '@/components/admin/StorageTab'
import ScenariosAdminTab from '@/components/admin/ScenariosAdminTab'
import RbacAdminTab from '@/components/admin/RbacAdminTab'
import NotificationsAdminTab from '@/components/admin/NotificationsAdminTab'
import PaymentTab from '@/components/admin/PaymentTab'
import OrderTab from '@/components/admin/OrderTab'
import { getTagLabel, TAG_MAPPING, getAllApiTags, getTagApiValue, setTagMapping, removeTagMapping, isBuiltinTag, getTagPair } from '@/config/capabilities'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  Users, Cpu, CreditCard, BarChart3, FileText, Bot, ArrowLeft, LayoutGrid,
  Plus, Search, MoreHorizontal, RefreshCw, CheckCircle2,
  TrendingUp, TrendingDown, MessageSquare, Zap, DollarSign, Shield,
  Edit, Trash2, Ban, UserCheck, Key, Globe, Activity, AlertTriangle,
  Eye, EyeOff, Download, X, Menu, ChevronLeft, ChevronRight, ChevronDown, ChevronUp,
  HardDrive, Loader2, Volume2, Bell, ShoppingCart, ReceiptText, PlayCircle,
} from 'lucide-react'

type AdminTab = 'overview' | 'users' | 'channels' | 'models' | 'subscriptions' | 'agents' | 'wallet' | 'storage' | 'scenarios' | 'logs' | 'rbac' | 'notifications' | 'payment' | 'orders'
type AdminNavItem = {
  id: AdminTab
  icon: React.ComponentType<{ className?: string }>
  label: string
  permission?: string
}

interface AdminPageProps {
  onBack: () => void
}

// ─── TTS 供应商预设音色模板 ─────────────────────────────────
const TTS_VOICE_PRESETS: Record<string, { id: string; label: string }[]> = {
  'OpenAI': [
    { id: 'alloy', label: 'Alloy（综合）' },
    { id: 'echo', label: 'Echo（男声·沉稳）' },
    { id: 'fable', label: 'Fable（男声·叙事）' },
    { id: 'onyx', label: 'Onyx（男声·低沉）' },
    { id: 'nova', label: 'Nova（女声·温暖）' },
    { id: 'shimmer', label: 'Shimmer（女声·清脆）' },
    { id: 'coral', label: 'Coral（女声·活泼）' },
    { id: 'sage', label: 'Sage（中性·智者）' },
  ],
  /** 阿里云 Qwen-TTS 系列（qwen3-tts-instruct-flash / qwen3-tts-flash / qwen-tts）
   *  来源: https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list
   *  voice ID 大小写敏感，必须与文档一致 */
  '阿里云 Qwen-TTS': [
    { id: 'Cherry', label: '芊悦（女声·通用）' },
    { id: 'Serena', label: '苏瑶（女声·温柔）' },
    { id: 'Ethan', label: '晨煦（男声·通用）' },
    { id: 'Chelsie', label: '千雪（女声·清亮）' },
    { id: 'Momo', label: '茉兔（女声·甜美）' },
    { id: 'Vivian', label: '十三（女声·活泼）' },
    { id: 'Moon', label: '月白（男声·沉稳）' },
    { id: 'Maia', label: '四月（女声·知性）' },
    { id: 'Kai', label: '凯（男声·阳光）' },
    { id: 'Nofish', label: '不吃鱼（男声·磁性）' },
    { id: 'Bella', label: '萌宝（女声·可爱）' },
    { id: 'Eldric Sage', label: '沧明子（男声·叙事）' },
    { id: 'Mia', label: '乖小妹（女声·甜美）' },
    { id: 'Mochi', label: '沙小弥（男声·少年）' },
    { id: 'Bellona', label: '燕铮莺（女声·优雅）' },
    { id: 'Vincent', label: '田叔（男声·成熟）' },
    { id: 'Bunny', label: '萌小姬（女声·萌系）' },
    { id: 'Neil', label: '阿闻（男声·青年）' },
    { id: 'Elias', label: '墨讲师（女声·专业）' },
    { id: 'Arthur', label: '徐大爷（男声·老年）' },
  ],
  /** 阿里云 CosyVoice 系列（cosyvoice-v1 / cosyvoice-v2 等模型）
   *  注意：与 Qwen-TTS 是不同模型系列，音色不互通 */
  '阿里云 CosyVoice': [
    { id: 'longxiaochun', label: '龙小纯（女声·标准）' },
    { id: 'longhua', label: '龙华（男声·标准）' },
    { id: 'longyan', label: '龙颜（男声·沉稳）' },
    { id: 'longxiao', label: '龙小（女声·温柔）' },
    { id: 'longshu', label: '龙叔（男声·浑厚）' },
    { id: 'longcheng', label: '龙诚（男声·新闻）' },
    { id: 'longjing', label: '龙静（女声·柔和）' },
    { id: 'longmiao', label: '龙喵（女声·可爱）' },
    { id: 'longyue', label: '龙悦（女声·活力）' },
    { id: 'longfei', label: '龙飞（男声·阳刚）' },
    { id: 'longbella', label: 'Bella（女声·英文）' },
    { id: 'longxiaobai', label: '龙小白（中性·清新）' },
  ],
  /** 阿里云 Sambert 系列（sambert-zhichu 等旧版模型）
   *  注意：仅适用于 sambert-zhichu/v1/v2 等模型，Qwen-TTS 不支持 */
  '阿里云 Sambert': [
    { id: 'sambert-zhichu', label: '知初（女声）' },
    { id: 'sambert-zhiyu', label: '知语（女声）' },
    { id: 'sambert-zhiting', label: '知婷（女声）' },
    { id: 'sambert-zhimi', label: '知米（女声）' },
    { id: 'sambert-zhixiao', label: '知笑（女声）' },
    { id: 'sambert-zhilin', label: '知琳（女声）' },
    { id: 'sambert-zhimiao', label: '知妙（女声）' },
    { id: 'sambert-zhiya', label: '知雅（女声）' },
    { id: 'sambert-zhifei', label: '知飞（男声）' },
  ],
  'Azure (中文)': [
    { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女声·温暖）' },
    { id: 'zh-CN-YunxiNeural', label: '云希（男声·阳光）' },
    { id: 'zh-CN-XiaoyiNeural', label: '晓伊（女声·活泼）' },
    { id: 'zh-CN-YunjianNeural', label: '云健（男声·浑厚）' },
    { id: 'zh-CN-XiaochenNeural', label: '晓辰（女声·成熟）' },
    { id: 'zh-CN-XiaohanNeural', label: '晓涵（女声·知性）' },
    { id: 'zh-CN-XiaomengNeural', label: '晓梦（女声·柔和）' },
    { id: 'zh-CN-XiaoqiuNeural', label: '晓秋（女声·亲切）' },
    { id: 'zh-CN-XiaoruiNeural', label: '晓瑞（女声·长辈）' },
    { id: 'zh-CN-XiaoshuangNeural', label: '晓双（女声·儿童）' },
    { id: 'zh-CN-XiaoxuanNeural', label: '晓萱（女声·元气）' },
    { id: 'zh-CN-XiaoyanNeural', label: '晓颜（女声·标准）' },
    { id: 'zh-CN-XiaozhenNeural', label: '晓甄（女声·端庄）' },
    { id: 'zh-CN-YunyangNeural', label: '云扬（男声·标准）' },
    { id: 'zh-CN-YunyeNeural', label: '云野（男声·少年）' },
    { id: 'zh-CN-YunzeNeural', label: '云泽（男声·成熟）' },
  ],
  '火山引擎': [
    { id: 'BV001_streaming', label: '通用女声' },
    { id: 'BV002_streaming', label: '通用男声' },
    { id: 'BV001_V2_streaming', label: '通用女声 V2' },
    { id: 'BV002_V2_streaming', label: '通用男声 V2' },
    { id: 'BV700_streaming', label: '灿灿（女声）' },
    { id: 'BV701_streaming', label: '擎苍（男声）' },
    { id: 'BV704_streaming', label: '湫澈（女声）' },
    { id: 'BV407_streaming', label: '湫田（男声）' },
    { id: 'BV408_streaming', label: '湫臻（男声）' },
  ],
  '腾讯云': [
    { id: '101001', label: '智瑜（女声·情感）' },
    { id: '101002', label: '智聆（女声·通用）' },
    { id: '101003', label: '智美（女声·客服）' },
    { id: '101004', label: '智云（男声·通用）' },
    { id: '101005', label: '智莉（女声·直播）' },
    { id: '101006', label: '智言（女声·助理）' },
    { id: '101007', label: '智娜（女声·亲切）' },
    { id: '101008', label: '智琪（女声·标准）' },
    { id: '101009', label: '智芸（女声·新闻）' },
    { id: '101010', label: '智华（男声·标准）' },
    { id: '101011', label: '智燕（女声·新闻）' },
    { id: '101012', label: '智丹（女声·新闻）' },
    { id: '101013', label: '智辉（男声·新闻）' },
    { id: '101014', label: '智宁（女声·新闻）' },
    { id: '101015', label: '智萌（男声·新闻）' },
    { id: '101016', label: '智甜（女声·客服）' },
    { id: '101017', label: '智蓉（女声·新闻）' },
    { id: '101018', label: '智靖（男声·新闻）' },
  ],
}

// ─── 批量导入解析器 ─────────────────────────────────
/** 解析批量粘贴文本，支持: id|label / id,label / id:label / id=label / 仅id / JSON数组 */
function parseBatchText(text: string, idKey: string, labelKey: string): { [k: string]: string }[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  // 尝试 JSON 数组
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed)
      if (Array.isArray(arr)) return arr
    } catch { /* 降级到行解析 */ }
  }
  // 行解析
  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean)
  const result: { [k: string]: string }[] = []
  for (const line of lines) {
    // 跳过注释行
    if (line.startsWith('#') || line.startsWith('//')) continue
    // 匹配分隔符 | , : = 或 tab
    const m = line.match(/^([^\s|,:=\t]+)\s*[|,:=\t]\s*(.+)$/)
    if (m) {
      result.push({ [idKey]: m[1].trim(), [labelKey]: m[2].trim() })
    } else {
      // 仅 id，label 默认等于 id
      result.push({ [idKey]: line, [labelKey]: line })
    }
  }
  return result
}

// ─── TTS 音色编辑器 ─────────────────────────────────
function TtsVoiceEditor({ value, onChange, channelId }: { value: string; onChange: (v: string) => void; channelId?: string | number }) {
  const [list, setList] = useState<{ id: string; label: string }[]>(() => {
    try { return value ? JSON.parse(value) : [] } catch { return [] }
  })
  // 关键修复：当 value prop 变化（切换编辑不同渠道）时同步 list 状态
  useEffect(() => {
    try {
      const next = value ? JSON.parse(value) : []
      if (JSON.stringify(next) !== JSON.stringify(list)) setList(next)
    } catch { /* 保持当前状态 */ }
  }, [value])
  const [newId, setNewId] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchText, setBatchText] = useState('')

  const commit = (next: { id: string; label: string }[]) => {
    setList(next)
    onChange(next.length ? JSON.stringify(next) : '')
  }

  const push = () => {
    if (!newId.trim() || !newLabel.trim()) return
    commit([...list, { id: newId.trim(), label: newLabel.trim() }])
    setNewId('')
    setNewLabel('')
  }

  const remove = (id: string) => commit(list.filter(v => v.id !== id))

  const applyPreset = (preset: { id: string; label: string }[]) => {
    // 合并去重（已有的不覆盖）
    const existingIds = new Set(list.map(v => v.id))
    const toAdd = preset.filter(v => !existingIds.has(v.id))
    commit([...list, ...toAdd])
  }

  const clearAll = () => commit([])

  const handleBatchImport = (mode: 'append' | 'replace') => {
    const parsed = parseBatchText(batchText, 'id', 'label')
    if (parsed.length === 0) return
    if (mode === 'replace') {
      commit(parsed as { id: string; label: string }[])
    } else {
      const existingIds = new Set(list.map(v => v.id))
      const toAdd = (parsed as { id: string; label: string }[]).filter(v => !existingIds.has(v.id))
      commit([...list, ...toAdd])
    }
    setBatchText('')
    setBatchOpen(false)
  }

  const handlePreview = async (id: string) => {
    if (!channelId) {
      alert('请先保存渠道后再预览音色（新建渠道暂无 ID，保存后即可使用当前渠道配置预览）')
      return
    }
    try {
      setPreviewing(id)
      const base64 = await ttsApi.preview(id, '你好，这是语音预览。', channelId)
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'audio/mpeg' })
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.play()
      audio.onended = () => URL.revokeObjectURL(url)
    } catch (e) {
      console.warn('预览失败:', e)
    } finally {
      setPreviewing(null)
    }
  }

  return (
    <div className="space-y-2">
      {/* 已有音色列表 */}
      <div className="flex flex-wrap gap-1.5">
        {list.map(v => (
          <span key={v.id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-accent/50 rounded text-xs">
            <button title="预览音色" className="hover:text-primary" onClick={() => handlePreview(v.id)} disabled={previewing !== null}>
              {previewing === v.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Volume2 className="w-3 h-3" />}
            </button>
            <span>{v.label}</span>
            <button title="删除" className="hover:text-destructive" onClick={() => remove(v.id)}><X className="w-3 h-3" /></button>
          </span>
        ))}
        {list.length === 0 && <span className="text-xs text-muted-foreground">未配置音色，用户将使用默认音色</span>}
      </div>

      {/* 预设模板 */}
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-muted-foreground mr-1">预设:</span>
        {Object.keys(TTS_VOICE_PRESETS).map(name => (
          <Button key={name} variant="outline" size="sm" className="h-6 px-2 text-xs"
            onClick={() => applyPreset(TTS_VOICE_PRESETS[name])}>
            {name}
          </Button>
        ))}
      </div>

      {/* 添加 + 批量导入 + 清空 */}
      <div className="flex gap-1.5 items-center">
        <Input placeholder="音色ID（如 alloy）" value={newId} onChange={e => setNewId(e.target.value)} className="h-7 text-xs flex-1" />
        <Input placeholder="显示名（如 标准）" value={newLabel} onChange={e => setNewLabel(e.target.value)} className="h-7 text-xs flex-1" />
        <Button size="sm" className="h-7 px-2 text-xs" onClick={push} disabled={!newId.trim() || !newLabel.trim()}>添加</Button>
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setBatchOpen(true)}>批量导入</Button>
        {list.length > 0 && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive" onClick={clearAll}>清空</Button>
        )}
      </div>

      {/* 批量导入弹窗 */}
      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>批量导入音色</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground space-y-0.5">
              <div>每行一条，支持以下格式:</div>
              <div className="pl-3 font-mono">
                <div>id|label  （如 alloy|标准）</div>
                <div>id,label / id:label / id=label</div>
                <div>仅 id（label 默认等于 id）</div>
                <div>JSON: [{"{ \"id\": \"x\", \"label\": \"y\" }"}]</div>
              </div>
              <div className="pl-3 text-muted-foreground"># 开头为注释</div>
            </div>
            <Textarea
              placeholder={'alloy|Alloy（综合）\necho|Echo（男声·沉稳）\nnova|Nova（女声·温暖）\n# 注释行会被忽略'}
              value={batchText}
              onChange={e => setBatchText(e.target.value)}
              className="font-mono text-xs min-h-[180px]"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => { setBatchText(''); setBatchOpen(false) }}>取消</Button>
            <Button variant="outline" size="sm"
              onClick={() => handleBatchImport('append')}
              disabled={!batchText.trim()}>追加导入</Button>
            <Button size="sm"
              onClick={() => handleBatchImport('replace')}
              disabled={!batchText.trim()}>覆盖导入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── 翻译语言编辑器 ─────────────────────────────────
const TRANSLATE_LANG_PRESETS: Record<string, { code: string; label: string }[]> = {
  '常用语言': [
    { code: '英文', label: '🇺🇸 英文' },
    { code: '日文', label: '🇯🇵 日文' },
    { code: '韩文', label: '🇰🇷 韩文' },
    { code: '法文', label: '🇫🇷 法文' },
    { code: '德文', label: '🇩🇪 德文' },
    { code: '西班牙文', label: '🇪🇸 西班牙文' },
    { code: '俄文', label: '🇷🇺 俄文' },
    { code: '阿拉伯文', label: '🇸🇦 阿拉伯文' },
    { code: '中文', label: '🇨🇳 中文' },
  ],
  '欧洲语言': [
    { code: '英文', label: '🇬🇧 英文' },
    { code: '法文', label: '🇫🇷 法文' },
    { code: '德文', label: '🇩🇪 德文' },
    { code: '西班牙文', label: '🇪🇸 西班牙文' },
    { code: '意大利文', label: '🇮🇹 意大利文' },
    { code: '葡萄牙文', label: '🇵🇹 葡萄牙文' },
    { code: '荷兰文', label: '🇳🇱 荷兰文' },
    { code: '俄文', label: '🇷🇺 俄文' },
    { code: '波兰文', label: '🇵🇱 波兰文' },
    { code: '瑞典文', label: '🇸🇪 瑞典文' },
  ],
  '亚洲语言': [
    { code: '中文', label: '🇨🇳 中文' },
    { code: '日文', label: '🇯🇵 日文' },
    { code: '韩文', label: '🇰🇷 韩文' },
    { code: '越南文', label: '🇻🇳 越南文' },
    { code: '泰文', label: '🇹🇭 泰文' },
    { code: '印尼文', label: '🇮🇩 印尼文' },
    { code: '马来文', label: '🇲🇾 马来文' },
    { code: '印地文', label: '🇮🇳 印地文' },
    { code: '阿拉伯文', label: '🇸🇦 阿拉伯文' },
  ],
}

function TranslateLangEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [list, setList] = useState<{ code: string; label: string }[]>(() => {
    try { return value ? JSON.parse(value) : [] } catch { return [] }
  })
  // 同步 value prop 变化到 list（切换编辑不同渠道时）
  useEffect(() => {
    try {
      const next = value ? JSON.parse(value) : []
      if (JSON.stringify(next) !== JSON.stringify(list)) setList(next)
    } catch { /* 保持当前状态 */ }
  }, [value])
  const [newCode, setNewCode] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchText, setBatchText] = useState('')

  const commit = (next: { code: string; label: string }[]) => {
    setList(next)
    onChange(next.length ? JSON.stringify(next) : '')
  }

  const push = () => {
    if (!newCode.trim() || !newLabel.trim()) return
    commit([...list, { code: newCode.trim(), label: newLabel.trim() }])
    setNewCode('')
    setNewLabel('')
  }

  const remove = (code: string) => commit(list.filter(l => l.code !== code))

  const applyPreset = (preset: { code: string; label: string }[]) => {
    const existingCodes = new Set(list.map(l => l.code))
    commit([...list, ...preset.filter(l => !existingCodes.has(l.code))])
  }

  const clearAll = () => commit([])

  const handleBatchImport = (mode: 'append' | 'replace') => {
    const parsed = parseBatchText(batchText, 'code', 'label')
    if (parsed.length === 0) return
    if (mode === 'replace') {
      commit(parsed as { code: string; label: string }[])
    } else {
      const existing = new Set(list.map(l => l.code))
      commit([...list, ...(parsed as { code: string; label: string }[]).filter(l => !existing.has(l.code))])
    }
    setBatchText('')
    setBatchOpen(false)
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {list.map(l => (
          <span key={l.code} className="inline-flex items-center gap-1 px-2 py-0.5 bg-accent/50 rounded text-xs">
            <span>{l.label}</span>
            <button title="删除" className="hover:text-destructive" onClick={() => remove(l.code)}><X className="w-3 h-3" /></button>
          </span>
        ))}
        {list.length === 0 && <span className="text-xs text-muted-foreground">未配置语言，将使用默认语言列表</span>}
      </div>

      {/* 预设模板 */}
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-muted-foreground mr-1">预设:</span>
        {Object.keys(TRANSLATE_LANG_PRESETS).map(name => (
          <Button key={name} variant="outline" size="sm" className="h-6 px-2 text-xs"
            onClick={() => applyPreset(TRANSLATE_LANG_PRESETS[name])}>
            {name}
          </Button>
        ))}
      </div>

      <div className="flex gap-1.5 items-center">
        <Input placeholder="语言代码（如 英文）" value={newCode} onChange={e => setNewCode(e.target.value)} className="h-7 text-xs flex-1" />
        <Input placeholder="显示名（如 🇺🇸 英文）" value={newLabel} onChange={e => setNewLabel(e.target.value)} className="h-7 text-xs flex-1" />
        <Button size="sm" className="h-7 px-2 text-xs" onClick={push} disabled={!newCode.trim() || !newLabel.trim()}>添加</Button>
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setBatchOpen(true)}>批量导入</Button>
        {list.length > 0 && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive" onClick={clearAll}>清空</Button>
        )}
      </div>

      {/* 批量导入弹窗 */}
      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>批量导入语言</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground space-y-0.5">
              <div>每行一条，支持以下格式:</div>
              <div className="pl-3 font-mono">
                <div>code|label  （如 英文|🇺🇸 英文）</div>
                <div>code,label / code:label / code=label</div>
                <div>仅 code（label 默认等于 code）</div>
                <div>JSON: [{"{ \"code\": \"x\", \"label\": \"y\" }"}]</div>
              </div>
              <div className="pl-3 text-muted-foreground"># 开头为注释</div>
            </div>
            <Textarea
              placeholder={'英文|🇺🇸 英文\n日文|🇯🇵 日文\n韩文|🇰🇷 韩文\n# 注释行会被忽略'}
              value={batchText}
              onChange={e => setBatchText(e.target.value)}
              className="font-mono text-xs min-h-[180px]"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => { setBatchText(''); setBatchOpen(false) }}>取消</Button>
            <Button variant="outline" size="sm"
              onClick={() => handleBatchImport('append')}
              disabled={!batchText.trim()}>追加导入</Button>
            <Button size="sm"
              onClick={() => handleBatchImport('replace')}
              disabled={!batchText.trim()}>覆盖导入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default function AdminPage({ onBack }: AdminPageProps) {
  const [activeTab, setActiveTab] = useState<AdminTab>('overview')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const { user, permissions } = useAuthStore()
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin'
  const hasAdminPermission = (permission?: string) => {
    if (!permission) return isAdmin
    return (isAdmin && permissions.length === 0) ||
      permissions.includes(permission) ||
      permissions.includes(`PERM_${permission}`)
  }

  const navItems = useMemo(() => {
    const items: AdminNavItem[] = [
    { id: 'overview', icon: BarChart3, label: '系统概览' },
    { id: 'users', icon: Users, label: '用户管理' },
    { id: 'channels', icon: Cpu, label: '模型渠道' },
    { id: 'models', icon: Bot, label: '模型价格' },
    { id: 'subscriptions', icon: CreditCard, label: '订阅管理' },
    { id: 'agents', icon: Bot, label: 'Skill 管理' },
    { id: 'wallet', icon: DollarSign, label: '钱包管理' },
    { id: 'storage', icon: HardDrive, label: '存储配置' },
    { id: 'scenarios', icon: LayoutGrid, label: '场景管理' },
    { id: 'rbac', icon: Shield, label: '权限管理' },
    { id: 'notifications', icon: Bell, label: '通知管理' },
    { id: 'payment', icon: ReceiptText, label: '支付管理' },
    { id: 'orders', icon: ShoppingCart, label: '订单管理' },
    { id: 'logs', icon: FileText, label: '日志管理' },
    ]
    return items.filter(item => hasAdminPermission(item.permission))
  }, [permissions, isAdmin])

  useEffect(() => {
    if (!navItems.some(item => item.id === activeTab)) {
      setActiveTab(navItems[0]?.id || 'overview')
    }
  }, [activeTab, navItems])

  const handleNavClick = (id: AdminTab) => {
    setActiveTab(id)
    setMobileSidebarOpen(false)
  }

  // 侧边栏内容（桌面端复用）
  const sidebarContent = (
    <>
      <div className="p-4 border-b shrink-0">
        <div className={cn('flex items-center gap-2 mb-3', sidebarCollapsed && 'justify-center')}>
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
            <Shield className="w-4 h-4 text-primary-foreground" />
          </div>
          {!sidebarCollapsed && (
            <div className="min-w-0">
              <span className="font-semibold text-sm block">管理后台</span>
              <span className="text-[10px] text-muted-foreground">Admin Console</span>
            </div>
          )}
        </div>
        {!sidebarCollapsed && (
          <Button variant="ghost" size="sm" className="gap-1.5 w-full justify-start px-2" onClick={onBack}>
            <ArrowLeft className="w-3.5 h-3.5" />返回聊天
          </Button>
        )}
        {sidebarCollapsed && (
          <Button variant="ghost" size="icon" className="w-full h-8" onClick={onBack} title="返回聊天">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        )}
      </div>
      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
        {navItems.map(({ id, icon: Icon, label }) => (
          <button key={id} onClick={() => handleNavClick(id)}
            title={sidebarCollapsed ? label : undefined}
            className={cn('w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors',
              sidebarCollapsed ? 'justify-center px-2' : '',
              activeTab === id ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}>
            <Icon className="w-4 h-4 shrink-0" />
            {!sidebarCollapsed && <span className="flex-1 text-left">{label}</span>}
          </button>
        ))}
      </nav>
      {!sidebarCollapsed && (
        <div className="p-3 border-t shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-xs font-medium text-primary shrink-0">
              {user?.name?.[0] || 'A'}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium truncate">{user?.name}</p>
              <p className="text-[10px] text-muted-foreground truncate">{user?.email}</p>
            </div>
          </div>
        </div>
      )}
    </>
  )

  return (
    <div className="flex h-full min-h-0 bg-background overflow-hidden">
      {/* 移动端遮罩 */}
      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setMobileSidebarOpen(false)} />
      )}

      {/* 移动端抽屉侧边栏 */}
      <div className={cn(
        'fixed inset-y-0 left-0 z-50 w-56 bg-background border-r flex flex-col transition-transform duration-300 md:hidden',
        mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'
      )}>
        <div className="flex items-center justify-between p-3 border-b">
          <span className="font-semibold text-sm">管理后台</span>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setMobileSidebarOpen(false)}>
            <X className="w-4 h-4" />
          </Button>
        </div>
        <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
          {navItems.map(({ id, icon: Icon, label }) => (
            <button key={id} onClick={() => handleNavClick(id)}
              className={cn('w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors',
                activeTab === id ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}>
              <Icon className="w-4 h-4 shrink-0" />
              <span className="flex-1 text-left">{label}</span>
            </button>
          ))}
        </nav>
        <div className="p-3 border-t">
          <Button variant="ghost" size="sm" className="gap-1.5 w-full justify-start px-2" onClick={onBack}>
            <ArrowLeft className="w-3.5 h-3.5" />返回聊天
          </Button>
          <div className="flex items-center gap-2 mt-2">
            <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-xs font-medium text-primary shrink-0">
              {user?.name?.[0] || 'A'}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium truncate">{user?.name}</p>
              <p className="text-[10px] text-muted-foreground truncate">{user?.email}</p>
            </div>
          </div>
        </div>
      </div>

      {/* 桌面端侧边栏 */}
      <div className={cn(
        'hidden md:flex flex-col border-r bg-muted/20 shrink-0 transition-all duration-200',
        sidebarCollapsed ? 'w-14' : 'w-56'
      )}>
        {sidebarContent}
        {/* 桌面端收缩按钮 */}
        <button
          onClick={() => setSidebarCollapsed(v => !v)}
          className="absolute top-1/2 -translate-y-1/2 -right-3 z-10 w-6 h-6 rounded-full bg-background border shadow-sm flex items-center justify-center hover:bg-muted transition-colors"
          style={{ position: 'sticky', left: sidebarCollapsed ? '3rem' : '13.5rem', marginLeft: 'auto' }}
          title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          {sidebarCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
        </button>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* 移动端顶栏 */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b bg-background shrink-0">
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setMobileSidebarOpen(true)}>
            <Menu className="w-4 h-4" />
          </Button>
          <span className="font-semibold text-sm flex-1">
            {navItems.find(n => n.id === activeTab)?.label || '管理后台'}
          </span>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onBack} title="返回聊天">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </div>

        {activeTab === 'overview' && <OverviewTab />}
        {activeTab === 'users' && <UsersTab />}
        {activeTab === 'channels' && <ChannelsTab />}
        {activeTab === 'models' && <ModelsTab />}
        {activeTab === 'subscriptions' && <SubscriptionsTab />}
        {activeTab === 'agents' && <AgentsTab />}
        {activeTab === 'wallet' && <WalletAdminTab />}
        {activeTab === 'storage' && <StorageTab />}
        {activeTab === 'scenarios' && <ScenariosAdminTab />}
        {activeTab === 'rbac' && <RbacAdminTab />}
        {activeTab === 'notifications' && <NotificationsAdminTab />}
        {activeTab === 'payment' && <PaymentTab />}
        {activeTab === 'orders' && <OrderTab />}
        {activeTab === 'logs' && <LogsTab />}
      </div>
    </div>
  )
}

// ==================== Overview ====================
function OverviewTab() {
  const { users, logs, channels, subscriptions, setUsers, setChannels, setLogs, setSubscriptions } = useAdminStore()
  const [backendStats, setBackendStats] = useState<Record<string, number> | null>(null)
  const [loading, setLoading] = useState(false)

  const mapOverviewUser = useCallback((u: any): User => ({
    id: String(u.id ?? u.uuid ?? ''),
    name: u.name,
    email: u.email,
    avatar: u.avatar,
    role: u.role,
    plan: u.plan,
    tokensUsed: u.tokensUsed ?? 0,
    tokensLimit: u.tokensLimit ?? 50000,
    createdAt: u.createdAt ?? '',
    status: u.status,
    costUsed: Number(u.costUsed ?? 0),
    costLimit: Number(u.costLimit ?? 0),
  }), [])

  const mapOverviewChannel = useCallback((c: any): ModelChannel => ({
    id: String(c.uuid || c.id),
    name: c.name,
    provider: c.provider,
    apiKey: c.apiKey || '',
    baseUrl: c.baseUrl || '',
    models: Array.isArray(c.models) ? c.models : (c.models ? String(c.models).split(',').filter(Boolean) : []),
    tags: (() => {
      if (!c.tags) return []
      if (Array.isArray(c.tags)) return c.tags
      try { return JSON.parse(c.tags) } catch { return String(c.tags).split(',').map((s: string) => s.trim()).filter(Boolean) }
    })(),
    status: c.status || 'active',
    priority: c.priority || 1,
    rateLimit: c.rateLimit || 60,
    createdAt: c.createdAt || '',
    channelType: c.channelType || 'chat',
  }), [])

  const mapOverviewLog = useCallback((l: any): LogEntry => ({
    id: String(l.id || l.uuid),
    userId: String(l.userId || ''),
    userName: String(l.userName || l.userId || ''),
    model: String(l.model || ''),
    inputTokens: Number(l.inputTokens) || 0,
    cachedInputTokens: Number(l.cachedInputTokens) || 0,
    outputTokens: Number(l.outputTokens) || 0,
    cost: Number(l.cost) || 0,
    latency: Number(l.latencyMs || l.latency) || 0,
    status: l.status === 'error' ? 'error' : 'success',
    timestamp: String(l.createdAt || l.timestamp || ''),
    conversationId: l.conversationId,
    requestIp: l.requestIp,
    provider: l.provider,
    channelId: l.channelId,
    channelName: l.channelName,
    errorMsg: l.errorMsg,
    sceneType: l.sceneType || 'chat',
  }), [])

  const mapOverviewSubscription = useCallback((s: any): Subscription => ({
    id: String(s.id || s.uuid),
    userId: String(s.userId || ''),
    userName: s.userName || String(s.userId || ''),
    plan: s.plan,
    planName: s.planName,
    status: s.status,
    price: Number(s.price) || 0,
    costLimit: Number(s.costLimit ?? 0),
    costUsed: Number(s.costUsed ?? 0),
    tokensLimit: s.tokensLimit,
    modelLimit: s.modelLimit,
    startDate: s.startDate || '',
    endDate: s.endDate || '',
  }), [])

  const refreshOverview = useCallback(async () => {
    if (isDemoMode()) return
    setLoading(true)
    try {
      const [stats, userRes, channelRes, subRes, logRes] = await Promise.all([
        adminApi.getStats(),
        adminApi.listUsers({ page: 1, size: 100 }),
        adminApi.listChannels().catch(() => []),
        adminApi.listSubscriptions(1, 100).catch(() => ({ list: [], total: 0 })),
        adminApi.listLogs(1, 100).catch(() => ({ list: [], total: 0 })),
      ])
      setBackendStats(stats)
      setUsers((userRes.list || []).map(mapOverviewUser))
      setChannels((channelRes as any[]).map(mapOverviewChannel))
      setSubscriptions((subRes.list || []).map(mapOverviewSubscription))
      setLogs((logRes.list || []).map(mapOverviewLog))
    } catch (e) {
      console.warn('加载系统概览失败:', e)
    } finally {
      setLoading(false)
    }
  }, [mapOverviewChannel, mapOverviewLog, mapOverviewSubscription, mapOverviewUser, setChannels, setLogs, setSubscriptions, setUsers])

  useEffect(() => {
    refreshOverview()
  }, [refreshOverview])

  const now = Date.now()
  const dayMs = 86400000
  const todayLogs = logs.filter(l => {
    const time = new Date(l.timestamp).getTime()
    return Number.isFinite(time) && time > now - dayMs
  })
  const weekLogs = logs.filter(l => {
    const time = new Date(l.timestamp).getTime()
    return Number.isFinite(time) && time > now - dayMs * 7
  })
  const totalCost = logs.reduce((s, l) => s + Number(l.cost || 0), 0)
  const totalUsers = backendStats?.totalUsers ?? users.length
  const activeChannels = channels.filter(c => c.status === 'active').length
  const activeSubs = backendStats?.activeSubscriptions ?? subscriptions.filter(s => s.status === 'active').length
  const successLogs = logs.filter(l => l.status === 'success').length
  const errorLogs = logs.length - successLogs
  const successRate = logs.length ? Math.round((successLogs / logs.length) * 1000) / 10 : 100
  const avgLatency = logs.length ? Math.round(logs.reduce((s, l) => s + Number(l.latency || 0), 0) / logs.length) : 0
  const tokenTotal = logs.reduce((s, l) => s + Number(l.inputTokens || 0) + Number(l.outputTokens || 0), 0)
  const cachedTokens = logs.reduce((s, l) => s + Number(l.cachedInputTokens || 0), 0)
  const cacheRate = tokenTotal ? Math.round((cachedTokens / tokenTotal) * 1000) / 10 : 0
  const monthlyIncome = subscriptions.filter(s => s.status === 'active').reduce((s, item) => s + Number(item.price || 0), 0)
  const channelCapacity = channels.reduce((s, c) => s + Number(c.rateLimit || 0), 0)
  const degradedChannels = channels.filter(c => c.status === 'error').length
  const disabledChannels = channels.filter(c => c.status === 'disabled').length
  const systemHealthy = degradedChannels === 0 && successRate >= 95

  const kpis = [
    { label: '总用户数', value: formatNumber(totalUsers), hint: `${users.filter(u => u.status === 'active').length} 人可用`, icon: Users, color: 'text-blue-500', bgColor: 'bg-blue-500/10' },
    { label: '今日请求', value: formatNumber(todayLogs.length), hint: `近 7 天 ${formatNumber(weekLogs.length)} 次`, icon: MessageSquare, color: 'text-orange-500', bgColor: 'bg-orange-500/10' },
    { label: '成功率', value: `${successRate}%`, hint: `${errorLogs} 条异常`, icon: CheckCircle2, color: successRate >= 95 ? 'text-emerald-500' : 'text-red-500', bgColor: successRate >= 95 ? 'bg-emerald-500/10' : 'bg-red-500/10' },
    { label: '月经常收入', value: `¥${monthlyIncome.toFixed(0)}`, hint: `${activeSubs} 个有效订阅`, icon: DollarSign, color: 'text-purple-500', bgColor: 'bg-purple-500/10' },
    { label: '渠道容量', value: `${formatNumber(channelCapacity)}/min`, hint: `${activeChannels}/${channels.length} 个启用`, icon: Cpu, color: 'text-cyan-500', bgColor: 'bg-cyan-500/10' },
    { label: '平均延迟', value: `${avgLatency}ms`, hint: avgLatency > 30000 ? '需要关注慢请求' : '响应健康', icon: Activity, color: avgLatency > 30000 ? 'text-red-500' : 'text-green-500', bgColor: avgLatency > 30000 ? 'bg-red-500/10' : 'bg-green-500/10' },
  ]

  const planStats = {
    free: subscriptions.filter(s => s.plan === 'free').length,
    pro: subscriptions.filter(s => s.plan === 'pro').length,
    enterprise: subscriptions.filter(s => s.plan === 'enterprise').length,
  }
  const planTotal = Math.max(1, subscriptions.length)
  const topModels = Object.entries(logs.reduce<Record<string, number>>((acc, log) => {
    const key = log.model || 'unknown'
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})).sort((a, b) => b[1] - a[1]).slice(0, 5)
  const maxModelCalls = Math.max(1, ...topModels.map(([, count]) => count))
  const recentErrors = logs.filter(l => l.status === 'error').slice(0, 4)
  const slowLogs = logs.filter(l => Number(l.latency || 0) > 30000).slice(0, 4)
  const hourBuckets = Array.from({ length: 12 }, (_, index) => {
    const bucketStart = now - (12 - index) * 2 * 60 * 60 * 1000
    const bucketEnd = bucketStart + 2 * 60 * 60 * 1000
    return logs.filter(log => {
      const time = new Date(log.timestamp).getTime()
      return Number.isFinite(time) && time >= bucketStart && time < bucketEnd
    }).length
  })
  const maxBucket = Math.max(1, ...hourBuckets)

  return (
    <div className="mobile-scroll-bottom-safe flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold">系统概览</h2>
            <Badge variant={systemHealthy ? 'success' : 'destructive'} className="text-xs">
              {systemHealthy ? '运行健康' : '需要关注'}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">运营、模型渠道、成本和请求质量的实时驾驶舱</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className={cn('flex items-center gap-1.5 text-sm', systemHealthy ? 'text-green-500' : 'text-red-500')}>
            <div className={cn('w-2 h-2 rounded-full animate-pulse', systemHealthy ? 'bg-green-500' : 'bg-red-500')} />
            {systemHealthy ? '核心链路正常' : `${degradedChannels} 个异常渠道`}
          </div>
          <Button variant="outline" size="sm" onClick={refreshOverview} disabled={loading} className="gap-1.5">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            刷新
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-4">
        {kpis.map(({ label, value, hint, icon: Icon, color, bgColor }) => (
          <div key={label} className="bg-card rounded-xl border p-4 hover:shadow-sm transition-shadow">
            <div className="flex items-start justify-between gap-3 mb-3">
              <span className="text-sm text-muted-foreground">{label}</span>
              <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center', bgColor)}>
                <Icon className={cn('w-4 h-4', color)} />
              </div>
            </div>
            <p className="text-2xl font-bold tracking-tight">{value}</p>
            <p className="text-xs text-muted-foreground mt-1">{hint}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.15fr_0.85fr] gap-6">
        <div className="space-y-6">
          <div className="bg-card rounded-xl border p-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold">请求吞吐</h3>
                <p className="text-xs text-muted-foreground">最近 24 小时，每 2 小时聚合</p>
              </div>
              <Badge variant="outline" className="text-xs">{todayLogs.length} 次今日请求</Badge>
            </div>
            <div className="flex items-end gap-2 h-36">
              {hourBuckets.map((count, index) => (
                <div key={index} className="flex-1 min-w-0 flex flex-col items-center gap-2">
                  <div className="w-full rounded-t-md bg-gradient-to-t from-blue-500 to-cyan-400 transition-all" style={{ height: `${Math.max(6, (count / maxBucket) * 120)}px` }} />
                  <span className="text-[10px] text-muted-foreground">{count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-card rounded-xl border p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold">热门模型</h3>
                <Badge variant="outline" className="text-xs">{topModels.length} 个模型</Badge>
              </div>
              <div className="space-y-3">
                {topModels.map(([model, count]) => (
                  <div key={model} className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm gap-3">
                      <span className="truncate font-mono text-xs">{model}</span>
                      <span className="text-muted-foreground">{count}</span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${(count / maxModelCalls) * 100}%` }} />
                    </div>
                  </div>
                ))}
                {topModels.length === 0 && <p className="text-sm text-muted-foreground">暂无请求数据</p>}
              </div>
            </div>

            <div className="bg-card rounded-xl border p-4">
              <h3 className="text-sm font-semibold mb-4">质量与缓存</h3>
              <div className="grid grid-cols-2 gap-3">
                <MiniMetric label="成功请求" value={formatNumber(successLogs)} tone="green" />
                <MiniMetric label="异常请求" value={formatNumber(errorLogs)} tone={errorLogs ? 'red' : 'muted'} />
                <MiniMetric label="Token 总量" value={formatNumber(tokenTotal)} tone="blue" />
                <MiniMetric label="缓存命中 Token" value={`${cacheRate}%`} tone="purple" />
              </div>
              <div className="mt-4 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
                当前统计基于最近加载的 {logs.length} 条请求日志；生产环境可继续扩展为按小时/天聚合表。
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">渠道状态</h3>
            <Badge variant="outline" className="text-xs">{activeChannels} / {channels.length} 可用</Badge>
          </div>
          <div className="space-y-2 max-h-[520px] overflow-auto pr-1">
            {channels.map(ch => (
              <div key={ch.id} className="bg-card rounded-xl border p-3 flex items-center gap-3">
                <div className={cn('w-2.5 h-2.5 rounded-full shrink-0',
                  ch.status === 'active' ? 'bg-green-500' : ch.status === 'error' ? 'bg-red-500 animate-pulse' : 'bg-gray-400')} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{ch.name}</p>
                  <p className="text-xs text-muted-foreground">{ch.models.length} 个模型 · {ch.rateLimit} req/min</p>
                </div>
                <Badge variant={ch.status === 'active' ? 'success' : ch.status === 'error' ? 'destructive' : 'secondary'} className="text-xs shrink-0">
                  {ch.status === 'active' ? '正常' : ch.status === 'error' ? '异常' : '禁用'}
                </Badge>
              </div>
            ))}
            {channels.length === 0 && <p className="text-sm text-muted-foreground p-4 border rounded-xl">暂无渠道数据</p>}
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-card rounded-xl border p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold">订阅分布</h3>
              <Badge variant="outline" className="text-xs">{subscriptions.length} 条记录</Badge>
            </div>
            <div className="space-y-3">
              {[
                { label: '免费版', count: planStats.free, color: 'bg-gray-400' },
                { label: 'Pro 版', count: planStats.pro, color: 'bg-blue-500' },
                { label: '企业版', count: planStats.enterprise, color: 'bg-purple-500' },
              ].map(({ label, count, color }) => (
                <div key={label} className="space-y-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <span>{label}</span>
                    <span className="font-medium">{count} 人</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div className={cn('h-full rounded-full transition-all', color)}
                      style={{ width: `${(count / planTotal) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3 mt-4">
              <MiniMetric label="订阅收入" value={`¥${monthlyIncome.toFixed(0)}`} tone="purple" />
              <MiniMetric label="已用成本" value={`¥${totalCost.toFixed(2)}`} tone="orange" />
            </div>
          </div>

          <div className="bg-card rounded-xl border p-4">
            <h3 className="text-sm font-semibold mb-4">风险提醒</h3>
            <div className="space-y-2">
              {degradedChannels > 0 && <RiskItem tone="red" title={`${degradedChannels} 个渠道异常`} desc="建议检查 API Key、余额、网络和上游限流。" />}
              {disabledChannels > 0 && <RiskItem tone="muted" title={`${disabledChannels} 个渠道禁用`} desc="禁用渠道不会参与模型路由。" />}
              {avgLatency > 30000 && <RiskItem tone="amber" title="平均延迟偏高" desc="建议查看日志管理中的慢请求详情。" />}
              {successRate < 95 && <RiskItem tone="red" title="成功率低于 95%" desc="建议优先排查最近错误日志和异常渠道。" />}
              {degradedChannels === 0 && avgLatency <= 30000 && successRate >= 95 && (
                <RiskItem tone="green" title="暂无高优先级风险" desc="核心请求链路、渠道状态和成功率处于健康区间。" />
              )}
            </div>
          </div>

          <div className="bg-card rounded-xl border p-4">
            <h3 className="text-sm font-semibold mb-4">最近异常</h3>
            <div className="space-y-2">
              {(recentErrors.length ? recentErrors : slowLogs).map(log => (
                <div key={log.id} className="rounded-lg border p-3">
                  <div className="flex items-center gap-2 text-sm">
                    <div className={cn('w-2 h-2 rounded-full', log.status === 'error' ? 'bg-red-500' : 'bg-amber-500')} />
                    <span className="font-medium truncate">{log.model || '-'}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{log.latency}ms</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{log.errorMsg || log.channelName || log.provider || '慢请求，需要结合日志详情排查'}</p>
                </div>
              ))}
              {recentErrors.length === 0 && slowLogs.length === 0 && <p className="text-sm text-muted-foreground">暂无异常或慢请求</p>}
            </div>
          </div>

          <div className="bg-card rounded-xl border p-4">
            <h3 className="text-sm font-semibold mb-4">最近请求</h3>
            <div className="space-y-1.5">
              {logs.slice(0, 5).map(log => (
                <div key={log.id} className="flex items-center gap-2 text-xs p-2 rounded-lg hover:bg-muted/50 transition-colors">
                  <div className={cn('w-1.5 h-1.5 rounded-full shrink-0', log.status === 'success' ? 'bg-green-500' : 'bg-red-500')} />
                  <span className="font-medium">{String(log.userName || log.userId || '-')}</span>
                  <span className="text-muted-foreground truncate">{log.model}</span>
                  <span className="ml-auto text-muted-foreground shrink-0">{log.latency}ms</span>
                </div>
              ))}
              {logs.length === 0 && <p className="text-sm text-muted-foreground">暂无请求日志</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function MiniMetric({ label, value, tone }: { label: string; value: string; tone: 'blue' | 'green' | 'red' | 'purple' | 'orange' | 'muted' }) {
  const toneClass = {
    blue: 'bg-blue-500/10 text-blue-600',
    green: 'bg-green-500/10 text-green-600',
    red: 'bg-red-500/10 text-red-600',
    purple: 'bg-purple-500/10 text-purple-600',
    orange: 'bg-orange-500/10 text-orange-600',
    muted: 'bg-muted text-muted-foreground',
  }[tone]
  return (
    <div className={cn('rounded-lg p-3', toneClass)}>
      <div className="text-[11px] opacity-80">{label}</div>
      <div className="text-lg font-semibold mt-0.5">{value}</div>
    </div>
  )
}

function RiskItem({ tone, title, desc }: { tone: 'red' | 'amber' | 'green' | 'muted'; title: string; desc: string }) {
  const dotClass = {
    red: 'bg-red-500',
    amber: 'bg-amber-500',
    green: 'bg-green-500',
    muted: 'bg-muted-foreground',
  }[tone]
  return (
    <div className="rounded-lg border p-3 flex gap-3">
      <div className={cn('w-2 h-2 rounded-full mt-1.5 shrink-0', dotClass)} />
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
      </div>
    </div>
  )
}

// ==================== Users ====================
function UsersTab() {
  const { users, addUser, updateUser, deleteUser, setUsers } = useAdminStore()
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'suspended'>('all')
  const [editUser, setEditUser] = useState<User | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // 角色列表（从角色表动态获取）
  const [roleList, setRoleList] = useState<SysRoleVO[]>([])
  const [rolesLoading, setRolesLoading] = useState(false)

  const mapUser = useCallback((u: any): User => ({
    id: String(u.id ?? u.uuid ?? ''),
    name: u.name,
    email: u.email,
    avatar: u.avatar,
    role: u.role,
    plan: u.plan,
    tokensUsed: u.tokensUsed ?? 0,
    tokensLimit: u.tokensLimit ?? 50000,
    createdAt: u.createdAt ?? '',
    status: u.status,
    costUsed: Number(u.costUsed ?? 0),
    costLimit: Number(u.costLimit ?? 0),
  }), [])

  const loadUsersAndRoles = useCallback(async () => {
    if (isDemoMode()) return
    setLoading(true)
    setRolesLoading(true)
    try {
      const [res, roles] = await Promise.all([
        adminApi.listUsers({ page: 1, size: 100 }),
        rbacApi.listRoles().catch(() => [] as SysRoleVO[]),
      ])
      setUsers((res.list || []).map(mapUser))
      setRoleList(Array.isArray(roles) ? roles : [])
    } catch (e) {
      console.warn('加载用户列表失败:', e)
    } finally {
      setLoading(false)
      setRolesLoading(false)
    }
  }, [mapUser, setUsers])

  useEffect(() => {
    loadUsersAndRoles()
  }, [loadUsersAndRoles])

  const emptyUser: Partial<User> = { name: '', email: '', role: 'user', plan: 'free', status: 'active', tokensUsed: 0, tokensLimit: 50000, costUsed: 0, costLimit: 0 }
  const [formData, setFormData] = useState<Partial<User>>(emptyUser)
  const [password, setPassword] = useState('')
  const [resetPassword, setResetPassword] = useState(false)

  // 根据 roleCode 获取角色名称
  const getRoleName = (code: string) => {
    const role = roleList.find(r => r.roleCode === code)
    return role?.roleName || code
  }

  const filtered = useMemo(() => users.filter(u => {
    const matchSearch = u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase())
    const matchRole = roleFilter === 'all' || u.role === roleFilter
    const matchStatus = statusFilter === 'all' || u.status === statusFilter
    return matchSearch && matchRole && matchStatus
  }), [users, search, roleFilter, statusFilter])

  const openEdit = (u: User) => { setEditUser(u); setFormData(u); setPassword(''); setResetPassword(false) }
  const openAdd = () => { setShowAdd(true); setFormData(emptyUser); setPassword('') }

  const handleSave = async () => {
    if (!formData.name || !formData.email) return
    if (!editUser && !password) { alert('请设置初始密码'); return }
    if (editUser) {
      if (!isDemoMode()) {
        try {
          const payload: any = { name: formData.name, email: formData.email, role: formData.role, plan: formData.plan, status: formData.status, costLimit: formData.costLimit }
          if (resetPassword && password) payload.password = password
          await adminApi.updateUser(editUser.id, payload)
          await loadUsersAndRoles()
        } catch (e) { alert((e as any).message || '更新失败'); return }
      } else { updateUser(editUser.id, formData) }
      setEditUser(null)
    } else {
      if (!isDemoMode()) {
        try {
          await adminApi.createUser({ name: formData.name, email: formData.email, role: formData.role, plan: formData.plan, status: formData.status, costLimit: formData.costLimit, tokensLimit: formData.tokensLimit, password } as any)
          await loadUsersAndRoles()
        } catch (e) { alert((e as any).message || '创建失败'); return }
      } else {
        addUser({ id: `user_${Date.now()}`, name: formData.name!, email: formData.email!, role: formData.role || 'user', plan: formData.plan || 'free', status: formData.status || 'active', tokensUsed: 0, tokensLimit: formData.plan === 'enterprise' ? 5000000 : formData.plan === 'pro' ? 500000 : 50000, costUsed: 0, costLimit: Number(formData.costLimit ?? 0), createdAt: new Date().toISOString() })
      }
      setShowAdd(false)
    }
    setFormData(emptyUser)
    setPassword('')
    setResetPassword(false)
  }

  const handleUpdateUser = async (id: string, updates: Partial<User>) => {
    if (!isDemoMode()) {
      try {
        await adminApi.updateUser(id, updates as any)
        await loadUsersAndRoles()
      }
      catch (e) { alert((e as any).message || '更新用户失败') }
    } else {
      updateUser(id, updates)
    }
  }

  const handleDeleteUser = async (id: string) => {
    if (!isDemoMode()) {
      try {
        await adminApi.deleteUser(id)
        await loadUsersAndRoles()
      }
      catch (e) { alert((e as any).message || '删除失败'); return }
    }
    deleteUser(id)
    setDeleteConfirm(null)
  }

  return (
    <div className="mobile-scroll-bottom-safe flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-semibold">用户管理</h2>
          <p className="text-sm text-muted-foreground">共 {users.length} 位用户，{users.filter(u => u.status === 'active').length} 人活跃</p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={openAdd}><Plus className="w-4 h-4" />添加用户</Button>
      </div>

      <div className="flex gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索用户名或邮箱..." className="pl-9" />
        </div>
        <Select value={roleFilter} onValueChange={v => setRoleFilter(v)}>
          <SelectTrigger className="w-36"><SelectValue placeholder="角色" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部角色</SelectItem>
            {roleList.map(r => (
              <SelectItem key={r.roleCode} value={r.roleCode}>{r.roleName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={v => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="w-32"><SelectValue placeholder="状态" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="active">正常</SelectItem>
            <SelectItem value="suspended">封禁</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="bg-card rounded-xl border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">用户</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">角色</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">套餐</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground w-40">消费额度</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">状态</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">注册时间</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(u => {
              const costLimit = Number(u.costLimit ?? 0)
              const costUsed = Number(u.costUsed ?? 0)
              const costPct = costLimit > 0 ? Math.round((costUsed / costLimit) * 100) : 0
              return (
                <tr key={u.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center text-xs font-semibold text-primary shrink-0">{u.name[0].toUpperCase()}</div>
                      <div><p className="font-medium">{u.name}</p><p className="text-xs text-muted-foreground">{u.email}</p></div>
                    </div>
                  </td>
                  <td className="px-4 py-3"><Badge variant={u.role === 'admin' || u.role === 'super_admin' ? 'default' : 'secondary'} className="text-xs">{getRoleName(u.role)}</Badge></td>
                  <td className="px-4 py-3"><Badge variant="outline" className="text-xs">{u.plan === 'free' ? '免费' : u.plan === 'pro' ? 'Pro' : '企业'}</Badge></td>
                  <td className="px-4 py-3 w-40">
                    <div className="space-y-1"><Progress value={costLimit > 0 ? Math.min(costPct, 100) : 0} className="h-1.5" /><p className="text-xs text-muted-foreground">¥{costUsed.toFixed(4)} / {costLimit > 0 ? `¥${costLimit.toFixed(2)}` : '不限'}</p></div>
                  </td>
                  <td className="px-4 py-3"><Badge variant={u.status === 'active' ? 'success' : 'destructive'} className="text-xs">{u.status === 'active' ? '正常' : '封禁'}</Badge></td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(u.createdAt)}</td>
                  <td className="px-4 py-3">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="h-7 w-7"><MoreHorizontal className="w-4 h-4" /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(u)}><Edit className="w-4 h-4 mr-2" />编辑用户</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => {
                          // 在非 admin/super_admin 之间切换角色
                          const nextRole = u.role === 'admin' || u.role === 'super_admin' ? 'user' : 'admin'
                          handleUpdateUser(u.id, { role: nextRole })
                        }}><Shield className="w-4 h-4 mr-2" />{u.role === 'admin' || u.role === 'super_admin' ? '撤销管理员' : '设为管理员'}</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => handleUpdateUser(u.id, { status: u.status === 'active' ? 'suspended' : 'active' })} className={u.status === 'active' ? 'text-destructive' : 'text-green-600'}>
                          {u.status === 'active' ? <Ban className="w-4 h-4 mr-2" /> : <UserCheck className="w-4 h-4 mr-2" />}
                          {u.status === 'active' ? '封禁用户' : '解封用户'}
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive" onClick={() => setDeleteConfirm(u.id)}><Trash2 className="w-4 h-4 mr-2" />删除用户</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
        {filtered.length === 0 && <div className="text-center py-12 text-muted-foreground"><Users className="w-8 h-8 mx-auto mb-2 opacity-40" /><p className="text-sm">未找到匹配的用户</p></div>}
      </div>

      <Dialog open={!!(editUser || showAdd)} onOpenChange={open => { if (!open) { setEditUser(null); setShowAdd(false) } }}>
        <DialogContent className="max-w-[95vw] sm:max-w-md">
          <DialogHeader><DialogTitle>{editUser ? '编辑用户' : '添加用户'}</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>姓名 <span className="text-destructive">*</span></Label><Input value={formData.name || ''} onChange={e => setFormData({ ...formData, name: e.target.value })} placeholder="用户姓名" /></div>
              <div className="space-y-1.5"><Label>邮箱 <span className="text-destructive">*</span></Label><Input value={formData.email || ''} onChange={e => setFormData({ ...formData, email: e.target.value })} placeholder="user@example.com" type="email" /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>角色</Label>
                <Select value={formData.role || 'user'} onValueChange={v => setFormData({ ...formData, role: v as User['role'] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {rolesLoading && <div className="px-2 py-1.5 text-xs text-muted-foreground">加载中...</div>}
                    {roleList.map(r => (
                      <SelectItem key={r.roleCode} value={r.roleCode}>{r.roleName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5"><Label>套餐</Label>
                <Select value={formData.plan || 'free'} onValueChange={v => setFormData({ ...formData, plan: v as User['plan'] })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="free">免费版</SelectItem><SelectItem value="pro">Pro 版</SelectItem><SelectItem value="enterprise">企业版</SelectItem></SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5"><Label>月消费额度 (¥)</Label><Input type="number" step="0.01" value={formData.costLimit ?? ''} onChange={e => setFormData({ ...formData, costLimit: Number(e.target.value) })} placeholder="0 表示不限" /></div>
            <div className="space-y-1.5"><Label>状态</Label>
              <Select value={formData.status || 'active'} onValueChange={v => setFormData({ ...formData, status: v as User['status'] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="active">正常</SelectItem><SelectItem value="suspended">封禁</SelectItem></SelectContent>
              </Select>
            </div>
            {/* 密码字段：添加时必填，编辑时可选重置 */}
            {!editUser ? (
              <div className="space-y-1.5">
                <Label>初始密码 <span className="text-destructive">*</span></Label>
                <Input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="至少 8 位"
                />
                <p className="text-[10px] text-muted-foreground">用户首次登录后可自行修改密码</p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="resetPwd" checked={resetPassword} onChange={e => setResetPassword(e.target.checked)} className="rounded" />
                  <Label htmlFor="resetPwd" className="cursor-pointer">重置密码</Label>
                </div>
                {resetPassword && (
                  <Input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="输入新密码（至少 8 位）"
                  />
                )}
              </div>
            )}
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => { setEditUser(null); setShowAdd(false) }}>取消</Button>
            <Button onClick={handleSave} disabled={!formData.name || !formData.email || (!editUser && !password)}>{editUser ? '保存修改' : '添加用户'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="flex items-center gap-2 text-destructive"><AlertTriangle className="w-5 h-5" />确认删除</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">此操作不可撤销，用户的所有数据将被永久删除。</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>取消</Button>
            <Button variant="destructive" onClick={() => { if (deleteConfirm) handleDeleteUser(deleteConfirm) }}>确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ==================== Channels ====================
function ChannelsTab() {
  const { channels, addChannel, updateChannel, deleteChannel, setChannels } = useAdminStore()
  const [showDialog, setShowDialog] = useState(false)
  const [editChannel, setEditChannel] = useState<ModelChannel | null>(null)
  const [showKey, setShowKey] = useState<Record<string, boolean>>({})
  const [testResult, setTestResult] = useState<Record<string, { state: 'testing' | 'ok' | 'fail'; latency?: number; msg?: string }>>({})
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [fetchingModels, setFetchingModels] = useState<string | null>(null)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const [fetchError, setFetchError] = useState('')
  // 批量操作
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [batchTesting, setBatchTesting] = useState(false)
  const [batchFetching, setBatchFetching] = useState(false)
  // 模型列表折叠状态：记录哪些渠道展开了完整模型列表
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (isDemoMode()) return
    adminApi.listChannels().then(list => {
      const mapped: ModelChannel[] = (list as any[]).map(c => ({
        id: String(c.uuid || c.id), name: c.name, provider: c.provider,
        apiKey: c.apiKey || '', baseUrl: c.baseUrl || '',
        models: Array.isArray(c.models) ? c.models : (c.models ? c.models.split(',').filter(Boolean) : []),
        tags: (() => {
          if (!c.tags) return []
          if (Array.isArray(c.tags)) return c.tags
          try { return JSON.parse(c.tags) } catch { return c.tags.split(',').map((s: string) => s.trim()).filter(Boolean) }
        })(),
        ttsVoices: c.ttsVoices || '',          // TTS 音色配置 JSON
        translateLangs: c.translateLangs || '',   // 翻译语言配置 JSON
        status: c.status || 'active', priority: c.priority || 1,
        rateLimit: c.rateLimit || 60, createdAt: c.createdAt || '',
        channelType: c.channelType || 'chat',
      } as any))
      setChannels(mapped)
    }).catch(console.warn)
  }, [])

  const emptyForm = { name: '', provider: 'OpenAI', apiKeys: '', baseUrl: '', models: '', channelType: 'chat', tags: '', ttsVoices: '', translateLangs: '', rateLimit: 60, priority: channels.length + 1 }
  const [form, setForm] = useState(emptyForm)

  const providers = ['OpenAI', 'Anthropic', 'Google', 'DeepSeek', 'Alibaba', 'Doubao', 'Baidu', 'Zhipu', 'Minimax', 'Mistral', 'Cohere', 'Custom']
  const providerFormats: Record<string, { label: string; detail: string; className: string }> = {
    OpenAI: { label: '官方原生', detail: '文本对话使用 OpenAI Chat Completions 格式', className: 'border-emerald-500/30 text-emerald-700 dark:text-emerald-300' },
    Anthropic: { label: '官方原生', detail: '文本对话使用 Anthropic Messages 格式', className: 'border-emerald-500/30 text-emerald-700 dark:text-emerald-300' },
    Google: { label: '官方原生', detail: '文本对话使用 Gemini generateContent 格式', className: 'border-emerald-500/30 text-emerald-700 dark:text-emerald-300' },
    Alibaba: { label: '兼容+原生', detail: '对话使用 DashScope OpenAI 兼容格式，TTS 使用 DashScope 原生格式', className: 'border-amber-500/30 text-amber-700 dark:text-amber-300' },
    Doubao: { label: '搜索专用', detail: '当前后端只接入豆包联网搜索，不是通用聊天 Provider', className: 'border-sky-500/30 text-sky-700 dark:text-sky-300' },
    DeepSeek: { label: 'OpenAI 兼容', detail: '按 OpenAI-compatible /chat/completions 调用', className: 'border-muted-foreground/30 text-muted-foreground' },
    Baidu: { label: 'OpenAI 兼容', detail: '按 OpenAI-compatible /chat/completions 调用，不是百度千帆原生格式', className: 'border-muted-foreground/30 text-muted-foreground' },
    Zhipu: { label: 'OpenAI 兼容', detail: '按 OpenAI-compatible /chat/completions 调用，不是智谱原生独立适配', className: 'border-muted-foreground/30 text-muted-foreground' },
    Minimax: { label: 'OpenAI 兼容', detail: '按 OpenAI-compatible /chat/completions 调用', className: 'border-muted-foreground/30 text-muted-foreground' },
    Mistral: { label: 'OpenAI 兼容', detail: '按 OpenAI-compatible /chat/completions 调用', className: 'border-muted-foreground/30 text-muted-foreground' },
    Cohere: { label: 'OpenAI 兼容', detail: '按 OpenAI-compatible /chat/completions 调用，不是 Cohere 原生 Chat 格式', className: 'border-muted-foreground/30 text-muted-foreground' },
    Custom: { label: 'OpenAI 兼容', detail: '自定义渠道默认按 OpenAI-compatible /chat/completions 调用', className: 'border-muted-foreground/30 text-muted-foreground' },
  }
  const getProviderFormat = (provider: string) => providerFormats[provider] || providerFormats.Custom
  const providerDefaults: Record<string, { baseUrl: string; models: string }> = {
    OpenAI: { baseUrl: 'https://api.openai.com/v1', models: 'gpt-4o,gpt-4o-mini,gpt-3.5-turbo' },
    Anthropic: { baseUrl: 'https://api.anthropic.com', models: 'claude-3-5-sonnet,claude-3-opus,claude-3-haiku' },
    Google: { baseUrl: 'https://generativelanguage.googleapis.com', models: 'gemini-2.0-flash,gemini-1.5-pro' },
    DeepSeek: { baseUrl: 'https://api.deepseek.com/v1', models: 'deepseek-chat,deepseek-reasoner' },
    Alibaba: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: 'qwen-max,qwen-plus,qwen-turbo' },
    Doubao: { baseUrl: 'https://open.feedcoopapi.com/search_api/global_search', models: 'global_search' },
    Baidu: { baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1', models: 'ernie-4.0-turbo,ernie-3.5' },
    Zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: 'glm-4,glm-4v,glm-3-turbo' },
    Minimax: { baseUrl: 'https://api.minimax.chat/v1', models: 'abab6.5s-chat,abab5.5-chat' },
    Mistral: { baseUrl: 'https://api.mistral.ai/v1', models: 'mistral-large,mistral-small' },
    Cohere: { baseUrl: 'https://api.cohere.ai/v1', models: 'command-r-plus,command-r' },
  }

  // 解析多 API Key（换行/逗号分隔）
  const parseApiKeys = (raw: string) => raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean)

  const openAdd = () => { setEditChannel(null); setForm(emptyForm); setShowDialog(true) }
  const openEdit = (ch: ModelChannel) => {
    setEditChannel(ch)
    setForm({
      name: ch.name, provider: ch.provider,
      apiKeys: ch.apiKey,  // apiKey 字段里可能已存储多个（逗号分隔），展示时换行显示
      baseUrl: ch.baseUrl, models: ch.models.join(','),
      channelType: ch.channelType || 'chat', rateLimit: ch.rateLimit, priority: ch.priority,
      tags: (ch.tags || []).join(','),
      ttsVoices: ch.ttsVoices || '',
      translateLangs: ch.translateLangs || '',
    })
    setShowDialog(true)
  }
  const handleProviderChange = (provider: string) => {
    const d = providerDefaults[provider] || { baseUrl: '', models: '' }
    setForm({ ...form, provider, baseUrl: d.baseUrl, models: d.models })
  }

  const handleSave = async () => {
    if (!form.name || !form.apiKeys.trim()) return
    const keys = parseApiKeys(form.apiKeys)
    // 多个 Key 以逗号拼接存储，后端请求时轮询使用
    const apiKey = keys.join(',')
    const data = { name: form.name, provider: form.provider, apiKey, baseUrl: form.baseUrl, models: form.models.split(',').map(s => s.trim()).filter(Boolean), channelType: (form as any).channelType || 'chat', tags: (form as any).tags ? (form as any).tags.split(',').map((s: string) => s.trim()).filter(Boolean) : [], rateLimit: form.rateLimit, priority: form.priority, ttsVoices: form.ttsVoices || '', translateLangs: form.translateLangs || '' }
    if (editChannel) {
      if (!isDemoMode()) { try { await adminApi.updateChannel(editChannel.id, data) } catch (e) { alert((e as any).message || '更新失败'); return } }
      updateChannel(editChannel.id, data)
    } else {
      if (!isDemoMode()) {
        try { const c = await adminApi.createChannel(data) as any; addChannel({ ...data, id: c.uuid || c.id || `ch_${Date.now()}`, status: 'active', createdAt: new Date().toISOString() }) }
        catch (e) { alert((e as any).message || '创建失败'); return }
      } else { addChannel({ ...data, id: `ch_${Date.now()}`, status: 'active', createdAt: new Date().toISOString() }) }
    }
    setShowDialog(false)
  }

  const handleTest = async (id: string) => {
    setTestResult(prev => ({ ...prev, [id]: { state: 'testing' } }))
    if (isDemoMode()) {
      await new Promise(r => setTimeout(r, 1200))
      const ok = Math.random() > 0.3
      setTestResult(prev => ({ ...prev, [id]: { state: ok ? 'ok' : 'fail', latency: Math.floor(Math.random() * 500) + 100 } }))
      updateChannel(id, { status: ok ? 'active' : 'error' }); return
    }
    try {
      const res = await adminApi.testChannel(id)
      setTestResult(prev => ({ ...prev, [id]: { state: res.ok ? 'ok' : 'fail', latency: res.latency, msg: res.message } }))
      updateChannel(id, { status: res.ok ? 'active' : 'error' })
    } catch (e) {
      const err = e as any
      setTestResult(prev => ({ ...prev, [id]: { state: 'fail', msg: err.message } }))
      updateChannel(id, { status: 'error' })
    }
    setTimeout(() => setTestResult(prev => { const n = { ...prev }; delete n[id]; return n }), 5000)
  }

  // 批量测试
  const handleBatchTest = async () => {
    if (selectedIds.size === 0) return
    setBatchTesting(true)
    const ids = Array.from(selectedIds)
    await Promise.all(ids.map(id => handleTest(id)))
    setBatchTesting(false)
  }

  const handleFetchModels = async (ch: ModelChannel) => {
    setFetchingModels(ch.id); setAvailableModels([]); setFetchError(''); setSelectedModels(new Set(ch.models))
    if (isDemoMode()) { await new Promise(r => setTimeout(r, 800)); setAvailableModels(['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo']); return }
    try {
      const models = await adminApi.fetchChannelModels(ch.id)
      setAvailableModels(models)
      if (models.length === 0) setFetchError('未获取到模型，请检查 API Key 和 Base URL')
    } catch (e) { setFetchError((e as any).message || '获取失败') }
  }

  // 批量获取模型列表
  const handleBatchFetchModels = async () => {
    if (selectedIds.size === 0) return
    setBatchFetching(true)
    const ids = Array.from(selectedIds)
    await Promise.all(ids.map(async id => {
      const ch = channels.find(c => c.id === id)
      if (!ch) return
      if (isDemoMode()) {
        await new Promise(r => setTimeout(r, 800))
        updateChannel(id, { models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'] })
        return
      }
      try {
        const models = await adminApi.fetchChannelModels(id)
        if (models.length > 0) {
          await adminApi.updateChannelModels(id, models)
          updateChannel(id, { models })
        }
      } catch (e) { console.warn(`获取渠道 ${ch.name} 模型失败:`, e) }
    }))
    setBatchFetching(false)
    alert(`批量获取模型完成，共处理 ${ids.length} 个渠道`)
  }

  const handleSaveModels = async () => {
    if (!fetchingModels) return
    const models = Array.from(selectedModels)
    if (!isDemoMode()) { try { await adminApi.updateChannelModels(fetchingModels, models) } catch (e) { alert((e as any).message || '保存失败'); return } }
    updateChannel(fetchingModels, { models }); setFetchingModels(null)
  }

  // 修复：删除时同步从 store 移除，避免刷新回显
  const handleDelete = async (id: string) => {
    if (!isDemoMode()) {
      try { await adminApi.deleteChannel(id) }
      catch (e) { alert((e as any).message || '删除失败'); return }
    }
    deleteChannel(id)
    setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next })
    setDeleteConfirm(null)
  }

  const maskKey = (key: string) => {
    if (!key) return '****'
    const keys = key.split(',').filter(Boolean)
    if (keys.length > 1) return `${keys[0].slice(0, 6)}**** 等 ${keys.length} 个 Key`
    if (key.length < 8) return '****'
    return key.slice(0, 6) + '****' + key.slice(-4)
  }
  const fetchingChannel = channels.find(c => c.id === fetchingModels)

  const toggleSelect = (id: string) => setSelectedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  const toggleSelectAll = () => setSelectedIds(prev => prev.size === channels.length ? new Set() : new Set(channels.map(c => c.id)))

  return (
    <div className="mobile-scroll-bottom-safe flex-1 overflow-y-auto p-4 md:p-6">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold">模型渠道管理</h2>
          <p className="text-sm text-muted-foreground">管理 AI 模型接入渠道，支持主流平台</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {selectedIds.size > 0 && (
            <>
              <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={handleBatchTest} disabled={batchTesting}>
                <Activity className="w-3.5 h-3.5" />{batchTesting ? '测试中...' : `批量测试 (${selectedIds.size})`}
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={handleBatchFetchModels} disabled={batchFetching}>
                <RefreshCw className={cn('w-3.5 h-3.5', batchFetching && 'animate-spin')} />{batchFetching ? '获取中...' : `批量获取模型 (${selectedIds.size})`}
              </Button>
            </>
          )}
          <Button size="sm" className="gap-1.5" onClick={openAdd}><Plus className="w-4 h-4" />添加渠道</Button>
        </div>
      </div>

      {channels.length > 0 && (
        <div className="flex items-center gap-2 mb-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input type="checkbox" checked={selectedIds.size === channels.length && channels.length > 0} onChange={toggleSelectAll} className="rounded" />
            全选（{selectedIds.size}/{channels.length}）
          </label>
        </div>
      )}

      <div className="space-y-3">
        {channels.map(ch => (
          <div key={ch.id} className={cn('bg-card rounded-xl border p-4 transition-shadow hover:shadow-sm', ch.status === 'error' && 'border-destructive/40 bg-destructive/5', selectedIds.has(ch.id) && 'ring-2 ring-primary/40')}>
            <div className="flex items-start gap-3 md:gap-4">
              {/* 复选框 */}
              <input type="checkbox" checked={selectedIds.has(ch.id)} onChange={() => toggleSelect(ch.id)} className="rounded mt-1.5 shrink-0" />
              <div className={cn('w-3 h-3 rounded-full shrink-0 mt-1.5', ch.status === 'active' ? 'bg-green-500' : ch.status === 'error' ? 'bg-red-500 animate-pulse' : 'bg-gray-400')} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="font-semibold">{ch.name}</span>
                  <Badge variant="outline" className="text-xs">{ch.provider}</Badge>
                  <Badge variant="outline" className={cn('text-xs', getProviderFormat(ch.provider).className)} title={getProviderFormat(ch.provider).detail}>
                    {getProviderFormat(ch.provider).label}
                  </Badge>
                  <Badge variant={ch.status === 'active' ? 'success' : ch.status === 'error' ? 'destructive' : 'secondary'} className="text-xs">
                    {ch.status === 'active' ? '正常' : ch.status === 'error' ? '异常' : '禁用'}
                  </Badge>
                  {(ch as any).channelType && (ch as any).channelType !== 'chat' && (
                    <Badge variant="outline" className="text-xs text-primary border-primary/40">
                      {(ch as any).channelType === 'translate' ? '翻译' : (ch as any).channelType === 'image' ? '图片' : (ch as any).channelType === 'asr' ? '语音识别' : (ch as any).channelType === 'search' ? '搜索' : 'TTS'}
                    </Badge>
                  )}
                  {testResult[ch.id]?.state === 'testing' && <Badge variant="outline" className="text-xs animate-pulse">测试中...</Badge>}
                  {testResult[ch.id]?.state === 'ok' && <Badge variant="success" className="text-xs">✓ {testResult[ch.id].latency}ms</Badge>}
                  {testResult[ch.id]?.state === 'fail' && <Badge variant="destructive" className="text-xs">✗ {testResult[ch.id].msg || '失败'}</Badge>}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2"><Globe className="w-3 h-3 shrink-0" /><span className="truncate">{ch.baseUrl}</span></div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                  <Key className="w-3 h-3 shrink-0" />
                  <span className="font-mono">{showKey[ch.id] ? ch.apiKey : maskKey(ch.apiKey)}</span>
                  <button onClick={() => setShowKey(prev => ({ ...prev, [ch.id]: !prev[ch.id] }))} className="p-0.5 hover:text-foreground">
                    {showKey[ch.id] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1 max-w-md">
                  {(() => {
                    const MAX_VISIBLE = 6
                    const models = ch.models.filter(Boolean)
                    const expanded = expandedChannels.has(ch.id)
                    const visible = expanded ? models : models.slice(0, MAX_VISIBLE)
                    const hiddenCount = models.length - MAX_VISIBLE
                    return (
                      <>
                        {visible.map(m => (
                          <span key={m} className="group inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground border border-border/50">
                            {m}
                            <button onClick={async e => {
                              e.stopPropagation()
                              const newModels = ch.models.filter(x => x !== m)
                              updateChannel(ch.id, { models: newModels })
                              if (!isDemoMode()) { try { await adminApi.updateChannelModels(ch.id, newModels) } catch (err) { console.warn('移除模型失败:', err) } }
                            }} className="opacity-0 group-hover:opacity-100 hover:text-destructive transition-all" title={`移除 ${m}`}>
                              <X className="w-2.5 h-2.5" />
                            </button>
                          </span>
                        ))}
                        {!expanded && hiddenCount > 0 && (
                          <button
                            onClick={e => { e.stopPropagation(); setExpandedChannels(prev => { const next = new Set(prev); next.add(ch.id); return next }) }}
                            className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 transition-colors"
                          >
                            +{hiddenCount} 个，展开
                          </button>
                        )}
                        {expanded && models.length > MAX_VISIBLE && (
                          <button
                            onClick={e => { e.stopPropagation(); setExpandedChannels(prev => { const next = new Set(prev); next.delete(ch.id); return next }) }}
                            className="text-[10px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground border border-border/50 hover:bg-muted/80 transition-colors"
                          >
                            收起
                          </button>
                        )}
                      </>
                    )
                  })()}
                  {ch.models.length === 0 && <span className="text-[10px] text-muted-foreground italic">暂无模型，点击"获取模型"添加</span>}
                </div>
              </div>
              <div className="flex items-center gap-2 md:gap-3 shrink-0">
                <div className="text-right text-xs text-muted-foreground hidden md:block"><p>优先级 {ch.priority}</p><p>{ch.rateLimit} req/min</p></div>
                <Switch checked={ch.status !== 'disabled'} onCheckedChange={async v => {
                  const newStatus = v ? 'active' : 'disabled'
                  updateChannel(ch.id, { status: newStatus })
                  if (!isDemoMode()) { try { await adminApi.updateChannel(ch.id, { status: newStatus } as any) } catch (e) { console.warn('更新渠道状态失败:', e) } }
                }} />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="h-8 w-8"><MoreHorizontal className="w-4 h-4" /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => openEdit(ch)}><Edit className="w-4 h-4 mr-2" />编辑渠道</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleFetchModels(ch)}><RefreshCw className="w-4 h-4 mr-2" />获取模型列表</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleTest(ch.id)} disabled={testResult[ch.id]?.state === 'testing'}><Activity className="w-4 h-4 mr-2" />测试连接</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive" onClick={() => setDeleteConfirm(ch.id)}><Trash2 className="w-4 h-4 mr-2" />删除渠道</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 添加/编辑渠道弹窗 */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editChannel ? '编辑渠道' : '添加模型渠道'}</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>渠道名称 <span className="text-destructive">*</span></Label><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="如: OpenAI 官方" /></div>
              <div className="space-y-1.5"><Label>供应商</Label>
                <Select value={form.provider} onValueChange={handleProviderChange}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{providers.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">
                  {getProviderFormat(form.provider).label}：{getProviderFormat(form.provider).detail}
                </p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>渠道用途</Label>
              <Select value={(form as any).channelType || 'chat'} onValueChange={v => setForm({ ...form, channelType: v } as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="chat">对话（Chat）</SelectItem>
                  <SelectItem value="translate">翻译（Translate）</SelectItem>
                  <SelectItem value="tts">语音合成（TTS）</SelectItem>
                  <SelectItem value="asr">语音识别（ASR）</SelectItem>
                  <SelectItem value="image">图片生成（Image）</SelectItem>
                  <SelectItem value="search">联网搜索（Search）</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">翻译、TTS、ASR、搜索渠道会优先用于对应功能；豆包搜索使用 Bearer API Key</p>
            </div>
            <div className="space-y-1.5">
              <Label>
                能力标签
                <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">（逗号分隔：tool 支持函数调用, vision 支持图片识别）</span>
              </Label>
              <Input
                value={(form as any).tags || ''}
                onChange={e => setForm({ ...form, tags: e.target.value })}
                placeholder="tool,vision"
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                API Key <span className="text-destructive">*</span>
                <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">（支持多个，每行填写一个，请求时自动轮询）</span>
              </Label>
              <Textarea
                value={form.apiKeys}
                onChange={e => setForm({ ...form, apiKeys: e.target.value })}
                placeholder={'sk-xxxx1\nsk-xxxx2\nsk-xxxx3'}
                rows={3}
                className="font-mono text-xs"
              />
              {form.apiKeys.split(/[\n,]/).filter(s => s.trim()).length > 1 && (
                <p className="text-[10px] text-primary">已填写 {form.apiKeys.split(/[\n,]/).filter(s => s.trim()).length} 个 API Key，将自动轮询使用</p>
              )}
            </div>
            <div className="space-y-1.5"><Label>Base URL</Label><Input value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" /></div>
            <div className="space-y-1.5"><Label>模型列表（逗号分隔，也可保存后点"获取模型"自动填充）</Label><Textarea value={form.models} onChange={e => setForm({ ...form, models: e.target.value })} placeholder="gpt-4o,gpt-4o-mini" rows={2} /></div>

            {/* TTS 音色配置（仅渠道用途=语音合成时显示） */}
            {form.channelType === 'tts' && (
              <div className="space-y-1.5">
                <Label>TTS 音色配置</Label>
                <p className="text-[10px] text-muted-foreground">配置此渠道支持的音色，用户可在消息气泡中选择。点击 🔊 可预览音色。</p>
                <TtsVoiceEditor
                  key={`tts-${editChannel?.id || 'new'}`}
                  value={form.ttsVoices}
                  onChange={v => setForm({ ...form, ttsVoices: v })}
                  channelId={editChannel?.id}
                />
              </div>
            )}

            {/* 翻译语言配置（仅渠道用途=翻译时显示） */}
            {form.channelType === 'translate' && (
              <div className="space-y-1.5">
                <Label>翻译支持语言</Label>
                <p className="text-[10px] text-muted-foreground">配置此渠道支持的翻译目标语言，用户可在消息气泡中选择。</p>
                <TranslateLangEditor
                  key={`translate-${editChannel?.id || 'new'}`}
                  value={form.translateLangs}
                  onChange={v => setForm({ ...form, translateLangs: v })}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>速率限制 (req/min)</Label><Input type="number" value={form.rateLimit} onChange={e => setForm({ ...form, rateLimit: Number(e.target.value) })} /></div>
              <div className="space-y-1.5"><Label>优先级</Label><Input type="number" min="1" value={form.priority} onChange={e => setForm({ ...form, priority: Number(e.target.value) })} /></div>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setShowDialog(false)}>取消</Button>
            <Button onClick={handleSave} disabled={!form.name || !form.apiKeys.trim()}>{editChannel ? '保存修改' : '添加渠道'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 获取模型列表弹窗 */}
      <Dialog open={!!fetchingModels} onOpenChange={open => { if (!open) setFetchingModels(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>获取模型列表 — {fetchingChannel?.name}</DialogTitle></DialogHeader>
          <div className="mt-2">
            {availableModels.length === 0 && !fetchError && (
              <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />正在从 API 获取模型列表...
              </div>
            )}
            {fetchError && <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md mb-3">{fetchError}</div>}
            {availableModels.length > 0 && (
              <>
                <p className="text-xs text-muted-foreground mb-3">共 {availableModels.length} 个模型，已选 {selectedModels.size} 个。勾选要加入渠道的模型：</p>
                <div className="max-h-72 overflow-y-auto space-y-1 border rounded-lg p-2">
                  {availableModels.map(m => (
                    <label key={m} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted cursor-pointer text-sm">
                      <input type="checkbox" checked={selectedModels.has(m)} onChange={e => { const next = new Set(selectedModels); e.target.checked ? next.add(m) : next.delete(m); setSelectedModels(next) }} className="rounded" />
                      <span className="font-mono text-xs">{m}</span>
                    </label>
                  ))}
                </div>
                <div className="flex gap-2 mt-2">
                  <Button size="sm" variant="outline" className="text-xs" onClick={() => setSelectedModels(new Set(availableModels))}>全选</Button>
                  <Button size="sm" variant="outline" className="text-xs" onClick={() => setSelectedModels(new Set())}>清空</Button>
                </div>
              </>
            )}
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setFetchingModels(null)}>取消</Button>
            <Button onClick={handleSaveModels} disabled={availableModels.length === 0}>保存选中模型</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="flex items-center gap-2 text-destructive"><AlertTriangle className="w-5 h-5" />确认删除渠道</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">删除后该渠道的所有配置将被清除，此操作不可撤销。</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>取消</Button>
            <Button variant="destructive" onClick={() => { if (deleteConfirm) handleDelete(deleteConfirm) }}>确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ==================== Models Price ====================
function ModelsTab() {
  const { models, addModel, updateModel, deleteModel, setModels, channels } = useAdminStore()
  const [showDialog, setShowDialog] = useState(false)
  const [editModel, setEditModel] = useState<Model | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // 批量导入
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importCandidates, setImportCandidates] = useState<string[]>([])
  const [importSelected, setImportSelected] = useState<Set<string>>(new Set())
  // 批量编辑
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set())
  const [showBatchEdit, setShowBatchEdit] = useState(false)
  const [batchForm, setBatchForm] = useState({ inputPrice: '', cachedInputPrice: '', outputPrice: '', enabled: '' as '' | 'true' | 'false', tagsMode: '' as '' | 'set' | 'add' | 'remove', tags: [] as string[] })

  // 模型管理：按渠道分组折叠 + 内联编辑
  const PRESET_CAPS = getAllApiTags() as Model['capabilities']
  const emptyForm = { name: '', provider: 'OpenAI', description: '', contextLength: 128000, inputPrice: 0, cachedInputPrice: 0, outputPrice: 0, capabilities: [] as Model['capabilities'], enabled: true }
  const [modelChannelCollapsed, setModelChannelCollapsed] = useState<Set<string>>(new Set())
  const [inlineEditId, setInlineEditId] = useState<string | null>(null)
  const [inlineForm, setInlineForm] = useState<typeof emptyForm>(emptyForm)
  const [inlineCustomTagKey, setInlineCustomTagKey] = useState('')
  const [inlineCustomTagLabel, setInlineCustomTagLabel] = useState('')
  const [editingInlineTagKey, setEditingInlineTagKey] = useState<string | null>(null)
  const [editingInlineTagLabel, setEditingInlineTagLabel] = useState('')

  // 新增/编辑模型对话框表单
  const [form, setForm] = useState<typeof emptyForm>(emptyForm)
  const [customTagKey, setCustomTagKey] = useState('')
  const [customTagLabel, setCustomTagLabel] = useState('')
  const [editingFormTagKey, setEditingFormTagKey] = useState<string | null>(null)
  const [editingFormTagLabel, setEditingFormTagLabel] = useState('')

  // 模型列表滚动容器 ref + 回到顶部按钮显隐
  const modelListRef = useRef<HTMLDivElement>(null)
  const [showBackToTop, setShowBackToTop] = useState(false)
  useEffect(() => {
    const el = modelListRef.current
    if (!el) return
    const onScroll = () => { setShowBackToTop(el.scrollTop > 300) }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  const scrollToTop = () => { modelListRef.current?.scrollTo({ top: 0, behavior: 'smooth' }) }

  // 页面挂载时从数据库加载模型列表（覆盖 localStorage 持久化的本地副本）
  useEffect(() => {
    if (isDemoMode()) return
    let cancelled = false
    const fetchModelsFromApi = async () => {
      try {
        const result = await adminApi.listModels()
        if (cancelled || !Array.isArray(result)) return
        const mapped: Model[] = result.map((m: any) => ({
          id: m.modelId || String(m.id),
          name: m.name || m.modelId || '',
          provider: m.provider || '',
          description: m.description || '',
          contextLength: m.contextLength || 128000,
          inputPrice: Number(m.inputPrice ?? 0),
          cachedInputPrice: Number(m.cachedInputPrice ?? 0),
          outputPrice: Number(m.outputPrice ?? 0),
          capabilities: (typeof m.capabilities === 'string' ? m.capabilities.split(',').filter(Boolean) : Array.isArray(m.capabilities) ? m.capabilities : ['text']) as Model['capabilities'],
          enabled: m.enabled !== false,
        }))
        setModels(mapped)
      } catch (e) {
        console.warn('从数据库加载模型列表失败:', e)
      }
    }
    fetchModelsFromApi()
    return () => { cancelled = true }
  }, [])

  // 从渠道批量导入模型
  const openImportDialog = () => {
    const existingIds = new Set(models.map(m => m.id))
    const candidates: string[] = []
    channels.forEach(ch => {
      ch.models.filter(Boolean).forEach(m => {
        if (!existingIds.has(m) && !candidates.includes(m)) {
          candidates.push(m)
        }
      })
    })
    setImportCandidates(candidates)
    setImportSelected(new Set(candidates))
    setShowImportDialog(true)
  }

  const handleImport = async () => {
    const toImport = Array.from(importSelected)
    for (const modelId of toImport) {
      // 尝试从渠道找到 provider
      let provider = 'OpenAI'
      for (const ch of channels) {
        if (ch.models.includes(modelId)) { provider = ch.provider; break }
      }
      const newModel = {
        id: modelId, name: modelId, provider,
        description: '', contextLength: 128000,
        inputPrice: 0, cachedInputPrice: 0, outputPrice: 0,
        capabilities: ['text'] as Model['capabilities'],
        enabled: true,
      }
      if (!isDemoMode()) {
        try { await adminApi.createModel(newModel as any) } catch (e) { console.warn('导入模型失败:', modelId, e) }
      }
      addModel(newModel)
    }
    setShowImportDialog(false)
  }

  // 批量编辑
  const handleBatchEditSave = async () => {
    const ids = Array.from(batchSelected)
    const updates: Partial<Model> = {}
    if (batchForm.inputPrice !== '') updates.inputPrice = Number(batchForm.inputPrice)
    if (batchForm.cachedInputPrice !== '') updates.cachedInputPrice = Number(batchForm.cachedInputPrice)
    if (batchForm.outputPrice !== '') updates.outputPrice = Number(batchForm.outputPrice)
    if (batchForm.enabled !== '') updates.enabled = batchForm.enabled === 'true'
    // 能力标签批量编辑
    if (batchForm.tagsMode && batchForm.tags.length > 0) {
      if (batchForm.tagsMode === 'set') {
        updates.capabilities = batchForm.tags as Model['capabilities']
      } else if (batchForm.tagsMode === 'add') {
        // 合并：后端需要知道每个模型的现有 capabilities 再加新的，所以这里只标记 add/remove
        ;(updates as any).__tagsAdd = batchForm.tags
      } else if (batchForm.tagsMode === 'remove') {
        ;(updates as any).__tagsRemove = batchForm.tags
      }
    }
    for (const id of ids) {
      // 获取当前模型
      const currentModel = models.find(m => m.id === id)
      const finalUpdates = { ...updates }
      if (batchForm.tagsMode === 'add' && (updates as any).__tagsAdd) {
        const existing = currentModel?.capabilities || []
        finalUpdates.capabilities = [...new Set([...existing, ...(updates as any).__tagsAdd])]
        delete (finalUpdates as any).__tagsAdd
      } else if (batchForm.tagsMode === 'remove' && (updates as any).__tagsRemove) {
        const existing = currentModel?.capabilities || []
        finalUpdates.capabilities = existing.filter(c => !(updates as any).__tagsRemove.includes(c))
        delete (finalUpdates as any).__tagsRemove
      }
      if (!isDemoMode()) {
        try {
          await adminApi.updateModel(id, finalUpdates as any)
        } catch (e: any) {
          alert('批量更新「' + (currentModel?.name || id) + '」失败: ' + (e.message || '未知错误'))
          continue
        }
      }
      updateModel(id, finalUpdates)
    }
    setShowBatchEdit(false)
    setBatchSelected(new Set())
    setBatchForm({ inputPrice: '', cachedInputPrice: '', outputPrice: '', enabled: '', tagsMode: '', tags: [] })
  }

  const selectModelIds = (ids: string[], selected: boolean) => {
    setBatchSelected(prev => {
      const next = new Set(prev)
      ids.forEach(id => selected ? next.add(id) : next.delete(id))
      return next
    })
  }

  const setModelsEnabled = async (ids: string[], enabled: boolean) => {
    if (ids.length === 0) return
    for (const id of ids) {
      if (!isDemoMode()) {
        try {
          await adminApi.updateModel(id, { enabled } as any)
        } catch (e: any) {
          alert(`更新模型「${id}」失败: ${e.message || '未知错误'}`)
          continue
        }
      }
      updateModel(id, { enabled })
    }
  }

  const deleteModelsByIds = async (ids: string[], label = '所选模型') => {
    const uniqueIds = Array.from(new Set(ids)).filter(Boolean)
    if (uniqueIds.length === 0) return
    if (!confirm(`确定删除 ${label} 的 ${uniqueIds.length} 个模型价格配置吗？\n\n这会从模型价格表清理记录，不会删除渠道中的模型列表。`)) return
    for (const id of uniqueIds) {
      if (!isDemoMode()) {
        try {
          await adminApi.deleteModel(id)
        } catch (e: any) {
          alert(`删除模型「${id}」失败: ${e.message || '未知错误'}`)
          continue
        }
      }
      deleteModel(id)
    }
    setBatchSelected(prev => {
      const next = new Set(prev)
      uniqueIds.forEach(id => next.delete(id))
      return next
    })
    if (inlineEditId && uniqueIds.includes(inlineEditId)) cancelInlineEdit()
  }

  const filtered = models.filter(m => m.name.toLowerCase().includes(search.toLowerCase()) || m.provider.toLowerCase().includes(search.toLowerCase()))

  // 按渠道对模型分组（支持折叠）
  const modelGroups = useMemo(() => {
    type Group = { channel: typeof channels[0] | null; models: typeof filtered }
    const map = new Map<string, Group>()
    const uncategorized: typeof filtered = []

    for (const m of filtered) {
      let assigned = false
      for (const ch of channels) {
        if (ch.models.includes(m.id)) {
          if (!map.has(ch.id)) map.set(ch.id, { channel: ch, models: [] })
          map.get(ch.id)!.models.push(m)
          assigned = true
          break
        }
      }
      if (!assigned) uncategorized.push(m)
    }

    const groups: Group[] = Array.from(map.values())
    groups.sort((a, b) => (a.channel?.name || '').localeCompare(b.channel?.name || ''))
    return { groups, uncategorized }
  }, [filtered, channels])

  // 内联编辑：切换编辑状态
  const startInlineEdit = (m: Model) => {
    setInlineEditId(m.id)
    setInlineForm({
      name: m.name, provider: m.provider, description: m.description,
      contextLength: m.contextLength,
      inputPrice: m.inputPrice, cachedInputPrice: m.cachedInputPrice ?? 0, outputPrice: m.outputPrice,
      capabilities: [...m.capabilities], enabled: m.enabled,
    })
    setInlineCustomTagKey('')
    setInlineCustomTagLabel('')
  }
  const cancelInlineEdit = () => {
    setInlineEditId(null)
    setInlineForm(emptyForm)
    setInlineCustomTagKey('')
    setInlineCustomTagLabel('')
  }
  const saveInlineEdit = async (m: Model) => {
    if (!inlineForm.name) return
    const updates: Partial<Model> = {
      name: inlineForm.name, provider: inlineForm.provider,
      description: inlineForm.description,
      contextLength: inlineForm.contextLength,
      inputPrice: inlineForm.inputPrice, cachedInputPrice: inlineForm.cachedInputPrice, outputPrice: inlineForm.outputPrice,
      capabilities: inlineForm.capabilities, enabled: inlineForm.enabled,
    }
    if (!isDemoMode()) {
      try {
        await adminApi.updateModel(m.id, updates as any)
      } catch (e: any) {
        alert('保存失败: ' + (e.message || '未知错误'))
        return
      }
    }
    updateModel(m.id, updates)
    setInlineEditId(null)
  }
  const toggleInlineCap = (cap: Model['capabilities'][number]) => {
    setInlineForm(prev => ({
      ...prev,
      capabilities: prev.capabilities.includes(cap)
        ? prev.capabilities.filter(c => c !== cap)
        : [...prev.capabilities, cap],
    }))
  }
  const addInlineCustomTag = () => {
    const key = inlineCustomTagKey.trim()
    const label = inlineCustomTagLabel.trim()
    if (!key || !label) return
    const tag = key.toLowerCase().replace(/\s+/g, '-')
    if (!tag || (inlineForm.capabilities as string[]).includes(tag)) { setInlineCustomTagKey(''); setInlineCustomTagLabel(''); return }
    // 保存 key→label 映射
    setTagMapping(tag, label)
    setInlineForm(prev => ({ ...prev, capabilities: [...prev.capabilities, tag] as Model['capabilities'] }))
    setInlineCustomTagKey('')
    setInlineCustomTagLabel('')
  }
  const startEditInlineTag = (key: string) => {
    setEditingInlineTagKey(key)
    setEditingInlineTagLabel(getTagLabel(key))
  }
  const saveEditInlineTag = () => {
    if (editingInlineTagKey && editingInlineTagLabel.trim()) {
      setTagMapping(editingInlineTagKey, editingInlineTagLabel.trim())
    }
    setEditingInlineTagKey(null)
  }
  const removeInlineCustomTag = (key: string) => {
    removeTagMapping(key)
    setInlineForm(prev => ({ ...prev, capabilities: prev.capabilities.filter(c => c !== key) }))
    if (editingInlineTagKey === key) setEditingInlineTagKey(null)
  }

  const openAdd = () => { setEditModel(null); setForm(emptyForm); setCustomTagKey(''); setCustomTagLabel(''); setShowDialog(true) }
  const openEdit = (m: Model) => {
    setEditModel(m)
    setForm({ name: m.name, provider: m.provider, description: m.description, contextLength: m.contextLength, inputPrice: m.inputPrice, cachedInputPrice: m.cachedInputPrice ?? 0, outputPrice: m.outputPrice, capabilities: [...m.capabilities], enabled: m.enabled })
    setCustomTagKey(''); setCustomTagLabel('')
    setShowDialog(true)
  }

  const handleSave = async () => {
    if (!form.name) return
    if (editModel) {
      if (!isDemoMode()) { try { await adminApi.updateModel(editModel.id, form as any) } catch (e) { alert((e as any).message || '更新失败'); return } }
      updateModel(editModel.id, form)
    } else {
      if (!isDemoMode()) {
        try { const c = await adminApi.createModel(form as any) as any; addModel({ ...form, id: c.modelId || c.id || `model_${Date.now()}` }) }
        catch (e) { alert((e as any).message || '创建失败'); return }
      } else { addModel({ ...form, id: `model_${Date.now()}` }) }
    }
    setShowDialog(false)
  }

  const toggleCap = (cap: Model['capabilities'][number]) => {
    setForm(prev => ({ ...prev, capabilities: prev.capabilities.includes(cap) ? prev.capabilities.filter(c => c !== cap) : [...prev.capabilities, cap] }))
  }

  const addCustomTag = () => {
    const key = customTagKey.trim()
    const label = customTagLabel.trim()
    if (!key || !label) return
    const tag = key.toLowerCase().replace(/\s+/g, '-')
    if (!tag || (form.capabilities as string[]).includes(tag)) { setCustomTagKey(''); setCustomTagLabel(''); return }
    // 保存 key→label 映射
    setTagMapping(tag, label)
    setForm(prev => ({ ...prev, capabilities: [...prev.capabilities, tag] as Model['capabilities'] }))
    setCustomTagKey('')
    setCustomTagLabel('')
  }
  const startEditFormTag = (key: string) => {
    setEditingFormTagKey(key)
    setEditingFormTagLabel(getTagLabel(key))
  }
  const saveEditFormTag = () => {
    if (editingFormTagKey && editingFormTagLabel.trim()) {
      setTagMapping(editingFormTagKey, editingFormTagLabel.trim())
    }
    setEditingFormTagKey(null)
  }
  const removeFormCustomTag = (key: string) => {
    removeTagMapping(key)
    setForm(prev => ({ ...prev, capabilities: prev.capabilities.filter(c => c !== key) }))
    if (editingFormTagKey === key) setEditingFormTagKey(null)
  }

  return (
    <div ref={modelListRef} className="mobile-scroll-bottom-safe flex-1 overflow-y-auto p-6">
      {/* 吸顶区域：标题+操作按钮+搜索框 */}
      <div className="sticky top-0 z-10 bg-background pb-4 -mx-6 px-6 pt-6">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h2 className="text-xl font-semibold">模型价格管理</h2>
            <p className="text-sm text-muted-foreground">管理模型定价和能力标签</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {batchSelected.size > 0 && (
              <>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowBatchEdit(true)}>
                  <Edit className="w-4 h-4" />批量编辑 ({batchSelected.size})
                </Button>
                <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => deleteModelsByIds(Array.from(batchSelected), '所选')}>
                  <Trash2 className="w-4 h-4" />批量删除 ({batchSelected.size})
                </Button>
              </>
            )}
            <Button size="sm" variant="outline" className="gap-1.5" onClick={openImportDialog}>
              <Download className="w-4 h-4" />从渠道导入
            </Button>
            <Button size="sm" className="gap-1.5" onClick={openAdd}><Plus className="w-4 h-4" />添加模型</Button>
          </div>
        </div>

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索模型名称或供应商..." className="pl-9" />
        </div>
      </div>

      {/* 模型列表：按渠道分组 + 内联编辑 */}
      <div className="space-y-3">
        {modelGroups.groups.map(({ channel: chRaw, models }) => {
          const ch = chRaw!
          const collapsed = modelChannelCollapsed.has(ch.id)
          const groupIds = models.map(m => m.id)
          const selectedInGroup = groupIds.filter(id => batchSelected.has(id)).length
          return (
            <div key={ch.id} className="border rounded-xl overflow-hidden">
              <div
                className="flex flex-wrap items-center gap-2 p-3 bg-muted/20 hover:bg-muted/40 transition-colors"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => {
                    const next = new Set(modelChannelCollapsed)
                    collapsed ? next.delete(ch.id) : next.add(ch.id)
                    setModelChannelCollapsed(next)
                  }}
                >
                  {collapsed ? <ChevronRight className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
                  <span className="truncate font-semibold text-sm">{ch.name}</span>
                </button>
                <Badge variant="outline" className="text-xs">{models.length} 个模型</Badge>
                {selectedInGroup > 0 && <Badge variant="outline" className="text-xs">已选 {selectedInGroup}</Badge>}
                {ch.status === 'error' && <Badge variant="destructive" className="text-xs">异常</Badge>}
                <div className="ml-auto flex flex-wrap items-center gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => selectModelIds(groupIds, true)} disabled={groupIds.length === 0}>
                    选中本渠道
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => selectModelIds(groupIds, false)} disabled={selectedInGroup === 0}>
                    取消本渠道
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setModelsEnabled(groupIds, true)} disabled={groupIds.length === 0}>
                    启用全部
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setModelsEnabled(groupIds, false)} disabled={groupIds.length === 0}>
                    禁用全部
                  </Button>
                  <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" onClick={() => deleteModelsByIds(groupIds, `渠道「${ch.name}」`) } disabled={groupIds.length === 0}>
                    删除本渠道
                  </Button>
                </div>
              </div>

              {!collapsed && (
                <div className="divide-y">
                  {models.map(m => (
                    <div key={m.id}>
                      <div
                        className={cn(
                          "flex items-center gap-2 px-3 py-2.5 hover:bg-muted/20 transition-colors cursor-pointer",
                          inlineEditId === m.id && "bg-muted/30"
                        )}
                        onClick={() => inlineEditId === m.id ? cancelInlineEdit() : startInlineEdit(m)}
                      >
                        <input
                          type="checkbox"
                          checked={batchSelected.has(m.id)}
                          onClick={e => e.stopPropagation()}
                          onChange={e => {
                            const next = new Set(batchSelected)
                            e.target.checked ? next.add(m.id) : next.delete(m.id)
                            setBatchSelected(next)
                          }}
                          className="rounded shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{m.name}</p>
                          <p className="text-[11px] text-muted-foreground truncate">{m.description || m.provider}</p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <div className="flex max-w-[180px] flex-wrap items-center justify-end gap-1">
                            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20" title="输入价格">
                              入 ${m.inputPrice}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20" title="缓存输入价格">
                              缓 ${m.cachedInputPrice ?? 0}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-muted/50 text-muted-foreground border border-border/50" title="输出价格">
                              出 ${m.outputPrice}
                            </span>
                          </div>
                          <Switch
                            checked={m.enabled}
                            onClick={e => e.stopPropagation()}
                            onCheckedChange={async v => {
                              if (!isDemoMode()) {
                                try {
                                  await adminApi.updateModel(m.id, { enabled: v } as any)
                                } catch (e) {
                                  console.warn('更新模型状态失败:', e)
                                  return // 不更新本地状态，保持原样
                                }
                              }
                              updateModel(m.id, { enabled: v })
                            }}
                          />
                        </div>
                      </div>

                      {/* 内联编辑区域 */}
                      {inlineEditId === m.id && (
                        <div className="px-4 pb-4 pt-2 bg-muted/10 border-t space-y-3">
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                              <Label className="text-xs">模型名称 <span className="text-destructive">*</span></Label>
                              <Input
                                value={inlineForm.name}
                                onChange={e => setInlineForm({ ...inlineForm, name: e.target.value })}
                                placeholder="gpt-4o"
                                className="h-8 text-xs"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">供应商</Label>
                              <Input
                                value={inlineForm.provider}
                                onChange={e => setInlineForm({ ...inlineForm, provider: e.target.value })}
                                placeholder="OpenAI"
                                className="h-8 text-xs"
                              />
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">描述</Label>
                            <Input
                              value={inlineForm.description}
                              onChange={e => setInlineForm({ ...inlineForm, description: e.target.value })}
                              placeholder="模型描述"
                              className="h-8 text-xs"
                            />
                          </div>
                          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                            <div className="space-y-1.5">
                              <Label className="text-xs">上下文长度</Label>
                              <Input type="number" value={inlineForm.contextLength} onChange={e => setInlineForm({ ...inlineForm, contextLength: Number(e.target.value) })} className="h-8 text-xs" />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">输入价格 ($/1M)</Label>
                              <Input type="number" step="0.01" value={inlineForm.inputPrice} onChange={e => setInlineForm({ ...inlineForm, inputPrice: Number(e.target.value) })} className="h-8 text-xs" />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">缓存输入价 ($/1M)</Label>
                              <Input type="number" step="0.01" value={inlineForm.cachedInputPrice} onChange={e => setInlineForm({ ...inlineForm, cachedInputPrice: Number(e.target.value) })} className="h-8 text-xs" />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs">输出价格 ($/1M)</Label>
                              <Input type="number" step="0.01" value={inlineForm.outputPrice} onChange={e => setInlineForm({ ...inlineForm, outputPrice: Number(e.target.value) })} className="h-8 text-xs" />
                            </div>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs">能力标签</Label>
                            <div className="flex flex-wrap gap-2">
                              {PRESET_CAPS.map(cap => (
                                <button
                                  key={cap}
                                  type="button"
                                  onClick={e => { e.stopPropagation(); toggleInlineCap(cap as Model['capabilities'][number]) }}
                                  className={cn('px-2.5 py-0.5 rounded-full text-xs border transition-colors',
                                    inlineForm.capabilities.includes(cap as Model['capabilities'][number])
                                      ? 'bg-primary text-primary-foreground border-primary'
                                      : 'bg-background hover:bg-muted border-border'
                                  )}
                                >
                                  {getTagLabel(cap)}
                                </button>
                              ))}
                            </div>
                            {inlineForm.capabilities.filter(c => !PRESET_CAPS.includes(c)).length > 0 && (
                              <div className="flex flex-wrap gap-1.5 pt-1">
                                {inlineForm.capabilities.filter(c => !PRESET_CAPS.includes(c)).map(cap => (
                                  editingInlineTagKey === cap ? (
                                    <span key={cap} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800">
                                      <span className="text-muted-foreground/70 font-mono">{cap}</span>
                                      <span className="text-muted-foreground/40">→</span>
                                      <Input
                                        value={editingInlineTagLabel}
                                        onClick={e => e.stopPropagation()}
                                        onChange={e => setEditingInlineTagLabel(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); saveEditInlineTag() } }}
                                        className="h-6 w-28 text-xs"
                                        autoFocus
                                      />
                                      <button type="button" onClick={e => { e.stopPropagation(); saveEditInlineTag() }} className="ml-0.5 text-green-600 hover:text-green-700 leading-none" title="保存">✓</button>
                                      <button type="button" onClick={e => { e.stopPropagation(); setEditingInlineTagKey(null) }} className="text-muted-foreground hover:text-destructive leading-none" title="取消">×</button>
                                    </span>
                                  ) : (
                                    <span key={cap} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                                      <span className="text-muted-foreground/60 font-mono">{cap}</span>
                                      <span className="text-muted-foreground/40">→</span>
                                      <span>{getTagLabel(cap)}</span>
                                      <button type="button" onClick={e => { e.stopPropagation(); startEditInlineTag(cap) }} className="ml-1 hover:text-primary leading-none opacity-60 hover:opacity-100" title="编辑显示名">✎</button>
                                      <button type="button" onClick={e => { e.stopPropagation(); removeInlineCustomTag(cap) }} className="hover:text-destructive leading-none opacity-60 hover:opacity-100">×</button>
                                    </span>
                                  )
                                ))}
                              </div>
                            )}
                            <div className="flex gap-2 pt-1">
                              <Input
                                value={inlineCustomTagKey}
                                onClick={e => e.stopPropagation()}
                                onChange={e => setInlineCustomTagKey(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addInlineCustomTag() } }}
                                placeholder="key（如 mcp）"
                                className="h-8 text-xs flex-1"
                              />
                              <Input
                                value={inlineCustomTagLabel}
                                onClick={e => e.stopPropagation()}
                                onChange={e => setInlineCustomTagLabel(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addInlineCustomTag() } }}
                                placeholder="显示名（如 MCP调用）"
                                className="h-8 text-xs flex-1"
                              />
                              <Button type="button" size="sm" variant="outline" className="h-8 px-3 shrink-0" onClick={e => { e.stopPropagation(); addInlineCustomTag() }}>添加</Button>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Switch checked={inlineForm.enabled} onCheckedChange={v => setInlineForm({ ...inlineForm, enabled: v })} />
                            <Label className="text-xs">启用此模型</Label>
                          </div>
                          <div className="flex gap-2 justify-end pt-1">
                            <Button size="sm" variant="outline" onClick={e => { e.stopPropagation(); cancelInlineEdit() }}>取消</Button>
                            <Button size="sm" onClick={e => { e.stopPropagation(); saveInlineEdit(m) }}>保存</Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {/* 未分类模型 */}
        {modelGroups.uncategorized.length > 0 && (
          <div className="border rounded-xl overflow-hidden">
            {(() => {
              const uncategorizedIds = modelGroups.uncategorized.map(m => m.id)
              const selectedUncategorized = uncategorizedIds.filter(id => batchSelected.has(id)).length
              return (
            <div className="flex flex-wrap items-center gap-2 p-3 bg-muted/20">
              <AlertTriangle className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="font-semibold text-sm">未分类</span>
              <Badge variant="outline" className="text-xs">{modelGroups.uncategorized.length} 个模型</Badge>
              {selectedUncategorized > 0 && <Badge variant="outline" className="text-xs">已选 {selectedUncategorized}</Badge>}
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => selectModelIds(uncategorizedIds, true)}>
                  选中未分类
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => selectModelIds(uncategorizedIds, false)} disabled={selectedUncategorized === 0}>
                  取消未分类
                </Button>
                <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" onClick={() => deleteModelsByIds(uncategorizedIds, '未分类')}>
                  删除未分类
                </Button>
              </div>
            </div>
              )
            })()}
            <div className="divide-y">
              {modelGroups.uncategorized.map(m => (
                <div key={m.id}>
                  <div
                    className={cn(
                      "flex items-center gap-2 px-3 py-2.5 hover:bg-muted/20 transition-colors cursor-pointer",
                      inlineEditId === m.id && "bg-muted/30"
                    )}
                    onClick={() => inlineEditId === m.id ? cancelInlineEdit() : startInlineEdit(m)}
                  >
                    <input
                      type="checkbox"
                      checked={batchSelected.has(m.id)}
                      onClick={e => e.stopPropagation()}
                      onChange={e => {
                        const next = new Set(batchSelected)
                        e.target.checked ? next.add(m.id) : next.delete(m.id)
                        setBatchSelected(next)
                      }}
                      className="rounded shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">{m.name}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{m.description || m.provider}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <div className="flex max-w-[180px] flex-wrap items-center justify-end gap-1">
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20" title="输入价格">
                          入 ${m.inputPrice}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20" title="缓存输入价格">
                          缓 ${m.cachedInputPrice ?? 0}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-muted/50 text-muted-foreground border border-border/50" title="输出价格">
                          出 ${m.outputPrice}
                        </span>
                      </div>
                      <Switch
                        checked={m.enabled}
                        onClick={e => e.stopPropagation()}
                        onCheckedChange={async v => {
                          if (!isDemoMode()) {
                            try {
                              await adminApi.updateModel(m.id, { enabled: v } as any)
                            } catch (e) {
                              console.warn('更新模型状态失败:', e)
                              return
                            }
                          }
                          updateModel(m.id, { enabled: v })
                        }}
                      />
                    </div>
                  </div>
                  {inlineEditId === m.id && (
                    <div className="px-4 pb-4 pt-2 bg-muted/10 border-t space-y-3">
                      {/* Same inline edit form as above */}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs">模型名称 <span className="text-destructive">*</span></Label>
                          <Input value={inlineForm.name} onChange={e => setInlineForm({ ...inlineForm, name: e.target.value })} placeholder="gpt-4o" className="h-8 text-xs" />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">供应商</Label>
                          <Input value={inlineForm.provider} onChange={e => setInlineForm({ ...inlineForm, provider: e.target.value })} placeholder="OpenAI" className="h-8 text-xs" />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">描述</Label>
                        <Input value={inlineForm.description} onChange={e => setInlineForm({ ...inlineForm, description: e.target.value })} placeholder="模型描述" className="h-8 text-xs" />
                      </div>
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs">上下文长度</Label>
                          <Input type="number" value={inlineForm.contextLength} onChange={e => setInlineForm({ ...inlineForm, contextLength: Number(e.target.value) })} className="h-8 text-xs" />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">输入价格 ($/1M)</Label>
                          <Input type="number" step="0.01" value={inlineForm.inputPrice} onChange={e => setInlineForm({ ...inlineForm, inputPrice: Number(e.target.value) })} className="h-8 text-xs" />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">缓存输入价 ($/1M)</Label>
                          <Input type="number" step="0.01" value={inlineForm.cachedInputPrice} onChange={e => setInlineForm({ ...inlineForm, cachedInputPrice: Number(e.target.value) })} className="h-8 text-xs" />
                        </div>
                        <div className="space-y-1.5">
                          <Label>输出价格 ($/1M)</Label>
                          <Input type="number" step="0.01" value={inlineForm.outputPrice} onChange={e => setInlineForm({ ...inlineForm, outputPrice: Number(e.target.value) })} className="h-8 text-xs" />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs">能力标签</Label>
                        <div className="flex flex-wrap gap-2">
                          {PRESET_CAPS.map(cap => (
                            <button
                              key={cap}
                              type="button"
                              onClick={e => { e.stopPropagation(); toggleInlineCap(cap as Model['capabilities'][number]) }}
                              className={cn('px-2.5 py-0.5 rounded-full text-xs border transition-colors',
                                inlineForm.capabilities.includes(cap as Model['capabilities'][number])
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : 'bg-background hover:bg-muted border-border'
                              )}
                            >
                              {getTagLabel(cap)}
                            </button>
                          ))}
                        </div>
                        {inlineForm.capabilities.filter(c => !PRESET_CAPS.includes(c)).length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {inlineForm.capabilities.filter(c => !PRESET_CAPS.includes(c)).map(cap => (
                              editingInlineTagKey === cap ? (
                                <span key={cap} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800">
                                  <span className="text-muted-foreground/70 font-mono">{cap}</span>
                                  <span className="text-muted-foreground/40">→</span>
                                  <Input
                                    value={editingInlineTagLabel}
                                    onClick={e => e.stopPropagation()}
                                    onChange={e => setEditingInlineTagLabel(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); saveEditInlineTag() } }}
                                    className="h-6 w-28 text-xs"
                                    autoFocus
                                  />
                                  <button type="button" onClick={e => { e.stopPropagation(); saveEditInlineTag() }} className="ml-0.5 text-green-600 hover:text-green-700 leading-none" title="保存">✓</button>
                                  <button type="button" onClick={e => { e.stopPropagation(); setEditingInlineTagKey(null) }} className="text-muted-foreground hover:text-destructive leading-none" title="取消">×</button>
                                </span>
                              ) : (
                                <span key={cap} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                                  <span className="text-muted-foreground/60 font-mono">{cap}</span>
                                  <span className="text-muted-foreground/40">→</span>
                                  <span>{getTagLabel(cap)}</span>
                                  <button type="button" onClick={e => { e.stopPropagation(); startEditInlineTag(cap) }} className="ml-1 hover:text-primary leading-none opacity-60 hover:opacity-100" title="编辑显示名">✎</button>
                                  <button type="button" onClick={e => { e.stopPropagation(); removeInlineCustomTag(cap) }} className="hover:text-destructive leading-none opacity-60 hover:opacity-100">×</button>
                                </span>
                              )
                            ))}
                          </div>
                        )}
                        <div className="flex gap-2 pt-1">
                          <Input
                            value={inlineCustomTagKey}
                            onClick={e => e.stopPropagation()}
                            onChange={e => setInlineCustomTagKey(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addInlineCustomTag() } }}
                            placeholder="key（如 mcp）"
                            className="h-8 text-xs flex-1"
                          />
                          <Input
                            value={inlineCustomTagLabel}
                            onClick={e => e.stopPropagation()}
                            onChange={e => setInlineCustomTagLabel(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addInlineCustomTag() } }}
                            placeholder="显示名（如 MCP调用）"
                            className="h-8 text-xs flex-1"
                          />
                          <Button type="button" size="sm" variant="outline" className="h-8 px-3 shrink-0" onClick={e => { e.stopPropagation(); addInlineCustomTag() }}>添加</Button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch checked={inlineForm.enabled} onCheckedChange={v => setInlineForm({ ...inlineForm, enabled: v })} />
                        <Label className="text-xs">启用此模型</Label>
                      </div>
                      <div className="flex gap-2 justify-end pt-1">
                        <Button size="sm" variant="outline" onClick={e => { e.stopPropagation(); cancelInlineEdit() }}>取消</Button>
                        <Button size="sm" onClick={e => { e.stopPropagation(); saveInlineEdit(m) }}>保存</Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 回到顶部按钮：滚动超过一屏时显示 */}
        {showBackToTop && (
          <div className="sticky bottom-4 flex justify-end pr-2 pb-2 z-10">
            <Button size="sm" variant="outline" className="shadow-lg gap-1.5" onClick={scrollToTop}>
              <ChevronUp className="w-4 h-4" />回到顶部
            </Button>
          </div>
        )}
      </div>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{editModel ? '编辑模型' : '添加模型'}</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>模型名称 <span className="text-destructive">*</span></Label><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="gpt-4o" /></div>
              <div className="space-y-1.5"><Label>供应商</Label><Input value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })} placeholder="OpenAI" /></div>
            </div>
            <div className="space-y-1.5"><Label>描述</Label><Input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="模型描述" /></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="space-y-1.5"><Label>上下文长度</Label><Input type="number" value={form.contextLength} onChange={e => setForm({ ...form, contextLength: Number(e.target.value) })} /></div>
              <div className="space-y-1.5"><Label>输入价格 ($/1M)</Label><Input type="number" step="0.01" value={form.inputPrice} onChange={e => setForm({ ...form, inputPrice: Number(e.target.value) })} /></div>
              <div className="space-y-1.5"><Label>缓存输入价 ($/1M)</Label><Input type="number" step="0.01" value={form.cachedInputPrice} onChange={e => setForm({ ...form, cachedInputPrice: Number(e.target.value) })} /></div>
              <div className="space-y-1.5"><Label>输出价格 ($/1M)</Label><Input type="number" step="0.01" value={form.outputPrice} onChange={e => setForm({ ...form, outputPrice: Number(e.target.value) })} /></div>
            </div>
            <div className="space-y-2"><Label>能力标签</Label>
              {/* 预设标签 */}
              <div className="flex flex-wrap gap-2">
                {PRESET_CAPS.map(cap => (
                  <button key={cap} type="button" onClick={() => toggleCap(cap as Model['capabilities'][number])} className={cn('px-3 py-1 rounded-full text-xs border transition-colors', form.capabilities.includes(cap as Model['capabilities'][number]) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-muted border-border')}>{getTagLabel(cap)}</button>
                ))}
              </div>
              {/* 自定义标签：key → value 显示 */}
              {form.capabilities.filter(c => !PRESET_CAPS.includes(c)).length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {form.capabilities.filter(c => !PRESET_CAPS.includes(c)).map(cap => (
                    editingFormTagKey === cap ? (
                      <span key={cap} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800">
                        <span className="text-muted-foreground/70 font-mono">{cap}</span>
                        <span className="text-muted-foreground/40">→</span>
                        <Input
                          value={editingFormTagLabel}
                          onChange={e => setEditingFormTagLabel(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); saveEditFormTag() } }}
                          className="h-6 w-28 text-xs"
                          autoFocus
                        />
                        <button type="button" onClick={saveEditFormTag} className="ml-0.5 text-green-600 hover:text-green-700 leading-none" title="保存">✓</button>
                        <button type="button" onClick={() => setEditingFormTagKey(null)} className="text-muted-foreground hover:text-destructive leading-none" title="取消">×</button>
                      </span>
                    ) : (
                      <span key={cap} className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                        <span className="text-muted-foreground/60 font-mono">{cap}</span>
                        <span className="text-muted-foreground/40">→</span>
                        <span>{getTagLabel(cap)}</span>
                        <button type="button" onClick={() => startEditFormTag(cap)} className="ml-1 hover:text-primary leading-none opacity-60 hover:opacity-100" title="编辑显示名">✎</button>
                        <button type="button" onClick={() => removeFormCustomTag(cap)} className="hover:text-destructive leading-none opacity-60 hover:opacity-100">×</button>
                      </span>
                    )
                  ))}
                </div>
              )}
              {/* 添加自定义标签：key + 显示名 */}
              <div className="flex gap-2 pt-1">
                <Input
                  value={customTagKey}
                  onChange={e => setCustomTagKey(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomTag() } }}
                  placeholder="key（如 mcp）"
                  className="h-8 text-xs flex-1"
                />
                <Input
                  value={customTagLabel}
                  onChange={e => setCustomTagLabel(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomTag() } }}
                  placeholder="显示名（如 MCP调用）"
                  className="h-8 text-xs flex-1"
                />
                <Button type="button" size="sm" variant="outline" className="h-8 px-3 shrink-0" onClick={addCustomTag}>添加</Button>
              </div>
            </div>
            <div className="flex items-center gap-2"><Switch checked={form.enabled} onCheckedChange={v => setForm({ ...form, enabled: v })} /><Label>启用此模型</Label></div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setShowDialog(false)}>取消</Button>
            <Button onClick={handleSave} disabled={!form.name}>{editModel ? '保存修改' : '添加模型'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="flex items-center gap-2 text-destructive"><AlertTriangle className="w-5 h-5" />确认删除模型</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">删除此模型配置将影响使用该模型的用户。</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>取消</Button>
            <Button variant="destructive" onClick={async () => {
              if (!deleteConfirm) return
              try {
                if (!isDemoMode()) await adminApi.deleteModel(deleteConfirm)
                deleteModel(deleteConfirm)
                setDeleteConfirm(null)
              } catch (e) {
                alert((e as any).message || '删除失败')
              }
            }}>确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量从渠道导入模型弹窗 */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>从渠道批量导入模型</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground mb-3">以下模型在渠道中存在，但尚未添加到定价表中。勾选要导入的模型：</p>
          {importCandidates.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">所有渠道模型已导入，暂无新模型可导入。</p>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-2">
                <input type="checkbox" checked={importSelected.size === importCandidates.length} onChange={e => setImportSelected(e.target.checked ? new Set(importCandidates) : new Set())} className="rounded" />
                <span className="text-xs text-muted-foreground">全选 ({importSelected.size}/{importCandidates.length})</span>
              </div>
              <div className="max-h-60 overflow-y-auto space-y-1 border rounded-lg p-2">
                {importCandidates.map(m => (
                  <label key={m} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted cursor-pointer text-sm">
                    <input type="checkbox" checked={importSelected.has(m)} onChange={e => { const next = new Set(importSelected); e.target.checked ? next.add(m) : next.delete(m); setImportSelected(next) }} className="rounded" />
                    <span className="font-mono text-xs">{m}</span>
                  </label>
                ))}
              </div>
            </>
          )}
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setShowImportDialog(false)}>取消</Button>
            <Button onClick={handleImport} disabled={importCandidates.length === 0 || importSelected.size === 0}>导入选中 ({importSelected.size})</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量编辑弹窗 */}
      <Dialog open={showBatchEdit} onOpenChange={setShowBatchEdit}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>批量编辑 ({batchSelected.size} 个模型)</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="space-y-1.5">
              <Label>输入价格 ($/1M，留空不修改)</Label>
              <Input type="number" step="0.01" value={batchForm.inputPrice} onChange={e => setBatchForm({ ...batchForm, inputPrice: e.target.value })} placeholder="留空表示不修改" />
            </div>
            <div className="space-y-1.5">
              <Label>缓存输入价 ($/1M，留空不修改)</Label>
              <Input type="number" step="0.01" value={batchForm.cachedInputPrice} onChange={e => setBatchForm({ ...batchForm, cachedInputPrice: e.target.value })} placeholder="留空表示不修改" />
            </div>
            <div className="space-y-1.5">
              <Label>输出价格 ($/1M，留空不修改)</Label>
              <Input type="number" step="0.01" value={batchForm.outputPrice} onChange={e => setBatchForm({ ...batchForm, outputPrice: e.target.value })} placeholder="留空表示不修改" />
            </div>
            <div className="space-y-1.5">
              <Label>启用状态</Label>
              <Select value={batchForm.enabled || '__no_change__'} onValueChange={v => setBatchForm({ ...batchForm, enabled: (v === '__no_change__' ? '' : v) as '' | 'true' | 'false' })}>
                <SelectTrigger><SelectValue placeholder="不修改" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__no_change__">不修改</SelectItem>
                  <SelectItem value="true">启用</SelectItem>
                  <SelectItem value="false">禁用</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>能力标签操作</Label>
              <Select value={batchForm.tagsMode || '__no_change__'} onValueChange={v => setBatchForm({ ...batchForm, tagsMode: (v === '__no_change__' ? '' : v) as '' | 'set' | 'add' | 'remove' })}>
                <SelectTrigger><SelectValue placeholder="不修改" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__no_change__">不修改</SelectItem>
                  <SelectItem value="set">设为指定标签（覆盖）</SelectItem>
                  <SelectItem value="add">追加标签</SelectItem>
                  <SelectItem value="remove">移除标签</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {batchForm.tagsMode && (
              <div className="space-y-2">
                <Label className="text-xs">
                  {batchForm.tagsMode === 'set' ? '目标标签（将覆盖所有现有标签）' :
                   batchForm.tagsMode === 'add' ? '要追加的标签' : '要移除的标签'}
                </Label>
                <div className="flex flex-wrap gap-1.5">
                  {PRESET_CAPS.map(cap => (
                    <button
                      key={cap}
                      type="button"
                      onClick={() => setBatchForm(prev => ({
                        ...prev,
                        tags: prev.tags.includes(cap) ? prev.tags.filter(t => t !== cap) : [...prev.tags, cap],
                      }))}
                      className={cn('px-2.5 py-0.5 rounded-full text-xs border transition-colors',
                        batchForm.tags.includes(cap)
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background hover:bg-muted border-border'
                      )}
                    >
                      {getTagLabel(cap)}
                    </button>
                  ))}
                </div>
                {batchForm.tags.filter(c => !(PRESET_CAPS as string[]).includes(c)).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {batchForm.tags.filter(c => !(PRESET_CAPS as string[]).includes(c)).map(cap => (
                      <span key={cap} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-primary/10 text-primary border border-primary/20">
                        {getTagLabel(cap)}
                        <button type="button" onClick={() => setBatchForm(prev => ({ ...prev, tags: prev.tags.filter(c => c !== cap) }))} className="ml-0.5 hover:text-destructive leading-none">×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setShowBatchEdit(false)}>取消</Button>
            <Button onClick={handleBatchEditSave}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ==================== Subscriptions (套餐管理 + 用户订阅记录) ====================
function SubscriptionsTab() {
  const [view, setView] = useState<'plans' | 'records'>('plans')
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex border-b px-6 pt-4 gap-4 shrink-0">
        <button onClick={() => setView('plans')} className={cn('pb-3 text-sm font-medium border-b-2 transition-colors', view === 'plans' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
          套餐配置
        </button>
        <button onClick={() => setView('records')} className={cn('pb-3 text-sm font-medium border-b-2 transition-colors', view === 'records' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
          用户订阅记录
        </button>
      </div>
      {view === 'plans' ? <PlansManageTab /> : <SubscriptionRecordsTab />}
    </div>
  )
}

// ---- 套餐配置管理 ----
function PlansManageTab() {
  const { channels } = useAdminStore()
  const [plans, setPlans] = useState<any[]>([])
  const [showDialog, setShowDialog] = useState(false)
  const [editPlan, setEditPlan] = useState<any | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [modelSearch, setModelSearch] = useState('')

  const emptyForm = { name: '', code: 'custom', description: '', price: 0, costLimit: 0, tokensLimit: 100000, modelLimit: [] as string[], features: '', sortOrder: 0, isPopular: false, enabled: true, roleId: null as number | null }
  const [form, setForm] = useState(emptyForm)

  // 角色列表（用于角色下拉选择）
  const [roles, setRoles] = useState<any[]>([])

  // 所有渠道中的模型（用于多选）
  const allChannelModels = useMemo(() => {
    const set = new Set<string>()
    channels.forEach(ch => ch.models.filter(Boolean).forEach(m => set.add(m)))
    return Array.from(set).sort()
  }, [channels])

  const filteredChannelModels = useMemo(() =>
    modelSearch ? allChannelModels.filter(m => m.toLowerCase().includes(modelSearch.toLowerCase())) : allChannelModels,
    [allChannelModels, modelSearch]
  )

  const reload = async () => {
    setLoading(true)
    try {
      const list = isDemoMode() ? DEMO_PLANS : await planApi.adminList()
      setPlans(list.map((p: any) => ({
        ...p,
        features: Array.isArray(p.features) ? p.features
          : (typeof p.features === 'string' ? (() => { try { return JSON.parse(p.features) } catch { return [] } })() : [])
      })))
      // 加载角色列表供下拉选择
      if (!isDemoMode()) {
        const roleList = await rbacApi.listRoles()
        setRoles(roleList)
      }
    } catch (e) { console.warn(e) }
    setLoading(false)
  }

  useEffect(() => { reload() }, [])

  const openAdd = () => { setEditPlan(null); setForm(emptyForm); setModelSearch(''); setShowDialog(true) }
  const openEdit = (p: any) => {
    setEditPlan(p)
    const modelLimitArr = p.modelLimit
      ? (typeof p.modelLimit === 'string' ? p.modelLimit.split(',').map((s: string) => s.trim()).filter(Boolean) : p.modelLimit)
      : []
    setForm({
      name: p.name, code: p.code, description: p.description || '',
      price: p.price, costLimit: Number(p.costLimit ?? p.price ?? 0), tokensLimit: p.tokensLimit, modelLimit: modelLimitArr,
      features: Array.isArray(p.features) ? p.features.join('\n') : '',
      sortOrder: p.sortOrder || 0, isPopular: p.isPopular || false, enabled: p.enabled !== false,
      roleId: p.roleId ?? null
    })
    setModelSearch('')
    setShowDialog(true)
  }

  const handleSave = async () => {
    if (!form.name) return
    const featuresArr = form.features.split('\n').map((s: string) => s.trim()).filter(Boolean)
    const data = { ...form, features: featuresArr, modelLimit: form.modelLimit.join(','), roleId: form.roleId }
    try {
      if (editPlan) { await planApi.adminUpdate(editPlan.uuid, data) }
      else { await planApi.adminCreate(data) }
      await reload(); setShowDialog(false)
    } catch (e) { alert((e as any).message || '保存失败') }
  }

  const handleDelete = async (uuid: string) => {
    try { await planApi.adminDelete(uuid); await reload(); setDeleteConfirm(null) }
    catch (e) { alert((e as any).message || '删除失败') }
  }

  const toggleModel = (modelId: string) => {
    setForm(prev => ({
      ...prev,
      modelLimit: prev.modelLimit.includes(modelId)
        ? prev.modelLimit.filter(m => m !== modelId)
        : [...prev.modelLimit, modelId]
    }))
  }

  const PLAN_COLOR: Record<string, string> = {
    free: 'text-gray-500', pro: 'text-blue-500', enterprise: 'text-purple-500', custom: 'text-orange-500'
  }

  return (
    <div className="mobile-scroll-bottom-safe flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">套餐配置</h2>
          <p className="text-sm text-muted-foreground">管理用户可订阅的套餐，配置价格、消费额度、模型权限和功能列表</p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={openAdd}><Plus className="w-4 h-4" />新建套餐</Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">加载中...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {plans.map(plan => (
            <div key={plan.uuid} className={cn(
              'relative rounded-2xl border-2 p-5 bg-card hover:shadow-md transition-all',
              plan.isPopular ? 'border-primary' : 'border-border',
              !plan.enabled && 'opacity-50'
            )}>
              {plan.isPopular && (
                <div className="absolute -top-3 left-4">
                  <span className="bg-primary text-primary-foreground text-[10px] font-bold px-2 py-0.5 rounded-full">推荐</span>
                </div>
              )}
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-bold text-base">{plan.name}</h3>
                  <div className="flex items-center gap-2">
                    <span className={cn('text-xs font-mono', PLAN_COLOR[plan.code] || 'text-muted-foreground')}>{plan.code}</span>
                    {plan.roleName && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800">
                        {plan.roleName}
                      </span>
                    )}
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" className="h-7 w-7 -mr-1"><MoreHorizontal className="w-4 h-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => openEdit(plan)}><Edit className="w-4 h-4 mr-2" />编辑</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive" onClick={() => setDeleteConfirm(plan.uuid)}><Trash2 className="w-4 h-4 mr-2" />删除</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div className="mb-3">
                {plan.price === 0 ? (
                  <span className="text-2xl font-black">免费</span>
                ) : (
                  <div className="flex items-baseline gap-1">
                    <span className="text-muted-foreground">¥</span>
                    <span className="text-2xl font-black">{plan.price}</span>
                    <span className="text-muted-foreground text-xs">/月</span>
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">
                  月消费额度 {plan.costLimit && Number(plan.costLimit) > 0 ? `¥${Number(plan.costLimit).toFixed(2)}` : '不限'} · {plan.modelLimit || '全部模型'}
                </p>
              </div>

              {plan.description && <p className="text-xs text-muted-foreground mb-3">{plan.description}</p>}

              <ul className="space-y-1.5 mb-3">
                {(Array.isArray(plan.features) ? plan.features : []).map((f: string, i: number) => (
                  <li key={i} className="flex items-center gap-1.5 text-xs">
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />{f}
                  </li>
                ))}
              </ul>

              <div className="pt-3 border-t flex items-center justify-between">
                <span className="text-xs text-muted-foreground">排序 {plan.sortOrder}</span>
                <Badge variant={plan.enabled ? 'success' : 'secondary'} className="text-xs">
                  {plan.enabled ? '已启用' : '已禁用'}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 编辑/新建弹窗 */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editPlan ? '编辑套餐' : '新建套餐'}</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>套餐名称 <span className="text-destructive">*</span></Label>
                <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="如: Pro 版" />
              </div>
              <div className="space-y-1.5">
                <Label>套餐代码</Label>
                <Input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="free/pro/enterprise/custom" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>描述</Label>
              <Input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="套餐简短描述" />
            </div>
            <div className="space-y-1.5">
              <Label>绑定角色</Label>
              <Select value={form.roleId != null ? String(form.roleId) : 'none'} onValueChange={v => setForm({ ...form, roleId: v === 'none' ? null : Number(v) })}>
                <SelectTrigger><SelectValue placeholder="选择角色（可选）" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不绑定</SelectItem>
                  {roles.map((r: any) => (
                    <SelectItem key={r.id} value={String(r.id)}>{r.roleName} ({r.roleCode})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">用户订阅此套餐后将自动获得绑定的角色</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>月价格 (¥)</Label>
                <Input type="number" value={form.price} onChange={e => setForm({ ...form, price: Number(e.target.value) })} />
              </div>
              <div className="space-y-1.5">
                <Label>月消费额度 (¥)</Label>
                <Input type="number" step="0.01" value={form.costLimit} onChange={e => setForm({ ...form, costLimit: Number(e.target.value) })} />
                <p className="text-[10px] text-muted-foreground">按模型输入、缓存输入、输出价格扣减</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>模型限制</Label>
              <div className="border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-muted-foreground">
                    {form.modelLimit.length === 0 ? '不限（用户可使用所有模型）' : `已选 ${form.modelLimit.length} 个模型`}
                  </span>
                  {form.modelLimit.length > 0 && (
                    <button onClick={() => setForm({ ...form, modelLimit: [] })} className="text-xs text-destructive hover:underline">清空</button>
                  )}
                </div>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <input value={modelSearch} onChange={e => setModelSearch(e.target.value)} placeholder="搜索模型..." className="w-full pl-8 pr-3 py-1.5 text-xs rounded border bg-muted/40 focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
                {allChannelModels.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-2">请先在渠道管理中配置模型</p>
                ) : (
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {filteredChannelModels.map(m => (
                      <label key={m} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer text-xs">
                        <input type="checkbox" checked={form.modelLimit.includes(m)} onChange={() => toggleModel(m)} className="rounded" />
                        <span className="font-mono">{m}</span>
                      </label>
                    ))}
                  </div>
                )}
                {form.modelLimit.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1 border-t">
                    {form.modelLimit.map(m => (
                      <span key={m} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                        {m}
                        <button onClick={() => toggleModel(m)} className="hover:text-destructive"><X className="w-2.5 h-2.5" /></button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>功能列表（每行一条）</Label>
              <Textarea
                value={form.features}
                onChange={e => setForm({ ...form, features: e.target.value })}
                placeholder={"每月 50 万 Token\n全部模型访问\n优先响应速度"}
                rows={5}
                className="font-mono text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>排序</Label>
                <Input type="number" value={form.sortOrder} onChange={e => setForm({ ...form, sortOrder: Number(e.target.value) })} />
              </div>
              <div className="space-y-3 pt-1">
                <div className="flex items-center gap-2">
                  <Switch checked={form.isPopular} onCheckedChange={v => setForm({ ...form, isPopular: v })} />
                  <Label>标记为推荐</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={form.enabled} onCheckedChange={v => setForm({ ...form, enabled: v })} />
                  <Label>启用套餐</Label>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setShowDialog(false)}>取消</Button>
            <Button onClick={handleSave} disabled={!form.name}>{editPlan ? '保存修改' : '创建套餐'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />确认删除套餐
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">删除后用户将无法订阅此套餐，已有订阅不受影响。</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>取消</Button>
            <Button variant="destructive" onClick={() => deleteConfirm && handleDelete(deleteConfirm)}>确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---- 用户订阅记录 ----
function SubscriptionRecordsTab() {
  const { subscriptions, updateSubscription, deleteSubscription } = useAdminStore()
  const [search, setSearch] = useState('')

  const reload = () => {
    if (isDemoMode()) return
    adminApi.listSubscriptions(1, 100).then(res => {
      const mapped: Subscription[] = (res.list || []).map((s: any) => ({
        id: s.id, userId: String(s.userId), userName: s.userName || String(s.userId),
        plan: s.plan, planName: s.planName, status: s.status, price: Number(s.price) || 0,
        costLimit: Number(s.costLimit ?? 0), costUsed: Number(s.costUsed ?? 0),
        tokensLimit: s.tokensLimit, modelLimit: s.modelLimit,
        startDate: s.startDate || '', endDate: s.endDate || '',
      }))
      useAdminStore.getState().setSubscriptions(mapped)
    }).catch(console.warn)
  }

  useEffect(() => { reload() }, [])

  const planStats = {
    free: subscriptions.filter(s => s.plan === 'free').length,
    pro: subscriptions.filter(s => s.plan === 'pro').length,
    enterprise: subscriptions.filter(s => s.plan === 'enterprise').length,
    active: subscriptions.filter(s => s.status === 'active').length,
  }
  const totalRevenue = subscriptions.filter(s => s.status === 'active').reduce((sum, s) => sum + s.price, 0)
  const filtered = subscriptions.filter(s => {
    const name = String(s.userName || s.userId || '')
    return name.toLowerCase().includes(search.toLowerCase()) || s.plan.includes(search.toLowerCase())
  })

  return (
    <div className="mobile-scroll-bottom-safe flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">用户订阅记录</h2>
          <p className="text-sm text-muted-foreground">月收入 ¥{totalRevenue.toLocaleString()} · {planStats.active} 个活跃订阅</p>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={reload}>
          <RefreshCw className="w-4 h-4" />刷新
        </Button>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: '免费版', count: planStats.free, color: 'bg-gray-100 dark:bg-gray-800/50', textColor: 'text-gray-600 dark:text-gray-400' },
          { label: 'Pro 版', count: planStats.pro, color: 'bg-blue-50 dark:bg-blue-900/20', textColor: 'text-blue-600' },
          { label: '企业版', count: planStats.enterprise, color: 'bg-purple-50 dark:bg-purple-900/20', textColor: 'text-purple-600' },
          { label: '活跃订阅', count: planStats.active, color: 'bg-green-50 dark:bg-green-900/20', textColor: 'text-green-600' },
        ].map(({ label, count, color, textColor }) => (
          <div key={label} className={cn('rounded-xl p-4 border', color)}>
            <p className={cn('text-2xl font-bold', textColor)}>{count}</p>
            <p className="text-sm font-medium mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索用户名或套餐..." className="pl-9" />
      </div>

      <div className="bg-card rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">用户</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">套餐</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">价格</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">消费额度</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">到期日期</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">状态</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(sub => {
              const isExpiringSoon = sub.status === 'active' && new Date(sub.endDate) < new Date(Date.now() + 86400000 * 7)
              return (
                <tr key={sub.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 font-medium">{sub.userName}</td>
                  <td className="px-4 py-3">
                    <Badge variant={sub.plan === 'enterprise' ? 'default' : sub.plan === 'pro' ? 'secondary' : 'outline'} className="text-xs">
                      {sub.planName || sub.plan}
                    </Badge>
                    {sub.modelLimit && <p className="text-[10px] text-muted-foreground mt-0.5">限: {sub.modelLimit}</p>}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono">¥{sub.price}/月</td>
                  <td className="px-4 py-3 text-xs">
                    ¥{Number(sub.costUsed ?? 0).toFixed(4)} / {sub.costLimit && sub.costLimit > 0 ? `¥${Number(sub.costLimit).toFixed(2)}` : '不限'}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span className={cn(isExpiringSoon && 'text-orange-500 font-medium')}>
                      {formatDate(sub.endDate)}{isExpiringSoon && ' ⚠️'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={sub.status === 'active' ? 'success' : sub.status === 'expired' ? 'warning' : 'destructive'} className="text-xs">
                      {sub.status === 'active' ? '有效' : sub.status === 'expired' ? '已过期' : '已取消'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" className="h-7 w-7"><MoreHorizontal className="w-4 h-4" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {sub.status === 'active' && (
                          <DropdownMenuItem className="text-destructive" onClick={async () => {
                            updateSubscription(sub.id, { status: 'cancelled' })
                            if (!isDemoMode()) { try { await adminApi.cancelSubscription(sub.id) } catch {} }
                          }}>
                            <X className="w-4 h-4 mr-2" />取消订阅
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive" onClick={async () => {
                          if (!isDemoMode()) { try { await adminApi.cancelSubscription(sub.id) } catch {} }
                          deleteSubscription(sub.id)
                        }}>
                          <Trash2 className="w-4 h-4 mr-2" />删除记录
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={7} className="text-center py-12 text-muted-foreground text-sm">暂无订阅记录</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ==================== Logs ====================
function LogsTab() {
  const { logs, setLogs } = useAdminStore()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'success' | 'error'>('all')
  const [modelFilter, setModelFilter] = useState('all')
  const [sceneFilter, setSceneFilter] = useState('all')
  const [detailLog, setDetailLog] = useState<LogEntry | null>(null)
  const [channelNameMap, setChannelNameMap] = useState<Record<string, string>>({})
  const [page, setPage] = useState(1)
  const pageSize = 20

  const resolveChannelName = useCallback((log?: Pick<LogEntry, 'channelId' | 'channelName'> | null) => {
    if (!log) return ''
    const explicitName = String(log.channelName || '').trim()
    if (explicitName) return explicitName
    const channelId = String(log.channelId || '').trim()
    return channelId ? (channelNameMap[channelId] || '') : ''
  }, [channelNameMap])

  const mapLogs = (list: any[]): LogEntry[] => list.map(l => ({
    id: String(l.id || l.uuid), userId: String(l.userId || ''),
    userName: String(l.userName || l.userId || ''),
    model: String(l.model || ''), inputTokens: Number(l.inputTokens) || 0,
    cachedInputTokens: Number(l.cachedInputTokens) || 0,
    outputTokens: Number(l.outputTokens) || 0, cost: Number(l.cost) || 0,
    latency: Number(l.latencyMs || l.latency) || 0,
    status: l.status === 'error' ? 'error' : 'success',
    timestamp: String(l.createdAt || l.timestamp || ''),
    conversationId: l.conversationId,
    requestIp: l.requestIp,
    provider: l.provider,
    channelId: l.channelId,
    channelName: l.channelName || channelNameMap[String(l.channelId || '').trim()],
    errorMsg: l.errorMsg,
    sceneType: l.sceneType || 'chat',
  }))

  useEffect(() => {
    if (isDemoMode()) return
    adminApi.listLogs(1, 100).then(res => setLogs(mapLogs(res.list || []))).catch(console.warn)
  }, [channelNameMap])

  useEffect(() => {
    if (isDemoMode()) return
    adminApi.listChannels().then(list => {
      const next: Record<string, string> = {}
      ;(list as any[]).forEach(c => {
        const name = String(c?.name || '').trim()
        if (!name) return
        if (c?.id != null) next[String(c.id)] = name
        if (c?.uuid != null && String(c.uuid).trim()) next[String(c.uuid).trim()] = name
      })
      setChannelNameMap(next)
    }).catch(console.warn)
  }, [])

  const uniqueModels = useMemo(() => ['all', ...Array.from(new Set(logs.map(l => l.model).filter(Boolean)))], [logs])

  const filtered = useMemo(() => logs.filter(l => {
    const userName = String(l.userName || l.userId || '')
    const model = String(l.model || '')
    const q = search.toLowerCase()
    const requestIp = String(l.requestIp || '')
    const provider = String(l.provider || '')
    const channelId = String(l.channelId || '')
    const channelName = resolveChannelName(l)
    const errorMsg = String(l.errorMsg || '')
    return (userName.toLowerCase().includes(q)
        || model.toLowerCase().includes(q)
        || requestIp.toLowerCase().includes(q)
        || provider.toLowerCase().includes(q)
        || channelId.toLowerCase().includes(q)
        || channelName.toLowerCase().includes(q)
        || errorMsg.toLowerCase().includes(q))
      && (filter === 'all' || l.status === filter)
      && (modelFilter === 'all' || l.model === modelFilter)
      && (sceneFilter === 'all' || l.sceneType === sceneFilter)
  }), [logs, search, filter, modelFilter, sceneFilter, resolveChannelName])

  const totalTokens = logs.reduce((s, l) => s + l.inputTokens + l.outputTokens, 0)
  const totalCost = logs.reduce((s, l) => s + l.cost, 0)
  const avgLatency = logs.length ? logs.reduce((s, l) => s + l.latency, 0) / logs.length : 0
  const errorRate = logs.length ? (logs.filter(l => l.status === 'error').length / logs.length * 100).toFixed(1) : '0'
  const pageData = filtered.slice((page - 1) * pageSize, page * pageSize)
  const totalPages = Math.ceil(filtered.length / pageSize)

  const refreshLogs = async () => {
    if (isDemoMode()) return
    try { const res = await adminApi.listLogs(1, 100); setLogs(mapLogs(res.list || [])) }
    catch (e) { console.warn('刷新日志失败:', e) }
  }

  return (
    <div className="mobile-scroll-bottom-safe flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-semibold">日志管理</h2>
          <p className="text-sm text-muted-foreground">共 {logs.length} 条请求记录</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => {}}><Download className="w-4 h-4" />导出</Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={refreshLogs}><RefreshCw className="w-4 h-4" />刷新</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        {[
          { label: '总 Token 用量', value: formatNumber(totalTokens), icon: Zap, color: 'text-blue-500' },
          { label: '累计费用', value: `¥${(totalCost * 7.3).toFixed(2)}`, icon: DollarSign, color: 'text-green-500' },
          { label: '平均延迟', value: `${avgLatency.toFixed(0)}ms`, icon: Activity, color: 'text-orange-500' },
          { label: '错误率', value: `${errorRate}%`, icon: AlertTriangle, color: Number(errorRate) > 5 ? 'text-red-500' : 'text-muted-foreground' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-card rounded-xl border p-4">
            <div className="flex items-center justify-between mb-1"><p className="text-xs text-muted-foreground">{label}</p><Icon className={cn('w-4 h-4', color)} /></div>
            <p className="text-xl font-bold">{value}</p>
          </div>
        ))}
      </div>

      <div className="flex gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder="搜索用户、模型、IP、渠道或失败原因..." className="pl-9" />
        </div>
        <Select value={modelFilter} onValueChange={v => { setModelFilter(v); setPage(1) }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="选择模型" /></SelectTrigger>
          <SelectContent>{uniqueModels.map(m => <SelectItem key={m} value={m}>{m === 'all' ? '全部模型' : m}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={sceneFilter} onValueChange={v => { setSceneFilter(v); setPage(1) }}>
          <SelectTrigger className="w-32"><SelectValue placeholder="来源" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部来源</SelectItem>
            <SelectItem value="chat">对话</SelectItem>
            <SelectItem value="autocode">AutoCode</SelectItem>
            <SelectItem value="translate">翻译</SelectItem>
            <SelectItem value="image">图片</SelectItem>
            <SelectItem value="asr">语音</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex gap-1">
          {(['all', 'success', 'error'] as const).map(f => (
            <Button key={f} size="sm" variant={filter === f ? 'default' : 'outline'} onClick={() => { setFilter(f); setPage(1) }}>
              {f === 'all' ? '全部' : f === 'success' ? '成功' : '失败'}
            </Button>
          ))}
        </div>
      </div>

      <div className="bg-card rounded-xl border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[980px]">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">用户</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">模型</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">来源</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">请求 IP</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">输入 Token</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">输出 Token</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">费用</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">延迟</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">状态</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">时间</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">详情</th>
            </tr>
          </thead>
          <tbody>
            {pageData.map(log => (
              <tr key={log.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors cursor-pointer" onClick={() => setDetailLog(log)}>
                <td className="px-4 py-2.5 font-medium text-sm">{log.userName}</td>
                <td className="px-4 py-2.5">
                  <div className="text-xs text-muted-foreground font-mono">{log.model}</div>
                  {(log.provider || resolveChannelName(log) || log.channelId) && (
                    <div className="text-[10px] text-muted-foreground/70 font-mono mt-0.5">
                      {[log.provider, resolveChannelName(log) || log.channelId].filter(Boolean).join(' / ')}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                    {{ chat: '对话', autocode: 'AutoCode', translate: '翻译', image: '图片', asr: '语音' }[log.sceneType || 'chat'] || log.sceneType || '对话'}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground font-mono">{log.requestIp || '-'}</td>
                <td className="px-4 py-2.5 text-xs font-mono">{log.inputTokens.toLocaleString()}</td>
                <td className="px-4 py-2.5 text-xs font-mono">{log.outputTokens.toLocaleString()}</td>
                <td className="px-4 py-2.5 text-xs font-mono">¥{(log.cost * 7.3).toFixed(4)}</td>
                <td className="px-4 py-2.5 text-xs">{log.latency}ms</td>
                <td className="px-4 py-2.5"><Badge variant={log.status === 'success' ? 'success' : 'destructive'} className="text-xs">{log.status === 'success' ? '成功' : '失败'}</Badge></td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">{formatDate(log.timestamp)}</td>
                <td className="px-4 py-2.5"><Button size="icon" variant="ghost" className="h-6 w-6" onClick={e => { e.stopPropagation(); setDetailLog(log) }}><Eye className="w-3.5 h-3.5" /></Button></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {pageData.length === 0 && <div className="text-center py-12 text-muted-foreground"><FileText className="w-8 h-8 mx-auto mb-2 opacity-40" /><p className="text-sm">暂无日志记录</p></div>}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-xs text-muted-foreground">共 {filtered.length} 条，第 {page}/{totalPages} 页</p>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>下一页</Button>
          </div>
        </div>
      )}

      <Dialog open={!!detailLog} onOpenChange={() => setDetailLog(null)}>
        <DialogContent className="max-w-[95vw] sm:max-w-md">
          <DialogHeader><DialogTitle>请求详情</DialogTitle></DialogHeader>
          {detailLog && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: '用户', value: detailLog.userName },
                  { label: '模型', value: detailLog.model },
                  { label: '输入 Token', value: detailLog.inputTokens.toLocaleString() },
                  { label: '缓存 Token', value: (detailLog.cachedInputTokens || 0).toLocaleString() },
                  { label: '输出 Token', value: detailLog.outputTokens.toLocaleString() },
                  { label: '费用', value: `¥${(detailLog.cost * 7.3).toFixed(4)}` },
                  { label: '延迟', value: `${detailLog.latency}ms` },
                  { label: '请求 IP', value: detailLog.requestIp || '-' },
                  { label: '供应商', value: detailLog.provider || '-' },
                  { label: '渠道', value: resolveChannelName(detailLog) || detailLog.channelId || '-' },
                  { label: '来源', value: { chat: '对话', autocode: 'AutoCode', translate: '翻译', image: '图片', asr: '语音' }[detailLog.sceneType || 'chat'] || detailLog.sceneType || '对话' },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-muted/50 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground mb-1">{label}</p>
                    <p className="font-mono text-xs font-medium break-all whitespace-pre-wrap min-w-0">{value}</p>
                  </div>
                ))}
              </div>
              <div className="bg-muted/50 rounded-lg p-3"><p className="text-xs text-muted-foreground mb-1">时间</p><p className="font-mono text-xs">{detailLog.timestamp}</p></div>
              {detailLog.conversationId && <div className="bg-muted/50 rounded-lg p-3"><p className="text-xs text-muted-foreground mb-1">对话 ID</p><p className="font-mono text-xs">{detailLog.conversationId}</p></div>}
              {detailLog.errorMsg && <div className="bg-destructive/10 rounded-lg p-3"><p className="text-xs text-destructive mb-1">失败原因</p><p className="font-mono text-xs whitespace-pre-wrap break-words">{detailLog.errorMsg}</p></div>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ==================== Agents ====================
function AgentsTab() {
  const [mode, setMode] = useState<'pending' | 'all'>('pending')
  const [pendingAgents, setPendingAgents] = useState<any[]>([])
  const [allAgents, setAllAgents] = useState<any[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const [skillSearch, setSkillSearch] = useState('')
  const [categories, setCategories] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [reviewDialog, setReviewDialog] = useState<{ agentId: string; action: 'approve' | 'reject' } | null>(null)
  const [reviewComment, setReviewComment] = useState('')
  const [editingRatio, setEditingRatio] = useState<{ agentId: string; ratio: number } | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<AgentRegistryDetail | null>(null)
  const [fileTree, setFileTree] = useState<AgentFileNode[]>([])
  const [selectedFile, setSelectedFile] = useState<{ path: string; content: string } | null>(null)
  const [tryPrompt, setTryPrompt] = useState('请用一句话说明这个 skill 的核心能力，并列出可能风险。')
  const [complianceResult, setComplianceResult] = useState<any | null>(null)
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set())
  const [batchLoading, setBatchLoading] = useState(false)
  const pageSize = 15

  const fetchPending = async () => {
    if (isDemoMode()) return
    setLoading(true)
    try { const res = await agentRegistryApi.pending(); setPendingAgents(Array.isArray(res) ? res : []) }
    catch (e) { console.warn('获取待审核Agent失败:', e) }
    finally { setLoading(false) }
  }

  const fetchAll = async () => {
    if (isDemoMode()) return
    setLoading(true)
    try {
      const res = await agentRegistryApi.adminAll({
        page,
        size: pageSize,
        status: statusFilter || undefined,
        category: categoryFilter || undefined,
        q: skillSearch.trim() || undefined,
      })
      setAllAgents(res.content || res.list || [])
      setTotalPages(Math.ceil((res.total || res.totalElements || 0) / pageSize))
    } catch (e) { console.warn('获取所有Agent失败:', e) }
    finally { setLoading(false) }
  }

  useEffect(() => { if (mode === 'pending') fetchPending(); else fetchAll() }, [mode])
  useEffect(() => { if (mode === 'all') fetchAll() }, [page, statusFilter, categoryFilter])
  useEffect(() => { agentRegistryApi.getCategories().then(setCategories).catch(() => {}) }, [])
  useEffect(() => { setSelectedSkillIds(new Set()) }, [mode, page, statusFilter, categoryFilter, skillSearch])
  useEffect(() => {
    if (mode !== 'all') return
    const t = window.setTimeout(() => { setPage(1); fetchAll() }, 350)
    return () => window.clearTimeout(t)
  }, [skillSearch])

  const handleApprove = async () => {
    if (!reviewDialog) return
    try { await agentRegistryApi.approve(reviewDialog.agentId, reviewComment); fetchPending(); setReviewDialog(null); setReviewComment('') }
    catch (e: any) { alert('审核失败: ' + (e.message || e)) }
  }

  const handleReject = async () => {
    if (!reviewDialog || !reviewComment.trim()) { alert('请输入拒绝原因'); return }
    try { await agentRegistryApi.reject(reviewDialog.agentId, reviewComment); fetchPending(); setReviewDialog(null); setReviewComment('') }
    catch (e: any) { alert('拒绝失败: ' + (e.message || e)) }
  }

  const handleToggle = async (agentId: string, currentStatus: string) => {
    const target = currentStatus === 'active' ? 'disabled' : 'active'
    try { await agentRegistryApi.toggleStatus(agentId, target); fetchAll() }
    catch (e: any) { alert('操作失败: ' + (e.message || e)) }
  }

  const handleDelete = async (agentId: string) => {
    if (!confirm('确定删除该 Skill?')) return
    try { await agentRegistryApi.adminDelete(agentId); fetchAll(); fetchPending() }
    catch (e: any) { alert('删除失败: ' + (e.message || e)) }
  }

  const currentAgents = mode === 'pending' ? pendingAgents : allAgents
  const currentIds = currentAgents.map((agent: any) => agent.agentId).filter(Boolean)
  const selectedIds = Array.from(selectedSkillIds)
  const allCurrentSelected = currentIds.length > 0 && currentIds.every((id: string) => selectedSkillIds.has(id))

  const toggleSelectedSkill = (agentId: string, checked: boolean) => {
    setSelectedSkillIds(prev => {
      const next = new Set(prev)
      checked ? next.add(agentId) : next.delete(agentId)
      return next
    })
  }

  const toggleSelectCurrent = (checked: boolean) => {
    setSelectedSkillIds(prev => {
      const next = new Set(prev)
      currentIds.forEach((id: string) => checked ? next.add(id) : next.delete(id))
      return next
    })
  }

  const refreshAgentsAfterBatch = async () => {
    await Promise.all([fetchPending(), fetchAll()])
    setSelectedSkillIds(new Set())
  }

  const runBatch = async (action: 'approve' | 'reject' | 'active' | 'disabled' | 'delete') => {
    if (selectedIds.length === 0) return
    let comment = ''
    if (action === 'reject') {
      comment = prompt('请输入批量拒绝原因:') || ''
      if (!comment.trim()) return
    }
    if (action === 'delete' && !confirm(`确定删除选中的 ${selectedIds.length} 个 Skill?`)) return
    setBatchLoading(true)
    try {
      for (const agentId of selectedIds) {
        if (action === 'approve') await agentRegistryApi.approve(agentId, '')
        if (action === 'reject') await agentRegistryApi.reject(agentId, comment)
        if (action === 'active') await agentRegistryApi.toggleStatus(agentId, 'active')
        if (action === 'disabled') await agentRegistryApi.toggleStatus(agentId, 'disabled')
        if (action === 'delete') await agentRegistryApi.adminDelete(agentId)
      }
      await refreshAgentsAfterBatch()
    } catch (e: any) {
      alert('批量操作失败: ' + (e.message || e))
      fetchPending()
      fetchAll()
    } finally {
      setBatchLoading(false)
    }
  }

  const handleSaveRatio = async () => {
    if (!editingRatio) return
    try { await agentRegistryApi.setRevenueRatio(editingRatio.agentId, editingRatio.ratio); fetchAll(); setEditingRatio(null) }
    catch (e: any) { alert('保存失败: ' + (e.message || e)) }
  }

  const flattenFiles = (nodes: AgentFileNode[]): AgentFileNode[] => {
    const out: AgentFileNode[] = []
    nodes.forEach(n => {
      const isDir = n.isDirectory || n.type === 'directory'
      if (!isDir) out.push(n)
      if (n.children?.length) out.push(...flattenFiles(n.children))
    })
    return out
  }

  const openDetail = async (agentId: string) => {
    setDetailOpen(true)
    setDetailLoading(true)
    setSelectedAgent(null)
    setFileTree([])
    setSelectedFile(null)
    setComplianceResult(null)
    try {
      const [detail, files] = await Promise.all([
        agentRegistryApi.getDetail(agentId),
        agentRegistryApi.getFileTree(agentId).catch(() => []),
      ])
      setSelectedAgent(detail)
      setFileTree(files)
      const firstFile = flattenFiles(files).find(f => /(^|\/|\\)(SKILL\.md|package\.json)$/.test(f.path || f.name)) || flattenFiles(files)[0]
      if (firstFile?.path) {
        const content = await agentRegistryApi.readFile(agentId, firstFile.path)
        setSelectedFile({ path: firstFile.path, content: String(content || '') })
      }
    } catch (e: any) {
      alert('加载详情失败: ' + (e.message || e))
    } finally {
      setDetailLoading(false)
    }
  }

  const readSkillFile = async (path: string) => {
    if (!selectedAgent) return
    const content = await agentRegistryApi.readFile(selectedAgent.agentId, path)
    setSelectedFile({ path, content: String(content || '') })
  }

  const runComplianceCheck = () => {
    if (!selectedAgent) return
    const filesText = `${selectedFile?.path || ''}\n${selectedFile?.content || ''}`.toLowerCase()
    const tools = selectedAgent.tools || []
    const dangerousHits = [
      'rm -rf', 'delete', 'remove-item', 'format ', 'shutdown', 'eval(', 'exec(', 'system(', 'subprocess',
      'private_key', 'password', 'token', 'secret', 'cookie', 'credential',
    ].filter(k => filesText.includes(k) || JSON.stringify(tools).toLowerCase().includes(k))
    const missing = [
      !selectedAgent.name && '名称',
      !selectedAgent.description && '描述',
      !selectedAgent.systemPrompt && '系统提示词',
      tools.length === 0 && '工具定义',
      !selectedAgent.usageGuide && '使用说明',
    ].filter(Boolean)
    setComplianceResult({
      prompt: tryPrompt,
      passed: dangerousHits.length === 0 && missing.length === 0,
      dangerousHits,
      missing,
      toolCount: tools.length,
      checkedAt: new Date().toLocaleString(),
    })
  }

  return (
    <div className="mobile-scroll-bottom-safe flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">Skill 管理</h2>
          <p className="text-sm text-muted-foreground">
            {mode === 'pending' ? `${pendingAgents.length} 个待审核` : `第 ${page}/${totalPages} 页`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant={mode === 'pending' ? 'default' : 'outline'} onClick={() => { setMode('pending'); setPage(1) }}>待审核</Button>
          <Button size="sm" variant={mode === 'all' ? 'default' : 'outline'} onClick={() => { setMode('all'); setPage(1) }}>所有 Skill</Button>
        </div>
      </div>

      {mode === 'all' && (
        <div className="flex gap-3 mb-4 flex-wrap">
          <div className="relative min-w-[260px] flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={skillSearch}
              onChange={e => setSkillSearch(e.target.value)}
              placeholder="搜索名称、Agent ID、作者、描述..."
              className="pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={v => { setStatusFilter(v === 'all' ? '' : v); setPage(1) }}>
            <SelectTrigger className="w-36"><SelectValue placeholder="全部状态" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="active">已启用</SelectItem>
              <SelectItem value="disabled">已禁用</SelectItem>
              <SelectItem value="approved">已通过</SelectItem>
              <SelectItem value="pending">待审核</SelectItem>
              <SelectItem value="rejected">已拒绝</SelectItem>
            </SelectContent>
          </Select>
          <Select value={categoryFilter || 'all'} onValueChange={v => { setCategoryFilter(v === 'all' ? '' : v); setPage(1) }}>
            <SelectTrigger className="w-40"><SelectValue placeholder="全部分类" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部分类</SelectItem>
              {categories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={fetchAll}><RefreshCw className="w-4 h-4 mr-1" />刷新</Button>
        </div>
      )}

      {selectedIds.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
          <div className="text-sm">
            已选择 <span className="font-semibold">{selectedIds.length}</span> 个 Skill
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {mode === 'pending' && (
              <>
                <Button size="sm" disabled={batchLoading} onClick={() => runBatch('approve')}>
                  批量通过
                </Button>
                <Button size="sm" variant="outline" disabled={batchLoading} onClick={() => runBatch('reject')}>
                  批量拒绝
                </Button>
              </>
            )}
            <Button size="sm" variant="outline" disabled={batchLoading} onClick={() => runBatch('active')}>
              批量启用
            </Button>
            <Button size="sm" variant="outline" disabled={batchLoading} onClick={() => runBatch('disabled')}>
              批量禁用
            </Button>
            <Button size="sm" variant="destructive" disabled={batchLoading} onClick={() => runBatch('delete')}>
              批量删除
            </Button>
            <Button size="sm" variant="ghost" disabled={batchLoading} onClick={() => setSelectedSkillIds(new Set())}>
              清空
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-muted-foreground">加载中...</div>
      ) : mode === 'pending' ? (
        <>
          {pendingAgents.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><CheckCircle2 className="w-8 h-8 mx-auto mb-2 opacity-40" /><p className="text-sm">暂无待审核 Skill</p></div>
          ) : (
            <div className="space-y-3">
              <label className="flex w-fit items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={allCurrentSelected}
                  onChange={e => toggleSelectCurrent(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                选择当前列表
              </label>
              {pendingAgents.map((agent: any) => (
                <div key={agent.agentId} className="bg-card rounded-xl border p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <input
                        type="checkbox"
                        checked={selectedSkillIds.has(agent.agentId)}
                        onChange={e => toggleSelectedSkill(agent.agentId, e.target.checked)}
                        className="mt-1 h-4 w-4 rounded border-border"
                        aria-label={`选择 ${agent.name}`}
                      />
                      <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-sm">{agent.name}</h3>
                        <Badge variant="outline" className="text-xs">{agent.agentId}</Badge>
                        {agent.category && <Badge variant="secondary" className="text-xs">{agent.category}</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground mb-2 line-clamp-2">{agent.description}</p>
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span>作者: {agent.author || '未知'}</span>
                        <span>推荐模型: {agent.model || '自动'}</span>
                        <span>注册时间: {formatDate(agent.createdAt)}</span>
                      </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-4">
                      <Button size="sm" variant="outline" className="gap-1" onClick={() => openDetail(agent.agentId)}>
                        <Eye className="w-3.5 h-3.5" />详情
                      </Button>
                      <Button size="sm" variant="default" className="gap-1" onClick={() => setReviewDialog({ agentId: agent.agentId, action: 'approve' })}>
                        <CheckCircle2 className="w-3.5 h-3.5" />通过
                      </Button>
                      <Button size="sm" variant="outline" className="gap-1 text-destructive hover:text-destructive" onClick={() => setReviewDialog({ agentId: agent.agentId, action: 'reject' })}>
                        <X className="w-3.5 h-3.5" />拒绝
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="bg-card rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={allCurrentSelected}
                    onChange={e => toggleSelectCurrent(e.target.checked)}
                    className="h-4 w-4 rounded border-border"
                    aria-label="选择当前页 Skill"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">Agent</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">分类</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">使用量</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">分成比例</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">作者</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">操作</th>
              </tr>
            </thead>
            <tbody>
              {allAgents.map((agent: any) => (
                <tr key={agent.agentId} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-2.5">
                    <input
                      type="checkbox"
                      checked={selectedSkillIds.has(agent.agentId)}
                      onChange={e => toggleSelectedSkill(agent.agentId, e.target.checked)}
                      className="h-4 w-4 rounded border-border"
                      aria-label={`选择 ${agent.name}`}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-sm">{agent.name}</div>
                    <div className="text-xs text-muted-foreground font-mono">{agent.agentId}</div>
                  </td>
                  <td className="px-4 py-2.5 text-xs">{agent.category || '-'}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={agent.status === 'active' ? 'success' : agent.status === 'approved' ? 'default' : agent.status === 'pending' ? 'outline' : agent.status === 'rejected' ? 'destructive' : 'secondary'} className="text-xs">
                      {agent.status === 'active' ? '已启用' : agent.status === 'approved' ? '已通过' : agent.status === 'pending' ? '待审核' : agent.status === 'rejected' ? '已拒绝' : '已禁用'}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-xs font-mono">{agent.totalUsage?.toLocaleString() || '0'} 次</td>
                  <td className="px-4 py-2.5 text-xs">
                    {editingRatio && editingRatio.agentId === agent.agentId ? (
                      <div className="flex items-center gap-1">
                        <Input type="number" min="0" max="1" step="0.01" value={editingRatio.ratio} onChange={e => setEditingRatio({ agentId: agent.agentId, ratio: parseFloat(e.target.value) || 0 })}
                          className="w-16 h-7 text-xs" />
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={handleSaveRatio}><CheckCircle2 className="w-3 h-3" /></Button>
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => setEditingRatio(null)}><X className="w-3 h-3" /></Button>
                      </div>
                    ) : (
                      <span className="cursor-pointer hover:text-primary" onClick={() => setEditingRatio({ agentId: agent.agentId, ratio: agent.revenueRatio || 0.3 })}>
                        {((agent.revenueRatio || 0.3) * 100).toFixed(0)}%
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{agent.author || '-'}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => openDetail(agent.agentId)}>
                        详情
                      </Button>
                      {(agent.status === 'active' || agent.status === 'disabled' || agent.status === 'approved') && (
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => handleToggle(agent.agentId, agent.status)}>
                          {agent.status === 'active' ? '禁用' : '启用'}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive hover:text-destructive" onClick={() => handleDelete(agent.agentId)}>
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {allAgents.length === 0 && (
            <div className="text-center py-12 text-muted-foreground"><Bot className="w-8 h-8 mx-auto mb-2 opacity-40" /><p className="text-sm">暂无 Skill</p></div>
          )}
        </div>
      )}

      {mode === 'all' && totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-xs text-muted-foreground">共 {totalPages} 页</p>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>下一页</Button>
          </div>
        </div>
      )}

      <Dialog open={!!reviewDialog} onOpenChange={() => setReviewDialog(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{reviewDialog?.action === 'approve' ? '审核通过' : '拒绝 Skill'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label>审核意见</Label>
            <Textarea value={reviewComment} onChange={e => setReviewComment(e.target.value)}
              placeholder={reviewDialog?.action === 'approve' ? '请输入通过说明（可选）' : '请输入拒绝原因（必填）'}
              rows={3} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewDialog(null)}>取消</Button>
            <Button onClick={reviewDialog?.action === 'approve' ? handleApprove : handleReject}>
              {reviewDialog?.action === 'approve' ? '确认通过' : '确认拒绝'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-[96vw] sm:max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bot className="w-5 h-5" />
              Skill 详情
            </DialogTitle>
          </DialogHeader>
          {detailLoading ? (
            <div className="py-16 text-center text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />加载中...
            </div>
          ) : selectedAgent ? (
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 min-h-0 overflow-y-auto pr-1">
              <div className="lg:col-span-2 space-y-3">
                <div className="rounded-lg border p-4 space-y-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold">{selectedAgent.name}</h3>
                      <Badge variant="outline" className="text-xs">{selectedAgent.agentId}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{selectedAgent.description || '暂无描述'}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded bg-muted/40 p-2"><span className="text-muted-foreground">状态</span><p>{selectedAgent.status}</p></div>
                    <div className="rounded bg-muted/40 p-2"><span className="text-muted-foreground">作者</span><p>{selectedAgent.author || '-'}</p></div>
                    <div className="rounded bg-muted/40 p-2"><span className="text-muted-foreground">模型</span><p>{selectedAgent.model || '自动'}</p></div>
                    <div className="rounded bg-muted/40 p-2"><span className="text-muted-foreground">工具数</span><p>{selectedAgent.tools?.length || 0}</p></div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(selectedAgent.categories || []).map(c => <Badge key={c} variant="secondary" className="text-xs">{c}</Badge>)}
                  </div>
                  {selectedAgent.reviewComment && (
                    <div className="text-xs rounded bg-muted/40 p-2">
                      <span className="text-muted-foreground">审核意见</span>
                      <p className="mt-1">{selectedAgent.reviewComment}</p>
                    </div>
                  )}
                </div>

                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="font-medium text-sm flex items-center gap-2"><PlayCircle className="w-4 h-4" />审核试用与合规判断</h4>
                    <Button size="sm" onClick={runComplianceCheck}>执行判断</Button>
                  </div>
                  <Textarea value={tryPrompt} onChange={e => setTryPrompt(e.target.value)} rows={3} placeholder="输入试用提示词，用于记录审核场景..." />
                  {complianceResult && (
                    <div className={cn('rounded-lg border p-3 text-xs space-y-2', complianceResult.passed ? 'border-green-200 bg-green-50 dark:bg-green-950/20' : 'border-orange-200 bg-orange-50 dark:bg-orange-950/20')}>
                      <div className="flex items-center gap-2 font-medium">
                        {complianceResult.passed ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <AlertTriangle className="w-4 h-4 text-orange-600" />}
                        {complianceResult.passed ? '基础合规检查通过' : '需要人工重点复核'}
                      </div>
                      <p>工具数量：{complianceResult.toolCount} · 检查时间：{complianceResult.checkedAt}</p>
                      {complianceResult.missing.length > 0 && <p>缺失项：{complianceResult.missing.join('、')}</p>}
                      {complianceResult.dangerousHits.length > 0 && <p>风险关键词：{complianceResult.dangerousHits.join('、')}</p>}
                    </div>
                  )}
                </div>
              </div>

              <div className="lg:col-span-3 space-y-3">
                <div className="rounded-lg border overflow-hidden">
                  <div className="px-3 py-2 border-b bg-muted/40 text-sm font-medium">系统提示词</div>
                  <pre className="max-h-40 overflow-auto p-3 text-xs whitespace-pre-wrap font-mono">{selectedAgent.systemPrompt || '-'}</pre>
                </div>
                <div className="rounded-lg border overflow-hidden">
                  <div className="px-3 py-2 border-b bg-muted/40 text-sm font-medium">工具定义</div>
                  <pre className="max-h-44 overflow-auto p-3 text-xs whitespace-pre-wrap font-mono">{JSON.stringify(selectedAgent.tools || [], null, 2)}</pre>
                </div>
                <div className="rounded-lg border overflow-hidden">
                  <div className="px-3 py-2 border-b bg-muted/40 text-sm font-medium">文件内容</div>
                  <div className="grid grid-cols-1 sm:grid-cols-[220px_1fr] min-h-[260px]">
                    <div className="border-r p-2 space-y-1 overflow-auto max-h-[360px]">
                      {flattenFiles(fileTree).map(f => (
                        <button key={f.path || f.name} className={cn('block w-full text-left text-xs px-2 py-1 rounded truncate hover:bg-muted', selectedFile?.path === f.path && 'bg-muted font-medium')} onClick={() => f.path && readSkillFile(f.path)}>
                          {f.path || f.name}
                        </button>
                      ))}
                      {flattenFiles(fileTree).length === 0 && <p className="text-xs text-muted-foreground p-2">暂无文件</p>}
                    </div>
                    <pre className="p-3 text-xs whitespace-pre-wrap font-mono overflow-auto max-h-[360px]">{selectedFile?.content || '请选择文件'}</pre>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="py-12 text-center text-muted-foreground">未选择 Skill</div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ==================== Wallet Admin ====================
function WalletAdminTab() {
  const [transactions, setTransactions] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [rechargeForm, setRechargeForm] = useState({ userId: '', amount: '', description: '' })

  const fetchTransactions = async () => {
    if (isDemoMode()) return
    setLoading(true)
    try { const res = await walletApi.adminTransactions(100); setTransactions(Array.isArray(res) ? res : []) }
    catch (e) { console.warn('获取交易记录失败:', e) }
    finally { setLoading(false) }
  }

  useEffect(() => { fetchTransactions() }, [])

  const handleRecharge = async () => {
    const userId = parseInt(rechargeForm.userId.trim())
    const amount = parseFloat(rechargeForm.amount)
    if (!userId || isNaN(amount) || amount <= 0) { alert('请输入有效的用户ID和金额'); return }
    try {
      await walletApi.adminRecharge(userId, amount, rechargeForm.description || '管理员充值')
      setRechargeForm({ userId: '', amount: '', description: '' })
      fetchTransactions()
      alert('充值成功')
    } catch (e: any) { alert('充值失败: ' + (e.message || e)) }
  }

  const handleApproveWithdraw = async (txId: string) => {
    if (!confirm('确定批准此提现申请?')) return
    try { await walletApi.adminApproveWithdraw(Number(txId)); fetchTransactions() }
    catch (e: any) { alert('操作失败: ' + (e.message || e)) }
  }

  const handleRejectWithdraw = async (txId: string) => {
    const reason = prompt('请输入拒绝原因:')
    if (!reason) return
    try { await walletApi.adminRejectWithdraw(Number(txId), reason); fetchTransactions() }
    catch (e: any) { alert('操作失败: ' + (e.message || e)) }
  }

  return (
    <div className="mobile-scroll-bottom-safe flex-1 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">钱包管理</h2>
          <p className="text-sm text-muted-foreground">{transactions.length} 条交易记录</p>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={fetchTransactions}><RefreshCw className="w-4 h-4" />刷新</Button>
      </div>

      <div className="bg-card rounded-xl border p-4 mb-6">
        <h3 className="font-semibold text-sm mb-3">管理员充值</h3>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="space-y-1.5">
            <Label className="text-xs">用户 ID</Label>
            <Input placeholder="输入用户ID" value={rechargeForm.userId} onChange={e => setRechargeForm(f => ({ ...f, userId: e.target.value }))} className="w-40" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">金额 (元)</Label>
            <Input type="number" placeholder="0.00" value={rechargeForm.amount} onChange={e => setRechargeForm(f => ({ ...f, amount: e.target.value }))} className="w-28" />
          </div>
          <div className="space-y-1.5 flex-1 min-w-[150px]">
            <Label className="text-xs">说明</Label>
            <Input placeholder="充值说明" value={rechargeForm.description} onChange={e => setRechargeForm(f => ({ ...f, description: e.target.value }))} className="w-full" />
          </div>
          <Button size="sm" onClick={handleRecharge} className="gap-1"><Plus className="w-3.5 h-3.5" />充值</Button>
        </div>
      </div>

      <div className="bg-card rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">用户</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">类型</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">金额</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">说明</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">状态</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">时间</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">操作</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((tx: any) => (
              <tr key={tx.id} className="border-b last:border-0 hover:bg-muted/20">
                <td className="px-4 py-2.5 text-xs font-mono">{tx.userId}</td>
                <td className="px-4 py-2.5">
                  <Badge variant={
                    tx.type === 'deposit' ? 'success' :
                    tx.type === 'withdraw' ? 'outline' :
                    tx.type === 'consume' ? 'destructive' :
                    tx.type === 'earn' ? 'success' : 'secondary'
                  } className="text-xs">
                    {tx.type === 'deposit' ? '充值' : tx.type === 'withdraw' ? '提现' : tx.type === 'consume' ? '消费' : tx.type === 'earn' ? '收益' : tx.type}
                  </Badge>
                </td>
                <td className={cn('px-4 py-2.5 text-xs font-mono font-medium',
                  (tx.type === 'deposit' || tx.type === 'earn') ? 'text-green-600' :
                  (tx.type === 'withdraw' || tx.type === 'consume') ? 'text-red-600' : '')}>
                  {(tx.type === 'deposit' || tx.type === 'earn') ? '+' : (tx.type === 'withdraw' || tx.type === 'consume') ? '-' : ''}¥{Math.abs(tx.amount || 0).toFixed(2)}
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-[150px] truncate">{tx.description || '-'}</td>
                <td className="px-4 py-2.5">
                  <Badge variant={tx.status === 'completed' ? 'success' : tx.status === 'pending' ? 'outline' : 'secondary'} className="text-xs">
                    {tx.status === 'completed' ? '已完成' : tx.status === 'pending' ? '待处理' : tx.status}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">{formatDate(tx.createdAt)}</td>
                <td className="px-4 py-2.5">
                  {tx.type === 'withdraw' && tx.status === 'pending' && (
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" className="h-7 text-xs text-green-600" onClick={() => handleApproveWithdraw(tx.id)}>批准</Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => handleRejectWithdraw(tx.id)}>拒绝</Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {transactions.length === 0 && !loading && (
          <div className="text-center py-12 text-muted-foreground"><DollarSign className="w-8 h-8 mx-auto mb-2 opacity-40" /><p className="text-sm">暂无交易记录</p></div>
        )}
      </div>
    </div>
  )
}
