package com.aiplatform.backend.service;

import com.aiplatform.backend.entity.UserPrivacySetting;
import com.aiplatform.backend.mapper.UserPrivacySettingMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class PrivacySettingService {

    private final UserPrivacySettingMapper privacySettingMapper;

    public boolean isSaveHistoryEnabled(Long userId) {
        UserPrivacySetting setting = findSetting(userId);
        return setting == null || setting.getSaveHistory() == null || setting.getSaveHistory() == 1;
    }

    public boolean isDataImprovementEnabled(Long userId) {
        UserPrivacySetting setting = findSetting(userId);
        return setting != null && setting.getDataImprovement() != null && setting.getDataImprovement() == 1;
    }

    public boolean isTwoFactorAuthEnabled(Long userId) {
        UserPrivacySetting setting = findSetting(userId);
        return setting != null && setting.getTwoFactorAuth() != null && setting.getTwoFactorAuth() == 1;
    }

    private UserPrivacySetting findSetting(Long userId) {
        if (userId == null) return null;
        return privacySettingMapper.selectOne(
                new QueryWrapper<UserPrivacySetting>().eq("user_id", userId));
    }
}
