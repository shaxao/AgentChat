-- 模型别名，逗号分隔。供入站网关（/v1/messages、/v1/responses、/v1/chat/completions）
-- 将外部工具发来的模型名（如 claude-3-5-sonnet-20241022）映射到平台已配置的 model_id。
ALTER TABLE model_config
    ADD COLUMN aliases VARCHAR(500) DEFAULT NULL
    COMMENT '模型别名，逗号分隔，供外部 API 模型名映射';
