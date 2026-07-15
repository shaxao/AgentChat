-- External OpenAI-compatible API keys.
-- Users can have one active key. Regeneration revokes the previous active key.

CREATE TABLE IF NOT EXISTS user_api_key (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid          VARCHAR(64)  NOT NULL,
    user_id       BIGINT       NOT NULL,
    name          VARCHAR(100) NOT NULL DEFAULT 'Default API Key',
    key_prefix    VARCHAR(32)  NOT NULL,
    key_hash      VARCHAR(128) NOT NULL,
    key_enc       TEXT         NOT NULL,
    status        VARCHAR(20)  NOT NULL DEFAULT 'active',
    expires_at    DATETIME     NULL,
    last_used_at  DATETIME     NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted       TINYINT      NOT NULL DEFAULT 0,
    UNIQUE KEY uk_user_api_key_uuid (uuid),
    UNIQUE KEY uk_user_api_key_hash (key_hash),
    INDEX idx_user_api_key_user_status (user_id, status, deleted),
    INDEX idx_user_api_key_prefix (key_prefix)
);
