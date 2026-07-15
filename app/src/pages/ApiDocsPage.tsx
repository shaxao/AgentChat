import { useMemo, useState } from 'react'
import {
  Activity,
  AudioLines,
  BadgeDollarSign,
  CheckCircle2,
  Code2,
  Copy,
  Image,
  KeyRound,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { copyText } from '@/lib/clipboard'

type Endpoint = {
  method: string
  path: string
  title: string
  description: string
}

type Feature = {
  title: string
  text: string
  icon: LucideIcon
}

const endpoints: Endpoint[] = [
  {
    method: 'GET',
    path: '/v1/models',
    title: '模型列表',
    description: '返回当前账号可调用的模型列表，兼容 OpenAI models 格式。',
  },
  {
    method: 'GET',
    path: '/v1/balance',
    title: '余额与额度',
    description: '查询钱包余额、套餐额度、token 使用量和当前订阅状态。',
  },
  {
    method: 'POST',
    path: '/v1/chat/completions',
    title: 'Chat Completions',
    description: '兼容 OpenAI Chat Completions，支持 messages、tools、temperature、stream 字段。',
  },
  {
    method: 'POST',
    path: '/v1/responses',
    title: 'Responses',
    description: '兼容 OpenAI Responses 基础格式，支持 input、instructions、tools。',
  },
  {
    method: 'POST',
    path: '/v1/audio/speech',
    title: '语音合成',
    description: '输入文本并返回 audio/mpeg 音频。',
  },
  {
    method: 'POST',
    path: '/v1/audio/transcriptions',
    title: '语音转文字',
    description: 'multipart 上传音频文件并返回识别文本。',
  },
  {
    method: 'POST',
    path: '/v1/images/generations',
    title: '图像生成',
    description: '输入 prompt，返回图片 URL 或 b64_json。',
  },
]

const features: Feature[] = [
  {
    title: '安全密钥',
    text: '完整 API Key 只在生成时显示一次，重新生成会立即撤销旧 Key。',
    icon: KeyRound,
  },
  {
    title: '统一计费',
    text: 'API 调用进入统一 usage 统计，可通过余额接口查询钱包和套餐状态。',
    icon: BadgeDollarSign,
  },
  {
    title: '官方格式',
    text: '兼容 Chat Completions、Responses、Audio、Images 等常用 OpenAI 接口形态。',
    icon: ShieldCheck,
  },
]

function CopyButton({ value }: { value: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'success' | 'error'>('idle')

  const copy = async () => {
    try {
      await copyText(value)
      setCopyState('success')
      toast.success('已复制')
    } catch {
      setCopyState('error')
      toast.error('复制失败，请手动选择复制')
    } finally {
      window.setTimeout(() => setCopyState('idle'), 1400)
    }
  }

  const stateClass = copyState === 'success'
    ? 'scale-105 border-emerald-400 bg-emerald-500/20 text-emerald-100 shadow-sm shadow-emerald-500/20'
    : copyState === 'error'
      ? 'scale-105 border-red-400 bg-red-500/20 text-red-100 shadow-sm shadow-red-500/20'
      : 'border-white/15 bg-white/10 text-white/85 hover:bg-white/15'

  return (
    <button
      type="button"
      onClick={copy}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-all duration-200 ${stateClass}`}
    >
      {copyState === 'success' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copyState === 'success' ? '已复制' : copyState === 'error' ? '失败' : '复制'}
    </button>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-950 shadow-sm">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <span className="text-xs font-medium text-slate-300">Example</span>
        <CopyButton value={children} />
      </div>
      <pre className="overflow-x-auto p-4 text-xs leading-6 text-slate-100">
        <code>{children}</code>
      </pre>
    </div>
  )
}

export default function ApiDocsPage() {
  const origin = window.location.origin
  const baseUrl = `${origin}/v1`
  const examples = useMemo(() => ({
    balance: `curl ${baseUrl}/balance \\
  -H "Authorization: Bearer muhuo-YOUR_API_KEY"`,
    chat: `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer muhuo-YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.5",
    "messages": [
      {"role": "user", "content": "用三句话介绍你的能力"}
    ]
  }'`,
    responses: `curl ${baseUrl}/responses \\
  -H "Authorization: Bearer muhuo-YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.5",
    "input": "写一个 TypeScript 防抖函数"
  }'`,
    speech: `curl ${baseUrl}/audio/speech \\
  -H "Authorization: Bearer muhuo-YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -o speech.mp3 \\
  -d '{
    "model": "tts",
    "voice": "alloy",
    "input": "你好，欢迎使用 MuHuo API。"
  }'`,
    image: `curl ${baseUrl}/images/generations \\
  -H "Authorization: Bearer muhuo-YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "image",
    "prompt": "未来感 AI 控制台界面，深色背景",
    "size": "1024x1024"
  }'`,
  }), [baseUrl])

  return (
    <div className="h-dvh overflow-y-auto overscroll-contain bg-slate-50 text-slate-950">
      <section className="relative overflow-hidden bg-slate-950 text-white">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(14,165,233,0.28),transparent_34%),radial-gradient(circle_at_80%_10%,rgba(34,197,94,0.20),transparent_28%),linear-gradient(135deg,#020617,#0f172a_62%,#111827)]" />
        <div className="relative mx-auto flex min-h-[420px] max-w-6xl flex-col justify-center px-6 py-16">
          <div className="mb-5 inline-flex w-fit items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-sm text-white/80">
            <Sparkles className="h-4 w-4 text-cyan-300" />
            OpenAI Compatible API
          </div>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-normal md:text-6xl">
            MuHuo API 使用文档
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-8 text-slate-300 md:text-lg">
            使用一个以 muhuo- 开头的 API Key，通过 OpenAI 官方兼容格式调用文本、Responses、语音、图像和余额查询接口。
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <div className="rounded-lg border border-white/15 bg-white/10 px-4 py-3">
              <div className="text-xs uppercase text-slate-400">Base URL</div>
              <div className="mt-1 font-mono text-sm text-cyan-100">{baseUrl}</div>
            </div>
            <CopyButton value={baseUrl} />
          </div>
        </div>
      </section>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <section className="grid gap-4 md:grid-cols-3">
          {features.map(({ title, text, icon: Icon }) => (
            <div key={title} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <Icon className="h-5 w-5 text-cyan-600" />
              <h2 className="mt-4 text-base font-semibold">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">{text}</p>
            </div>
          ))}
        </section>

        <section className="mt-10 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <Code2 className="h-5 w-5 text-cyan-600" />
            <h2 className="text-xl font-semibold">鉴权方式</h2>
          </div>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            在设置的 API Key 页面生成密钥，然后在请求头中加入 Authorization。不要把密钥放到浏览器前端或公开仓库。
          </p>
          <div className="mt-4 rounded-md bg-slate-100 px-4 py-3 font-mono text-sm text-slate-800">
            Authorization: Bearer muhuo-YOUR_API_KEY
          </div>
        </section>

        <section className="mt-10">
          <div className="mb-4 flex items-center gap-3">
            <Activity className="h-5 w-5 text-cyan-600" />
            <h2 className="text-xl font-semibold">接口列表</h2>
          </div>
          <div className="grid gap-3">
            {endpoints.map(endpoint => (
              <div key={endpoint.path} className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-[110px_1fr]">
                <div>
                  <span className="inline-flex rounded-md bg-slate-950 px-2.5 py-1 font-mono text-xs font-semibold text-white">
                    {endpoint.method}
                  </span>
                </div>
                <div>
                  <div className="font-mono text-sm text-cyan-700">{endpoint.path}</div>
                  <h3 className="mt-1 font-semibold">{endpoint.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">{endpoint.description}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm text-slate-500">
            兼容别名：<span className="font-mono">POST /v1/char/com</span> 可作为 <span className="font-mono">/v1/chat/completions</span> 的容错入口。
          </p>
        </section>

        <section className="mt-10 grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <BadgeDollarSign className="h-5 w-5 text-cyan-600" />
              <h2 className="text-xl font-semibold">余额查询</h2>
            </div>
            <CodeBlock>{examples.balance}</CodeBlock>
          </div>
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <MessageSquareText className="h-5 w-5 text-cyan-600" />
              <h2 className="text-xl font-semibold">Chat Completions</h2>
            </div>
            <CodeBlock>{examples.chat}</CodeBlock>
          </div>
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-cyan-600" />
              <h2 className="text-xl font-semibold">Responses</h2>
            </div>
            <CodeBlock>{examples.responses}</CodeBlock>
          </div>
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <AudioLines className="h-5 w-5 text-cyan-600" />
              <h2 className="text-xl font-semibold">语音合成</h2>
            </div>
            <CodeBlock>{examples.speech}</CodeBlock>
          </div>
          <div className="space-y-4 lg:col-span-2">
            <div className="flex items-center gap-3">
              <Image className="h-5 w-5 text-cyan-600" />
              <h2 className="text-xl font-semibold">图像生成</h2>
            </div>
            <CodeBlock>{examples.image}</CodeBlock>
          </div>
        </section>
      </main>
    </div>
  )
}
