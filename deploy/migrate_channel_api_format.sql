-- 渠道出站接口格式：chat_completions（默认）/ responses / messages
-- 用于让平台调用上游时选择 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages 格式
ALTER TABLE model_channel
    ADD COLUMN api_format VARCHAR(30) NOT NULL DEFAULT 'chat_completions'
    COMMENT '出站接口格式：chat_completions/responses/messages';
