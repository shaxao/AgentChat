package com.aiplatform.backend.service;

import com.aiplatform.backend.entity.AgentRegistry;
import com.aiplatform.backend.entity.SkillRating;
import com.aiplatform.backend.mapper.AgentRegistryMapper;
import com.aiplatform.backend.mapper.SkillRatingMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;

/**
 * 技能评分服务
 * <p>
 * 用户对已安装/使用过的技能进行 1-5 星评分。
 * 评分后自动重算 agent_registry 的 avg_rating / rating_count 冗余字段。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SkillRatingService {

    private final SkillRatingMapper skillRatingMapper;
    private final AgentRegistryMapper agentRegistryMapper;

    /**
     * 提交/更新评分（同一用户对同一技能只能有一条有效评分）
     */
    @Transactional
    public SkillRating rateSkill(Long agentId, Long userId, int rating, String comment) {
        if (rating < 1 || rating > 5) {
            throw new IllegalArgumentException("评分必须在 1-5 之间");
        }

        // 检查技能是否存在
        AgentRegistry agent = agentRegistryMapper.selectById(agentId);
        if (agent == null || agent.getDeleted() != null && agent.getDeleted() == 1) {
            throw new IllegalArgumentException("技能不存在或已下架");
        }

        // 查找已有评分（逻辑删除的也查出来）
        SkillRating existing = skillRatingMapper.selectOne(
                new QueryWrapper<SkillRating>()
                        .eq("agent_id", agentId)
                        .eq("user_id", userId));

        if (existing != null) {
            // 如果之前被逻辑删除了，恢复它
            existing.setDeleted(0);
            existing.setRating(rating);
            existing.setComment(comment);
            skillRatingMapper.updateById(existing);
            log.info("用户 {} 更新了对技能 {} 的评分: {} 星", userId, agentId, rating);
        } else {
            // 新建评分
            SkillRating sr = new SkillRating();
            sr.setAgentId(agentId);
            sr.setUserId(userId);
            sr.setRating(rating);
            sr.setComment(comment);
            skillRatingMapper.insert(sr);
            log.info("用户 {} 对技能 {} 评分: {} 星", userId, agentId, rating);
        }

        // 重算平均分
        recalculateAvgRating(agentId);

        return existing != null ? existing : skillRatingMapper.selectOne(
                new QueryWrapper<SkillRating>()
                        .eq("agent_id", agentId)
                        .eq("user_id", userId)
                        .eq("deleted", 0));
    }

    /**
     * 删除评分（逻辑删除）
     */
    @Transactional
    public void deleteRating(Long ratingId, Long userId) {
        SkillRating sr = skillRatingMapper.selectById(ratingId);
        if (sr == null || sr.getDeleted() != null && sr.getDeleted() == 1) {
            throw new IllegalArgumentException("评分不存在");
        }

        // 检查权限：只有评分人自己可以删除
        if (!sr.getUserId().equals(userId)) {
            throw new IllegalArgumentException("只能删除自己的评分");
        }

        skillRatingMapper.deleteById(ratingId);

        // 重算平均分
        recalculateAvgRating(sr.getAgentId());
        log.info("用户 {} 删除了对技能 {} 的评分", userId, sr.getAgentId());
    }

    /**
     * 获取指定技能的评分列表（分页）
     */
    public List<SkillRating> getRatings(Long agentId, int page, int size) {
        Page<SkillRating> p = new Page<>(page, size);
        QueryWrapper<SkillRating> qw = new QueryWrapper<SkillRating>()
                .eq("agent_id", agentId)
                .eq("deleted", 0)
                .orderByDesc("created_at");
        return skillRatingMapper.selectPage(p, qw).getRecords();
    }

    /**
     * 获取评分总数
     */
    public long getRatingCount(Long agentId) {
        return skillRatingMapper.selectCount(
                new QueryWrapper<SkillRating>()
                        .eq("agent_id", agentId)
                        .eq("deleted", 0));
    }

    /**
     * 获取用户对指定技能的评分（未评分返回 null）
     */
    public SkillRating getUserRating(Long agentId, Long userId) {
        return skillRatingMapper.selectOne(
                new QueryWrapper<SkillRating>()
                        .eq("agent_id", agentId)
                        .eq("user_id", userId)
                        .eq("deleted", 0));
    }

    /**
     * 重算并更新 agent_registry 的 avg_rating / rating_count
     */
    private void recalculateAvgRating(Long agentId) {
        List<SkillRating> ratings = skillRatingMapper.selectList(
                new QueryWrapper<SkillRating>()
                        .eq("agent_id", agentId)
                        .eq("deleted", 0)
                        .select("rating"));

        int count = ratings.size();
        BigDecimal avg = BigDecimal.ZERO;
        if (count > 0) {
            int sum = ratings.stream().mapToInt(SkillRating::getRating).sum();
            avg = new BigDecimal(sum).divide(new BigDecimal(count), 2, RoundingMode.HALF_UP);
        }

        AgentRegistry agent = agentRegistryMapper.selectById(agentId);
        if (agent != null) {
            agent.setAvgRating(avg);
            agent.setRatingCount(count);
            agentRegistryMapper.updateById(agent);
        }
    }
}
