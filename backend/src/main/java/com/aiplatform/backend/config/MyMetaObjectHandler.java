package com.aiplatform.backend.config;

import com.baomidou.mybatisplus.core.handlers.MetaObjectHandler;
import org.apache.ibatis.reflection.MetaObject;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;

@Component
public class MyMetaObjectHandler implements MetaObjectHandler {
    @Override
    public void insertFill(MetaObject metaObject) {
        this.strictInsertFill(metaObject, "createdAt", LocalDateTime.class, LocalDateTime.now());
        this.strictInsertFill(metaObject, "updatedAt", LocalDateTime.class, LocalDateTime.now());
        // 🔴 修复（第35轮）：自动填充 deleted=0
        // @TableLogic 注解会在所有查询中追加 WHERE deleted=0，
        // 如果插入时 deleted 为 NULL，记录将永远无法被查询到
        if (metaObject.hasSetter("deleted") && metaObject.getValue("deleted") == null) {
            this.strictInsertFill(metaObject, "deleted", Integer.class, 0);
        }
    }

    @Override
    public void updateFill(MetaObject metaObject) {
        this.strictUpdateFill(metaObject, "updatedAt", LocalDateTime.class, LocalDateTime.now());
    }
}
