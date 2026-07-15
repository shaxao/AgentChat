/**
 * 聊天命令解析工具
 * 支持以下命令：
 * - /edit-skill <技能名> - 快速编辑技能
 * - /view-skill <技能名> - 查看技能详情
 * - /help - 显示帮助
 */

export interface ChatCommand {
  command: string;
  args: string[];
  raw: string;
}

export interface CommandHandler {
  canHandle: (cmd: ChatCommand) => boolean;
  handle: (cmd: ChatCommand) => void;
}

/**
 * 解析用户输入，提取命令
 * @param input 用户输入
 * @returns 如果是命令返回ChatCommand，否则返回null
 */
export function parseCommand(input: string): ChatCommand | null {
  const trimmed = input.trim();
  
  // 检查是否以 / 开头
  if (!trimmed.startsWith('/')) {
    return null;
  }
  
  // 分割命令和参数
  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  
  return {
    command,
    args,
    raw: trimmed
  };
}

/**
 * 检查输入是否包含命令
 */
export function isCommand(input: string): boolean {
  return input.trim().startsWith('/');
}

/**
 * 获取所有可用命令的帮助信息
 */
export function getCommandHelp(): string {
  return `
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
`;
}

/**
 * 从参数中提取技能名称
 * 支持引号包围的技能名
 */
export function extractSkillName(args: string[]): string {
  if (args.length === 0) {
    return '';
  }
  
  // 如果第一个参数以引号开头，合并直到找到结尾引号
  if (args[0].startsWith('"') || args[0].startsWith("'")) {
    const quote = args[0][0];
    let name = args[0].substring(1); // 移除开头引号
    
    for (let i = 1; i < args.length; i++) {
      if (args[i].endsWith(quote)) {
        name += ' ' + args[i].substring(0, args[i].length - 1);
        return name;
      }
      name += ' ' + args[i];
    }
    
    // 如果没有找到结尾引号，返回已组装的名称
    return name;
  }
  
  // 没有引号，返回第一个参数
  return args[0];
}
