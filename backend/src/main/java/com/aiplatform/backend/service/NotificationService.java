package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.NotificationDTO;
import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.Notification;
import com.aiplatform.backend.entity.SysUser;
import com.aiplatform.backend.entity.UserNotification;
import com.aiplatform.backend.entity.UserPrivacySetting;
import com.aiplatform.backend.mapper.NotificationMapper;
import com.aiplatform.backend.mapper.SysUserMapper;
import com.aiplatform.backend.mapper.UserNotificationMapper;
import com.aiplatform.backend.mapper.UserPrivacySettingMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 通知系统核心服务
 * <p>
 * 功能：
 * 1. 管理端：通知 CRUD、发布/撤回
 * 2. 用户端：查询通知列表、标记已读、未读计数
 * 3. 内部调用：发送技能审核结果通知
 * 4. 隐私设置：查询/更新
 * <p>
 * 懒投递机制：target_type=all 的通知在用户首次查询时自动创建 user_notification 记录，
 * 避免大量用户时批量插入的性能问题。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class NotificationService {

    private final NotificationMapper notificationMapper;
    private final UserNotificationMapper userNotificationMapper;
    private final UserPrivacySettingMapper privacySettingMapper;
    private final SysUserMapper sysUserMapper;

    // =============================================
    // 管理端：通知 CRUD
    // =============================================

    /**
     * 分页查询通知列表（管理端）
     */
    public Result.PageResult<NotificationDTO.NotificationAdminVO> adminList(int page, int size, String type, String status) {
        QueryWrapper<Notification> qw = new QueryWrapper<>();
        qw.eq("deleted", 0).orderByDesc("created_at");
        if (type != null && !type.isBlank()) qw.eq("type", type);
        if (status != null && !status.isBlank()) qw.eq("status", status);

        Page<Notification> result = notificationMapper.selectPage(new Page<>(page, size), qw);
        List<NotificationDTO.NotificationAdminVO> voList = result.getRecords().stream()
                .map(this::toAdminVO)
                .collect(Collectors.toList());

        return new Result.PageResult<>(voList, result.getTotal(), page, size);
    }

    /**
     * 创建通知
     */
    @Transactional
    public NotificationDTO.NotificationAdminVO create(NotificationDTO.CreateRequest req, Long createdBy) {
        Notification n = new Notification();
        n.setUuid(UUID.randomUUID().toString());
        n.setTitle(req.getTitle());
        n.setContent(req.getContent());
        n.setType(req.getType() != null ? req.getType() : "announcement");
        n.setTargetType(req.getTargetType() != null ? req.getTargetType() : "all");
        if (req.getTargetUserIds() != null && !req.getTargetUserIds().isEmpty()) {
            n.setTargetUserIds(req.getTargetUserIds().stream()
                    .map(String::valueOf).collect(Collectors.joining(",")));
        }
        n.setExtraData(req.getExtraData());
        n.setCreatedBy(createdBy);
        n.setStatus("published");

        notificationMapper.insert(n);
        log.info("[Notification] 创建通知: id={}, title={}, type={}, target={}",
                n.getId(), n.getTitle(), n.getType(), n.getTargetType());

        // 对于 specific 目标，立即创建 user_notification 记录
        if ("specific".equals(n.getTargetType()) && req.getTargetUserIds() != null) {
            for (Long userId : req.getTargetUserIds()) {
                createUserNotificationIfNotExists(userId, n.getId());
            }
        }

        return toAdminVO(n);
    }

    /**
     * 更新通知
     */
    @Transactional
    public NotificationDTO.NotificationAdminVO update(Long id, NotificationDTO.UpdateRequest req) {
        Notification n = notificationMapper.selectById(id);
        if (n == null || n.getDeleted() == 1) {
            throw new RuntimeException("通知不存在");
        }

        if (req.getTitle() != null) n.setTitle(req.getTitle());
        if (req.getContent() != null) n.setContent(req.getContent());
        if (req.getType() != null) n.setType(req.getType());
        if (req.getTargetType() != null) n.setTargetType(req.getTargetType());
        if (req.getTargetUserIds() != null) {
            n.setTargetUserIds(req.getTargetUserIds().stream()
                    .map(String::valueOf).collect(Collectors.joining(",")));
        }
        if (req.getExtraData() != null) n.setExtraData(req.getExtraData());
        if (req.getStatus() != null) n.setStatus(req.getStatus());

        notificationMapper.updateById(n);
        log.info("[Notification] 更新通知: id={}", id);
        return toAdminVO(n);
    }

    /**
     * 删除通知（逻辑删除）
     */
    @Transactional
    public void delete(Long id) {
        UpdateWrapper<Notification> uw = new UpdateWrapper<>();
        uw.eq("id", id).set("deleted", 1);
        notificationMapper.update(null, uw);
        log.info("[Notification] 删除通知: id={}", id);
    }

    // =============================================
    // 用户端：查询通知
    // =============================================

    /**
     * 获取用户通知列表（懒投递：首次查询时自动补充未投递的广播通知）
     */
    @Transactional
    public List<NotificationDTO.UserNotificationVO> getUserNotifications(Long userId, int limit) {
        // 1. 懒投递：查找用户尚未收到的 published 广播通知
        ensureBroadcastDelivered(userId);

        // 2. 查询用户的通知列表
        QueryWrapper<UserNotification> unw = new QueryWrapper<>();
        unw.eq("user_id", userId).orderByDesc("created_at").last("LIMIT " + limit);
        List<UserNotification> userNotifs = userNotificationMapper.selectList(unw);

        if (userNotifs.isEmpty()) return Collections.emptyList();

        // 3. 批量查询通知详情
        List<Long> notifIds = userNotifs.stream()
                .map(UserNotification::getNotificationId).collect(Collectors.toList());
        QueryWrapper<Notification> nw = new QueryWrapper<>();
        nw.in("id", notifIds).eq("deleted", 0).eq("status", "published");
        List<Notification> notifs = notificationMapper.selectList(nw);
        Map<Long, Notification> notifMap = notifs.stream()
                .collect(Collectors.toMap(Notification::getId, n -> n));

        // 4. 组装 VO
        return userNotifs.stream()
                .filter(un -> notifMap.containsKey(un.getNotificationId()))
                .map(un -> toUserVO(un, notifMap.get(un.getNotificationId())))
                .collect(Collectors.toList());
    }

    /**
     * 获取未读通知数
     */
    @Transactional
    public NotificationDTO.UserNotificationPageVO getUserNotificationsPaged(Long userId, int page, int size, Boolean read) {
        ensureBroadcastDelivered(userId);

        int safePage = Math.max(1, page);
        int safeSize = Math.max(1, Math.min(size, 50));

        QueryWrapper<UserNotification> countWrapper = new QueryWrapper<>();
        countWrapper.eq("user_id", userId);
        if (read != null) countWrapper.eq("is_read", read ? 1 : 0);
        long total = userNotificationMapper.selectCount(countWrapper);

        QueryWrapper<UserNotification> unw = new QueryWrapper<>();
        unw.eq("user_id", userId);
        if (read != null) unw.eq("is_read", read ? 1 : 0);
        unw.orderByDesc("created_at").last("LIMIT " + ((safePage - 1) * safeSize) + "," + safeSize);
        List<UserNotification> userNotifs = userNotificationMapper.selectList(unw);

        List<NotificationDTO.UserNotificationVO> list = Collections.emptyList();
        if (!userNotifs.isEmpty()) {
            List<Long> notifIds = userNotifs.stream()
                    .map(UserNotification::getNotificationId).collect(Collectors.toList());
            QueryWrapper<Notification> nw = new QueryWrapper<>();
            nw.in("id", notifIds).eq("deleted", 0).eq("status", "published");
            List<Notification> notifs = notificationMapper.selectList(nw);
            Map<Long, Notification> notifMap = notifs.stream()
                    .collect(Collectors.toMap(Notification::getId, n -> n));

            list = userNotifs.stream()
                    .filter(un -> notifMap.containsKey(un.getNotificationId()))
                    .map(un -> toUserVO(un, notifMap.get(un.getNotificationId())))
                    .sorted((a, b) -> {
                        if (a.getCreatedAt() == null && b.getCreatedAt() == null) return 0;
                        if (a.getCreatedAt() == null) return 1;
                        if (b.getCreatedAt() == null) return -1;
                        return b.getCreatedAt().compareTo(a.getCreatedAt());
                    })
                    .collect(Collectors.toList());
        }

        NotificationDTO.UserNotificationPageVO vo = new NotificationDTO.UserNotificationPageVO();
        vo.setList(list);
        vo.setTotal(total);
        vo.setPage(safePage);
        vo.setSize(safeSize);
        vo.setHasMore((long) safePage * safeSize < total);
        return vo;
    }

    @Transactional
    public int getUnreadCount(Long userId) {
        ensureBroadcastDelivered(userId);
        QueryWrapper<UserNotification> qw = new QueryWrapper<>();
        qw.eq("user_id", userId).eq("is_read", 0);
        return Math.toIntExact(userNotificationMapper.selectCount(qw));
    }

    /**
     * 标记单条通知为已读
     */
    @Transactional
    public void markAsRead(Long userId, Long notificationId) {
        UpdateWrapper<UserNotification> uw = new UpdateWrapper<>();
        uw.eq("user_id", userId)
                .and(w -> w.eq("id", notificationId).or().eq("notification_id", notificationId))
                .set("is_read", 1).set("read_at", LocalDateTime.now());
        userNotificationMapper.update(null, uw);
    }

    /**
     * 标记所有通知为已读
     */
    @Transactional
    public void markAllAsRead(Long userId) {
        UpdateWrapper<UserNotification> uw = new UpdateWrapper<>();
        uw.eq("user_id", userId).eq("is_read", 0)
                .set("is_read", 1).set("read_at", LocalDateTime.now());
        userNotificationMapper.update(null, uw);
    }

    // =============================================
    // 内部调用：发送通知
    // =============================================

    /**
     * 发送技能审核结果通知（内部调用）
     *
     * @param userId    目标用户ID
     * @param skillName 技能名称
     * @param approved  是否通过
     * @param reason    审核原因（拒绝时使用）
     */
    @Transactional
    public void sendSkillReviewNotification(Long userId, String skillName, boolean approved, String reason) {
        Notification n = new Notification();
        n.setUuid(UUID.randomUUID().toString());
        n.setTitle(approved ? "技能审核通过" : "技能审核未通过");
        n.setContent(approved
                ? String.format("您提交的技能「%s」已审核通过，现已上架到技能商店。", skillName)
                : String.format("您提交的技能「%s」审核未通过。原因：%s", skillName, reason != null ? reason : "未提供"));
        n.setType("skill_review");
        n.setTargetType("specific");
        n.setTargetUserIds(String.valueOf(userId));
        n.setExtraData(String.format("{\"skillName\":\"%s\",\"approved\":%b,\"reason\":\"%s\"}",
                skillName != null ? skillName : "", approved, reason != null ? reason : ""));
        n.setCreatedBy(0L); // 系统创建
        n.setStatus("published");

        notificationMapper.insert(n);
        createUserNotificationIfNotExists(userId, n.getId());
        log.info("[Notification] 发送技能审核通知: userId={}, skill={}, approved={}", userId, skillName, approved);
    }

    /**
     * 发送系统通知给指定用户（内部调用）
     */
    @Transactional
    public void sendSystemNotification(Long userId, String title, String content) {
        Notification n = new Notification();
        n.setUuid(UUID.randomUUID().toString());
        n.setTitle(title);
        n.setContent(content);
        n.setType("system");
        n.setTargetType("specific");
        n.setTargetUserIds(String.valueOf(userId));
        n.setCreatedBy(0L);
        n.setStatus("published");

        notificationMapper.insert(n);
        createUserNotificationIfNotExists(userId, n.getId());
        log.info("[Notification] 发送系统通知: userId={}, title={}", userId, title);
    }

    // =============================================
    // 隐私设置
    // =============================================

    /**
     * 获取用户隐私设置
     */
    public NotificationDTO.PrivacySettingVO getPrivacySettings(Long userId) {
        UserPrivacySetting setting = privacySettingMapper.selectOne(
                new QueryWrapper<UserPrivacySetting>().eq("user_id", userId));

        NotificationDTO.PrivacySettingVO vo = new NotificationDTO.PrivacySettingVO();
        if (setting != null) {
            vo.setSaveHistory(setting.getSaveHistory() == 1);
            vo.setDataImprovement(setting.getDataImprovement() == 1);
            vo.setTwoFactorAuth(setting.getTwoFactorAuth() == 1);
        } else {
            // 默认值
            vo.setSaveHistory(true);
            vo.setDataImprovement(false);
            vo.setTwoFactorAuth(false);
        }
        return vo;
    }

    /**
     * 更新用户隐私设置
     */
    @Transactional
    public NotificationDTO.PrivacySettingVO updatePrivacySettings(Long userId, NotificationDTO.UpdatePrivacyRequest req) {
        UserPrivacySetting setting = privacySettingMapper.selectOne(
                new QueryWrapper<UserPrivacySetting>().eq("user_id", userId));

        if (setting == null) {
            setting = new UserPrivacySetting();
            setting.setUserId(userId);
            setting.setSaveHistory(req.getSaveHistory() != null ? (req.getSaveHistory() ? 1 : 0) : 1);
            setting.setDataImprovement(req.getDataImprovement() != null && req.getDataImprovement() ? 1 : 0);
            setting.setTwoFactorAuth(req.getTwoFactorAuth() != null && req.getTwoFactorAuth() ? 1 : 0);
            privacySettingMapper.insert(setting);
        } else {
            if (req.getSaveHistory() != null) setting.setSaveHistory(req.getSaveHistory() ? 1 : 0);
            if (req.getDataImprovement() != null) setting.setDataImprovement(req.getDataImprovement() ? 1 : 0);
            if (req.getTwoFactorAuth() != null) setting.setTwoFactorAuth(req.getTwoFactorAuth() ? 1 : 0);
            privacySettingMapper.updateById(setting);
        }

        return getPrivacySettings(userId);
    }

    // =============================================
    // 私有方法
    // =============================================

    /**
     * 懒投递：查找用户尚未收到的 published 广播通知，创建 user_notification 记录
     */
    private void ensureBroadcastDelivered(Long userId) {
        // 查找所有 target_type=all, status=published 的通知
        QueryWrapper<Notification> bw = new QueryWrapper<>();
        bw.eq("target_type", "all").eq("status", "published").eq("deleted", 0);
        List<Notification> broadcasts = notificationMapper.selectList(bw);

        if (broadcasts.isEmpty()) return;

        // 查找用户已有的通知记录
        QueryWrapper<UserNotification> uw = new QueryWrapper<>();
        uw.eq("user_id", userId).select("notification_id");
        Set<Long> existingIds = userNotificationMapper.selectList(uw).stream()
                .map(UserNotification::getNotificationId).collect(Collectors.toSet());

        // 也需要检查 specific 类型中包含该用户的
        QueryWrapper<Notification> sw = new QueryWrapper<>();
        sw.eq("target_type", "specific").eq("status", "published").eq("deleted", 0);
        List<Notification> specificNotifs = notificationMapper.selectList(sw);
        for (Notification sn : specificNotifs) {
            if (sn.getTargetUserIds() != null && sn.getTargetUserIds().contains(String.valueOf(userId))) {
                if (!existingIds.contains(sn.getId())) {
                    broadcasts.add(sn);
                }
            }
        }

        // 创建缺失的 user_notification 记录
        for (Notification n : broadcasts) {
            if (!existingIds.contains(n.getId())) {
                createUserNotificationIfNotExists(userId, n.getId());
            }
        }
    }

    /**
     * 创建用户通知记录（幂等：如果已存在则跳过）
     */
    private void createUserNotificationIfNotExists(Long userId, Long notificationId) {
        QueryWrapper<UserNotification> qw = new QueryWrapper<>();
        qw.eq("user_id", userId).eq("notification_id", notificationId);
        if (userNotificationMapper.selectCount(qw) > 0) return;

        UserNotification un = new UserNotification();
        un.setUserId(userId);
        un.setNotificationId(notificationId);
        un.setIsRead(0);
        try {
            userNotificationMapper.insert(un);
        } catch (Exception e) {
            // 并发插入时唯一键冲突，忽略
            log.debug("[Notification] 用户通知记录已存在: userId={}, notificationId={}", userId, notificationId);
        }
    }

    /**
     * 转换为管理端 VO
     */
    private NotificationDTO.NotificationAdminVO toAdminVO(Notification n) {
        NotificationDTO.NotificationAdminVO vo = new NotificationDTO.NotificationAdminVO();
        vo.setId(n.getId());
        vo.setUuid(n.getUuid());
        vo.setTitle(n.getTitle());
        vo.setContent(n.getContent());
        vo.setType(n.getType());
        vo.setTargetType(n.getTargetType());
        if (n.getTargetUserIds() != null && !n.getTargetUserIds().isBlank()) {
            vo.setTargetUserIds(Arrays.stream(n.getTargetUserIds().split(","))
                    .map(s -> Long.parseLong(s.trim())).collect(Collectors.toList()));
        }
        vo.setExtraData(n.getExtraData());
        vo.setCreatedBy(n.getCreatedBy());
        vo.setStatus(n.getStatus());
        vo.setCreatedAt(n.getCreatedAt());
        vo.setUpdatedAt(n.getUpdatedAt());

        // 查询创建者名称
        if (n.getCreatedBy() != null && n.getCreatedBy() > 0) {
            SysUser creator = sysUserMapper.selectById(n.getCreatedBy());
            if (creator != null) {
                vo.setCreatedByName(creator.getUsername());
            }
        } else {
            vo.setCreatedByName("系统");
        }

        // 统计投递数和已读数
        QueryWrapper<UserNotification> countWrapper = new QueryWrapper<>();
        countWrapper.eq("notification_id", n.getId());
        long total = userNotificationMapper.selectCount(countWrapper);
        vo.setTotalRecipients((int) total);

        QueryWrapper<UserNotification> readWrapper = new QueryWrapper<>();
        readWrapper.eq("notification_id", n.getId()).eq("is_read", 1);
        long readCount = userNotificationMapper.selectCount(readWrapper);
        vo.setTotalRead((int) readCount);

        return vo;
    }

    /**
     * 转换为用户端 VO
     */
    private NotificationDTO.UserNotificationVO toUserVO(UserNotification un, Notification n) {
        NotificationDTO.UserNotificationVO vo = new NotificationDTO.UserNotificationVO();
        vo.setId(un.getId());
        vo.setNotificationId(n.getId());
        vo.setTitle(n.getTitle());
        vo.setContent(n.getContent());
        vo.setType(n.getType());
        vo.setExtraData(n.getExtraData());
        vo.setIsRead(un.getIsRead() == 1);
        vo.setReadAt(un.getReadAt());
        vo.setCreatedAt(n.getCreatedAt());
        return vo;
    }
}
