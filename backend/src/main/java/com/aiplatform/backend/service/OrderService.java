package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.PaymentDTO;
import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.*;
import com.aiplatform.backend.mapper.*;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 订单管理服务
 * <p>
 * 核心职责：
 * 1. 订单多条件组合查询（订单号/状态/时间/金额/支付方式等）
 * 2. 订单详情查看（关联用户信息）
 * 3. 订单导出（CSV 格式，兼容 Excel 打开）
 * 4. 支付统计概览
 * 5. 支付记录 / 退款记录查询
 * 6. 用户自己的订单查询
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class OrderService {

    private final OrderMapper orderMapper;
    private final PaymentRecordMapper paymentRecordMapper;
    private final RefundRecordMapper refundRecordMapper;
    private final PayAuditLogMapper payAuditLogMapper;
    private final SysUserMapper sysUserMapper;

    private static final DateTimeFormatter CSV_DATE_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    // ==================== 订单列表（多条件组合查询） ====================

    /**
     * 多条件组合分页查询订单
     *
     * @param req 查询条件
     * @return 分页结果
     */
    public Result.PageResult<PaymentDTO.OrderBriefVO> listOrders(PaymentDTO.OrderQueryRequest req) {
        // 构建查询条件
        LambdaQueryWrapper<OrderEntity> wrapper = new LambdaQueryWrapper<>();

        // 订单号模糊匹配
        if (StringUtils.hasText(req.getOrderNo())) {
            wrapper.like(OrderEntity::getOrderNo, req.getOrderNo());
        }
        // 交易流水号
        if (StringUtils.hasText(req.getTradeNo())) {
            wrapper.eq(OrderEntity::getTradeNo, req.getTradeNo());
        }
        // 用户ID
        if (req.getUserId() != null) {
            wrapper.eq(OrderEntity::getUserId, req.getUserId());
        }
        // 用户名模糊匹配 — 先查出匹配的用户ID
        if (StringUtils.hasText(req.getUsername())) {
            List<SysUser> matchedUsers = sysUserMapper.selectList(
                new LambdaQueryWrapper<SysUser>()
                    .like(SysUser::getUsername, req.getUsername())
                    .select(SysUser::getId)
            );
            if (matchedUsers.isEmpty()) {
                // 没有匹配的用户，返回空结果
                return new Result.PageResult<>(Collections.emptyList(), 0, 
                    req.getPage() != null ? req.getPage() : 1, 
                    req.getSize() != null ? req.getSize() : 20);
            }
            List<Long> userIds = matchedUsers.stream().map(SysUser::getId).collect(Collectors.toList());
            wrapper.in(OrderEntity::getUserId, userIds);
        }
        // 订单状态
        if (StringUtils.hasText(req.getStatus())) {
            wrapper.eq(OrderEntity::getStatus, req.getStatus());
        }
        // 支付方式
        if (StringUtils.hasText(req.getPaymentMethod())) {
            wrapper.eq(OrderEntity::getPaymentMethod, req.getPaymentMethod());
        }
        // 套餐ID
        if (req.getPlanId() != null) {
            wrapper.eq(OrderEntity::getPlanId, req.getPlanId());
        }
        // 金额范围
        if (req.getMinAmount() != null) {
            wrapper.ge(OrderEntity::getActualAmount, req.getMinAmount());
        }
        if (req.getMaxAmount() != null) {
            wrapper.le(OrderEntity::getActualAmount, req.getMaxAmount());
        }
        // 时间范围
        if (req.getStartTime() != null) {
            wrapper.ge(OrderEntity::getCreatedAt, req.getStartTime());
        }
        if (req.getEndTime() != null) {
            wrapper.le(OrderEntity::getCreatedAt, req.getEndTime());
        }

        // 排序（白名单防注入）
        String sortBy = StringUtils.hasText(req.getSortBy()) ? req.getSortBy() : "created_at";
        String sortDir = StringUtils.hasText(req.getSortDir()) ? req.getSortDir() : "desc";
        String sortColumn = getSortColumn(sortBy);
        String sortClause = "ORDER BY " + sortColumn + " " + ("asc".equalsIgnoreCase(sortDir) ? "ASC" : "DESC");
        wrapper.last(sortClause);

        // 分页
        int page = req.getPage() != null && req.getPage() > 0 ? req.getPage() : 1;
        int size = req.getSize() != null && req.getSize() > 0 ? req.getSize() : 20;
        Page<OrderEntity> pageResult = orderMapper.selectPage(new Page<>(page, size), wrapper);

        // 转换 VO + 填充用户名
        List<PaymentDTO.OrderBriefVO> voList = pageResult.getRecords().stream()
            .map(this::toBriefVO)
            .collect(Collectors.toList());

        // 批量填充用户名
        fillUsernames(voList);

        return new Result.PageResult<>(voList, pageResult.getTotal(), page, size);
    }

    // ==================== 订单详情 ====================

    /**
     * 获取订单详情（含用户信息）
     *
     * @param id 订单ID
     * @return 订单详情 VO
     */
    public PaymentDTO.OrderVO getOrderDetail(Long id) {
        OrderEntity order = orderMapper.selectById(id);
        if (order == null) {
            throw new RuntimeException("订单不存在");
        }
        return toDetailVO(order);
    }

    /**
     * 根据订单号获取订单详情
     */
    public PaymentDTO.OrderVO getOrderDetailByNo(String orderNo) {
        OrderEntity order = orderMapper.selectOne(
            new LambdaQueryWrapper<OrderEntity>()
                .eq(OrderEntity::getOrderNo, orderNo)
                .last("LIMIT 1")
        );
        if (order == null) {
            throw new RuntimeException("订单不存在");
        }
        return toDetailVO(order);
    }

    // ==================== 用户订单 ====================

    /**
     * 获取用户自己的订单列表
     *
     * @param userId 用户ID
     * @param page   页码
     * @param size   每页大小
     * @param status 状态过滤（可选）
     * @return 分页结果
     */
    public Result.PageResult<PaymentDTO.OrderBriefVO> listUserOrders(Long userId, int page, int size, String status) {
        LambdaQueryWrapper<OrderEntity> wrapper = new LambdaQueryWrapper<OrderEntity>()
            .eq(OrderEntity::getUserId, userId)
            .orderByDesc(OrderEntity::getCreatedAt);

        if (StringUtils.hasText(status)) {
            wrapper.eq(OrderEntity::getStatus, status);
        }

        Page<OrderEntity> pageResult = orderMapper.selectPage(new Page<>(page, size), wrapper);

        List<PaymentDTO.OrderBriefVO> voList = pageResult.getRecords().stream()
            .map(this::toBriefVO)
            .collect(Collectors.toList());

        fillUsernames(voList);

        return new Result.PageResult<>(voList, pageResult.getTotal(), page, size);
    }

    // ==================== 支付记录 ====================

    /**
     * 获取订单的支付记录列表
     *
     * @param orderId 订单ID
     * @return 支付记录列表
     */
    public List<PaymentDTO.PaymentRecordVO> listPaymentRecords(Long orderId) {
        List<PaymentRecord> records = paymentRecordMapper.selectList(
            new LambdaQueryWrapper<PaymentRecord>()
                .eq(PaymentRecord::getOrderId, orderId)
                .orderByDesc(PaymentRecord::getCreatedAt)
        );
        return records.stream().map(this::toPaymentRecordVO).collect(Collectors.toList());
    }

    /**
     * 分页查询所有支付记录
     */
    public Result.PageResult<PaymentDTO.PaymentRecordVO> listAllPaymentRecords(int page, int size, String orderNo) {
        LambdaQueryWrapper<PaymentRecord> wrapper = new LambdaQueryWrapper<PaymentRecord>()
            .orderByDesc(PaymentRecord::getCreatedAt);

        if (StringUtils.hasText(orderNo)) {
            wrapper.eq(PaymentRecord::getOrderNo, orderNo);
        }

        Page<PaymentRecord> pageResult = paymentRecordMapper.selectPage(new Page<>(page, size), wrapper);
        List<PaymentDTO.PaymentRecordVO> voList = pageResult.getRecords().stream()
            .map(this::toPaymentRecordVO)
            .collect(Collectors.toList());

        return new Result.PageResult<>(voList, pageResult.getTotal(), page, size);
    }

    // ==================== 退款记录 ====================

    /**
     * 获取订单的退款记录列表
     *
     * @param orderId 订单ID
     * @return 退款记录列表
     */
    public List<PaymentDTO.RefundRecordVO> listRefundRecords(Long orderId) {
        List<RefundRecord> records = refundRecordMapper.selectList(
            new LambdaQueryWrapper<RefundRecord>()
                .eq(RefundRecord::getOrderId, orderId)
                .orderByDesc(RefundRecord::getCreatedAt)
        );
        return records.stream().map(this::toRefundRecordVO).collect(Collectors.toList());
    }

    /**
     * 分页查询所有退款记录
     */
    public Result.PageResult<PaymentDTO.RefundRecordVO> listAllRefundRecords(int page, int size, String status) {
        LambdaQueryWrapper<RefundRecord> wrapper = new LambdaQueryWrapper<RefundRecord>()
            .orderByDesc(RefundRecord::getCreatedAt);

        if (StringUtils.hasText(status)) {
            wrapper.eq(RefundRecord::getRefundStatus, status);
        }

        Page<RefundRecord> pageResult = refundRecordMapper.selectPage(new Page<>(page, size), wrapper);
        List<PaymentDTO.RefundRecordVO> voList = pageResult.getRecords().stream()
            .map(this::toRefundRecordVO)
            .collect(Collectors.toList());

        return new Result.PageResult<>(voList, pageResult.getTotal(), page, size);
    }

    // ==================== 统计概览 ====================

    /**
     * 支付统计概览
     *
     * @return 统计数据
     */
    public PaymentDTO.PaymentStatsVO getStats() {
        PaymentDTO.PaymentStatsVO stats = new PaymentDTO.PaymentStatsVO();

        LocalDateTime todayStart = LocalDateTime.now().toLocalDate().atStartOfDay();
        LocalDateTime todayEnd = todayStart.plusDays(1);

        // 今日订单数
        Long todayOrderCount = orderMapper.selectCount(
            new LambdaQueryWrapper<OrderEntity>()
                .ge(OrderEntity::getCreatedAt, todayStart)
                .lt(OrderEntity::getCreatedAt, todayEnd)
        );
        stats.setTodayOrderCount(todayOrderCount);

        // 今日支付金额（仅 paid 订单）
        List<OrderEntity> todayPaidOrders = orderMapper.selectList(
            new LambdaQueryWrapper<OrderEntity>()
                .eq(OrderEntity::getStatus, "paid")
                .ge(OrderEntity::getPaidAt, todayStart)
                .lt(OrderEntity::getPaidAt, todayEnd)
                .select(OrderEntity::getActualAmount)
        );
        BigDecimal todayPayAmount = todayPaidOrders.stream()
            .map(OrderEntity::getActualAmount)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        stats.setTodayPayAmount(todayPayAmount);

        // 总订单数
        Long totalOrderCount = orderMapper.selectCount(new LambdaQueryWrapper<>());
        stats.setTotalOrderCount(totalOrderCount);

        // 总支付金额
        List<OrderEntity> allPaidOrders = orderMapper.selectList(
            new LambdaQueryWrapper<OrderEntity>()
                .eq(OrderEntity::getStatus, "paid")
                .select(OrderEntity::getActualAmount)
        );
        BigDecimal totalPayAmount = allPaidOrders.stream()
            .map(OrderEntity::getActualAmount)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        stats.setTotalPayAmount(totalPayAmount);

        // 待处理退款数
        Long pendingRefundCount = refundRecordMapper.selectCount(
            new LambdaQueryWrapper<RefundRecord>()
                .in(RefundRecord::getRefundStatus, "pending", "processing")
        );
        stats.setPendingRefundCount(pendingRefundCount);

        // 已退款总金额
        List<RefundRecord> successRefunds = refundRecordMapper.selectList(
            new LambdaQueryWrapper<RefundRecord>()
                .eq(RefundRecord::getRefundStatus, "success")
                .select(RefundRecord::getRefundAmount)
        );
        BigDecimal totalRefundAmount = successRefunds.stream()
            .map(RefundRecord::getRefundAmount)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
        stats.setTotalRefundAmount(totalRefundAmount);

        // 各支付方式统计
        stats.setMethodStats(getMethodStats());

        return stats;
    }

    /**
     * 各支付方式统计
     */
    private List<PaymentDTO.PaymentMethodStat> getMethodStats() {
        List<OrderEntity> paidOrders = orderMapper.selectList(
            new LambdaQueryWrapper<OrderEntity>()
                .eq(OrderEntity::getStatus, "paid")
                .select(OrderEntity::getPaymentMethod, OrderEntity::getActualAmount)
        );

        Map<String, List<OrderEntity>> grouped = paidOrders.stream()
            .filter(o -> StringUtils.hasText(o.getPaymentMethod()))
            .collect(Collectors.groupingBy(OrderEntity::getPaymentMethod));

        return grouped.entrySet().stream().map(entry -> {
            PaymentDTO.PaymentMethodStat stat = new PaymentDTO.PaymentMethodStat();
            stat.setPaymentMethod(entry.getKey());
            stat.setOrderCount((long) entry.getValue().size());
            stat.setTotalAmount(entry.getValue().stream()
                .map(OrderEntity::getActualAmount)
                .reduce(BigDecimal.ZERO, BigDecimal::add));
            return stat;
        }).collect(Collectors.toList());
    }

    // ==================== 审计日志查询 ====================

    /**
     * 分页查询审计日志
     */
    public Result.PageResult<PaymentDTO.PayAuditLogVO> listAuditLogs(PaymentDTO.AuditLogQueryRequest req) {
        LambdaQueryWrapper<PayAuditLog> wrapper = new LambdaQueryWrapper<PayAuditLog>()
            .orderByDesc(PayAuditLog::getCreatedAt);

        if (StringUtils.hasText(req.getAction())) {
            wrapper.eq(PayAuditLog::getAction, req.getAction());
        }
        if (StringUtils.hasText(req.getTargetType())) {
            wrapper.eq(PayAuditLog::getTargetType, req.getTargetType());
        }
        if (StringUtils.hasText(req.getTargetId())) {
            wrapper.eq(PayAuditLog::getTargetId, req.getTargetId());
        }
        if (req.getOperatorId() != null) {
            wrapper.eq(PayAuditLog::getOperatorId, req.getOperatorId());
        }
        if (StringUtils.hasText(req.getResult())) {
            wrapper.eq(PayAuditLog::getResult, req.getResult());
        }
        if (req.getStartTime() != null) {
            wrapper.ge(PayAuditLog::getCreatedAt, req.getStartTime());
        }
        if (req.getEndTime() != null) {
            wrapper.le(PayAuditLog::getCreatedAt, req.getEndTime());
        }

        int page = req.getPage() != null && req.getPage() > 0 ? req.getPage() : 1;
        int size = req.getSize() != null && req.getSize() > 0 ? req.getSize() : 20;
        Page<PayAuditLog> pageResult = payAuditLogMapper.selectPage(new Page<>(page, size), wrapper);

        List<PaymentDTO.PayAuditLogVO> voList = pageResult.getRecords().stream()
            .map(this::toAuditLogVO)
            .collect(Collectors.toList());

        return new Result.PageResult<>(voList, pageResult.getTotal(), page, size);
    }

    // ==================== 订单导出 ====================

    /**
     * 导出订单为 CSV（兼容 Excel 打开）
     * 添加 BOM 头确保 Excel 正确识别 UTF-8 编码
     *
     * @param req 查询条件（与列表查询一致）
     * @return CSV 字符串
     */
    public String exportOrdersCsv(PaymentDTO.OrderQueryRequest req) {
        // 复用查询逻辑但不分页（限制最大导出行数 10000）
        LambdaQueryWrapper<OrderEntity> wrapper = new LambdaQueryWrapper<>();

        if (StringUtils.hasText(req.getOrderNo())) {
            wrapper.like(OrderEntity::getOrderNo, req.getOrderNo());
        }
        if (StringUtils.hasText(req.getTradeNo())) {
            wrapper.eq(OrderEntity::getTradeNo, req.getTradeNo());
        }
        if (req.getUserId() != null) {
            wrapper.eq(OrderEntity::getUserId, req.getUserId());
        }
        if (StringUtils.hasText(req.getUsername())) {
            List<SysUser> matchedUsers = sysUserMapper.selectList(
                new LambdaQueryWrapper<SysUser>()
                    .like(SysUser::getUsername, req.getUsername())
                    .select(SysUser::getId)
            );
            if (matchedUsers.isEmpty()) {
                return generateCsvHeaders().toString();
            }
            List<Long> userIds = matchedUsers.stream().map(SysUser::getId).collect(Collectors.toList());
            wrapper.in(OrderEntity::getUserId, userIds);
        }
        if (StringUtils.hasText(req.getStatus())) {
            wrapper.eq(OrderEntity::getStatus, req.getStatus());
        }
        if (StringUtils.hasText(req.getPaymentMethod())) {
            wrapper.eq(OrderEntity::getPaymentMethod, req.getPaymentMethod());
        }
        if (req.getPlanId() != null) {
            wrapper.eq(OrderEntity::getPlanId, req.getPlanId());
        }
        if (req.getMinAmount() != null) {
            wrapper.ge(OrderEntity::getActualAmount, req.getMinAmount());
        }
        if (req.getMaxAmount() != null) {
            wrapper.le(OrderEntity::getActualAmount, req.getMaxAmount());
        }
        if (req.getStartTime() != null) {
            wrapper.ge(OrderEntity::getCreatedAt, req.getStartTime());
        }
        if (req.getEndTime() != null) {
            wrapper.le(OrderEntity::getCreatedAt, req.getEndTime());
        }

        wrapper.orderByDesc(OrderEntity::getCreatedAt).last("LIMIT 10000");

        List<OrderEntity> orders = orderMapper.selectList(wrapper);

        // 批量获取用户名
        Set<Long> userIds = orders.stream().map(OrderEntity::getUserId).filter(Objects::nonNull).collect(Collectors.toSet());
        Map<Long, SysUser> userMap = new HashMap<>();
        if (!userIds.isEmpty()) {
            List<SysUser> users = sysUserMapper.selectBatchIds(userIds);
            userMap = users.stream().collect(Collectors.toMap(SysUser::getId, u -> u, (a, b) -> a));
        }

        // 构建 CSV
        StringBuilder sb = generateCsvHeaders();
        for (OrderEntity order : orders) {
            SysUser user = userMap.get(order.getUserId());
            String username = user != null ? user.getUsername() : "";
            String statusText = translateStatus(order.getStatus());

            sb.append(escapeCsv(order.getOrderNo())).append(",")
              .append(escapeCsv(username)).append(",")
              .append(escapeCsv(order.getPlanName())).append(",")
              .append(order.getAmount() != null ? order.getAmount().toPlainString() : "").append(",")
              .append(order.getActualAmount() != null ? order.getActualAmount().toPlainString() : "").append(",")
              .append(escapeCsv(order.getPaymentMethod())).append(",")
              .append(escapeCsv(order.getTradeNo())).append(",")
              .append(escapeCsv(statusText)).append(",")
              .append(order.getPaidAt() != null ? order.getPaidAt().format(CSV_DATE_FMT) : "").append(",")
              .append(order.getCreatedAt() != null ? order.getCreatedAt().format(CSV_DATE_FMT) : "")
              .append("\n");
        }

        log.info("[OrderService] 导出订单 CSV: 共 {} 条", orders.size());
        return sb.toString();
    }

    // ==================== VO 转换 ====================

    private PaymentDTO.OrderBriefVO toBriefVO(OrderEntity order) {
        PaymentDTO.OrderBriefVO vo = new PaymentDTO.OrderBriefVO();
        vo.setId(order.getId());
        vo.setOrderNo(order.getOrderNo());
        vo.setUserId(order.getUserId());
        vo.setUsername(order.getUsername());
        vo.setPlanName(order.getPlanName());
        vo.setActualAmount(order.getActualAmount());
        vo.setPaymentMethod(order.getPaymentMethod());
        vo.setTradeNo(order.getTradeNo());
        vo.setStatus(order.getStatus());
        vo.setPaidAt(order.getPaidAt());
        vo.setCreatedAt(order.getCreatedAt());
        return vo;
    }

    private PaymentDTO.OrderVO toDetailVO(OrderEntity order) {
        PaymentDTO.OrderVO vo = new PaymentDTO.OrderVO();
        vo.setId(order.getId());
        vo.setUuid(order.getUuid());
        vo.setOrderNo(order.getOrderNo());
        vo.setUserId(order.getUserId());
        vo.setUsername(order.getUsername());
        vo.setNickname(order.getNickname());
        vo.setPlanId(order.getPlanId());
        vo.setPlanName(order.getPlanName());
        vo.setAmount(order.getAmount());
        vo.setDiscountAmount(order.getDiscountAmount());
        vo.setActualAmount(order.getActualAmount());
        vo.setPaymentMethod(order.getPaymentMethod());
        vo.setPaymentProvider(order.getPaymentProvider());
        vo.setTradeNo(order.getTradeNo());
        vo.setStatus(order.getStatus());
        vo.setPaidAt(order.getPaidAt());
        vo.setRefundedAt(order.getRefundedAt());
        vo.setCancelledAt(order.getCancelledAt());
        vo.setExpiredAt(order.getExpiredAt());
        vo.setClientIp(order.getClientIp());
        vo.setRemark(order.getRemark());
        vo.setExtraData(order.getExtraData());
        vo.setCreatedAt(order.getCreatedAt());
        vo.setUpdatedAt(order.getUpdatedAt());

        // 填充用户名
        if (order.getUserId() != null) {
            SysUser user = sysUserMapper.selectById(order.getUserId());
            if (user != null) {
                vo.setUsername(user.getUsername());
                vo.setNickname(user.getEmail());
            }
        }

        return vo;
    }

    private PaymentDTO.PaymentRecordVO toPaymentRecordVO(PaymentRecord record) {
        PaymentDTO.PaymentRecordVO vo = new PaymentDTO.PaymentRecordVO();
        vo.setId(record.getId());
        vo.setUuid(record.getUuid());
        vo.setOrderId(record.getOrderId());
        vo.setOrderNo(record.getOrderNo());
        vo.setTradeNo(record.getTradeNo());
        vo.setAmount(record.getAmount());
        vo.setPaymentStatus(record.getPaymentStatus());
        vo.setVerifyStatus(record.getVerifyStatus());
        vo.setVerifyMsg(record.getVerifyMsg());
        vo.setCallbackContent(record.getCallbackContent());
        vo.setCallbackAt(record.getCallbackAt());
        vo.setRequestContent(record.getRequestContent());
        vo.setResponseContent(record.getResponseContent());
        vo.setErrorCode(record.getErrorCode());
        vo.setErrorMsg(record.getErrorMsg());
        vo.setCreatedAt(record.getCreatedAt());
        return vo;
    }

    private PaymentDTO.RefundRecordVO toRefundRecordVO(RefundRecord record) {
        PaymentDTO.RefundRecordVO vo = new PaymentDTO.RefundRecordVO();
        vo.setId(record.getId());
        vo.setUuid(record.getUuid());
        vo.setRefundNo(record.getRefundNo());
        vo.setOrderId(record.getOrderId());
        vo.setOrderNo(record.getOrderNo());
        vo.setTradeNo(record.getTradeNo());
        vo.setRefundAmount(record.getRefundAmount());
        vo.setTotalAmount(record.getTotalAmount());
        vo.setRefundStatus(record.getRefundStatus());
        vo.setReason(record.getReason());
        vo.setOperatorId(record.getOperatorId());
        vo.setOperatorName(record.getOperatorName());
        vo.setTradeRefundNo(record.getTradeRefundNo());
        vo.setCallbackContent(record.getCallbackContent());
        vo.setCallbackAt(record.getCallbackAt());
        vo.setErrorCode(record.getErrorCode());
        vo.setErrorMsg(record.getErrorMsg());
        vo.setCompletedAt(record.getCompletedAt());
        vo.setCreatedAt(record.getCreatedAt());

        // 填充操作人名称
        if (record.getOperatorId() != null && !StringUtils.hasText(record.getOperatorName())) {
            SysUser operator = sysUserMapper.selectById(record.getOperatorId());
            if (operator != null) {
                vo.setOperatorName(operator.getUsername());
            }
        }

        return vo;
    }

    private PaymentDTO.PayAuditLogVO toAuditLogVO(PayAuditLog log) {
        PaymentDTO.PayAuditLogVO vo = new PaymentDTO.PayAuditLogVO();
        vo.setId(log.getId());
        vo.setUuid(log.getUuid());
        vo.setOperatorId(log.getOperatorId());
        vo.setOperatorName(log.getOperatorName());
        vo.setOperatorIp(log.getOperatorIp());
        vo.setAction(log.getAction());
        vo.setTargetType(log.getTargetType());
        vo.setTargetId(log.getTargetId());
        vo.setDescription(log.getDescription());
        vo.setBeforeData(log.getBeforeData());
        vo.setAfterData(log.getAfterData());
        vo.setResult(log.getResult());
        vo.setErrorMsg(log.getErrorMsg());
        vo.setCreatedAt(log.getCreatedAt());
        return vo;
    }

    // ==================== 辅助方法 ====================

    /**
     * 批量填充订单列表中的用户名
     */
    private void fillUsernames(List<PaymentDTO.OrderBriefVO> voList) {
        if (voList.isEmpty()) return;

        Set<Long> userIds = voList.stream()
            .map(PaymentDTO.OrderBriefVO::getUserId)
            .filter(Objects::nonNull)
            .collect(Collectors.toSet());

        if (userIds.isEmpty()) return;

        List<SysUser> users = sysUserMapper.selectBatchIds(userIds);
        Map<Long, String> userIdToName = users.stream()
            .collect(Collectors.toMap(SysUser::getId, SysUser::getUsername, (a, b) -> a));

        for (PaymentDTO.OrderBriefVO vo : voList) {
            if (vo.getUserId() != null) {
                vo.setUsername(userIdToName.get(vo.getUserId()));
            }
        }
    }

    /**
     * 获取排序字段（防注入：白名单映射）
     */
    private String getSortColumn(String sortBy) {
        return switch (sortBy) {
            case "amount" -> "actual_amount";
            case "paid_at" -> "paid_at";
            case "updated_at" -> "updated_at";
            default -> "created_at";  // 默认按创建时间排序
        };
    }

    /**
     * 翻译订单状态为中文
     */
    private String translateStatus(String status) {
        return switch (status) {
            case "pending" -> "待支付";
            case "paid" -> "已支付";
            case "refunded" -> "已退款";
            case "cancelled" -> "已取消";
            case "expired" -> "已过期";
            default -> status != null ? status : "";
        };
    }

    /**
     * 生成 CSV 表头行
     */
    private StringBuilder generateCsvHeaders() {
        // BOM 头 + 表头
        StringBuilder sb = new StringBuilder();
        sb.append("\uFEFF");  // UTF-8 BOM
        sb.append("订单号,用户名,套餐名称,订单金额,实付金额,支付方式,交易流水号,订单状态,支付时间,创建时间\n");
        return sb;
    }

    /**
     * CSV 字段转义（包含逗号、引号、换行时用双引号包裹）
     */
    private String escapeCsv(String field) {
        if (field == null) return "";
        if (field.contains(",") || field.contains("\"") || field.contains("\n")) {
            return "\"" + field.replace("\"", "\"\"") + "\"";
        }
        return field;
    }
}
