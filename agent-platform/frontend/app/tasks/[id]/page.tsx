import TaskDetailClient from './TaskDetailClient'

// 静态导出：生成 /tasks/index.html 作为入口，Nginx 将 /tasks/* 全部重写到这个页面
export async function generateStaticParams() {
  return [{ id: 'index' }]
}

export default function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  return <TaskDetailClient params={params} />
}
