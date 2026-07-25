ALTER TABLE model_channel
    ADD COLUMN status_message VARCHAR(1000) DEFAULT NULL COMMENT '最近一次连接测试结果或异常原因';
