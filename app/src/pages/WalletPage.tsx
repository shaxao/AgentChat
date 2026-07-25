import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Wallet,
  ArrowUpCircle,
  ArrowDownCircle,
  History,
  Loader2,
  CreditCard,
  ReceiptText,
  TableProperties,
  BarChart3,
  RefreshCw,
  Eye,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { walletApi, usageApi, type WalletTransaction, type UserUsageSummary, type UserUsageLogItem, type ModelPriceItem } from '@/lib/api'
import type { AppPage } from '@/App'

interface WalletPageProps { onNavigate: (page: AppPage) => void }
type WalletTab = 'transactions' | 'usage' | 'prices'

const SCENE_LABEL: Record<string, string> = {
  chat: '对话',
  api: '外部 API',
  autocode: 'AutoCode',
  translate: '翻译',
  image: '图片',
  asr: '语音',
  tts: '语音合成',
}

function money(value?: number | null, digits = 4) {
  return `¥${Number(value || 0).toFixed(digits)}`
}

function price(value?: number | null) {
  return `¥${Number(value || 0).toFixed(4)}/1M`
}

function tokens(value?: number | null) {
  return Number(value || 0).toLocaleString()
}

function formatTime(value?: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
}

export default function WalletPage({ onNavigate }: WalletPageProps) {
  const [activeTab, setActiveTab] = useState<WalletTab>('transactions')
  const [balance, setBalance] = useState<number>(0)
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [loading, setLoading] = useState(true)

  const [rechargeAmount, setRechargeAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('alipay')
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  const [usageLoading, setUsageLoading] = useState(false)
  const [summary, setSummary] = useState<UserUsageSummary | null>(null)
  const [usageLogs, setUsageLogs] = useState<UserUsageLogItem[]>([])
  const [usageTotal, setUsageTotal] = useState(0)
  const [usagePage, setUsagePage] = useState(1)
  const usagePageSize = 20
  const [modelFilter, setModelFilter] = useState('all')
  const [sceneFilter, setSceneFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [detailLog, setDetailLog] = useState<UserUsageLogItem | null>(null)

  const [priceLoading, setPriceLoading] = useState(false)
  const [modelPrices, setModelPrices] = useState<ModelPriceItem[]>([])

  const loadWallet = useCallback(async () => {
    setLoading(true)
    try {
      const [bal, txs] = await Promise.all([walletApi.getBalance(), walletApi.getTransactions()])
      setBalance(Number(bal || 0))
      setTransactions(txs || [])
    } catch (e) {
      console.error('加载钱包数据失败:', e)
      setMessage((e as Error).message || '加载钱包数据失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadUsage = useCallback(async () => {
    setUsageLoading(true)
    try {
      const [sum, logs] = await Promise.all([
        usageApi.summary(30),
        usageApi.logs({ page: usagePage, size: usagePageSize, model: modelFilter, sceneType: sceneFilter, status: statusFilter }),
      ])
      setSummary(sum)
      setUsageLogs(logs.list || [])
      setUsageTotal(Number(logs.total || 0))
    } catch (e) {
      console.error('加载用量明细失败:', e)
      setMessage((e as Error).message || '加载用量明细失败')
    } finally {
      setUsageLoading(false)
    }
  }, [modelFilter, sceneFilter, statusFilter, usagePage])

  const loadPrices = useCallback(async () => {
    setPriceLoading(true)
    try {
      setModelPrices(await usageApi.modelPrices())
    } catch (e) {
      console.error('加载模型价目表失败:', e)
      setMessage((e as Error).message || '加载模型价目表失败')
    } finally {
      setPriceLoading(false)
    }
  }, [])

  useEffect(() => { loadWallet() }, [loadWallet])
  useEffect(() => { loadUsage() }, [loadUsage])
  useEffect(() => { loadPrices() }, [loadPrices])

  const submitPayForm = (html: string) => {
    const win = window.open('', '_blank')
    if (!win) {
      setMessage('浏览器拦截了支付窗口，请允许弹窗后重试')
      return
    }
    win.document.open()
    win.document.write(html)
    win.document.close()
  }

  const handleRecharge = async () => {
    const amt = parseFloat(rechargeAmount)
    if (!amt || amt <= 0) { setMessage('请输入有效金额'); return }
    setSubmitting(true); setMessage('')
    try {
      const pay = await walletApi.recharge(amt, undefined, paymentMethod)
      if (pay?.payForm) submitPayForm(pay.payForm)
      setMessage('充值申请已提交，请按支付页提示完成支付')
      setRechargeAmount('')
      loadWallet()
    } catch (e: any) { setMessage(e?.message || '充值失败') }
    finally { setSubmitting(false) }
  }

  const handleWithdraw = async () => {
    const amt = parseFloat(withdrawAmount)
    if (!amt || amt <= 0) { setMessage('请输入有效金额'); return }
    setSubmitting(true); setMessage('')
    try {
      await walletApi.withdraw(amt)
      setMessage('提现申请已提交，等待管理员审核')
      setWithdrawAmount('')
      loadWallet()
    } catch (e: any) { setMessage(e?.message || '提现失败') }
    finally { setSubmitting(false) }
  }

  const refreshAll = () => {
    loadWallet()
    loadUsage()
    loadPrices()
  }

  const typeLabel = (type: string): string => ({
    deposit: '充值', withdraw: '提现', consume: '消费', earn: '收益', refund: '退款',
  } as Record<string, string>)[type] || type

  const typeColor = (type: string): string => ({
    deposit: 'text-green-600', earn: 'text-green-600', refund: 'text-green-600',
    withdraw: 'text-red-600', consume: 'text-yellow-600',
  } as Record<string, string>)[type] || ''

  const modelOptions = useMemo(() => {
    const set = new Set<string>()
    modelPrices.forEach(m => m.id && set.add(m.id))
    usageLogs.forEach(l => l.model && set.add(l.model))
    return ['all', ...Array.from(set)]
  }, [modelPrices, usageLogs])

  const totalUsagePages = Math.max(1, Math.ceil(usageTotal / usagePageSize))
  const summaryCards = [
    { label: '近 30 天请求', value: tokens(summary?.requestCount), icon: ReceiptText },
    { label: '总 Token', value: tokens(summary?.totalTokens), icon: BarChart3 },
    { label: '缓存 Token', value: tokens(summary?.cachedInputTokens), icon: History },
    { label: '缓存命中率', value: `${Number(summary?.cacheHitRate || 0).toFixed(2)}%`, icon: TableProperties },
    { label: '总费用', value: money(summary?.totalCost, 6), icon: Wallet },
  ]

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card/50">
        <Button variant="ghost" size="sm" onClick={() => onNavigate('chat')}>← 返回</Button>
        <h1 className="text-lg font-semibold flex-1">我的钱包</h1>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={refreshAll}>
          <RefreshCw className="w-4 h-4" />刷新
        </Button>
      </div>

      <div className="mobile-scroll-bottom-safe flex-1 overflow-auto p-4 space-y-4 max-w-6xl mx-auto w-full">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wallet className="w-5 h-5 text-primary" />账户余额
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{money(balance, 4)}</p>
            <p className="text-xs text-muted-foreground mt-2">模型价格与请求费用统一按人民币计价，单位为 ¥/1M tokens。</p>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1.5"><ArrowDownCircle className="w-4 h-4 text-green-500" />充值</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <Input type="number" min="0" step="0.01" placeholder="充值金额" value={rechargeAmount} onChange={e => setRechargeAmount(e.target.value)} />
              <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="alipay">支付宝</option>
                <option value="ldc">LDC / Linux DO Credit</option>
              </select>
              <Button size="sm" className="w-full" onClick={handleRecharge} disabled={submitting}>{submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <><CreditCard className="w-4 h-4 mr-1" />提交充值</>}</Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1.5"><ArrowUpCircle className="w-4 h-4 text-red-500" />提现</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <Input type="number" min="0" step="0.01" placeholder="提现金额" value={withdrawAmount} onChange={e => setWithdrawAmount(e.target.value)} />
              <Button size="sm" className="w-full" variant="outline" onClick={handleWithdraw} disabled={submitting}>{submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : '提交提现申请'}</Button>
            </CardContent>
          </Card>
        </div>

        {message && <p className="text-sm text-center text-muted-foreground">{message}</p>}

        <div className="flex flex-wrap gap-2 border-b">
          {([
            ['transactions', '余额流水'],
            ['usage', '用量明细'],
            ['prices', '模型价目表'],
          ] as Array<[WalletTab, string]>).map(([key, label]) => (
            <button key={key} onClick={() => setActiveTab(key)} className={`px-3 py-2 text-sm border-b-2 transition-colors ${activeTab === key ? 'border-primary text-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              {label}
            </button>
          ))}
        </div>

        {activeTab === 'transactions' && (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1.5"><History className="w-4 h-4" />最近交易</CardTitle></CardHeader>
            <CardContent>
              {loading ? <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin" /></div> : (
                <div className="space-y-2 max-h-[520px] overflow-auto">
                  {transactions.map(tx => (
                    <div key={tx.id} className="flex items-center justify-between text-xs py-2 border-b border-border/50 last:border-0">
                      <div className="flex-1 min-w-0">
                        <p className="truncate font-medium">{tx.description || typeLabel(tx.type)}</p>
                        <p className="text-muted-foreground">{typeLabel(tx.type)} · {formatTime(tx.createdAt)}</p>
                      </div>
                      <span className={`font-mono font-semibold ml-2 ${typeColor(tx.type)}`}>
                        {tx.type === 'consume' ? '-' : tx.type === 'deposit' || tx.type === 'earn' || tx.type === 'refund' ? '+' : ''}
                        {money(Math.abs(tx.amount), 4)}
                      </span>
                    </div>
                  ))}
                  {transactions.length === 0 && <p className="text-xs text-muted-foreground text-center py-3">暂无交易记录</p>}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {activeTab === 'usage' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {summaryCards.map(({ label, value, icon: Icon }) => (
                <Card key={label}><CardContent className="p-4"><div className="flex items-center justify-between mb-1"><p className="text-xs text-muted-foreground">{label}</p><Icon className="w-4 h-4 text-primary" /></div><p className="text-lg font-bold font-mono">{value}</p></CardContent></Card>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 items-center">
              <select value={modelFilter} onChange={e => { setModelFilter(e.target.value); setUsagePage(1) }} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                {modelOptions.map(m => <option key={m} value={m}>{m === 'all' ? '全部模型' : m}</option>)}
              </select>
              <select value={sceneFilter} onChange={e => { setSceneFilter(e.target.value); setUsagePage(1) }} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="all">全部来源</option>
                <option value="chat">对话</option>
                <option value="api">外部 API</option>
                <option value="autocode">AutoCode</option>
                <option value="translate">翻译</option>
                <option value="image">图片</option>
                <option value="asr">语音</option>
                <option value="tts">语音合成</option>
              </select>
              <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setUsagePage(1) }} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                <option value="all">全部状态</option>
                <option value="success">成功</option>
                <option value="error">失败</option>
                <option value="billing_failed">扣费失败</option>
              </select>
              {usageLoading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            </div>

            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[980px]">
                  <thead className="bg-muted/50 border-b">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">模型</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">来源/渠道</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">输入</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">缓存</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">输出</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">命中率</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">费用</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">状态</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">时间</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">详情</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageLogs.map(log => (
                      <tr key={log.id} className="border-b last:border-0 hover:bg-muted/20 cursor-pointer" onClick={() => setDetailLog(log)}>
                        <td className="px-4 py-2.5 font-mono text-xs">{log.model}</td>
                        <td className="px-4 py-2.5 text-xs">
                          <div>{SCENE_LABEL[log.sceneType] || log.sceneType || '对话'}</div>
                          <div className="text-muted-foreground font-mono">{[log.provider, log.channelName || log.channelId].filter(Boolean).join(' / ') || '-'}</div>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs">{tokens(log.inputTokens)}</td>
                        <td className="px-4 py-2.5 font-mono text-xs">{tokens(log.cachedInputTokens)}</td>
                        <td className="px-4 py-2.5 font-mono text-xs">{tokens(log.outputTokens)}</td>
                        <td className="px-4 py-2.5 font-mono text-xs">{Number(log.cacheHitRate || 0).toFixed(2)}%</td>
                        <td className="px-4 py-2.5 font-mono text-xs">{money(log.totalCost, 6)}{log.costEstimated && <span className="ml-1 text-[10px] text-muted-foreground">估</span>}</td>
                        <td className="px-4 py-2.5"><Badge variant={log.status === 'success' ? 'success' : 'destructive'} className="text-xs">{log.status === 'success' ? '成功' : log.status}</Badge></td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">{formatTime(log.createdAt)}</td>
                        <td className="px-4 py-2.5"><Button size="icon" variant="ghost" className="h-6 w-6" onClick={e => { e.stopPropagation(); setDetailLog(log) }}><Eye className="w-3.5 h-3.5" /></Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {usageLogs.length === 0 && <div className="text-center py-10 text-xs text-muted-foreground">暂无用量记录</div>}
            </Card>

            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">共 {usageTotal} 条，第 {usagePage}/{totalUsagePages} 页</p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={usagePage <= 1} onClick={() => setUsagePage(p => Math.max(1, p - 1))}>上一页</Button>
                <Button size="sm" variant="outline" disabled={usagePage >= totalUsagePages} onClick={() => setUsagePage(p => p + 1)}>下一页</Button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'prices' && (
          <Card className="overflow-hidden">
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1.5"><TableProperties className="w-4 h-4" />模型价目表 <span className="text-xs text-muted-foreground font-normal">单位：¥/1M tokens</span></CardTitle></CardHeader>
            <CardContent className="p-0">
              {priceLoading ? <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin" /></div> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[860px]">
                    <thead className="bg-muted/50 border-b">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">模型</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">供应商</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">上下文</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">输入价</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">缓存输入价</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">输出价</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">能力</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modelPrices.map(model => (
                        <tr key={model.id} className="border-b last:border-0 hover:bg-muted/20">
                          <td className="px-4 py-2.5"><div className="font-medium text-sm">{model.name}</div><div className="font-mono text-xs text-muted-foreground">{model.id}</div></td>
                          <td className="px-4 py-2.5 text-xs">{model.provider || '-'}</td>
                          <td className="px-4 py-2.5 text-xs font-mono">{tokens(model.contextLength)}</td>
                          <td className="px-4 py-2.5 text-xs font-mono">{price(model.inputPrice)}</td>
                          <td className="px-4 py-2.5 text-xs font-mono text-emerald-600">{price(model.cachedInputPrice)}</td>
                          <td className="px-4 py-2.5 text-xs font-mono">{price(model.outputPrice)}</td>
                          <td className="px-4 py-2.5"><div className="flex flex-wrap gap-1">{(model.capabilities || []).map(cap => <Badge key={cap} variant="outline" className="text-[10px] px-1.5 py-0">{cap}</Badge>)}</div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {modelPrices.length === 0 && <div className="text-center py-10 text-xs text-muted-foreground">暂无可用模型价格</div>}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={!!detailLog} onOpenChange={() => setDetailLog(null)}>
        <DialogContent className="max-w-[95vw] sm:max-w-lg">
          <DialogHeader><DialogTitle>请求用量详情</DialogTitle></DialogHeader>
          {detailLog && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                {[
                  ['模型', detailLog.model],
                  ['来源', SCENE_LABEL[detailLog.sceneType] || detailLog.sceneType],
                  ['输入 Token', tokens(detailLog.inputTokens)],
                  ['可计费输入', tokens(detailLog.billableInputTokens)],
                  ['缓存 Token', tokens(detailLog.cachedInputTokens)],
                  ['输出 Token', tokens(detailLog.outputTokens)],
                  ['缓存命中率', `${Number(detailLog.cacheHitRate || 0).toFixed(2)}%`],
                  ['总费用', `${money(detailLog.totalCost, 6)}${detailLog.costEstimated ? '（拆分估算）' : ''}`],
                  ['输入费用', money(detailLog.inputCost, 6)],
                  ['缓存输入费用', money(detailLog.cachedInputCost, 6)],
                  ['输出费用', money(detailLog.outputCost, 6)],
                  ['延迟', `${detailLog.latencyMs || 0}ms`],
                  ['输入价', price(detailLog.inputPrice)],
                  ['缓存输入价', price(detailLog.cachedInputPrice)],
                  ['输出价', price(detailLog.outputPrice)],
                  ['渠道', [detailLog.provider, detailLog.channelName || detailLog.channelId].filter(Boolean).join(' / ') || '-'],
                ].map(([label, value]) => (
                  <div key={label} className="bg-muted/50 rounded-lg p-3 min-w-0">
                    <p className="text-xs text-muted-foreground mb-1">{label}</p>
                    <p className="font-mono text-xs font-medium break-all whitespace-pre-wrap">{value}</p>
                  </div>
                ))}
              </div>
              <div className="bg-muted/50 rounded-lg p-3"><p className="text-xs text-muted-foreground mb-1">时间</p><p className="font-mono text-xs">{formatTime(detailLog.createdAt)}</p></div>
              {detailLog.errorMsg && <div className="bg-destructive/10 rounded-lg p-3"><p className="text-xs text-destructive mb-1">失败原因</p><p className="font-mono text-xs whitespace-pre-wrap break-words">{detailLog.errorMsg}</p></div>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
