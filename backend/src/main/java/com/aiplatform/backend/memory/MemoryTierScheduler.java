package com.aiplatform.backend.memory;

import com.aiplatform.backend.mapper.MemoryDocumentMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 记忆分层定时任务（轻量级，复用现有 ThreadPoolTaskScheduler，poolSize=5）。
 *
 *  - 每日低峰执行归档任务（L2/L3 → L4，30/60 天规则）
 *  - 每日执行 L1 压缩审计（超预算降级低频项到 L2）
 *
 * 见 docs/memory_layered_architecture.md §5
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class MemoryTierScheduler {

    private final MemoryTierService tierService;
    private final MemoryDocumentMapper documentMapper;

    /** 每天 03:17 执行（避开整点高峰）。cron = 秒 分 时 日 月 周 */
    @Scheduled(cron = "0 17 3 * * ?")
    public void nightlyTierMaintenance() {
        log.info("[TierScheduler] 开始每日记忆分层维护");
        try {
            int archived = tierService.archiveJob();
            log.info("[TierScheduler] 归档处理文档数={}", archived);
        } catch (Exception e) {
            log.warn("[TierScheduler] 归档任务异常: {}", e.getMessage());
        }

        try {
            List<Long> userIds = documentMapper.selectObjs(
                    new QueryWrapper<com.aiplatform.backend.entity.MemoryDocument>()
                            .select("DISTINCT user_id").eq("deleted", 0)
            ).stream().map(o -> ((Number) o).longValue()).toList();
            int totalDemoted = 0;
            for (Long uid : userIds) {
                totalDemoted += tierService.compressionAudit(uid);
            }
            log.info("[TierScheduler] 压缩审计降级总数={}, 涉及用户数={}", totalDemoted, userIds.size());
        } catch (Exception e) {
            log.warn("[TierScheduler] 压缩审计异常: {}", e.getMessage());
        }
        log.info("[TierScheduler] 记忆分层维护完成");
    }
}
