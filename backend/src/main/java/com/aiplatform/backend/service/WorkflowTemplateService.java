package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.WorkflowDTO;
import com.aiplatform.backend.entity.Workflow;
import com.aiplatform.backend.entity.WorkflowTemplate;
import com.aiplatform.backend.mapper.WorkflowMapper;
import com.aiplatform.backend.mapper.WorkflowTemplateMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import jakarta.annotation.PostConstruct;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 工作流模板市场服务（战略改造 v3.0 P3-2）
 * <p>
 * 官方出 20+ 模板覆盖主要场景，用户可将工作流发布为模板。
 * 模板支持参数化（params_schema），克隆时用户填入参数即可用。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WorkflowTemplateService {

    private final WorkflowTemplateMapper templateMapper;
    private final WorkflowMapper workflowMapper;
    private final ObjectMapper objectMapper;

    private static final DateTimeFormatter FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    // =============================================
    // 种子数据 — 20+ 官方模板
    // =============================================

    /**
     * 应用启动时自动植入官方模板种子数据（幂等，已存在则跳过）
     */
    @PostConstruct
    @Transactional
    public void seedOfficialTemplates() {
        long count = templateMapper.selectCount(
                new QueryWrapper<WorkflowTemplate>().eq("is_official", 1));
        if (count > 0) {
            log.info("[TemplateMarket] 官方模板已存在 ({} 个)，跳过种子数据", count);
            return;
        }

        log.info("[TemplateMarket] 开始植入官方模板种子数据...");
        List<SeedTemplate> seeds = buildSeedTemplates();
        int inserted = 0;
        for (SeedTemplate seed : seeds) {
            try {
                WorkflowTemplate t = new WorkflowTemplate();
                t.setUuid(UUID.randomUUID().toString());
                t.setName(seed.name);
                t.setDescription(seed.description);
                t.setCategory(seed.category);
                t.setIcon(seed.icon);
                t.setDsl(seed.dsl);
                t.setParamsSchema(seed.paramsSchema);
                t.setIsOfficial(1);
                t.setAuthorId(0L);
                t.setAuthorName("官方");
                t.setUseCount(seed.initialUse);
                t.setRating(BigDecimal.valueOf(seed.initialRating));
                t.setRatingCount(seed.initialVotes);
                t.setIsPublished(1);
                t.setIsCertified(1);
                templateMapper.insert(t);
                inserted++;
            } catch (Exception e) {
                log.warn("[TemplateMarket] 种子模板插入失败: {} — {}", seed.name, e.getMessage());
            }
        }
        log.info("[TemplateMarket] 官方模板种子数据植入完成: {}/{}", inserted, seeds.size());
    }

    private List<SeedTemplate> buildSeedTemplates() {
        List<SeedTemplate> seeds = new ArrayList<>();

        // 1. 每日早报推送
        seeds.add(new SeedTemplate(
                "📊", "每日AI早报推送", "每日定时抓取AI行业新闻，生成摘要并通过Webhook推送到企业微信/钉钉",
                "schedule",
                "{\"trigger\":{\"type\":\"cron\",\"value\":\"0 9 * * *\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"web_search\",\"description\":\"搜索AI行业最新新闻\",\"args\":{\"query\":\"人工智能 最新动态\",\"count\":10}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"AI总结新闻摘要\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"请将以下新闻总结为3-5条要点，每条不超过100字：\\n{{step1.output}}\"}},{\"id\":\"step3\",\"tool\":\"webhook\",\"description\":\"发送到企业微信/钉钉\",\"condition\":\"step2.success\",\"args\":{\"url\":\"{{webhook_url}}\",\"content\":\"{{step2.output}}\"}}]}",
                "[{\"key\":\"webhook_url\",\"label\":\"Webhook地址\",\"type\":\"string\",\"required\":true,\"placeholder\":\"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx\"}]",
                156, 4.7, 89
        ));

        // 2. 数据日报生成
        seeds.add(new SeedTemplate(
                "📈", "数据日报自动生成", "接入数据库或API，自动生成每日数据报表并发送邮件",
                "report",
                "{\"trigger\":{\"type\":\"cron\",\"value\":\"0 18 * * *\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"sql_query\",\"description\":\"查询昨日关键指标\",\"args\":{\"sql\":\"{{sql_query}}\"}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"AI生成数据分析报告\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"根据以下数据生成一份数据日报，包含关键指标、趋势分析和建议：\\n{{step1.output}}\"}},{\"id\":\"step3\",\"tool\":\"send_email\",\"description\":\"发送邮件报告\",\"condition\":\"step2.success\",\"args\":{\"to\":\"{{email_to}}\",\"subject\":\"每日数据报告\",\"body\":\"{{step2.output}}\"}}]}",
                "[{\"key\":\"sql_query\",\"label\":\"SQL查询语句\",\"type\":\"text\",\"required\":true},{\"key\":\"email_to\",\"label\":\"收件邮箱\",\"type\":\"string\",\"required\":true}]",
                98, 4.5, 45
        ));

        // 3. 代码审查助手
        seeds.add(new SeedTemplate(
                "🔍", "代码审查助手", "监听 Git 仓库提交，自动进行 AI 代码审查并评论",
                "automation",
                "{\"trigger\":{\"type\":\"webhook\",\"value\":\"/git-webhook\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"git_diff\",\"description\":\"获取最新提交的代码变更\",\"args\":{\"repo\":\"{{repo_url}}\",\"branch\":\"{{branch}}\"}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"AI审查代码质量\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"请审查以下代码变更，检查潜在bug、安全隐患和代码风格问题：\\n{{step1.output}}\"}},{\"id\":\"step3\",\"tool\":\"git_comment\",\"description\":\"提交审查评论\",\"condition\":\"step2.success\",\"args\":{\"repo\":\"{{repo_url}}\",\"content\":\"{{step2.output}}\"}}]}",
                "[{\"key\":\"repo_url\",\"label\":\"Git仓库地址\",\"type\":\"string\",\"required\":true},{\"key\":\"branch\",\"label\":\"分支名\",\"type\":\"string\",\"required\":true,\"default\":\"main\"}]",
                89, 4.8, 67
        ));

        // 4. 社交媒体内容发布
        seeds.add(new SeedTemplate(
                "📱", "社交媒体内容发布", "定时生成并发布社交媒体内容到多个平台",
                "schedule",
                "{\"trigger\":{\"type\":\"cron\",\"value\":\"0 10 * * 1,3,5\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"ai_chat\",\"description\":\"AI生成社交媒体内容\",\"args\":{\"prompt\":\"请为{{platform}}生成一篇关于{{topic}}的社交媒体帖子，风格{{style}}，字数200以内\"}},{\"id\":\"step2\",\"tool\":\"social_post\",\"description\":\"发布到社交平台\",\"condition\":\"step1.success\",\"args\":{\"platform\":\"{{platform}}\",\"content\":\"{{step1.output}}\",\"api_key\":\"{{api_key}}\"}}]}",
                "[{\"key\":\"platform\",\"label\":\"目标平台\",\"type\":\"select\",\"required\":true,\"options\":[\"微博\",\"知乎\",\"小红书\",\"Twitter\"]},{\"key\":\"topic\",\"label\":\"内容主题\",\"type\":\"string\",\"required\":true},{\"key\":\"style\",\"label\":\"内容风格\",\"type\":\"select\",\"options\":[\"专业\",\"活泼\",\"故事化\"],\"default\":\"专业\"},{\"key\":\"api_key\",\"label\":\"平台API密钥\",\"type\":\"password\",\"required\":true}]",
                76, 4.3, 34
        ));

        // 5. 客户支持工单分类
        seeds.add(new SeedTemplate(
                "🎫", "客户支持工单自动分类", "自动读取新工单，AI分类并分配优先级，发送通知",
                "automation",
                "{\"trigger\":{\"type\":\"cron\",\"value\":\"*/15 * * * *\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"ticket_fetch\",\"description\":\"获取未处理工单\",\"args\":{\"source\":\"{{ticket_source}}\",\"status\":\"new\"}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"AI分类工单\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"请将以下工单分类（bug/功能请求/咨询/投诉）并评估优先级（P0-P3）：\\n{{step1.output}}\"}},{\"id\":\"step3\",\"tool\":\"ticket_update\",\"description\":\"更新工单分类\",\"condition\":\"step2.success\",\"args\":{\"classification\":\"{{step2.classification}}\",\"priority\":\"{{step2.priority}}\"}},{\"id\":\"step4\",\"tool\":\"webhook\",\"description\":\"紧急工单通知\",\"condition\":\"step2.priority == 'P0'\",\"args\":{\"url\":\"{{webhook_url}}\",\"content\":\"🚨 新紧急工单: {{step2.summary}}\"}}]}",
                "[{\"key\":\"ticket_source\",\"label\":\"工单来源\",\"type\":\"string\",\"required\":true,\"placeholder\":\"JIRA/Flybook/Zendesk\"},{\"key\":\"webhook_url\",\"label\":\"紧急通知Webhook\",\"type\":\"string\",\"required\":true}]",
                134, 4.6, 78
        ));

        // 6. 竞品价格监控
        seeds.add(new SeedTemplate(
                "💹", "竞品价格监控", "定时爬取竞品价格变化，生成对比报告并告警",
                "data",
                "{\"trigger\":{\"type\":\"cron\",\"value\":\"0 8 * * *\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"web_scrape\",\"description\":\"爬取竞品价格\",\"args\":{\"urls\":[{{competitor_urls}}],\"selector\":\"{{price_selector}}\"}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"AI分析价格变化\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"分析以下竞品价格数据，找出变化>5%的项并生成报告：\\n{{step1.output}}\"}},{\"id\":\"step3\",\"tool\":\"webhook\",\"description\":\"价格异动通知\",\"condition\":\"step2.has_changes\",\"args\":{\"url\":\"{{webhook_url}}\",\"content\":\"{{step2.output}}\"}}]}",
                "[{\"key\":\"competitor_urls\",\"label\":\"竞品URL列表\",\"type\":\"text\",\"required\":true,\"placeholder\":\"https://example.com/product1\\nhttps://example.com/product2\"},{\"key\":\"price_selector\",\"label\":\"价格CSS选择器\",\"type\":\"string\",\"required\":true,\"default\":\".price\"},{\"key\":\"webhook_url\",\"label\":\"通知Webhook\",\"type\":\"string\",\"required\":true}]",
                67, 4.4, 29
        ));

        // 7. SEO 内容优化
        seeds.add(new SeedTemplate(
                "🔎", "SEO文章自动生成", "根据关键词自动生成SEO优化文章，包含元描述和标签",
                "ai",
                "{\"trigger\":{\"type\":\"manual\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"ai_chat\",\"description\":\"生成SEO文章大纲\",\"args\":{\"prompt\":\"为关键词「{{keyword}}」生成一篇SEO文章大纲，包含H1-H3标题结构\"}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"根据大纲生成正文\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"根据以下大纲撰写一篇1500字的SEO文章，融入关键词「{{keyword}}」，密度3-5%：\\n{{step1.output}}\"}},{\"id\":\"step3\",\"tool\":\"ai_chat\",\"description\":\"生成元描述和标签\",\"condition\":\"step2.success\",\"args\":{\"prompt\":\"为以下文章生成meta description（150字内）和5个相关标签：\\n{{step2.output}}\"}}]}",
                "[{\"key\":\"keyword\",\"label\":\"目标关键词\",\"type\":\"string\",\"required\":true,\"placeholder\":\"AI自动化工具\"}]",
                112, 4.5, 56
        ));

        // 8. 数据库备份通知
        seeds.add(new SeedTemplate(
                "💾", "数据库备份与通知", "定时执行数据库备份，验证备份完整性并发送通知",
                "schedule",
                "{\"trigger\":{\"type\":\"cron\",\"value\":\"0 2 * * *\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"db_backup\",\"description\":\"执行数据库备份\",\"args\":{\"host\":\"{{db_host}}\",\"database\":\"{{db_name}}\",\"output\":\"/backups/{{db_name}}_{date}.sql\"}},{\"id\":\"step2\",\"tool\":\"cmd_exec\",\"description\":\"验证备份文件\",\"condition\":\"step1.success\",\"args\":{\"command\":\"ls -lh /backups/{{db_name}}_{date}.sql\"}},{\"id\":\"step3\",\"tool\":\"webhook\",\"description\":\"发送备份完成通知\",\"condition\":\"step2.success\",\"args\":{\"url\":\"{{webhook_url}}\",\"content\":\"✅ 数据库备份完成: {{db_name}} ({{step2.size}})\"}}]}",
                "[{\"key\":\"db_host\",\"label\":\"数据库地址\",\"type\":\"string\",\"required\":true},{\"key\":\"db_name\",\"label\":\"数据库名\",\"type\":\"string\",\"required\":true},{\"key\":\"webhook_url\",\"label\":\"通知Webhook\",\"type\":\"string\",\"required\":true}]",
                89, 4.6, 41
        ));

        // 9. 周报自动生成
        seeds.add(new SeedTemplate(
                "📋", "团队周报自动生成", "收集团队成员工作记录，AI汇总生成周报",
                "report",
                "{\"trigger\":{\"type\":\"cron\",\"value\":\"0 17 * * 5\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"sheet_fetch\",\"description\":\"读取团队工作记录表\",\"args\":{\"sheet_url\":\"{{sheet_url}}\",\"range\":\"本周\"}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"AI生成周报\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"根据以下团队工作记录生成一份周报，包含：本周成果、关键数据、下周计划、风险项：\\n{{step1.output}}\"}},{\"id\":\"step3\",\"tool\":\"send_email\",\"description\":\"发送周报邮件\",\"condition\":\"step2.success\",\"args\":{\"to\":\"{{email_to}}\",\"subject\":\"团队周报 {{date}}\",\"body\":\"{{step2.output}}\"}}]}",
                "[{\"key\":\"sheet_url\",\"label\":\"工作记录表链接\",\"type\":\"string\",\"required\":true},{\"key\":\"email_to\",\"label\":\"收件邮箱（多人逗号分隔）\",\"type\":\"string\",\"required\":true}]",
                145, 4.8, 102
        ));

        // 10. 天气预警通知
        seeds.add(new SeedTemplate(
                "🌤️", "天气预警自动通知", "定时查询天气API，发现恶劣天气自动发送预警通知",
                "notification",
                "{\"trigger\":{\"type\":\"cron\",\"value\":\"0 */6 * * *\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"api_call\",\"description\":\"查询天气\",\"args\":{\"url\":\"https://api.weather.com/forecast\",\"params\":{\"city\":\"{{city}}\",\"key\":\"{{api_key}}\"}}},{\"id\":\"step2\",\"tool\":\"condition_check\",\"description\":\"检查是否有恶劣天气\",\"args\":{\"condition\":\"step1.alert_level >= 2\"}},{\"id\":\"step3\",\"tool\":\"webhook\",\"description\":\"发送天气预警\",\"condition\":\"step2.result == true\",\"args\":{\"url\":\"{{webhook_url}}\",\"content\":\"⚠️ 天气预警: {{city}} 预计出现{{step1.alert_type}}，请提前做好准备\"}}]}",
                "[{\"key\":\"city\",\"label\":\"城市名称\",\"type\":\"string\",\"required\":true},{\"key\":\"api_key\",\"label\":\"天气API密钥\",\"type\":\"password\",\"required\":true},{\"key\":\"webhook_url\",\"label\":\"通知Webhook\",\"type\":\"string\",\"required\":true}]",
                56, 4.2, 22
        ));

        // 11. GitHub 趋势分析
        seeds.add(new SeedTemplate(
                "⭐", "GitHub趋势项目分析", "每日抓取 GitHub Trending，AI分析并推荐高价值项目",
                "data",
                "{\"trigger\":{\"type\":\"cron\",\"value\":\"0 9 * * *\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"web_scrape\",\"description\":\"抓取GitHub Trending\",\"args\":{\"urls\":[\"https://github.com/trending/{{language}}?since=daily\"],\"selector\":\"article.Box-row\"}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"AI分析趋势项目\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"分析以下GitHub Trending项目，选出最值得关注的3个并说明理由：\\n{{step1.output}}\"}},{\"id\":\"step3\",\"tool\":\"webhook\",\"description\":\"推送推荐\",\"condition\":\"step2.success\",\"args\":{\"url\":\"{{webhook_url}}\",\"content\":\"📌 今日GitHub精选:\\n{{step2.output}}\"}}]}",
                "[{\"key\":\"language\",\"label\":\"编程语言\",\"type\":\"string\",\"required\":false,\"default\":\"\"},{\"key\":\"webhook_url\",\"label\":\"推送Webhook\",\"type\":\"string\",\"required\":true}]",
                78, 4.5, 38
        ));

        // 12. 简历筛选助手
        seeds.add(new SeedTemplate(
                "📄", "简历智能筛选", "批量读取简历文件，AI根据JD要求评分排序",
                "ai",
                "{\"trigger\":{\"type\":\"manual\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"file_read\",\"description\":\"读取简历文件\",\"args\":{\"path\":\"{{resume_dir}}\",\"pattern\":\"*.pdf\"}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"AI评分排序\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"根据以下JD要求，对每份简历评分（1-10分）并给出简短理由，按分数从高到低排列：\\n\\nJD要求：\\n{{jd}}\\n\\n简历列表：\\n{{step1.output}}\"}},{\"id\":\"step3\",\"tool\":\"file_write\",\"description\":\"输出筛选结果\",\"condition\":\"step2.success\",\"args\":{\"path\":\"/output/resume_ranking_{{date}}.md\",\"content\":\"{{step2.output}}\"}}]}",
                "[{\"key\":\"resume_dir\",\"label\":\"简历文件夹路径\",\"type\":\"string\",\"required\":true},{\"key\":\"jd\",\"label\":\"岗位JD描述\",\"type\":\"text\",\"required\":true}]",
                92, 4.7, 55
        ));

        // 13. 定时健康提醒
        seeds.add(new SeedTemplate(
                "💪", "定时健康提醒", "工作时段定时提醒喝水、休息、伸展",
                "schedule",
                "{\"trigger\":{\"type\":\"cron\",\"value\":\"0 */2 9-18 * * 1-5\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"webhook\",\"description\":\"发送健康提醒\",\"args\":{\"url\":\"{{webhook_url}}\",\"content\":\"⏰ {{reminder_message}}\"}}]}",
                "[{\"key\":\"webhook_url\",\"label\":\"通知Webhook\",\"type\":\"string\",\"required\":true},{\"key\":\"reminder_message\",\"label\":\"提醒内容\",\"type\":\"text\",\"required\":true,\"default\":\"该起来活动一下啦！喝杯水，看看窗外~\"}]",
                234, 4.1, 44
        ));

        // 14. 发票识别与录入
        seeds.add(new SeedTemplate(
                "🧾", "发票识别与录入", "上传发票图片，AI识别关键信息并录入表格",
                "automation",
                "{\"trigger\":{\"type\":\"manual\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"image_ocr\",\"description\":\"OCR识别发票\",\"args\":{\"images\":[{{invoice_images}}]}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"AI提取发票关键字段\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"从以下OCR结果中提取：发票号码、开票日期、金额、销售方名称、购买方名称：\\n{{step1.output}}\"}},{\"id\":\"step3\",\"tool\":\"sheet_append\",\"description\":\"写入表格\",\"condition\":\"step2.success\",\"args\":{\"sheet_url\":\"{{sheet_url}}\",\"data\":\"{{step2.output}}\"}}]}",
                "[{\"key\":\"invoice_images\",\"label\":\"发票图片路径\",\"type\":\"text\",\"required\":true},{\"key\":\"sheet_url\",\"label\":\"记录表格链接\",\"type\":\"string\",\"required\":true}]",
                63, 4.4, 28
        ));

        // 15. 多平台消息同步
        seeds.add(new SeedTemplate(
                "🔔", "多平台消息同步", "一条消息同步推送到微信/钉钉/飞书/Slack等平台",
                "notification",
                "{\"trigger\":{\"type\":\"manual\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"webhook\",\"description\":\"推送到企业微信\",\"args\":{\"url\":\"{{wework_webhook}}\",\"content\":\"{{message}}\"}},{\"id\":\"step2\",\"tool\":\"webhook\",\"description\":\"推送到钉钉\",\"args\":{\"url\":\"{{dingtalk_webhook}}\",\"content\":\"{{message}}\"}},{\"id\":\"step3\",\"tool\":\"webhook\",\"description\":\"推送到飞书\",\"args\":{\"url\":\"{{feishu_webhook}}\",\"content\":\"{{message}}\"}},{\"id\":\"step4\",\"tool\":\"webhook\",\"description\":\"推送到Slack\",\"args\":{\"url\":\"{{slack_webhook}}\",\"content\":\"{{message}}\"}}]}",
                "[{\"key\":\"message\",\"label\":\"消息内容\",\"type\":\"text\",\"required\":true},{\"key\":\"wework_webhook\",\"label\":\"企业微信Webhook\",\"type\":\"string\",\"required\":false},{\"key\":\"dingtalk_webhook\",\"label\":\"钉钉Webhook\",\"type\":\"string\",\"required\":false},{\"key\":\"feishu_webhook\",\"label\":\"飞书Webhook\",\"type\":\"string\",\"required\":false},{\"key\":\"slack_webhook\",\"label\":\"Slack Webhook\",\"type\":\"string\",\"required\":false}]",
                187, 4.6, 73
        ));

        // 16. 会议纪要生成
        seeds.add(new SeedTemplate(
                "📝", "会议纪要自动生成", "上传会议录音/文字记录，AI生成结构化会议纪要",
                "ai",
                "{\"trigger\":{\"type\":\"manual\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"file_read\",\"description\":\"读取会议记录\",\"args\":{\"path\":\"{{meeting_file}}\"}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"AI生成会议纪要\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"根据以下会议记录生成结构化纪要，包含：会议主题、参会人员、讨论要点、决议事项、待办任务（含负责人和截止日期）：\\n{{step1.output}}\"}},{\"id\":\"step3\",\"tool\":\"file_write\",\"description\":\"保存纪要文件\",\"condition\":\"step2.success\",\"args\":{\"path\":\"/output/meeting_minutes_{{date}}.md\",\"content\":\"{{step2.output}}\"}}]}",
                "[{\"key\":\"meeting_file\",\"label\":\"会议记录文件路径\",\"type\":\"string\",\"required\":true}]",
                108, 4.8, 91
        ));

        // 17. 网站可用性监控
        seeds.add(new SeedTemplate(
                "🖥️", "网站可用性监控", "定时检测网站可用性，宕机即时告警",
                "schedule",
                "{\"trigger\":{\"type\":\"cron\",\"value\":\"*/5 * * * *\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"http_check\",\"description\":\"检测网站状态\",\"args\":{\"url\":\"{{website_url}}\",\"timeout\":10}},{\"id\":\"step2\",\"tool\":\"condition_check\",\"description\":\"检查是否宕机\",\"args\":{\"condition\":\"step1.status_code != 200\"}},{\"id\":\"step3\",\"tool\":\"webhook\",\"description\":\"发送宕机告警\",\"condition\":\"step2.result == true\",\"args\":{\"url\":\"{{webhook_url}}\",\"content\":\"🚨 网站宕机告警: {{website_url}} 返回状态码 {{step1.status_code}}，响应时间 {{step1.response_time}}ms\"}}]}",
                "[{\"key\":\"website_url\",\"label\":\"监控网址\",\"type\":\"string\",\"required\":true,\"placeholder\":\"https://example.com\"},{\"key\":\"webhook_url\",\"label\":\"告警Webhook\",\"type\":\"string\",\"required\":true}]",
                201, 4.7, 115
        ));

        // 18. 翻译工作流
        seeds.add(new SeedTemplate(
                "🌐", "多语言翻译流水线", "文档批量翻译，支持多语言、术语表、审校流程",
                "ai",
                "{\"trigger\":{\"type\":\"manual\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"file_read\",\"description\":\"读取源文件\",\"args\":{\"path\":\"{{source_file}}\"}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"AI翻译\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"将以下内容翻译为{{target_lang}}，使用以下术语表确保一致性：\\n{{glossary}}\\n\\n原文：\\n{{step1.output}}\"}},{\"id\":\"step3\",\"tool\":\"ai_chat\",\"description\":\"AI审校\",\"condition\":\"step2.success\",\"args\":{\"prompt\":\"请审校以下翻译，检查术语一致性、语法和流畅度，标注任何问题：\\n{{step2.output}}\"}},{\"id\":\"step4\",\"tool\":\"file_write\",\"description\":\"保存译文\",\"condition\":\"step3.success\",\"args\":{\"path\":\"/output/translated_{{date}}.{{format}}\",\"content\":\"{{step2.output}}\"}}]}",
                "[{\"key\":\"source_file\",\"label\":\"源文件路径\",\"type\":\"string\",\"required\":true},{\"key\":\"target_lang\",\"label\":\"目标语言\",\"type\":\"select\",\"required\":true,\"options\":[\"英文\",\"日文\",\"韩文\",\"法文\",\"德文\",\"西班牙文\"]},{\"key\":\"glossary\",\"label\":\"术语表（可选）\",\"type\":\"text\",\"required\":false},{\"key\":\"format\",\"label\":\"输出格式\",\"type\":\"string\",\"required\":false,\"default\":\"md\"}]",
                73, 4.5, 47
        ));

        // 19. 定时数据清洗
        seeds.add(new SeedTemplate(
                "🧹", "定时数据清洗管道", "定时执行数据清洗规则，输出清洗后数据",
                "data",
                "{\"trigger\":{\"type\":\"cron\",\"value\":\"0 3 * * *\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"sql_query\",\"description\":\"提取原始数据\",\"args\":{\"sql\":\"SELECT * FROM {{source_table}} WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)\"}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"AI执行数据清洗\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"根据以下清洗规则处理数据：\\n{{cleaning_rules}}\\n\\n原始数据：\\n{{step1.output}}\"}},{\"id\":\"step3\",\"tool\":\"sql_exec\",\"description\":\"写入清洗后数据\",\"condition\":\"step2.success\",\"args\":{\"sql\":\"INSERT INTO {{target_table}} VALUES {{step2.output}}\"}}]}",
                "[{\"key\":\"source_table\",\"label\":\"源数据表\",\"type\":\"string\",\"required\":true},{\"key\":\"target_table\",\"label\":\"目标表\",\"type\":\"string\",\"required\":true},{\"key\":\"cleaning_rules\",\"label\":\"清洗规则\",\"type\":\"text\",\"required\":true,\"placeholder\":\"1. 去除空值\\n2. 统一日期格式\\n3. 去重\"}]",
                45, 4.3, 19
        ));

        // 20. 学习计划生成器
        seeds.add(new SeedTemplate(
                "📚", "个性化学习计划生成", "输入学习目标，AI生成分阶段学习计划",
                "ai",
                "{\"trigger\":{\"type\":\"manual\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"ai_chat\",\"description\":\"分析学习目标\",\"args\":{\"prompt\":\"分析以下学习目标，评估所需先修知识、学习难度和预估时间：\\n目标：{{goal}}\\n现有基础：{{background}}\\n可用时间：{{time_per_week}}/周\"}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"生成学习计划\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"基于以下分析，生成一个{{weeks}}周的学习计划，每周有明确目标和具体学习内容：\\n{{step1.output}}\"}},{\"id\":\"step3\",\"tool\":\"file_write\",\"description\":\"保存学习计划\",\"condition\":\"step2.success\",\"args\":{\"path\":\"/output/study_plan_{{date}}.md\",\"content\":\"{{step2.output}}\"}}]}",
                "[{\"key\":\"goal\",\"label\":\"学习目标\",\"type\":\"text\",\"required\":true,\"placeholder\":\"掌握Python数据分析\"},{\"key\":\"background\",\"label\":\"现有基础\",\"type\":\"text\",\"required\":true,\"placeholder\":\"有编程基础，熟悉基本语法\"},{\"key\":\"time_per_week\",\"label\":\"每周可用时间\",\"type\":\"string\",\"required\":true,\"default\":\"10小时\"},{\"key\":\"weeks\",\"label\":\"计划周数\",\"type\":\"select\",\"required\":true,\"options\":[\"2\",\"4\",\"8\",\"12\"],\"default\":\"4\"}]",
                166, 4.9, 128
        ));

        // 21. 饭否式AI日记
        seeds.add(new SeedTemplate(
                "📓", "AI每日反思日记", "每日晚间收集当天工作记录，AI生成反思日记",
                "schedule",
                "{\"trigger\":{\"type\":\"cron\",\"value\":\"0 22 * * *\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"memory_query\",\"description\":\"获取当日记忆\",\"args\":{\"doc_type\":\"daily_notes\",\"date\":\"{{today}}\"}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"AI生成反思日记\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"根据今天的记录，用温暖而思考的语气写一篇300字的反思日记，包含：今日收获、一个反思点、明天的目标\"}},{\"id\":\"step3\",\"tool\":\"memory_save\",\"description\":\"保存日记\",\"condition\":\"step2.success\",\"args\":{\"doc_type\":\"reflection\",\"title\":\"每日反思 {{today}}\",\"content\":\"{{step2.output}}\"}}]}",
                "[{\"key\":\"today\",\"label\":\"{{日期会自动填充}}\",\"type\":\"string\",\"required\":false}]",
                88, 4.4, 31
        ));

        // 22. 播客/视频总结
        seeds.add(new SeedTemplate(
                "🎙️", "播客/视频内容总结", "输入播客/视频链接或文字稿，AI生成关键要点总结",
                "ai",
                "{\"trigger\":{\"type\":\"manual\"},\"steps\":[{\"id\":\"step1\",\"tool\":\"content_fetch\",\"description\":\"获取内容\",\"args\":{\"url\":\"{{content_url}}\",\"type\":\"{{content_type}}\"}},{\"id\":\"step2\",\"tool\":\"ai_chat\",\"description\":\"AI生成总结\",\"condition\":\"step1.success\",\"args\":{\"prompt\":\"请总结以下内容的关键要点，包括：3个核心观点、重要引用、可行动建议：\\n{{step1.output}}\"}},{\"id\":\"step3\",\"tool\":\"file_write\",\"description\":\"保存总结\",\"condition\":\"step2.success\",\"args\":{\"path\":\"/output/summary_{{date}}.md\",\"content\":\"{{step2.output}}\"}}]}",
                "[{\"key\":\"content_url\",\"label\":\"内容链接\",\"type\":\"string\",\"required\":true},{\"key\":\"content_type\",\"label\":\"内容类型\",\"type\":\"select\",\"required\":true,\"options\":[\"podcast\",\"video\",\"article\"]}]",
                59, 4.6, 36
        ));

        return seeds;
    }

    /**
     * 种子模板数据结构
     */
    private static class SeedTemplate {
        String icon, name, description, category, dsl, paramsSchema;
        int initialUse, initialVotes;
        double initialRating;

        SeedTemplate(String icon, String name, String description, String category,
                     String dsl, String paramsSchema, int initialUse, double rating, int votes) {
            this.icon = icon;
            this.name = name;
            this.description = description;
            this.category = category;
            this.dsl = dsl;
            this.paramsSchema = paramsSchema;
            this.initialUse = initialUse;
            this.initialRating = rating;
            this.initialVotes = votes;
        }
    }

    // =============================================
    // 模板列表/搜索
    // =============================================

    /**
     * 搜索/浏览模板市场
     */
    public WorkflowDTO.TemplatePageResult searchTemplates(WorkflowDTO.TemplateSearchRequest req) {
        QueryWrapper<WorkflowTemplate> qw = new QueryWrapper<>();
        qw.eq("deleted", 0);
        qw.eq("is_published", 1);

        if (req.getKeyword() != null && !req.getKeyword().trim().isEmpty()) {
            qw.and(w -> w
                    .like("name", req.getKeyword())
                    .or()
                    .like("description", req.getKeyword()));
        }
        if (req.getCategory() != null && !req.getCategory().trim().isEmpty()) {
            qw.eq("category", req.getCategory());
        }
        if (req.getOfficial() != null && req.getOfficial()) {
            qw.eq("is_official", 1);
        }
        if (req.getCertified() != null && req.getCertified()) {
            qw.eq("is_certified", 1);
        }

        // 排序
        String sort = req.getSort() != null ? req.getSort() : "hot";
        switch (sort) {
            case "newest" -> qw.orderByDesc("created_at");
            case "rating" -> qw.orderByDesc("rating");
            default -> qw.orderByDesc("use_count"); // hot
        }

        // 分页
        int page = req.getPage() != null && req.getPage() > 0 ? req.getPage() : 1;
        int pageSize = req.getPageSize() != null && req.getPageSize() > 0 ? req.getPageSize() : 12;
        pageSize = Math.min(pageSize, 50);

        long total = templateMapper.selectCount(qw);
        qw.last("LIMIT " + ((page - 1) * pageSize) + ", " + pageSize);
        List<WorkflowTemplate> list = templateMapper.selectList(qw);

        List<WorkflowDTO.WorkflowTemplateBriefVO> items = list.stream()
                .map(this::toBriefVO)
                .collect(Collectors.toList());

        WorkflowDTO.TemplatePageResult result = new WorkflowDTO.TemplatePageResult();
        result.setItems(items);
        result.setTotal(total);
        result.setPage(page);
        result.setPageSize(pageSize);
        result.setTotalPages((int) Math.ceil((double) total / pageSize));
        return result;
    }

    /**
     * 获取模板详情
     */
    public WorkflowDTO.WorkflowTemplateVO getTemplate(String uuid) {
        WorkflowTemplate t = templateMapper.selectOne(
                new QueryWrapper<WorkflowTemplate>()
                        .eq("uuid", uuid)
                        .eq("deleted", 0));
        if (t == null) {
            throw new RuntimeException("模板不存在");
        }
        return toVO(t);
    }

    /**
     * 获取所有分类
     */
    public List<Map<String, Object>> getCategories() {
        List<Map<String, Object>> categories = new ArrayList<>();
        String[] cats = {"general", "data", "report", "notification", "schedule", "automation", "ai"};
        String[] labels = {"通用", "数据处理", "报表生成", "消息通知", "定时任务", "自动化", "AI生成"};
        String[] icons = {"📦", "📊", "📋", "🔔", "⏰", "⚡", "🤖"};

        for (int i = 0; i < cats.length; i++) {
            long count = templateMapper.selectCount(
                    new QueryWrapper<WorkflowTemplate>()
                            .eq("category", cats[i])
                            .eq("is_published", 1)
                            .eq("deleted", 0));

            Map<String, Object> cat = new LinkedHashMap<>();
            cat.put("key", cats[i]);
            cat.put("label", labels[i]);
            cat.put("icon", icons[i]);
            cat.put("count", count);
            categories.add(cat);
        }
        return categories;
    }

    // =============================================
    // 发布/取消发布
    // =============================================

    /**
     * 用户将工作流发布为模板
     */
    @Transactional
    public WorkflowDTO.WorkflowTemplateVO publishTemplate(Long userId, WorkflowDTO.TemplatePublishRequest req) {
        if (req.getWorkflowId() == null) {
            throw new RuntimeException("请指定要发布的工作流");
        }
        Workflow wf = workflowMapper.selectById(req.getWorkflowId());
        if (wf == null || !Objects.equals(wf.getUserId(), userId)) {
            throw new RuntimeException("工作流不存在或无权操作");
        }
        if (wf.getDsl() == null || wf.getDsl().trim().isEmpty()) {
            throw new RuntimeException("工作流 DSL 为空，无法发布为模板");
        }

        // 检查是否已发布过
        WorkflowTemplate existing = templateMapper.selectOne(
                new QueryWrapper<WorkflowTemplate>()
                        .eq("source_workflow_id", req.getWorkflowId())
                        .eq("author_id", userId)
                        .eq("deleted", 0));
        if (existing != null) {
            throw new RuntimeException("该工作流已发布为模板 (UUID: " + existing.getUuid() + ")");
        }

        WorkflowTemplate t = new WorkflowTemplate();
        t.setUuid(UUID.randomUUID().toString());
        t.setName(req.getName() != null ? req.getName() : wf.getName());
        t.setDescription(req.getDescription() != null ? req.getDescription() : wf.getDescription());
        t.setCategory(req.getCategory() != null ? req.getCategory() : "general");
        t.setIcon(req.getIcon() != null ? req.getIcon() : "⚙️");
        t.setDsl(wf.getDsl());
        t.setParamsSchema(req.getParamsSchema());
        t.setIsOfficial(0);
        t.setAuthorId(userId);
        t.setAuthorName(""); // 后续从用户表填充
        t.setUseCount(0);
        t.setRating(BigDecimal.ZERO);
        t.setRatingCount(0);
        t.setIsPublished(1);
        t.setIsCertified(0);
        t.setSourceWorkflowId(req.getWorkflowId());

        templateMapper.insert(t);
        log.info("[TemplateMarket] 用户 {} 发布模板: {} (UUID={})", userId, t.getName(), t.getUuid());
        return toVO(t);
    }

    /**
     * 取消发布（作者或管理员）
     */
    @Transactional
    public void unpublishTemplate(String uuid, Long userId) {
        WorkflowTemplate t = templateMapper.selectOne(
                new QueryWrapper<WorkflowTemplate>()
                        .eq("uuid", uuid)
                        .eq("deleted", 0));
        if (t == null) {
            throw new RuntimeException("模板不存在");
        }
        if (!Objects.equals(t.getAuthorId(), userId) && t.getIsOfficial() == 0) {
            throw new RuntimeException("无权取消发布此模板");
        }

        // 逻辑删除
        UpdateWrapper<WorkflowTemplate> uw = new UpdateWrapper<>();
        uw.eq("uuid", uuid).set("deleted", 1);
        templateMapper.update(null, uw);
        log.info("[TemplateMarket] 模板 {} (UUID={}) 已取消发布", t.getName(), uuid);
    }

    // =============================================
    // 克隆
    // =============================================

    /**
     * 克隆模板为用户自己的工作流
     */
    @Transactional
    public WorkflowDTO.WorkflowVO cloneTemplate(String uuid, Long userId, WorkflowDTO.TemplateCloneRequest req) {
        WorkflowTemplate t = templateMapper.selectOne(
                new QueryWrapper<WorkflowTemplate>()
                        .eq("uuid", uuid)
                        .eq("is_published", 1)
                        .eq("deleted", 0));
        if (t == null) {
            throw new RuntimeException("模板不存在或已下架");
        }

        // 替换 DSL 中的参数占位符
        String dsl = t.getDsl();
        if (req.getParams() != null && !req.getParams().trim().isEmpty()) {
            try {
                Map<String, Object> params = objectMapper.readValue(req.getParams(),
                        new TypeReference<Map<String, Object>>() {});
                for (Map.Entry<String, Object> entry : params.entrySet()) {
                    String placeholder = "{{" + entry.getKey() + "}}";
                    String value = entry.getValue() != null ? entry.getValue().toString() : "";
                    dsl = dsl.replace(placeholder, value);
                }
            } catch (Exception e) {
                throw new RuntimeException("参数解析失败: " + e.getMessage());
            }
        }

        // 创建用户自己的工作流
        Workflow wf = new Workflow();
        wf.setUserId(userId);
        wf.setName(req.getName() != null ? req.getName() : t.getName() + " (克隆)");
        wf.setDescription("基于模板「" + t.getName() + "」克隆\n" + (t.getDescription() != null ? t.getDescription() : ""));
        wf.setDsl(dsl);
        wf.setStatus("paused");

        // 解析 cron 表达式
        try {
            var root = objectMapper.readTree(dsl);
            if (root.has("trigger")) {
                var trigger = root.get("trigger");
                if (trigger.has("type") && "cron".equals(trigger.get("type").asText())) {
                    if (trigger.has("value")) {
                        wf.setCronExpr(trigger.get("value").asText());
                    }
                }
            }
        } catch (Exception ignored) {}

        workflowMapper.insert(wf);

        // 增加使用计数
        UpdateWrapper<WorkflowTemplate> uw = new UpdateWrapper<>();
        uw.eq("id", t.getId()).setSql("use_count = use_count + 1");
        templateMapper.update(null, uw);

        log.info("[TemplateMarket] 用户 {} 克隆模板 {} → 工作流 {} (ID={})", userId, t.getName(), wf.getName(), wf.getId());

        // 转换为 VO
        WorkflowDTO.WorkflowVO vo = new WorkflowDTO.WorkflowVO();
        vo.setId(wf.getId());
        vo.setUserId(wf.getUserId());
        vo.setName(wf.getName());
        vo.setDescription(wf.getDescription());
        vo.setDsl(wf.getDsl());
        vo.setCronExpr(wf.getCronExpr());
        vo.setStatus(wf.getStatus());
        vo.setCreatedAt(wf.getCreatedAt() != null ? wf.getCreatedAt().format(FMT) : null);
        return vo;
    }

    // =============================================
    // 评分
    // =============================================

    /**
     * 给模板评分（1-5分）
     */
    @Transactional
    public void rateTemplate(String uuid, Long userId, int rating) {
        if (rating < 1 || rating > 5) {
            throw new RuntimeException("评分必须在 1-5 之间");
        }

        WorkflowTemplate t = templateMapper.selectOne(
                new QueryWrapper<WorkflowTemplate>()
                        .eq("uuid", uuid)
                        .eq("is_published", 1)
                        .eq("deleted", 0));
        if (t == null) {
            throw new RuntimeException("模板不存在");
        }

        // 简单评分：新评分 = (旧总分 + 新评分) / (旧人数 + 1)
        int oldCount = t.getRatingCount() != null ? t.getRatingCount() : 0;
        BigDecimal oldTotal = t.getRating() != null
                ? t.getRating().multiply(BigDecimal.valueOf(oldCount))
                : BigDecimal.ZERO;
        BigDecimal newTotal = oldTotal.add(BigDecimal.valueOf(rating));
        int newCount = oldCount + 1;
        BigDecimal newRating = newTotal.divide(BigDecimal.valueOf(newCount), 2, RoundingMode.HALF_UP);

        UpdateWrapper<WorkflowTemplate> uw = new UpdateWrapper<>();
        uw.eq("id", t.getId())
                .set("rating", newRating)
                .set("rating_count", newCount);
        templateMapper.update(null, uw);

        log.info("[TemplateMarket] 用户 {} 对模板 {} 评分: {} (新均分: {})", userId, t.getName(), rating, newRating);
    }

    // =============================================
    // 转换方法
    // =============================================

    private WorkflowDTO.WorkflowTemplateVO toVO(WorkflowTemplate t) {
        WorkflowDTO.WorkflowTemplateVO vo = new WorkflowDTO.WorkflowTemplateVO();
        vo.setId(t.getId());
        vo.setUuid(t.getUuid());
        vo.setName(t.getName());
        vo.setDescription(t.getDescription());
        vo.setCategory(t.getCategory());
        vo.setIcon(t.getIcon());
        vo.setDsl(t.getDsl());
        vo.setParamsSchema(t.getParamsSchema());
        vo.setIsOfficial(t.getIsOfficial() == 1);
        vo.setAuthorId(t.getAuthorId());
        vo.setAuthorName(t.getAuthorName());
        vo.setUseCount(t.getUseCount());
        vo.setRating(t.getRating());
        vo.setRatingCount(t.getRatingCount());
        vo.setIsPublished(t.getIsPublished() == 1);
        vo.setIsCertified(t.getIsCertified() == 1);
        vo.setSourceWorkflowId(t.getSourceWorkflowId());
        vo.setCreatedAt(t.getCreatedAt() != null ? t.getCreatedAt().format(FMT) : null);
        vo.setUpdatedAt(t.getUpdatedAt() != null ? t.getUpdatedAt().format(FMT) : null);
        return vo;
    }

    private WorkflowDTO.WorkflowTemplateBriefVO toBriefVO(WorkflowTemplate t) {
        WorkflowDTO.WorkflowTemplateBriefVO vo = new WorkflowDTO.WorkflowTemplateBriefVO();
        vo.setId(t.getId());
        vo.setUuid(t.getUuid());
        vo.setName(t.getName());
        vo.setDescription(t.getDescription());
        vo.setCategory(t.getCategory());
        vo.setIcon(t.getIcon());
        vo.setIsOfficial(t.getIsOfficial() == 1);
        vo.setAuthorName(t.getAuthorName());
        vo.setUseCount(t.getUseCount());
        vo.setRating(t.getRating());
        vo.setRatingCount(t.getRatingCount());
        vo.setIsCertified(t.getIsCertified() == 1);
        // 计算步骤数
        vo.setStepCount(countSteps(t.getDsl()));
        vo.setCreatedAt(t.getCreatedAt() != null ? t.getCreatedAt().format(FMT) : null);
        return vo;
    }

    private int countSteps(String dsl) {
        if (dsl == null) return 0;
        try {
            var root = objectMapper.readTree(dsl);
            if (root.has("steps") && root.get("steps").isArray()) {
                return root.get("steps").size();
            }
        } catch (Exception ignored) {}
        return 0;
    }
}
