import { useState, useEffect, useCallback } from 'react'
import {
  Search, Loader2, Download, Eye, RefreshCw, X,
  ShoppingCart, TrendingUp, Wallet, RotateCcw, Filter,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn, formatDate } from '@/lib/utils'
import {
  orderApi,
  type OrderBriefVO, type OrderVO, type OrderQueryParams,
  type PaymentRecordVO, type RefundRecordVO, type PaymentStatsVO,
} from '@/lib/api'

type SubTab = 'list' | 'stats'

// ==================== 主组件 ====================
export default function OrderTab() {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('list')

  const subTabs: { id: SubTab; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
    { id: 'list', icon: ShoppingCart, label: '订单列表' },
    { id: 'stats', icon: TrendingUp, label: '统计概览' },
  ]

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b px-6 py-3 shrink-0">
        <div className="flex items-center gap-1 flex-wrap">
          {subTabs.map(({ id, icon: Icon, label }) => (
            <Button
              key={id}
              variant={activeSubTab === id ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setActiveSubTab(id)}
              className="gap-1.5"
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeSubTab === 'list' && <OrderListSubTab />}
        {activeSubTab === 'stats' && <OrderStatsSubTab />}
      </div>
    </div>
  )
}

// ==================== 订单列表 ====================
function OrderListSubTab() {
  const [orders, setOrders] = useState<OrderBriefVO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [size] = useState(20)

  // 筛选条件
  const [filterOrderNo, setFilterOrderNo] = useState('')
  const [filterTradeNo, setFilterTradeNo] = useState('')
  const [filterUsername, setFilterUsername] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [filterMethod, setFilterMethod] = useState('all')
  const [filterMinAmount, setFilterMinAmount] = useState('')
  const [filterMaxAmount, setFilterMaxAmount] = useState('')
  const [filterStartTime, setFilterStartTime] = useState('')
  const [filterEndTime, setFilterEndTime] = useState('')
  const [showFilters, setShowFilters] = useState(false)

  // 详情弹窗
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailData, setDetailData] = useState<OrderVO | null>(null)
  const [detailPayments, setDetailPayments] = useState<PaymentRecordVO[]>([])
  const [detailRefunds, setDetailRefunds] = useState<RefundRecordVO[]>([])
  const [detailLoading, setDetailLoading] = useState(false)

  // 导出
  const [exporting, setExporting] = useState(false)

  const fetchOrders = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: OrderQueryParams = { page, size }
      if (filterOrderNo) params.orderNo = filterOrderNo
      if (filterTradeNo) params.tradeNo = filterTradeNo
      if (filterUsername) params.username = filterUsername
      if (filterStatus && filterStatus !== 'all') params.status = filterStatus
      if (filterMethod && filterMethod !== 'all') params.paymentMethod = filterMethod
      if (filterMinAmount) params.minAmount = Number(filterMinAmount)
      if (filterMaxAmount) params.maxAmount = Number(filterMaxAmount)
      if (filterStartTime) params.startTime = filterStartTime
      if (filterEndTime) params.endTime = filterEndTime
      const res = await orderApi.list(params)
      setOrders(res.list || [])
      setTotal(res.total || 0)
    } catch (e: any) {
      setError(e.message || '加载订单列表失败')
    } finally {
      setLoading(false)
    }
  }, [page, size, filterOrderNo, filterTradeNo, filterUsername, filterStatus, filterMethod, filterMinAmount, filterMaxAmount, filterStartTime, filterEndTime])

  useEffect(() => { fetchOrders() }, [fetchOrders])

  const handleSearch = () => {
    setPage(1)
    fetchOrders()
  }

  const handleReset = () => {
    setFilterOrderNo('')
    setFilterTradeNo('')
    setFilterUsername('')
    setFilterStatus('all')
    setFilterMethod('all')
    setFilterMinAmount('')
    setFilterMaxAmount('')
    setFilterStartTime('')
    setFilterEndTime('')
    setPage(1)
  }

  const handleViewDetail = async (id: number) => {
    setDetailOpen(true)
    setDetailLoading(true)
    setDetailData(null)
    setDetailPayments([])
    setDetailRefunds([])
    try {
      const [order, payments, refunds] = await Promise.all([
        orderApi.getDetail(id),
        orderApi.getOrderPayments(id),
        orderApi.getOrderRefunds(id),
      ])
      setDetailData(order)
      setDetailPayments(payments || [])
      setDetailRefunds(refunds || [])
    } catch (e: any) {
      setError(e.message || '加载订单详情失败')
    } finally {
      setDetailLoading(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const params: OrderQueryParams = {}
      if (filterOrderNo) params.orderNo = filterOrderNo
      if (filterTradeNo) params.tradeNo = filterTradeNo
      if (filterUsername) params.username = filterUsername
      if (filterStatus && filterStatus !== 'all') params.status = filterStatus
      if (filterMethod && filterMethod !== 'all') params.paymentMethod = filterMethod
      if (filterMinAmount) params.minAmount = Number(filterMinAmount)
      if (filterMaxAmount) params.maxAmount = Number(filterMaxAmount)
      if (filterStartTime) params.startTime = filterStartTime
      if (filterEndTime) params.endTime = filterEndTime
      const blob = await orderApi.export(params)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `orders_export_${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setError(e.message || '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const totalPages = Math.ceil(total / size)

  return (
    <div className="p-6 space-y-4">
      {/* 搜索栏 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="搜索订单号..."
            value={filterOrderNo}
            onChange={(e) => setFilterOrderNo(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="pl-8"
          />
        </div>
        <Button size="sm" onClick={handleSearch} disabled={loading} className="gap-1.5">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          搜索
        </Button>
        <Button size="sm" variant="outline" onClick={() => setShowFilters(!showFilters)} className="gap-1.5">
          <Filter className="w-4 h-4" />
          高级筛选
        </Button>
        <Button size="sm" variant="outline" onClick={handleExport} disabled={exporting} className="gap-1.5">
          {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          导出CSV
        </Button>
        <Button size="sm" variant="ghost" onClick={fetchOrders} className="gap-1.5">
          <RefreshCw className="w-4 h-4" />
          刷新
        </Button>
      </div>

      {/* 高级筛选面板 */}
      {showFilters && (
        <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">高级筛选</span>
            <Button size="sm" variant="ghost" onClick={() => setShowFilters(false)} className="h-7 w-7 p-0">
              <X className="w-4 h-4" />
            </Button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">支付宝交易号</Label>
              <Input
                placeholder="交易号"
                value={filterTradeNo}
                onChange={(e) => setFilterTradeNo(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">用户名</Label>
              <Input
                placeholder="用户名"
                value={filterUsername}
                onChange={(e) => setFilterUsername(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">订单状态</Label>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="全部状态" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="pending">待支付</SelectItem>
                  <SelectItem value="paid">已支付</SelectItem>
                  <SelectItem value="refunded">已退款</SelectItem>
                  <SelectItem value="cancelled">已取消</SelectItem>
                  <SelectItem value="expired">已过期</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">支付方式</Label>
              <Select value={filterMethod} onValueChange={setFilterMethod}>
                <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="全部方式" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部方式</SelectItem>
                  <SelectItem value="alipay">支付宝</SelectItem>
                  <SelectItem value="wechat">微信支付</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">最小金额</Label>
              <Input
                type="number"
                placeholder="0.00"
                value={filterMinAmount}
                onChange={(e) => setFilterMinAmount(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">最大金额</Label>
              <Input
                type="number"
                placeholder="99999.00"
                value={filterMaxAmount}
                onChange={(e) => setFilterMaxAmount(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">开始时间</Label>
              <Input
                type="datetime-local"
                value={filterStartTime}
                onChange={(e) => setFilterStartTime(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">结束时间</Label>
              <Input
                type="datetime-local"
                value={filterEndTime}
                onChange={(e) => setFilterEndTime(e.target.value)}
                className="h-8 text-sm"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleSearch}>应用筛选</Button>
            <Button size="sm" variant="ghost" onClick={handleReset}>重置</Button>
          </div>
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded p-3">
          {error}
        </div>
      )}

      {/* 订单表格 */}
      <div className="border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="border-b">
                <th className="text-left p-3 font-medium">订单号</th>
                <th className="text-left p-3 font-medium">用户</th>
                <th className="text-left p-3 font-medium">套餐</th>
                <th className="text-right p-3 font-medium">金额</th>
                <th className="text-left p-3 font-medium">支付方式</th>
                <th className="text-left p-3 font-medium">交易号</th>
                <th className="text-left p-3 font-medium">状态</th>
                <th className="text-left p-3 font-medium">支付时间</th>
                <th className="text-left p-3 font-medium">创建时间</th>
                <th className="text-center p-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={10} className="text-center py-8 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />加载中...</td></tr>
              ) : orders.length === 0 ? (
                <tr><td colSpan={10} className="text-center py-8 text-muted-foreground">暂无订单数据</td></tr>
              ) : orders.map((order) => (
                <tr key={order.id} className="border-b hover:bg-muted/30 transition-colors">
                  <td className="p-3 font-mono text-xs">{order.orderNo}</td>
                  <td className="p-3">{order.username || '-'}</td>
                  <td className="p-3">{order.planName || '-'}</td>
                  <td className="p-3 text-right font-medium">¥{order.actualAmount?.toFixed(2) || '0.00'}</td>
                  <td className="p-3">
                    <Badge variant="outline" className="text-xs">{methodLabel(order.paymentMethod)}</Badge>
                  </td>
                  <td className="p-3 font-mono text-xs text-muted-foreground">{order.tradeNo || '-'}</td>
                  <td className="p-3"><StatusBadge status={order.status} /></td>
                  <td className="p-3 text-xs text-muted-foreground">{order.paidAt ? formatDate(order.paidAt) : '-'}</td>
                  <td className="p-3 text-xs text-muted-foreground">{formatDate(order.createdAt)}</td>
                  <td className="p-3 text-center">
                    <Button size="sm" variant="ghost" onClick={() => handleViewDetail(order.id)} className="h-7 gap-1">
                      <Eye className="w-3.5 h-3.5" /> 详情
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">共 {total} 条记录，第 {page}/{totalPages} 页</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>下一页</Button>
          </div>
        </div>
      )}

      {/* 详情弹窗 */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>订单详情</DialogTitle>
            <DialogDescription>查看订单完整信息、支付记录和退款记录</DialogDescription>
          </DialogHeader>
          {detailLoading ? (
            <div className="py-8 text-center"><Loader2 className="w-6 h-6 animate-spin inline mr-2" />加载中...</div>
          ) : detailData ? (
            <div className="space-y-4">
              {/* 基本信息 */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <DetailField label="订单号" value={detailData.orderNo} mono />
                <DetailField label="订单状态" value={<StatusBadge status={detailData.status} />} />
                <DetailField label="用户" value={detailData.username || '-'} />
                <DetailField label="昵称" value={detailData.nickname || '-'} />
                <DetailField label="套餐" value={detailData.planName || '-'} />
                <DetailField label="支付方式" value={methodLabel(detailData.paymentMethod)} />
                <DetailField label="订单金额" value={`¥${detailData.amount?.toFixed(2) || '0.00'}`} />
                <DetailField label="折扣金额" value={`¥${detailData.discountAmount?.toFixed(2) || '0.00'}`} />
                <DetailField label="实付金额" value={`¥${detailData.actualAmount?.toFixed(2) || '0.00'}`} highlight />
                <DetailField label="支付宝交易号" value={detailData.tradeNo || '-'} mono />
                <DetailField label="支付时间" value={detailData.paidAt ? formatDate(detailData.paidAt) : '-'} />
                <DetailField label="退款时间" value={detailData.refundedAt ? formatDate(detailData.refundedAt) : '-'} />
                <DetailField label="取消时间" value={detailData.cancelledAt ? formatDate(detailData.cancelledAt) : '-'} />
                <DetailField label="过期时间" value={detailData.expiredAt ? formatDate(detailData.expiredAt) : '-'} />
                <DetailField label="客户端IP" value={detailData.clientIp || '-'} mono />
                <DetailField label="创建时间" value={formatDate(detailData.createdAt)} />
              </div>

              {detailData.remark && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">备注</Label>
                  <div className="text-sm bg-muted/30 rounded p-2">{detailData.remark}</div>
                </div>
              )}

              {/* 支付记录 */}
              <div className="space-y-2">
                <h4 className="text-sm font-medium flex items-center gap-1.5">
                  <Wallet className="w-4 h-4" /> 支付记录 ({detailPayments.length})
                </h4>
                {detailPayments.length === 0 ? (
                  <p className="text-sm text-muted-foreground pl-6">暂无支付记录</p>
                ) : (
                  <div className="border rounded overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50"><tr className="border-b">
                        <th className="text-left p-2">交易号</th>
                        <th className="text-right p-2">金额</th>
                        <th className="text-left p-2">支付状态</th>
                        <th className="text-left p-2">验签</th>
                        <th className="text-left p-2">回调时间</th>
                      </tr></thead>
                      <tbody>
                        {detailPayments.map((p) => (
                          <tr key={p.id} className="border-b">
                            <td className="p-2 font-mono">{p.tradeNo || '-'}</td>
                            <td className="p-2 text-right">¥{p.amount?.toFixed(2) || '0.00'}</td>
                            <td className="p-2"><Badge variant="outline" className="text-xs">{p.paymentStatus}</Badge></td>
                            <td className="p-2">
                              {p.verifyStatus === 'success' ?
                                <Badge className="text-xs bg-green-100 text-green-700">通过</Badge> :
                                <Badge className="text-xs bg-red-100 text-red-700">失败</Badge>}
                            </td>
                            <td className="p-2 text-muted-foreground">{p.callbackAt ? formatDate(p.callbackAt) : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* 退款记录 */}
              <div className="space-y-2">
                <h4 className="text-sm font-medium flex items-center gap-1.5">
                  <RotateCcw className="w-4 h-4" /> 退款记录 ({detailRefunds.length})
                </h4>
                {detailRefunds.length === 0 ? (
                  <p className="text-sm text-muted-foreground pl-6">暂无退款记录</p>
                ) : (
                  <div className="border rounded overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50"><tr className="border-b">
                        <th className="text-left p-2">退款单号</th>
                        <th className="text-right p-2">退款金额</th>
                        <th className="text-left p-2">状态</th>
                        <th className="text-left p-2">原因</th>
                        <th className="text-left p-2">操作人</th>
                        <th className="text-left p-2">时间</th>
                      </tr></thead>
                      <tbody>
                        {detailRefunds.map((r) => (
                          <tr key={r.id} className="border-b">
                            <td className="p-2 font-mono">{r.refundNo}</td>
                            <td className="p-2 text-right">¥{r.refundAmount?.toFixed(2) || '0.00'}</td>
                            <td className="p-2"><Badge variant="outline" className="text-xs">{r.refundStatus}</Badge></td>
                            <td className="p-2 max-w-[200px] truncate" title={r.reason}>{r.reason}</td>
                            <td className="p-2">{r.operatorName || '-'}</td>
                            <td className="p-2 text-muted-foreground">{formatDate(r.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="py-8 text-center text-muted-foreground">加载失败</div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ==================== 统计概览 ====================
function OrderStatsSubTab() {
  const [stats, setStats] = useState<PaymentStatsVO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchStats = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await orderApi.getStats()
      setStats(res)
    } catch (e: any) {
      setError(e.message || '加载统计数据失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchStats() }, [fetchStats])

  if (loading) {
    return <div className="p-6 text-center"><Loader2 className="w-6 h-6 animate-spin inline mr-2" />加载中...</div>
  }
  if (error) {
    return <div className="p-6"><div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded p-3">{error}</div></div>
  }
  if (!stats) return null

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">订单统计概览</h3>
        <Button size="sm" variant="ghost" onClick={fetchStats} className="gap-1.5">
          <RefreshCw className="w-4 h-4" /> 刷新
        </Button>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={ShoppingCart} label="今日订单数" value={String(stats.todayOrderCount)} color="text-blue-600 bg-blue-50 dark:bg-blue-950/20" />
        <StatCard icon={Wallet} label="今日支付金额" value={`¥${stats.todayPayAmount?.toFixed(2) || '0.00'}`} color="text-green-600 bg-green-50 dark:bg-green-950/20" />
        <StatCard icon={TrendingUp} label="累计订单数" value={String(stats.totalOrderCount)} color="text-purple-600 bg-purple-50 dark:bg-purple-950/20" />
        <StatCard icon={Wallet} label="累计支付金额" value={`¥${stats.totalPayAmount?.toFixed(2) || '0.00'}`} color="text-orange-600 bg-orange-50 dark:bg-orange-950/20" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <StatCard icon={RotateCcw} label="待处理退款数" value={String(stats.pendingRefundCount)} color="text-red-600 bg-red-50 dark:bg-red-950/20" />
        <StatCard icon={RotateCcw} label="累计退款金额" value={`¥${stats.totalRefundAmount?.toFixed(2) || '0.00'}`} color="text-gray-600 bg-gray-50 dark:bg-gray-950/20" />
      </div>

      {/* 支付方式分布 */}
      {stats.methodStats && stats.methodStats.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium">支付方式分布</h4>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="border-b">
                  <th className="text-left p-3 font-medium">支付方式</th>
                  <th className="text-right p-3 font-medium">订单数</th>
                  <th className="text-right p-3 font-medium">总金额</th>
                </tr>
              </thead>
              <tbody>
                {stats.methodStats.map((m, i) => (
                  <tr key={i} className="border-b hover:bg-muted/30">
                    <td className="p-3"><Badge variant="outline">{methodLabel(m.paymentMethod)}</Badge></td>
                    <td className="p-3 text-right">{m.orderCount}</td>
                    <td className="p-3 text-right font-medium">¥{m.totalAmount?.toFixed(2) || '0.00'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ==================== 辅助组件 ====================
function DetailField({ label, value, mono, highlight }: { label: string; value: React.ReactNode; mono?: boolean; highlight?: boolean }) {
  return (
    <div className="space-y-0.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className={cn('text-sm', mono && 'font-mono', highlight && 'font-bold text-green-600')}>
        {value}
      </div>
    </div>
  )
}

function StatCard({ icon: Icon, label, value, color }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; color: string }) {
  return (
    <div className="border rounded-lg p-4 space-y-2">
      <div className="flex items-center gap-2">
        <div className={cn('p-2 rounded-lg', color)}>
          <Icon className="w-4 h-4" />
        </div>
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    pending: { label: '待支付', className: 'bg-yellow-100 text-yellow-700' },
    paid: { label: '已支付', className: 'bg-green-100 text-green-700' },
    refunded: { label: '已退款', className: 'bg-blue-100 text-blue-700' },
    cancelled: { label: '已取消', className: 'bg-gray-100 text-gray-700' },
    expired: { label: '已过期', className: 'bg-red-100 text-red-700' },
  }
  const cfg = map[status] || { label: status, className: 'bg-gray-100 text-gray-700' }
  return <Badge className={cn('text-xs', cfg.className)}>{cfg.label}</Badge>
}

function methodLabel(method: string): string {
  const map: Record<string, string> = {
    alipay: '支付宝',
    wechat: '微信支付',
  }
  return map[method] || method || '-'
}
