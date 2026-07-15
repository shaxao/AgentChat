-- 初始化管理员账号 (密码: Admin@123456, BCrypt加密)
INSERT INTO sys_user (uuid, username, email, password, role, plan, status, email_verified, tokens_limit, balance)
VALUES (
    'admin-uuid-0001',
    'admin',
    'admin@aiplatform.com',
    '$2a$10$kccceDAX2h0tpVLcLHz0GumCGhwpooGgqs0KX5tA9aGDIzT8PFXki',
    'admin',
    'enterprise',
    'active',
    TRUE,
    999999999,
    10000
) ON DUPLICATE KEY UPDATE id=id;

-- 初始化模型配置
INSERT INTO model_config (model_id, name, provider, description, context_length, input_price, output_price, capabilities, enabled) VALUES
('gpt-4o',           'GPT-4o',              'OpenAI',    'OpenAI最新多模态模型',      128000,  5.00,  15.00, 'text,vision,code',           TRUE),
('gpt-4.1-mini',      'GPT-4.1-Mini',         'OpenAI',    '快速经济的GPT-4.1版本',      128000,  0.15,   0.60, 'text,vision,code',           TRUE),
('claude-3-5-sonnet','Claude 3.5 Sonnet',   'Anthropic', 'Anthropic旗舰推理模型',     200000,  3.00,  15.00, 'text,vision,code,reasoning', TRUE),
('gemini-2.0-flash', 'Gemini 2.0 Flash',    'Google',    'Google最新快速模型',       1000000,  0.10,   0.40, 'text,vision,audio,code',     TRUE),
('deepseek-chat',    'DeepSeek Chat',       'DeepSeek',  '深度求索高性价比对话模型',   64000,  0.14,   0.28, 'text,code',                  TRUE),
('deepseek-reasoner','DeepSeek R1',         'DeepSeek',  '深度求索推理模型',           64000,  0.55,   2.19, 'text,code,reasoning',        TRUE),
('qwen-max',         '通义千问 Max',         'Alibaba',   '阿里云旗舰大模型',          32000,  0.04,   0.12, 'text,code',                  TRUE)
ON DUPLICATE KEY UPDATE
    name        = VALUES(name),
    description = VALUES(description);

-- 初始化订阅套餐
-- model_limit: 逗号分隔的模型ID列表，为空表示不限制
INSERT INTO subscription_plan (uuid, name, code, description, price, tokens_limit, model_limit, features, sort_order, is_popular, enabled, role_id) VALUES
('plan-free-0001', '免费版', 'free',       '适合个人轻度使用',     0,   50000,   'gpt-3.5-turbo,gpt-3.5-turbo-16k,gpt-4o-mini', '["每月 5 万 Token","基础模型访问","标准响应速度","社区支持"]',                                                                          1, FALSE, TRUE, (SELECT id FROM (SELECT id FROM sys_role WHERE role_code='user' AND deleted=0) t)),
('plan-pro-0001',  'Pro 版', 'pro',        '适合专业用户和小团队', 99,  500000,  '',                                             '["每月 50 万 Token","全部模型访问","优先响应速度","邮件支持","API 访问","对话历史无限制"]',                                              2, TRUE,  TRUE, (SELECT id FROM (SELECT id FROM sys_role WHERE role_code='vip' AND deleted=0) t)),
('plan-ent-0001',  '企业版', 'enterprise', '适合企业和大型团队',   299, 5000000, '',                                             '["每月 500 万 Token","全部模型访问","最高响应速度","专属客服","SLA 保障","自定义模型","团队管理","数据导出"]',                            3, FALSE, TRUE, (SELECT id FROM (SELECT id FROM sys_role WHERE role_code='premium' AND deleted=0) t))
ON DUPLICATE KEY UPDATE
    name        = VALUES(name),
    description = VALUES(description),
    features    = VALUES(features);

-- 初始化默认模型渠道（示例，实际使用前请替换 API Key）
INSERT INTO model_channel (uuid, name, provider, api_key, base_url, models, channel_type, status, priority, rate_limit) VALUES
('ch-uuid-0001', 'OpenAI 官方',  'OpenAI',    'sk-your-openai-api-key',    'https://api.example.com/v1',   'gpt-4o,gpt-4.1-mini',             'chat', 'disabled',   1, 60),
('ch-uuid-0004', 'OSS',  'OpenAI',    'sk-your-oss-api-key',    'https://api.example.com/v1',   'gpt-oss-120b,gpt-oss-20b',             'chat', 'disabled',   1, 60),
('ch-uuid-0002', 'Anthropic',    'Anthropic', 'sk-ant-your-api-key',       'https://api.anthropic.com',   '["claude-3-5-sonnet"]',                'chat', 'disabled', 2, 30),
('ch-uuid-0005', '千问voice',    'Alibaba', 'sk-your-dashscope-api-key',       'https://dashscope.aliyuncs.com/compatible-mode/v1',   'qwen3-tts-instruct-flash',   'tts', 'disabled', 2, 30),
('ch-uuid-0003', 'DeepSeek',     'DeepSeek',  'sk-your-deepseek-api-key',  'https://api.deepseek.com', 'deepseek-v4-pro,deepseek-v4-flash', 'chat', 'disabled',   3, 60)
ON DUPLICATE KEY UPDATE uuid=uuid;

-- =============================================
-- 初始化场景数据（战略改造 v2.0）
-- =============================================
INSERT INTO scenario (name, icon, profession, description, system_prompt, recommended_skills, is_official, is_public, usage_count, sort_order) VALUES
('餐饮管理',     '🍽️', '餐饮业',   '为餐厅老板和管理者打造的 AI 助手，覆盖排班、台账、库存、订货等日常经营场景', 
 '你是一个专业的餐厅经营顾问。你了解中餐和西餐的运营模式，擅长帮助餐厅老板管理日常经营事务。你的沟通风格亲切专业，会主动提醒用户关键的经营指标和数据。当你参与报表/台账生成时，你会生成结构清晰的表格；当你讨论经营策略时，你会提供数据驱动的建议。请根据用户的需求灵活切换模式。',
 '["ledger-agent"]', 1, 1, 0, 1),

('代码开发',     '💻', '开发者',   '面向程序员的全栈开发助手，支持需求分析、代码生成、调试和部署', 
 '你是一个资深全栈开发工程师。你精通多种编程语言和框架，擅长需求分析、架构设计、代码实现、调试和部署。你会主动确认需求细节，提供清晰的注释和文档，并给出可运行的代码示例。你注重代码质量和最佳实践。',
 NULL, 1, 1, 0, 2),

('数据分析',     '📊', '数据',     '数据驱动的决策助手，支持数据清洗、可视化、报表生成和洞察提取', 
 '你是一个专业的数据分析师。你擅长理解数据业务需求，能够指导用户完成数据清洗、分析和可视化。你会使用表格和图表展示分析结果，并提供可操作的洞察建议。你注重数据的准确性和分析的合理性。',
 NULL, 1, 1, 0, 3),

('内容创作',     '✍️', '创作者',   '为自媒体创作者和营销人员提供内容策划、文案撰写和优化建议', 
 '你是一个资深的文案和内容策略顾问。你擅长品牌定位、内容策划和各种形式的文案创作（公众号、短视频、广告、邮件等）。你会根据目标受众调整语言风格，注重情感共鸣和转化效果。',
 NULL, 1, 1, 0, 4),

('企业管理',     '🏢', '管理',     '面向中小企业管理者的综合助手，覆盖人事、财务、运营等场景', 
 '你是一个经验丰富的企业管理顾问。你熟悉中小企业的管理挑战，能够提供人事管理、财务规划、运营优化等方面的建议。你的建议务实可落地，会考虑到中小企业的资源和限制条件。',
 NULL, 1, 1, 0, 5),

('教育教学',     '📚', '教育',     '为教师和学生打造的 AI 学习伙伴，支持备课、答疑、作业辅导和知识梳理', 
 '你是一个耐心细致的教育工作者。你擅长将复杂概念简化为易懂的解释，能够根据不同学习阶段调整教学内容深度。你可以帮助备课、答疑、批改作业、生成练习题，也会鼓励和激励学习者。',
 NULL, 1, 1, 0, 6)
ON DUPLICATE KEY UPDATE name=name;

-- =============================================
-- 初始化模型路由规则（智能模型选择）
-- =============================================
INSERT INTO model_routing_rule (rule_name, description, scene_type, agent_type, complexity, required_tags, priority, enabled) VALUES
('默认对话路由',    '普通对话场景，优先低延迟模型',     'chat',   NULL,        NULL,       NULL,               10, 1),
('Vision识别路由',  '图片识别场景，必须有vision能力',  'vision',  NULL,        NULL,       '["vision"]',       10, 1),
('代码生成路由',    '代码生成场景，优先代码质量高的模型', 'code',   NULL,        'complex',  '["code"]',        10, 1),
('图片生成路由',    '图片生成场景，必须有image能力',    'image',  NULL,        NULL,       '["image"]',        10, 1),
('Agent执行路由',   'Agent技能执行，必须有tool能力',    'agent',   NULL,        NULL,       '["tool"]',         10, 1),
('台账Agent路由',   '台账生成Agent，需要code+tool能力', 'agent',   'ledger',    'complex',  '["tool","code"]',  20, 1),
('写作Agent路由',   '写作Agent，需要text能力',         'agent',   'writing',   'moderate', '["text"]',        15, 1),
('数据分析路由',    '数据分析场景，优先推理能力',       'chat',    NULL,        'complex',  '["reasoning"]',    15, 1)
ON DUPLICATE KEY UPDATE rule_name=rule_name;
