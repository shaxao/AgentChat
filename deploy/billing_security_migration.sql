-- Billing and payment safety migration.
-- Adds money-based subscription quota fields and cached input model pricing.

ALTER TABLE model_config
    ADD COLUMN IF NOT EXISTS cached_input_price DECIMAL(10,4) NOT NULL DEFAULT 0 AFTER input_price;

ALTER TABLE api_log
    ADD COLUMN IF NOT EXISTS cached_input_tokens INT DEFAULT 0 AFTER input_tokens,
    MODIFY COLUMN cost DECIMAL(12,8) DEFAULT 0;

ALTER TABLE subscription_plan
    ADD COLUMN IF NOT EXISTS cost_limit DECIMAL(12,4) NOT NULL DEFAULT 0 AFTER price;

ALTER TABLE subscription
    ADD COLUMN IF NOT EXISTS cost_limit DECIMAL(12,4) NOT NULL DEFAULT 0 AFTER price,
    ADD COLUMN IF NOT EXISTS cost_used DECIMAL(12,4) NOT NULL DEFAULT 0 AFTER cost_limit;

ALTER TABLE sys_user
    ADD COLUMN IF NOT EXISTS cost_used DECIMAL(12,4) NOT NULL DEFAULT 0 AFTER tokens_limit,
    ADD COLUMN IF NOT EXISTS cost_limit DECIMAL(12,4) NOT NULL DEFAULT 0 AFTER cost_used;

UPDATE model_config
SET cached_input_price = input_price
WHERE cached_input_price IS NULL OR cached_input_price = 0;

UPDATE subscription_plan
SET cost_limit = price
WHERE cost_limit IS NULL OR cost_limit = 0;

UPDATE subscription
SET cost_limit = price
WHERE cost_limit IS NULL OR cost_limit = 0;

UPDATE sys_user
SET cost_used = COALESCE(total_consumed, 0)
WHERE cost_used IS NULL OR cost_used = 0;
