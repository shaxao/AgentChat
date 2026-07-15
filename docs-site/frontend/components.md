# shadcn 组件体系

前端的 `src/components/ui/` 下有 19 个基础组件（`button` / `dialog` / `select` / `tabs` / `tooltip` / `switch` / `slider` …）。它们是整个界面的「积木」——上层的对话气泡、管理后台表格、设置弹窗，全部由这些积木拼出来。

这一章讲清楚三件事：这套组件是什么风格、它和「组件库」有什么不同、以及项目里一个**值得注意的偏差**。

## 不是「装了一个组件库」

很多人以为 shadcn/ui 是像 antd、MUI 那样 `npm install` 装进来的组件库。**不是。** shadcn 的理念是「把组件源码拷进你的项目」——你拥有每一个组件的源码，可以随意改，没有版本锁定，也没有「覆盖第三方样式」的痛苦。

所以你在 `src/components/ui/` 看到的 `button.tsx`、`dialog.tsx` 都是**项目自己的代码**，不是 `node_modules` 里的。改一个圆角、加一个 variant，直接改文件即可。

那 `node_modules` 里装的是什么？是这套组件依赖的两类底座：

| 依赖 | 作用 |
|------|------|
| `@radix-ui/*` | 无样式的**行为**原语：弹窗的焦点陷阱、下拉的键盘导航、开关的 ARIA 状态。负责「怎么交互」，不管「长什么样」。 |
| `tailwindcss` + `tailwind-merge` + `clsx` | 负责「长什么样」：用 Tailwind 类名描述样式，`cn()` 把它们智能合并。 |

一句话：**Radix 管行为与可访问性，Tailwind 管外观，shadcn 是把两者缝合起来的那层薄代码。** 项目直接拥有这层薄代码。

## 核心工具：cn()

几乎每个组件都会 `import { cn } from "@/lib/utils"`。它是这套体系的黏合剂：

<SourceExplainer
  file="app/src/lib/utils.ts"
  :notes="[
    { lines: '1-3', text: 'clsx 负责把条件类名（对象、数组、假值）压平成一个字符串；twMerge 负责解决 Tailwind 类冲突。' },
    { lines: '5', text: '两者组合：先 clsx 收集，再 twMerge 去冲突。这就是 cn 的全部。' }
  ]">

```ts
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

</SourceExplainer>

为什么需要 `twMerge`？因为 Tailwind 里 `px-4` 和 `px-8` 是冲突的两个类，普通字符串拼接会两个都留下，谁生效取决于 CSS 顺序，不可控。`twMerge` 知道它们是同一维度，会**只保留后者**。于是组件可以这样写：

```tsx
// 组件内置 px-4，调用方传 px-8 覆盖 —— twMerge 保证 px-8 生效
<Button className="px-8" />
```

这让「组件给默认样式、调用方按需覆盖」变得干净可靠。

## 一个真实的组件长什么样

看项目里 `button.tsx` 的真实实现：

<SourceExplainer
  file="app/src/components/ui/button.tsx"
  :notes="[
    { lines: '1-9', text: 'forwardRef 转发 ref（让父组件能拿到真实 DOM 按钮）；类型上扩展原生 button 属性，再加 variant 和 size 两个可选联合类型。' },
    { lines: '11-24', text: 'variant 和 size 各是一张普通对象表：键是变体名，值是 Tailwind 类名串。default/destructive/outline/secondary/ghost/link 六种风格，default/sm/lg/icon 四种尺寸。' },
    { lines: '26-35', text: 'cn 把三部分合并：基础类（布局/圆角/焦点环/禁用态）+ 选中的 variant + 选中的 size + 调用方传入的 className。顺序靠后的能覆盖靠前的。' }
  ]">

```tsx
const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link"
    size?: "default" | "sm" | "lg" | "icon"
  }
>(({ className, variant = "default", size = "default", ...props }, ref) => {
  const variants = {
    default: "bg-primary text-primary-foreground hover:bg-primary/90",
    destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
    outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
    secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
    ghost: "hover:bg-accent hover:text-accent-foreground",
    link: "text-primary underline-offset-4 hover:underline",
  }
  const sizes = {
    default: "h-10 px-4 py-2",
    sm: "h-8 rounded-md px-3 text-xs",
    lg: "h-11 rounded-md px-8",
    icon: "h-9 w-9",
  }
  return (
    <button
      className={cn("inline-flex items-center justify-center …", variants[variant], sizes[size], className)}
      ref={ref}
      {...props}
    />
  )
})
```

</SourceExplainer>

## 值得注意的偏差：没有用 CVA

标准的 shadcn/ui `button.tsx` 会用 `class-variance-authority`（CVA）的 `cva()` 来声明变体，而且 `class-variance-authority` **确实在这个项目的 `package.json` 依赖里**。

但项目里这个 `button.tsx` 并没有用 CVA——它用的是**两张普通对象表 + `cn()`**（`variants[variant]`、`sizes[size]`）。

这是个真实的、值得你留意的细节，两点启发：

1. **读源码要以磁盘为准，不要用「框架惯例」去脑补。** 如果你照搬 shadcn 官方文档，会以为这里用了 `cva()`，实际没有。
2. **两种写法效果几乎等价。** CVA 的价值在变体维度多、需要「复合变体」（比如 `variant=outline 且 size=sm 时额外加某个类）时才明显。这里只有两个独立维度，普通对象表更直白，也少一层抽象。

留着 CVA 依赖、却在这个组件里没用，很可能是「装了但当时没用上」或「部分组件用、部分没用」。这在真实项目里非常常见——依赖清单和实际用法之间总会有一点漂移。

::: tip 给学习者的动手练习
打开 `app/src/components/ui/` 里另外几个组件（比如 `badge.tsx`、`switch.tsx`），看看它们各自用的是哪种写法。对比 `dialog.tsx`、`select.tsx` 这类**包了 Radix 原语**的组件——它们会 `import * as XxxPrimitive from "@radix-ui/react-xxx"`，然后用 `cn()` 给原语套上 Tailwind 样式。这是理解「Radix 管行为、Tailwind 管外观」最直接的方式。
:::

## 组件清单

`src/components/ui/` 现有 19 个组件，可分三类：

| 类别 | 组件 | 特点 |
|------|------|------|
| 纯样式封装 | `button` `badge` `card` `input` `textarea` `label` `separator` | 基本只是 `cn()` + Tailwind，无复杂行为 |
| 包 Radix 原语 | `dialog` `dropdown-menu` `select` `tabs` `tooltip` `switch` `slider` `progress` `scroll-area` `avatar` | 依赖 `@radix-ui/*` 提供焦点管理、键盘导航、ARIA |
| 项目自定义 | `star-rating` `toast` | 结合业务需要手写（评分、通知） |

上层业务组件（`chat/`、`admin/`、`workflow/` 等）几乎全部是把这些 ui 积木组合起来的。理解了这一层，再看上层组件就只是「用积木搭房子」。

## 小结

- shadcn 不是组件库，是**拷进项目、由你拥有的组件源码**。
- 分工：`@radix-ui/*` 管行为与可访问性，Tailwind 管外观，`cn()` 缝合。
- 本项目 `button.tsx` **没有用 CVA**（尽管依赖里有），用的是普通对象表——读码以磁盘为准。

下一章 [代码执行预览](/frontend/code-preview) 会看到这些组件如何和 Pyodide、iframe 沙箱一起，把「在浏览器里跑代码」这件事做出来。
