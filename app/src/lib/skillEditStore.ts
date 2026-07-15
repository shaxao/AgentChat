/**
 * 技能编辑全局状态管理
 * 允许从应用的任何地方触发技能编辑对话框
 */

import { create } from 'zustand';

interface SkillEditState {
  // 对话框状态
  isOpen: boolean;
  agentId: string | null;
  skillName: string | null;
  
  // 操作方法
  openSkillEditor: (agentId: string, skillName?: string) => void;
  closeSkillEditor: () => void;
  
  // 快捷命令触发
  triggerFromCommand: (skillIdentifier: string) => void;
}

export const useSkillEditStore = create<SkillEditState>((set, get) => ({
  isOpen: false,
  agentId: null,
  skillName: null,
  
  openSkillEditor: (agentId: string, skillName?: string) => {
    set({
      isOpen: true,
      agentId,
      skillName: skillName || null
    });
  },
  
  closeSkillEditor: () => {
    set({
      isOpen: false,
      agentId: null,
      skillName: null
    });
  },
  
  triggerFromCommand: (skillIdentifier: string) => {
    // 这个方法会被Chat组件调用
    // 它发送一个自定义事件，由SkillStoreView监听
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('skill-edit-command', {
          detail: { skillIdentifier }
        })
      );
    }
  }
}));

/**
 * 聊天命令处理Hook
 * 在Chat组件中使用此Hook来处理命令
 */
export function useChatCommandHandler() {
  const openSkillEditor = useSkillEditStore((state) => state.openSkillEditor);
  
  return {
    handleCommand: async (command: string, args: string[]) => {
      if (command === '/edit-skill' || command === '/edit') {
        const skillName = args.join(' ');
        if (!skillName) {
          return { success: false, message: '请提供技能名称。用法：/edit-skill <技能名>' };
        }
        
        // 触发全局事件
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('skill-edit-command', {
              detail: { skillIdentifier: skillName }
            })
          );
        }
        
        return { success: true, message: `正在查找技能: ${skillName}...` };
      }
      
      if (command === '/view-skill' || command === '/view') {
        const skillName = args.join(' ');
        if (!skillName) {
          return { success: false, message: '请提供技能名称。用法：/view-skill <技能名>' };
        }
        
        // 触发查看技能事件
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('skill-view-command', {
              detail: { skillIdentifier: skillName }
            })
          );
        }
        
        return { success: true, message: `正在查找技能: ${skillName}...` };
      }
      
      if (command === '/help') {
        return { 
          success: true, 
          message: `
可用命令：

/edit-skill <技能名>  - 快速编辑指定技能
  示例：/edit-skill pdf
  示例：/edit-skill "my skill"

/view-skill <技能名>  - 查看技能详情
  示例：/view-skill pdf

/help  - 显示此帮助信息

提示：
- 技能名支持模糊匹配
- 如果技能名包含空格，请用引号包围
`.trim() 
        };
      }
      
      return { success: false, message: `未知命令: ${command}。输入 /help 查看可用命令。` };
    }
  };
}
