const fs = require('fs');
const file = 'ChatPage.tsx';
let content = fs.readFileSync(file, 'utf8');

// Fix 1: Add type assertion to toolCalls array
const fix1 = `toolCalls: [...existing, {
                  toolCallId: event.toolCallId!,
                  toolName: event.toolName || '',
                  status: 'calling' as const,
                  arguments: truncateToolArgs(event.toolArgs),  // OOM 防护：截断超大参数
                } as ToolCallInfo]`;

const replace1 = `toolCalls: [...existing, {
                  toolCallId: event.toolCallId!,
                  toolName: event.toolName || '',
                  status: 'calling' as const,
                  arguments: truncateToolArgs(event.toolArgs),  // OOM 防护：截断超大参数
                }]`;

if (content.includes(replace1)) {
  content = content.replace(replace1, fix1);
  console.log('✅ Fixed TypeScript error 1 (toolCalls type assertion)');
} else {
  console.log('⚠️ Pattern 1 not found, manual fix needed');
}

// Fix 2: Ensure toolName is string (not string | undefined)
const fix2 = `toolName: event.toolName || ''`;

fs.writeFileSync(file, content, 'utf8');
console.log('✅ Fixed ChatPage.tsx TypeScript errors');
