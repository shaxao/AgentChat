export type TaskStatus = 'pending' | 'running' | 'waiting_confirm' | 'waiting_plan_confirm' | 'waiting_prototype_confirm' | 'reviewing' | 'waiting_review_confirm' | 'completed' | 'failed' | 'cancelled'
export type SubTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface AgentLogEntry {
  timestamp: string
  agent: string
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
  detail?: string
}

export interface GitCommit {
  hash: string
  message: string
  author: string
  date: string
  files_changed: string[]
}

export interface SubTask {
  id: string
  title: string
  description: string
  agent_type: string
  estimated_files: string[]
  dependencies: string[]
  status: SubTaskStatus
  progress: number
}

export interface TaskPlan {
  overall_approach: string
  architecture: string
  tech_stack: Record<string, string>
  subtasks: SubTask[]
  execution_groups: string[][]
}

export interface Task {
  id: string
  title: string
  description: string
  project_type: string
  status: TaskStatus
  created_at: string
  workspace_id: string
  agents: string[]
  logs: AgentLogEntry[]
  commit_history: GitCommit[]
  preview_url?: string
  dev_server_port?: number
  progress?: number
  current_step?: string
  research_report?: ResearchReport
  agent_progress?: Record<string, number>
  agent_active?: Record<string, boolean>
  pending_confirmation?: PendingConfirmation
  plan?: TaskPlan
  current_subtask_id?: string
  model?: string
  spec?: string
  review?: Record<string, any>
  phase_reviews?: Record<string, any>[]
  review_confirmed?: boolean | null
  prototype?: Record<string, any>
  prototype_confirmed?: boolean | null
  plan_confirmed?: boolean | null
  execution_active?: boolean
  runtime_state?: 'active' | 'waiting' | 'terminal' | 'idle' | string
  runtime_note?: string
}

export interface ResearchReport {
  tech_stack: {
    frontend?: string
    backend?: string
    database?: string
    deploy?: string
  }
  key_libraries: string[]
  best_practices: string[]
  pitfalls: string[]
  project_structure?: string
  reference_projects: Array<{ name: string; url: string; why: string }>
  confidence: number
}

export interface TaskCreate {
  title: string
  description: string
  project_type: string
  agent_types?: string[]
  enable_smart_planning?: boolean
  model?: string
  spec?: string
}

export interface ModelInfo {
  model_id: string
  name: string
  provider: string
  capabilities: string[]
  input_price?: number
  output_price?: number
  context_length?: number
  code_quality?: number
}

export interface PendingConfirmation {
  action: string
  path: string
  reason: string
}

export interface AgentInfo {
  name: string
  description: string
  skills: string[]
  status: string
}
