type SplashController = {
  finish: () => void
}

export function startStartupSplash(): SplashController {
  const splash = document.getElementById('startup-splash')
  const canvas = document.getElementById('startup-scene') as HTMLCanvasElement | null
  const bar = document.getElementById('startup-progress-bar') as HTMLElement | null
  const status = document.getElementById('startup-status') as HTMLElement | null
  if (!splash || !canvas) return { finish: () => undefined }

  const ctx = canvas.getContext('2d')
  if (!ctx) return { finish: () => splash.remove() }

  let width = 0
  let height = 0
  let dpr = 1
  let raf = 0
  let progressRaf = 0
  let start = performance.now()
  let finished = false
  const nodes: Array<{ x: number; y: number; vx: number; vy: number; r: number; pulse: number }> = []
  const core: Array<{ x: number; y: number; phase: number; amp: number; fire: number }> = []
  const steps = ['初始化本地工作台', '加载智能体运行时', '检查工具与权限', '同步项目会话', '准备语音模块', '启动完成']

  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    width = Math.max(1, Math.floor(window.innerWidth * dpr))
    height = Math.max(1, Math.floor(window.innerHeight * dpr))
    canvas.width = width
    canvas.height = height
    canvas.style.width = `${window.innerWidth}px`
    canvas.style.height = `${window.innerHeight}px`
    buildParticles()
  }

  const buildParticles = () => {
    nodes.length = 0
    core.length = 0
    const count = Math.max(36, Math.min(120, Math.floor((width * height) / (38000 * dpr * dpr))))
    for (let index = 0; index < count; index += 1) {
      nodes.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.24 * dpr,
        vy: (Math.random() - 0.5) * 0.24 * dpr,
        r: (Math.random() * 1.15 + 0.45) * dpr,
        pulse: Math.random() * Math.PI * 2,
      })
    }
    const cx = width / 2
    const cy = height * 0.43
    const scale = Math.min(width, height) * 0.28
    for (let index = 0; index < 170; index += 1) {
      const angle = Math.random() * Math.PI * 2
      const radius = Math.pow(Math.random(), 0.5) * (0.74 + Math.sin(angle * 5) * 0.06)
      core.push({
        x: cx + Math.cos(angle) * radius * scale,
        y: cy + Math.sin(angle) * radius * scale * 0.78,
        phase: Math.random() * Math.PI * 2,
        amp: (Math.random() * 5 + 2) * dpr,
        fire: Math.random(),
      })
    }
  }

  const draw = (time: number) => {
    if (!document.body.contains(splash)) return
    const t = time * 0.001
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = 'rgba(9, 12, 17, 0.36)'
    ctx.fillRect(0, 0, width, height)
    ctx.globalCompositeOperation = 'lighter'

    const cx = width / 2
    const cy = height * 0.43
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(width, height) * 0.56)
    halo.addColorStop(0, 'rgba(92, 162, 200, 0.16)')
    halo.addColorStop(0.52, 'rgba(53, 93, 122, 0.08)')
    halo.addColorStop(1, 'rgba(0, 0, 0, 0)')
    ctx.fillStyle = halo
    ctx.fillRect(0, 0, width, height)

    const link = 125 * dpr
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i]
      a.x += a.vx
      a.y += a.vy
      if (a.x < 0) a.x = width
      if (a.x > width) a.x = 0
      if (a.y < 0) a.y = height
      if (a.y > height) a.y = 0
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        if (dist > link) continue
        ctx.strokeStyle = `rgba(111, 216, 182, ${(1 - dist / link) * 0.12})`
        ctx.lineWidth = 0.7 * dpr
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
      ctx.fillStyle = 'rgba(142, 201, 255, 0.28)'
      ctx.beginPath()
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2)
      ctx.fill()
    }

    for (let i = 0; i < core.length; i += 1) {
      const a = core[i]
      const x = a.x + Math.cos(t * 1.5 + a.phase) * a.amp
      const y = a.y + Math.sin(t * 1.8 + a.phase) * a.amp
      const pulse = 0.55 + Math.sin(t * 3 + a.phase) * 0.45
      if (i % 3 === 0 && core[i + 1]) {
        const b = core[i + 1]
        ctx.strokeStyle = `rgba(110, 216, 182, ${0.08 + pulse * 0.12})`
        ctx.lineWidth = 0.8 * dpr
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
      const r = (1.1 + pulse * 1.6) * dpr
      ctx.fillStyle = `rgba(232, 247, 255, ${0.35 + pulse * 0.45})`
      ctx.shadowBlur = 10 * dpr
      ctx.shadowColor = 'rgba(110, 216, 182, 0.68)'
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0
    }

    ctx.globalCompositeOperation = 'source-over'
    raf = requestAnimationFrame(draw)
  }

  const updateProgress = () => {
    if (!document.body.contains(splash)) return
    const elapsed = performance.now() - start
    const softProgress = finished ? 100 : Math.min(94, (elapsed / 1800) * 94)
    if (bar) bar.style.width = `${softProgress}%`
    if (status) {
      const index = Math.min(steps.length - 1, Math.floor((softProgress / 100) * steps.length))
      status.textContent = `${steps[index]} · ${String(Math.floor(softProgress)).padStart(2, '0')}%`
    }
    if (!finished) progressRaf = requestAnimationFrame(updateProgress)
  }

  const finish = () => {
    if (finished) return
    finished = true
    const elapsed = performance.now() - start
    const wait = Math.max(160, 900 - elapsed)
    window.setTimeout(() => {
      if (bar) bar.style.width = '100%'
      if (status) status.textContent = '启动完成 · 100%'
      splash.classList.add('done')
      window.setTimeout(() => {
        cancelAnimationFrame(raf)
        cancelAnimationFrame(progressRaf)
        window.removeEventListener('resize', resize)
        splash.remove()
      }, 520)
    }, wait)
  }

  window.addEventListener('resize', resize)
  resize()
  raf = requestAnimationFrame(draw)
  progressRaf = requestAnimationFrame(updateProgress)
  return { finish }
}
