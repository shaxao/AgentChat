import { useState, useRef, useEffect } from 'react'
import { useAuthStore } from '@/store'
import { authApi, rbacApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  ArrowLeft,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Mail,
  Network,
  RefreshCw,
  Shield,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type Tab = 'login' | 'register' | 'forgot'

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE !== 'false'

// 演示账号（后端未启动时使用）
const DEMO_ACCOUNTS = [
  { email: 'admin@demo.com', password: 'admin123', name: '管理员', role: 'admin' as const },
  { email: 'user@demo.com', password: 'user123', name: '张三', role: 'user' as const },
]

function NeuralNetworkBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let animationFrame = 0
    let width = 0
    let height = 0
    let nodes: Array<{ x: number; y: number; vx: number; vy: number; r: number; phase: number }> = []

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const count = Math.min(88, Math.max(42, Math.floor((width * height) / 18000)))
      nodes = Array.from({ length: count }, (_, index) => ({
        x: (Math.sin(index * 91.7) * 0.5 + 0.5) * width,
        y: (Math.cos(index * 53.3) * 0.5 + 0.5) * height,
        vx: Math.sin(index * 17.1) * 0.28 || 0.12,
        vy: Math.cos(index * 29.9) * 0.28 || -0.12,
        r: 1.2 + ((index * 7) % 8) / 8,
        phase: index * 0.37,
      }))
    }

    const draw = (time = 0) => {
      ctx.clearRect(0, 0, width, height)

      const glow = ctx.createRadialGradient(width * 0.5, height * 0.18, 0, width * 0.5, height * 0.18, Math.max(width, height))
      glow.addColorStop(0, 'rgba(34, 211, 238, 0.16)')
      glow.addColorStop(0.38, 'rgba(16, 185, 129, 0.09)')
      glow.addColorStop(1, 'rgba(2, 6, 23, 0)')
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, width, height)

      const maxDistance = Math.min(170, Math.max(105, width / 8))
      for (let i = 0; i < nodes.length; i += 1) {
        const a = nodes[i]
        if (!reduceMotion) {
          a.x += a.vx
          a.y += a.vy
          if (a.x < -20) a.x = width + 20
          if (a.x > width + 20) a.x = -20
          if (a.y < -20) a.y = height + 20
          if (a.y > height + 20) a.y = -20
        }

        for (let j = i + 1; j < nodes.length; j += 1) {
          const b = nodes[j]
          const distance = Math.hypot(a.x - b.x, a.y - b.y)
          if (distance < maxDistance) {
            const alpha = (1 - distance / maxDistance) * 0.32
            ctx.strokeStyle = `rgba(125, 211, 252, ${alpha})`
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }

      for (const node of nodes) {
        const pulse = reduceMotion ? 0.6 : 0.45 + Math.sin(time * 0.0018 + node.phase) * 0.25
        ctx.fillStyle = `rgba(240, 253, 250, ${0.42 + pulse * 0.38})`
        ctx.beginPath()
        ctx.arc(node.x, node.y, node.r + pulse, 0, Math.PI * 2)
        ctx.fill()
      }

      animationFrame = window.requestAnimationFrame(draw)
    }

    resize()
    draw()
    window.addEventListener('resize', resize)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full opacity-90" aria-hidden="true" />
}

export default function LoginPage() {
  const { login, setPermissions } = useAuthStore()
  const [tab, setTab] = useState<Tab>('login')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [oauthLoading, setOauthLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // 登录表单
  const [loginForm, setLoginForm] = useState({ email: '', password: '', verifyCode: '' })
  const [loginNeedsCode, setLoginNeedsCode] = useState(false)

  // 注册表单
  const [registerForm, setRegisterForm] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    verifyCode: '',
  })

  // 忘记密码表单
  const [forgotForm, setForgotForm] = useState({
    email: '',
    verifyCode: '',
    newPassword: '',
    confirmPassword: '',
  })

  // 验证码倒计时
  const [codeCooldown, setCodeCooldown] = useState(0)
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startCooldown = () => {
    setCodeCooldown(60)
    cooldownRef.current = setInterval(() => {
      setCodeCooldown((v) => {
        if (v <= 1) {
          clearInterval(cooldownRef.current!)
          return 0
        }
        return v - 1
      })
    }, 1000)
  }

  useEffect(() => () => { if (cooldownRef.current) clearInterval(cooldownRef.current) }, [])

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('oauth_token')
    if (!token) return
    setOauthLoading(true)
    setError('')
    authApi.getMeWithToken(token)
      .then(async (u) => {
        login({
          id: u.id,
          name: u.name,
          email: u.email,
          avatar: u.avatar,
          role: u.role,
          plan: u.plan,
          tokensUsed: u.tokensUsed,
          tokensLimit: u.tokensLimit,
          createdAt: u.createdAt,
          status: u.status,
          modelLimit: (u as any).modelLimit,
        }, token)
        try {
          setPermissions(await rbacApi.getMyPermissions())
        } catch {
          console.warn('Failed to fetch user permissions')
        }
        window.history.replaceState({}, '', window.location.pathname)
      })
      .catch((e: any) => setError(e?.message || 'Linux.do 登录失败'))
      .finally(() => setOauthLoading(false))
  }, [login, setPermissions])

  const clearMessages = () => { setError(''); setSuccess('') }

  /** 发送验证码 */
  const handleSendCode = async (email: string, scene: 'register' | 'reset' | 'login') => {
    if (!email) { setError('请先填写邮箱'); return }
    clearMessages()
    setLoading(true)
    try {
      if (DEMO_MODE) {
        // 演示模式 mock
        await new Promise((r) => setTimeout(r, 600))
        setSuccess(`验证码已发送至 ${email}（演示模式：验证码为 123456）`)
        startCooldown()
      } else {
        const msg = await authApi.sendCode(email, scene)
        setSuccess(msg || `验证码已发送至 ${email}，请注意查收`)
        startCooldown()
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '发送失败，请稍后重试')
    }
    setLoading(false)
  }

  /** 登录 */
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    clearMessages()
    setLoading(true)
    try {
      if (DEMO_MODE) {
        await new Promise((r) => setTimeout(r, 600))
        const account = DEMO_ACCOUNTS.find(
          (a) => a.email === loginForm.email && a.password === loginForm.password
        )
        if (account) {
          login({
            id: `demo_${account.role}`,
            name: account.name,
            email: account.email,
            role: account.role,
            plan: account.role === 'admin' ? 'enterprise' : 'pro',
            tokensUsed: 12500,
            tokensLimit: 500000,
            createdAt: new Date().toISOString(),
            status: 'active',
          }, 'demo-token')
        } else {
          setError('邮箱或密码错误，请使用演示账号')
        }
      } else {
        const resp = await authApi.login(loginForm.email, loginForm.password, loginForm.verifyCode)
        const u = resp.user
        login({
          id: u.id,
          name: u.name,
          email: u.email,
          avatar: u.avatar,
          role: u.role,
          plan: u.plan,
          tokensUsed: u.tokensUsed,
          tokensLimit: u.tokensLimit,
          createdAt: u.createdAt,
          status: u.status,
          modelLimit: (u as any).modelLimit,
        }, resp.token)

        // 登录后获取 RBAC 权限码
        try {
          const permissions = await rbacApi.getMyPermissions()
          setPermissions(permissions)
        } catch {
          // 权限获取失败不阻塞登录流程
          console.warn('Failed to fetch user permissions')
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : '登录失败'
      if (message.includes('验证码') || message.includes('两步验证')) {
        setLoginNeedsCode(true)
      }
      setError(message)
    }
    setLoading(false)
  }

  /** 注册 */
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    clearMessages()
    if (registerForm.password !== registerForm.confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }
    if (registerForm.password.length < 8) {
      setError('密码至少 8 位')
      return
    }
    setLoading(true)
    try {
      if (DEMO_MODE) {
        await new Promise((r) => setTimeout(r, 600))
        if (registerForm.verifyCode !== '123456') {
          setError('验证码错误（演示模式：请输入 123456）')
          setLoading(false)
          return
        }
        login({
          id: `user_${Date.now()}`,
          name: registerForm.username,
          email: registerForm.email,
          role: 'user',
          plan: 'free',
          tokensUsed: 0,
          tokensLimit: 50000,
          createdAt: new Date().toISOString(),
          status: 'active',
        }, 'demo-token')
      } else {
        const resp = await authApi.register({
          username: registerForm.username,
          email: registerForm.email,
          password: registerForm.password,
          verifyCode: registerForm.verifyCode,
        })
        const u = resp.user
        login({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          plan: u.plan,
          tokensUsed: u.tokensUsed,
          tokensLimit: u.tokensLimit,
          createdAt: u.createdAt,
          status: u.status,
          modelLimit: (u as any).modelLimit,
        }, resp.token)
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '注册失败')
    }
    setLoading(false)
  }

  /** 重置密码 */
  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    clearMessages()
    if (forgotForm.newPassword !== forgotForm.confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }
    setLoading(true)
    try {
      if (DEMO_MODE) {
        await new Promise((r) => setTimeout(r, 600))
        if (forgotForm.verifyCode !== '123456') {
          setError('验证码错误（演示模式：请输入 123456）')
          setLoading(false)
          return
        }
        setSuccess('密码重置成功（演示模式），请使用新密码登录')
        setTimeout(() => { setTab('login'); clearMessages() }, 2000)
      } else {
        await authApi.resetPassword({
          email: forgotForm.email,
          verifyCode: forgotForm.verifyCode,
          newPassword: forgotForm.newPassword,
        })
        setSuccess('密码重置成功，请使用新密码登录')
        setTimeout(() => { setTab('login'); clearMessages() }, 2000)
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '重置失败')
    }
    setLoading(false)
  }

  const quickLogin = (role: 'admin' | 'user') => {
    const account = DEMO_ACCOUNTS.find((a) => a.role === role)!
    setLoginForm({ email: account.email, password: account.password, verifyCode: '' })
    setLoginNeedsCode(false)
    clearMessages()
  }

  return (
    <div className="relative h-dvh min-h-screen overflow-hidden bg-slate-950 text-slate-950">
      <div className="absolute inset-0 pointer-events-none">
        <NeuralNetworkBackground />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.05)_1px,transparent_1px)] bg-[size:42px_42px]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_10%,rgba(14,165,233,0.18),transparent_34%),linear-gradient(180deg,rgba(2,6,23,0.1),rgba(2,6,23,0.86))]" />
      </div>

      <div className="relative z-10 h-full overflow-y-auto overflow-x-hidden px-4 py-6 sm:py-8">
        <div className="mx-auto w-full max-w-md pb-8">
        {/* Logo */}
        <div className="text-center mb-6 sm:mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-white shadow-[0_18px_60px_rgba(14,165,233,0.35)] mb-3 sm:mb-4 overflow-hidden border border-cyan-100/70">
            <img src="/logo.png" alt="木火智能对话" className="w-full h-full object-cover" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold bg-gradient-to-r from-white via-cyan-100 to-emerald-200 bg-clip-text text-transparent drop-shadow">
            木火智能对话
          </h1>
          <p className="text-cyan-50/72 mt-1 text-sm sm:text-base">智能对话，无限可能</p>
        </div>

        <Card className="shadow-[0_28px_90px_rgba(2,6,23,0.58)] border border-white/16 bg-white/92 dark:bg-slate-950/82 backdrop-blur-xl ring-1 ring-cyan-200/12">
          {/* 忘记密码页面 */}
          {tab === 'forgot' ? (
            <form onSubmit={handleResetPassword}>
              <div className="flex items-center gap-2 px-5 sm:px-6 pt-4 sm:pt-5 pb-3 sm:pb-4 border-b">
                <button type="button" onClick={() => { setTab('login'); clearMessages() }}
                  className="p-1 rounded-md hover:bg-muted transition-colors">
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <span className="font-semibold">重置密码</span>
              </div>
              <CardContent className="space-y-4 pt-4 sm:pt-5 px-4 sm:px-6">
                <div className="space-y-2">
                  <Label>注册邮箱</Label>
                  <div className="flex gap-2">
                    <Input
                      type="email"
                      placeholder="name@example.com"
                      value={forgotForm.email}
                      onChange={(e) => setForgotForm({ ...forgotForm, email: e.target.value })}
                      required
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={codeCooldown > 0 || loading}
                      onClick={() => handleSendCode(forgotForm.email, 'reset')}
                      className="shrink-0 min-w-[80px] sm:min-w-[90px] text-xs sm:text-sm"
                    >
                      {codeCooldown > 0 ? `${codeCooldown}s` : '获取验证码'}
                    </Button>
                  </div>
                </div>
                <VerifyCodeInput
                  value={forgotForm.verifyCode}
                  onChange={(v) => setForgotForm({ ...forgotForm, verifyCode: v })}
                />
                <div className="space-y-2">
                  <Label>新密码</Label>
                  <Input
                    type="password" placeholder="至少 8 位"
                    value={forgotForm.newPassword}
                    onChange={(e) => setForgotForm({ ...forgotForm, newPassword: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>确认新密码</Label>
                  <Input
                    type="password" placeholder="再次输入新密码"
                    value={forgotForm.confirmPassword}
                    onChange={(e) => setForgotForm({ ...forgotForm, confirmPassword: e.target.value })}
                    required
                  />
                </div>
                <AlertMsg error={error} success={success} />
              </CardContent>
              <CardFooter className="px-4 sm:px-6">
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />重置中...</> : '确认重置'}
                </Button>
              </CardFooter>
            </form>
          ) : (
            <Tabs value={tab} onValueChange={(v) => { setTab(v as Tab); clearMessages() }}>
              <TabsList className="w-full rounded-none border-b bg-transparent h-12">
                <TabsTrigger value="login" className="flex-1 rounded-none data-[state=active]:border-b-2 data-[state=active]:border-primary">
                  登录
                </TabsTrigger>
                <TabsTrigger value="register" className="flex-1 rounded-none data-[state=active]:border-b-2 data-[state=active]:border-primary">
                  注册
                </TabsTrigger>
              </TabsList>

              {/* 登录 Tab */}
              <TabsContent value="login">
                <form onSubmit={handleLogin}>
                  <CardContent className="space-y-4 pt-5 px-4 sm:px-6">
                    {DEMO_MODE && (
                      <div className="flex gap-2 p-3 bg-primary/5 rounded-lg border border-primary/20">
                        <Sparkles className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                        <div className="flex-1">
                          <p className="text-xs font-medium text-primary mb-1.5">演示模式 — 快速登录</p>
                          <div className="flex gap-2">
                            <button type="button" onClick={() => quickLogin('admin')}
                              className="flex-1 text-xs py-1 px-2 rounded bg-primary/10 hover:bg-primary/20 text-primary transition-colors">
                              🛡️ 管理员
                            </button>
                            <button type="button" onClick={() => quickLogin('user')}
                              className="flex-1 text-xs py-1 px-2 rounded bg-primary/10 hover:bg-primary/20 text-primary transition-colors">
                              👤 普通用户
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label htmlFor="login-email">邮箱 / 用户名</Label>
                      <Input
                        id="login-email"
                        placeholder="邮箱或用户名"
                        value={loginForm.email}
                        onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })}
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="login-password">密码</Label>
                        <button type="button"
                          onClick={() => { setTab('forgot'); clearMessages() }}
                          className="text-xs text-primary hover:underline">
                          忘记密码？
                        </button>
                      </div>
                      <div className="relative">
                        <Input
                          id="login-password"
                          type={showPassword ? 'text' : 'password'}
                          placeholder="输入密码"
                          value={loginForm.password}
                          onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })}
                          required
                        />
                        <button type="button" onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    <div className="relative flex items-center py-1">
                      <div className="h-px flex-1 bg-border" />
                      <span className="px-3 text-xs text-muted-foreground">或使用第三方应用</span>
                      <div className="h-px flex-1 bg-border" />
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      className="w-full gap-2"
                      disabled={loading || oauthLoading}
                      onClick={() => { window.location.href = authApi.linuxDoAuthorizeUrl() }}
                    >
                      {oauthLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <img
                          src="https://cdn3.ldstatic.com/original/4X/c/c/d/ccd8c210609d498cbeb3d5201d4c259348447562.png"
                          alt=""
                          className="h-5 w-5 rounded-sm"
                        />
                      )}
                      使用 Linux.do 登录
                    </Button>

                    {!loginNeedsCode && (
                      <button
                        type="button"
                        onClick={() => { setLoginNeedsCode(true); clearMessages() }}
                        className="text-xs text-primary hover:underline"
                      >
                        使用两步验证登录
                      </button>
                    )}

                    {loginNeedsCode && (
                      <div className="space-y-2">
                        <Label htmlFor="login-code">邮箱验证码</Label>
                        <div className="flex gap-2">
                          <Input
                            id="login-code"
                            inputMode="numeric"
                            maxLength={6}
                            placeholder="6 位验证码"
                            value={loginForm.verifyCode}
                            onChange={(e) => setLoginForm({ ...loginForm, verifyCode: e.target.value })}
                            required
                          />
                          <Button
                            type="button"
                            variant="outline"
                            disabled={codeCooldown > 0 || loading}
                            onClick={() => handleSendCode(loginForm.email, 'login')}
                            className="shrink-0 min-w-[88px] text-xs sm:text-sm"
                          >
                            {codeCooldown > 0 ? `${codeCooldown}s` : '发送验证码'}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          已开启两步验证，请使用账号邮箱接收验证码后登录。
                        </p>
                      </div>
                    )}

                    <AlertMsg error={error} success={success} />
                  </CardContent>
                  <CardFooter className="px-4 sm:px-6">
                    <Button type="submit" className="w-full" disabled={loading}>
                      {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />登录中...</> : '登录'}
                    </Button>
                  </CardFooter>
                </form>
              </TabsContent>

              {/* 注册 Tab */}
              <TabsContent value="register">
                <form onSubmit={handleRegister}>
                  <CardContent className="space-y-4 pt-5 px-4 sm:px-6">
                    <div className="flex gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                      <Mail className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
                      <p className="text-xs text-blue-600 dark:text-blue-400">
                        注册需要验证邮箱。{DEMO_MODE ? '演示模式下验证码固定为 123456。' : '请填写真实邮箱以接收验证码。'}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>用户名</Label>
                      <Input
                        placeholder="2-20 位字符"
                        value={registerForm.username}
                        onChange={(e) => setRegisterForm({ ...registerForm, username: e.target.value })}
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>邮箱</Label>
                      <div className="flex gap-2">
                        <Input
                          type="email"
                          placeholder="name@example.com"
                          value={registerForm.email}
                          onChange={(e) => setRegisterForm({ ...registerForm, email: e.target.value })}
                          required
                        />
                        <Button
                          type="button"
                          variant="outline"
                          disabled={codeCooldown > 0 || loading}
                          onClick={() => handleSendCode(registerForm.email, 'register')}
                          className="shrink-0 min-w-[80px] sm:min-w-[90px] text-xs sm:text-sm"
                        >
                          {codeCooldown > 0 ? `${codeCooldown}s` : (
                            <span className="flex items-center gap-1">
                              <Shield className="w-3.5 h-3.5" /><span className="hidden sm:inline">获取</span>验证码
                            </span>
                          )}
                        </Button>
                      </div>
                    </div>

                    <VerifyCodeInput
                      value={registerForm.verifyCode}
                      onChange={(v) => setRegisterForm({ ...registerForm, verifyCode: v })}
                    />

                    <div className="space-y-2">
                      <Label>密码</Label>
                      <Input
                        type="password" placeholder="至少 8 位"
                        value={registerForm.password}
                        onChange={(e) => setRegisterForm({ ...registerForm, password: e.target.value })}
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>确认密码</Label>
                      <Input
                        type="password" placeholder="再次输入密码"
                        value={registerForm.confirmPassword}
                        onChange={(e) => setRegisterForm({ ...registerForm, confirmPassword: e.target.value })}
                        required
                      />
                      {registerForm.confirmPassword && registerForm.password !== registerForm.confirmPassword && (
                        <p className="text-xs text-destructive">两次密码不一致</p>
                      )}
                    </div>

                    <AlertMsg error={error} success={success} />
                  </CardContent>
                  <CardFooter className="flex-col gap-3 px-4 sm:px-6">
                    <Button type="submit" className="w-full" disabled={loading}>
                      {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />注册中...</> : '创建账号'}
                    </Button>
                    <p className="text-xs text-muted-foreground text-center">
                      注册即同意《服务条款》和《隐私政策》
                    </p>
                  </CardFooter>
                </form>
              </TabsContent>
            </Tabs>
          )}
        </Card>

        {/* Features */}
        <div className="mt-6 sm:mt-8 grid grid-cols-3 gap-2 sm:gap-3 text-center">
          {[
            { icon: BrainCircuit, text: '多模型支持' },
            { icon: ShieldCheck, text: '安全隐私' },
            { icon: Zap, text: '极速响应' },
          ].map((item) => (
            <div key={item.text} className="group rounded-xl border border-white/14 bg-white/10 p-2.5 sm:p-3 text-cyan-50 shadow-lg backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 hover:border-cyan-200/40 hover:bg-white/15">
              <div className="mx-auto mb-1 flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-200/20 bg-slate-950/35 text-cyan-100 shadow-inner shadow-cyan-950/40 sm:h-9 sm:w-9">
                <item.icon className="h-4 w-4 sm:h-5 sm:w-5" />
              </div>
              <div className="text-xs font-medium text-cyan-50/78">{item.text}</div>
            </div>
          ))}
        </div>
        </div>
      </div>
    </div>
  )
}

/** 6位验证码输入组件 */
function VerifyCodeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const inputs = useRef<(HTMLInputElement | null)[]>([])

  const handleChange = (i: number, v: string) => {
    if (!/^\d*$/.test(v)) return
    const chars = value.split('')
    chars[i] = v.slice(-1)
    const newVal = chars.join('')
    onChange(newVal)
    if (v && i < 5) inputs.current[i + 1]?.focus()
  }

  const handleKeyDown = (i: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !value[i] && i > 0) {
      inputs.current[i - 1]?.focus()
    }
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    onChange(pasted)
    inputs.current[Math.min(pasted.length, 5)]?.focus()
    e.preventDefault()
  }

  return (
    <div className="space-y-2">
      <Label>邮箱验证码</Label>
      <div className="flex gap-2" onPaste={handlePaste}>
        {Array.from({ length: 6 }).map((_, i) => (
          <input
            key={i}
            ref={(el) => { inputs.current[i] = el }}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={value[i] || ''}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            className={cn(
              'w-full aspect-square text-center text-lg font-bold rounded-lg border bg-background',
              'focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary',
              'transition-all',
              value[i] ? 'border-primary/60 bg-primary/5' : 'border-input'
            )}
          />
        ))}
      </div>
      {value.length === 6 && (
        <p className="text-xs text-green-600 flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3" />验证码已填写
        </p>
      )}
    </div>
  )
}

function AlertMsg({ error, success }: { error: string; success: string }) {
  if (error) return (
    <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">{error}</p>
  )
  if (success) return (
    <p className="text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-3 py-2 rounded-md flex items-center gap-2">
      <CheckCircle2 className="w-4 h-4 shrink-0" />{success}
    </p>
  )
  return null
}
