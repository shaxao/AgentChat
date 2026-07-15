package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 用户安装的技能记录
 * <p>
 * 记录用户从技能商店安装到「我的技能」的技能关联。
 * 安装后可在 WelcomeScreen / Sidebar / SkillChips 直接使用。
 */
@Data
@TableName("user_installed_skills")
public class UserInstalledSkill {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 用户 ID */
    private Long userId;

    /** 技能 agentId（关联 agent_registry.agent_id） */
    private String agentId;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime installedAt;
}
