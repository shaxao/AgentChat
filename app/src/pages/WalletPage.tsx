import { useState, useEffect, useCallback } from 'react'
import { Wallet, ArrowUpCircle, ArrowDownCircle, History, Loader2, CreditCard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { walletApi, WalletTransaction } from '@/lib/api'
import type { AppPage } from '@/App'

interface WalletPageProps { onNavigate: (page: AppPage) => void }

export default function WalletPage({ onNavigate }: WalletPageProps) {
  const [balance, setBalance] = useState<number>(0)
  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [loading, setLoading] = useState(true)

  const [rechargeAmount, setRechargeAmount] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('alipay')
  const [withdrawAmount, setWithdrawAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [bal, txs] = await Promise.all([walletApi.getBalance(), walletApi.getTransactions()])
      setBalance(bal)
      setTransactions(txs)
    } catch (e) {
      console.error('加载钱包数据失败:', e)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { loadData() }, [loadData])

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
      setMessage('充值申请已提交，等待管理员确认')
      setRechargeAmount('')
      loadData()
    } catch (e: any) { setMessage(e?.message || '充值失败') }
    finally { setSubmitting(false) }
  }

  const handleWithdraw = async () => {
    const amt = parseFloat(withdrawAmount)
    if (!amt || amt <= 0) { setMessage('请输入有效金额'); return }
    setSubmitting(true); setMessage('')
    try {
      await walletApi.withdraw(amt)
      setMessage('提现申请已提交，等待管理员审批')
      setWithdrawAmount('')
    } catch (e: any) { setMessage(e?.message || '提现失败') }
    finally { setSubmitting(false) }
  }

  const typeLabel = (type: string): string => ({
    deposit: '充值', withdraw: '提现', consume: '消费', earn: '收益', refund: '退款'
  } as Record<string, string>)[type] || type

  const typeColor = (type: string): string => ({
    deposit: 'text-green-600', earn: 'text-green-600',
    withdraw: 'text-red-600', consume: 'text-yellow-600'
  } as Record<string, string>)[type] || ''

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card/50">
        <Button variant="ghost" size="sm" onClick={() => onNavigate('chat')}>← 返回</Button>
        <h1 className="text-lg font-semibold flex-1">我的钱包</h1>
      </div>

      <div className="mobile-scroll-bottom-safe flex-1 overflow-auto p-4 space-y-4 max-w-2xl mx-auto w-full">
        {/* 余额卡片 */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wallet className="w-5 h-5 text-primary" />账户余额
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">¥ {balance?.toFixed(4) || '0.00'}</p>
          </CardContent>
        </Card>

        {/* 充值 + 提现 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1.5"><ArrowDownCircle className="w-4 h-4 text-green-500" />充值</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <Input type="number" min="0" step="0.01" placeholder="充值金额" value={rechargeAmount} onChange={e => setRechargeAmount(e.target.value)} />
              <select
                value={paymentMethod}
                onChange={e => setPaymentMethod(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="alipay">支付宝</option>
                <option value="ldc">LDC / Linux DO Credit</option>
              </select>
              <Button size="sm" className="w-full" onClick={handleRecharge} disabled={submitting}>{submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : '提交充值申请'}</Button>
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

        {/* 交易流水 */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1.5"><History className="w-4 h-4" />最近交易</CardTitle></CardHeader>
          <CardContent>
            {loading ? <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin" /></div> : (
              <div className="space-y-2 max-h-64 overflow-auto">
                {transactions.map(tx => (
                  <div key={tx.id} className="flex items-center justify-between text-xs py-1.5 border-b border-border/50 last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="truncate">{tx.description}</p>
                      <p className="text-muted-foreground">{new Date(tx.createdAt).toLocaleString()}</p>
                    </div>
                    <span className={`font-mono font-semibold ml-2 ${typeColor(tx.type)}`}>
                      {tx.type === 'consume' ? '-' : tx.type === 'deposit' || tx.type === 'earn' ? '+' : ''}
                      ¥{Math.abs(tx.amount).toFixed(4)}
                    </span>
                  </div>
                ))}
                {transactions.length === 0 && <p className="text-xs text-muted-foreground text-center py-3">暂无交易记录</p>}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
