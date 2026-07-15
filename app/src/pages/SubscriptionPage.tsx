import { useState, useEffect } from 'react'
import { useAuthStore } from '@/store'
import { planApi, authApi, paymentApi, SubscriptionPlanVO } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { Check, Zap, ArrowLeft, Crown, Star, Building2, Loader2, CreditCard, AlertCircle, RefreshCw } from 'lucide-react'

interface SubscriptionPageProps {
  onBack: () => void
}

const PLAN_ICONS: Record<string, React.ReactNode> = {
  free: <Zap className="w-6 h-6" />,
  pro: <Star className="w-6 h-6" />,
  enterprise: <Building2 className="w-6 h-6" />,
  custom: <Crown className="w-6 h-6" />,
}

const PLAN_COLORS: Record<string, { bg: string; border: string; badge: string; btn: string }> = {
  free: { bg: 'bg-muted/30', border: 'border-border', badge: 'bg-muted text-muted-foreground', btn: 'variant-outline' },
  pro: { bg: 'bg-primary/5', border: 'border-primary', badge: 'bg-primary text-primary-foreground', btn: 'variant-default' },
  enterprise: { bg: 'bg-purple-50 dark:bg-purple-950/20', border: 'border-purple-400', badge: 'bg-purple-600 text-white', btn: 'variant-default' },
  custom: { bg: 'bg-orange-50 dark:bg-orange-950/20', border: 'border-orange-400', badge: 'bg-orange-500 text-white', btn: 'variant-default' },
}

export default function SubscriptionPage({ onBack }: SubscriptionPageProps) {
  const { user, updateUser } = useAuthStore()
  const [plans, setPlans] = useState<SubscriptionPlanVO[]>([])
  const [loading, setLoading] = useState(true)
  const [subscribing, setSubscribing] = useState<string | null>(null)
  const [confirmPlan, setConfirmPlan] = useState<SubscriptionPlanVO | null>(null)
  const [paymentMethod, setPaymentMethod] = useState('alipay')
  const [payResult, setPayResult] = useState<'success' | 'error' | null>(null)
  const [error, setError] = useState('')
  const [retryKey, setRetryKey] = useState(0) // 用于强制重新加载

  // 加载套餐数据（依赖 retryKey 实现重试）
  useEffect(() => {
    setLoading(true)
    planApi.listPublic()
      .then(list => {
        // 解析 features JSON 字符串
        setPlans(list.map(p => ({
          ...p,
          features: typeof p.features === 'string'
            ? (() => { try { return JSON.parse(p.features as any) } catch { return [] } })()
            : (p.features || []),
        })))
        setError('') // 清除错误
      })
      .catch((err: Error) => {
        console.error('加载套餐失败:', err)
        setError(err.message || '加载套餐失败，请检查网络或后端服务是否正常运行')
        // 不再降级到写死的 DEMO_PLANS，显示错误让用户重试
        setPlans([])
      })
      .finally(() => setLoading(false))
  }, [retryKey])

  const submitPayForm = (html: string) => {
    const win = window.open('', '_blank')
    if (!win) {
      setError('浏览器拦截了支付窗口，请允许弹窗后重试')
      return
    }
    win.document.open()
    win.document.write(html)
    win.document.close()
  }

  const handleSubscribe = async () => {
    if (!confirmPlan) return
    setSubscribing(confirmPlan.uuid)
    setError('')
    try {
      if (Number(confirmPlan.price || 0) > 0) {
        if (!confirmPlan.id) {
          throw new Error('套餐缺少支付订单 ID，请刷新套餐列表后重试')
        }
        const pay = await paymentApi.createOrder({ planId: confirmPlan.id, paymentMethod })
        if (pay?.payForm) {
          submitPayForm(pay.payForm)
        }
        setError('支付订单已创建，请在新打开的支付页面完成付款。付款成功后套餐会自动开通。')
        return
      }
      await planApi.subscribe(confirmPlan.uuid)
      // 刷新用户信息
      const me = await authApi.getMe()
      updateUser({ plan: me.plan, tokensLimit: me.tokensLimit, tokensUsed: me.tokensUsed, costLimit: me.costLimit, costUsed: me.costUsed })
      setPayResult('success')
    } catch (e: any) {
      setError(e.message || '订阅失败，请稍后重试')
      setPayResult('error')
    } finally {
      setSubscribing(null)
    }
  }

  const costUsed = Number(user?.costUsed ?? 0)
  const costLimit = Number(user?.costLimit ?? 0)
  const costPercent = costLimit > 0 ? Math.min(Math.round((costUsed / costLimit) * 100), 100) : 0
  const currentPlan = plans.find(p => p.code === user?.plan)

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    )
  }

  // API 加载失败时显示错误和重试按钮
  if (error && plans.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md px-6">
          <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-8 h-8 text-destructive" />
          </div>
          <h3 className="text-lg font-semibold mb-2">无法加载套餐</h3>
          <p className="text-sm text-muted-foreground mb-4">{error}</p>
          <Button onClick={() => setRetryKey(k => k + 1)} className="gap-2">
            <RefreshCw className="w-4 h-4" />
            重新加载
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mobile-scroll-bottom-safe flex-1 overflow-y-auto bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-6 py-4 flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
          <ArrowLeft className="w-4 h-4" />返回
        </Button>
        <div>
          <h1 className="text-lg font-semibold">订阅套餐</h1>
          <p className="text-xs text-muted-foreground">选择适合您的套餐，解锁更多功能</p>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* 当前用量 */}
        {user && (
          <div className="mb-8 p-5 rounded-2xl border bg-card">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-medium">当前套餐</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {currentPlan?.name || user.plan} · 每月重置用量
                </p>
              </div>
              <Badge className="capitalize">{currentPlan?.name || user.plan}</Badge>
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">消费额度</span>
                <span className="font-medium">¥{costUsed.toFixed(4)} / {costLimit > 0 ? `¥${costLimit.toFixed(2)}` : '不限'}</span>
              </div>
              <Progress value={costPercent} className={cn(costPercent > 80 && 'text-orange-500')} />
              <p className="text-xs text-muted-foreground text-right">{costLimit > 0 ? `${costPercent}% 已使用` : '按模型输入/输出价格计费'}</p>
            </div>
          </div>
        )}

        {/* 套餐卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {plans.map(plan => {
            const colors = PLAN_COLORS[plan.code] || PLAN_COLORS.custom
            const isCurrent = user?.plan === plan.code
            const features = Array.isArray(plan.features) ? plan.features : []

            return (
              <div key={plan.uuid} className={cn(
                'relative rounded-2xl border-2 p-6 flex flex-col transition-all hover:shadow-lg',
                colors.bg, colors.border,
                plan.isPopular && 'scale-[1.02]'
              )}>
                {plan.isPopular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="bg-primary text-primary-foreground text-xs font-semibold px-3 py-1 rounded-full shadow">
                      🔥 最受欢迎
                    </span>
                  </div>
                )}

                {/* 套餐头部 */}
                <div className="flex items-center gap-3 mb-4">
                  <div className={cn('w-12 h-12 rounded-xl flex items-center justify-center', colors.badge)}>
                    {PLAN_ICONS[plan.code] || <Crown className="w-6 h-6" />}
                  </div>
                  <div>
                    <h3 className="font-bold text-lg">{plan.name}</h3>
                    <p className="text-xs text-muted-foreground">{plan.description}</p>
                  </div>
                </div>

                {/* 价格 */}
                <div className="mb-5">
                  {plan.price === 0 ? (
                    <div className="flex items-baseline gap-1">
                      <span className="text-4xl font-black">免费</span>
                    </div>
                  ) : (
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-bold text-muted-foreground">¥</span>
                      <span className="text-4xl font-black">{plan.price}</span>
                      <span className="text-muted-foreground text-sm">/月</span>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">
                    每月消费额度 {plan.costLimit && plan.costLimit > 0 ? `¥${Number(plan.costLimit).toFixed(2)}` : '不限'}
                    {plan.modelLimit ? ` · 限定模型` : ' · 全部模型'}
                  </p>
                </div>

                {/* 功能列表 */}
                <ul className="space-y-2.5 flex-1 mb-6">
                  {features.map((f, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <Check className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
                      <span>{f}</span>
                    </li>
                  ))}
                  {plan.modelLimit && (
                    <li className="flex items-start gap-2 text-sm text-muted-foreground">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>限定模型: {plan.modelLimit}</span>
                    </li>
                  )}
                </ul>

                {/* 订阅按钮 */}
                {isCurrent ? (
                  <Button disabled className="w-full" variant="outline">
                    <Check className="w-4 h-4 mr-2" />当前套餐
                  </Button>
                ) : plan.price === 0 ? (
                  <Button variant="outline" className="w-full" onClick={() => setConfirmPlan(plan)}>
                    切换到免费版
                  </Button>
                ) : (
                  <Button className="w-full gap-2" onClick={() => setConfirmPlan(plan)}>
                    <CreditCard className="w-4 h-4" />
                    立即订阅
                  </Button>
                )}
              </div>
            )
          })}
        </div>

        <p className="text-center text-xs text-muted-foreground mt-8">
          订阅后立即生效 · 随时可取消 · 支持支付宝/微信支付
        </p>
      </div>

      {/* 支付确认弹窗 */}
      <Dialog open={!!confirmPlan && !payResult} onOpenChange={open => { if (!open) { setConfirmPlan(null); setError('') } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CreditCard className="w-5 h-5 text-primary" />
              确认订阅
            </DialogTitle>
          </DialogHeader>
          {confirmPlan && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-muted/40 border">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold">{confirmPlan.name}</span>
                  <span className="text-xl font-bold">{confirmPlan.price === 0 ? '免费' : `¥${confirmPlan.price}/月`}</span>
                </div>
                <p className="text-xs text-muted-foreground">{confirmPlan.description}</p>
                <div className="mt-2 pt-2 border-t text-xs text-muted-foreground">
                  每月消费额度 {confirmPlan.costLimit && confirmPlan.costLimit > 0 ? `¥${Number(confirmPlan.costLimit).toFixed(2)}` : '不限'} ·
                  {confirmPlan.modelLimit ? ` 限定模型` : ' 全部模型'}
                </div>
              </div>
              {Number(confirmPlan.price || 0) > 0 && (
                <div className="space-y-2">
                  <label className="text-xs font-medium">支付方式</label>
                  <select
                    value={paymentMethod}
                    onChange={e => setPaymentMethod(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="alipay">支付宝</option>
                    <option value="ldc">LDC / Linux DO Credit</option>
                  </select>
                </div>
              )}
              {error && <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{error}</p>}
              <p className="text-xs text-muted-foreground text-center">
                点击确认后将模拟支付成功并立即激活订阅
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setConfirmPlan(null); setError('') }}>取消</Button>
            <Button onClick={handleSubscribe} disabled={!!subscribing} className="gap-2">
              {subscribing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
              确认支付
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 支付结果弹窗 */}
      <Dialog open={payResult !== null} onOpenChange={() => { setPayResult(null); setConfirmPlan(null) }}>
        <DialogContent className="max-w-sm text-center">
          <DialogHeader>
            <DialogTitle className="sr-only">{payResult === 'success' ? '订阅成功' : '订阅失败'}</DialogTitle>
          </DialogHeader>
          {payResult === 'success' ? (
            <div className="py-4 space-y-3">
              <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
                <Check className="w-8 h-8 text-green-500" />
              </div>
              <h3 className="text-lg font-semibold">订阅成功！</h3>
              <p className="text-sm text-muted-foreground">
                已成功订阅 <strong>{confirmPlan?.name}</strong>，新的消费额度已生效。
              </p>
              <Button className="w-full" onClick={() => { setPayResult(null); setConfirmPlan(null); onBack() }}>
                返回使用
              </Button>
            </div>
          ) : (
            <div className="py-4 space-y-3">
              <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
                <AlertCircle className="w-8 h-8 text-destructive" />
              </div>
              <h3 className="text-lg font-semibold">订阅失败</h3>
              <p className="text-sm text-muted-foreground">{error || '请稍后重试'}</p>
              <Button variant="outline" className="w-full" onClick={() => setPayResult(null)}>重试</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Demo 模式降级数据（与管理后台保持一致）
const DEMO_PLANS: SubscriptionPlanVO[] = [
  { uuid: 'plan-free', name: '免费版', code: 'free', description: '适合个人轻度使用', price: 0, costLimit: 1, tokensLimit: 50000, modelLimit: '', features: ['每月 ¥1 消费额度', '基础模型访问', '标准响应速度', '社区支持'], sortOrder: 1, isPopular: false, enabled: true, roleId: null, roleName: '' },
  { uuid: 'plan-pro', name: 'Pro 版', code: 'pro', description: '适合专业用户和小团队', price: 99, costLimit: 99, tokensLimit: 500000, modelLimit: '', features: ['每月 ¥99 消费额度', '全部模型访问', '优先响应速度', '邮件支持', 'API 访问', '对话历史无限制'], sortOrder: 2, isPopular: true, enabled: true, roleId: null, roleName: '' },
  { uuid: 'plan-ent', name: '企业版', code: 'enterprise', description: '适合企业和大型团队', price: 299, costLimit: 299, tokensLimit: 5000000, modelLimit: '', features: ['每月 ¥299 消费额度', '全部模型访问', '最高响应速度', '专属客服', 'SLA 保障', '自定义模型', '团队管理', '数据导出'], sortOrder: 3, isPopular: false, enabled: true, roleId: null, roleName: '' },
]

export { DEMO_PLANS }
