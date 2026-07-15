package com.aiplatform.backend.service;

import com.aiplatform.backend.agent.AgentSessionContext;
import com.aiplatform.backend.agent.ToolDefinition;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.FileOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * 台账工具服务
 * <p>
 * 实现真实的台账生成逻辑：
 * 1. 上传千克表 Excel → 解析商品编码/名称 → 单位重量映射
 * 2. 上传台账模板 Excel → 保存模板文件供后续生成使用
 * 3. 上传订货 Excel（可选）
 * 4. 识别送货单图片（LLM Vision）
 * 5. 查询千克表（从上传的千克表数据中查询）
 * 6. 匹配台账模板（从上传的模板中匹配）
 * 7. 填入模板数据
 * 8. 生成台账文件（基于模板复制+填数据）
 * 9. 外网上报（可选）
 */
@Service
@Slf4j
@RequiredArgsConstructor
public class LedgerToolService {

    private final ObjectMapper objectMapper;
    /** 复用 AiService 的渠道负载均衡，不再硬编码 OpenAI */
    private final AiService aiService;

    @Value("${app.upload-dir:${java.io.tmpdir}/aiplatform/uploads}")
    private String uploadDir;

    @Value("${app.ledger-output-dir:${java.io.tmpdir}/aiplatform/ledgers}")
    private String ledgerOutputDir;

    @Value("${app.base-url:}")
    private String appBaseUrl;

    // ─── 内存存储（按 sessionId 隔离）─────────────────────────

    /**
     * 存储用户上传的千克表数据
     * key: sessionId, value: 千克表数据列表
     */
    private final Map<String, List<KgTableEntry>> kgTableStorage = new HashMap<>();

    /**
     * 存储用户上传的台账模板文件路径
     * key: sessionId, value: 模板文件路径
     */
    private final Map<String, String> templateFileStorage = new HashMap<>();

    /**
     * 存储识别出的送货单数据
     * key: sessionId, value: 送货单数据列表
     */
    private final Map<String, List<DeliveryNoteItem>> deliveryNoteStorage = new HashMap<>();

    /**
     * 存储已填入的台账数据行
     * key: sessionId, value: 已填入的行数据列表
     */
    private final Map<String, List<LedgerFilledRow>> filledRowsStorage = new HashMap<>();

    // ─── Tool 定义 ─────────────────────────────────────────────

    /**
     * 获取台账识别 Agent 所需的所有工具定义
     */
    public List<ToolDefinition> getBanBiaoTools() {
        return List.of(
            // 工具1：上传千克表
            ToolDefinition.of("upload_kg_table",
                "上传并解析千克表（换算表）Excel 文件，提取商品编码、商品名称、单位重量等数据。当用户上传千克表/换算表 Excel 时调用此工具。file_path 参数使用消息中的「服务器路径」。",
                Map.of(
                    "type", "object",
                    "properties", Map.of(
                        "file_path", Map.of("type", "string", "description", "千克表 Excel 文件的服务器路径（从用户消息中的「服务器路径」获取）")
                    ),
                    "required", List.of("file_path")
                )
            ),
            // 工具2：上传台账模板
            ToolDefinition.of("upload_template",
                "上传并保存台账模板 Excel 文件，后续生成台账时会基于此模板填充数据。当用户上传台账模板 Excel 时调用此工具。file_path 参数使用消息中的「服务器路径」。",
                Map.of(
                    "type", "object",
                    "properties", Map.of(
                        "file_path", Map.of("type", "string", "description", "台账模板 Excel 文件的服务器路径（从用户消息中的「服务器路径」获取）")
                    ),
                    "required", List.of("file_path")
                )
            ),
            // 工具3：上传订货 Excel（可选）
            ToolDefinition.of("upload_procurement_excel",
                "上传订货 Excel 文件，从中提取商品清单。如果用户提供了订货 Excel 文件，调用此工具解析。file_path 参数使用消息中的「服务器路径」。",
                Map.of(
                    "type", "object",
                    "properties", Map.of(
                        "file_path", Map.of("type", "string", "description", "上传的 Excel 文件路径（从用户消息中的「服务器路径」获取）")
                    ),
                    "required", List.of("file_path")
                )
            ),
            // 工具4：识别送货单图片
            ToolDefinition.of("recognize_delivery_image",
                "识别送货单图片，提取商品编码、件数、箱数、生产日期等信息。当用户上传送货单图片时调用此工具。image_path 参数使用用户消息中「服务器路径」对应的值（格式：[已上传图片: 文件名，服务器路径: /path/to/img.jpg]）。",
                Map.of(
                    "type", "object",
                    "properties", Map.of(
                        "image_path", Map.of("type", "string", "description", "图片的服务器路径（从用户消息中「服务器路径」获取，优先使用此参数）"),
                        "image_base64", Map.of("type", "string", "description", "图片的 base64 编码（与 image_path 二选一，当没有服务器路径时使用）"),
                        "mime_type", Map.of("type", "string", "description", "图片 MIME 类型（如 image/jpeg, image/png），默认 image/jpeg")
                    ),
                    "required", List.of()
                )
            ),
            // 工具5：一键批量生成台账（核心工具！推荐优先使用）
            ToolDefinition.of("batch_generate_ledger",
                "一键批量生成台账：自动对识别出的所有商品执行查千克表、匹配模板、填入数据、生成Excel文件。推荐在 recognize_delivery_image 之后直接调用此工具，无需逐个商品调用 query_kg_table/match_ledger_template/fill_ledger_template/generate_ledger_file。参数 delivery_date 为进货日期，ledger_title 为台账标题。",
                Map.of(
                    "type", "object",
                    "properties", Map.of(
                        "delivery_date", Map.of("type", "string", "description", "进货日期/送货日期（YYYY-MM-DD 格式，默认今天）"),
                        "ledger_title", Map.of("type", "string", "description", "台账标题（如'食品台账'，默认'材料台账'）")
                    ),
                    "required", List.of()
                )
            ),
            // 工具6：查询千克表（保留供单独查询使用）
            ToolDefinition.of("query_kg_table",
                "查询千克表，获取商品的单位重量等参考数据。仅在需要单独查询某个商品时使用，批量生成台账时无需手动调用。",
                Map.of(
                    "type", "object",
                    "properties", Map.of(
                        "material_name", Map.of("type", "string", "description", "商品/材料名称（支持模糊匹配）"),
                        "product_code", Map.of("type", "string", "description", "商品编码（可选，更精确的匹配）")
                    ),
                    "required", List.of("material_name")
                )
            ),
            // 工具7：生成台账文件（保留供单独使用）
            ToolDefinition.of("generate_ledger_file",
                "根据已填入的数据生成台账 Excel 文件。仅在单独填入数据后使用，批量生成台账时无需手动调用。",
                Map.of(
                    "type", "object",
                    "properties", Map.of(
                        "ledger_title", Map.of("type", "string", "description", "台账标题（如'食品台账'）")
                    ),
                    "required", List.of("ledger_title")
                )
            ),
            // 工具8：外网上报（可选）
            ToolDefinition.of("external_upload",
                "将生成的台账文件上报到外部系统（如 TastyQube）。可选操作，用户明确请求时才调用。",
                Map.of(
                    "type", "object",
                    "properties", Map.of(
                        "file_path", Map.of("type", "string", "description", "台账文件路径"),
                        "external_system", Map.of("type", "string", "description", "外部系统名称（如'TastyQube'）")
                    ),
                    "required", List.of("file_path")
                )
            )
        );
    }

    // ─── Tool 执行器 ─────────────────────────────────────────

    /**
     * 执行台账识别 Agent 的工具
     */
    public String executeBanBiaoTool(String toolName, String argumentsJson, String sessionId) {
        try {
            JsonNode args = objectMapper.readTree(argumentsJson);
            return switch (toolName) {
                case "upload_kg_table" -> uploadKgTable(args, sessionId);
                case "upload_template" -> uploadTemplate(args, sessionId);
                case "upload_procurement_excel" -> uploadProcurementExcel(args, sessionId);
                case "recognize_delivery_image" -> recognizeDeliveryImage(args, sessionId);
                case "batch_generate_ledger" -> batchGenerateLedger(args, sessionId);
                case "query_kg_table" -> queryKgTable(args, sessionId);
                case "match_ledger_template" -> matchLedgerTemplate(args, sessionId);
                case "fill_ledger_template" -> fillLedgerTemplate(args, sessionId);
                case "generate_ledger_file" -> generateLedgerFile(args, sessionId);
                case "external_upload" -> externalUpload(args, sessionId);
                default -> "{\"error\": \"未知工具: " + toolName + "\"}";
            };
        } catch (Exception e) {
            log.error("[BanBiao] 工具执行失败: {} - {}", toolName, e.getMessage(), e);
            return "{\"error\": \"工具执行失败: " + e.getMessage().replace("\"", "'") + "\"}";
        }
    }

    // ─── 工具1：上传千克表 ─────────────────────────────────

    private String uploadKgTable(JsonNode args, String sessionId) throws Exception {
        String filePath = resolveFilePath(args, "千克表");
        log.info("[BanBiao] 上传千克表: {}", filePath);

        if (!Files.exists(Path.of(filePath))) {
            return "{\"error\": \"文件不存在: " + filePath + "\"}";
        }

        // 读取 Excel 文件，尝试智能解析千克表
        List<KgTableEntry> entries = new ArrayList<>();
        try (Workbook workbook = WorkbookFactory.create(Files.newInputStream(Path.of(filePath)))) {
            Sheet sheet = workbook.getSheetAt(0);
            // 扫描前10行找到表头行（包含"编码"/"代码"/"名称"等关键词）
            int headerRowIdx = -1;
            for (int r = 0; r <= Math.min(10, sheet.getLastRowNum()); r++) {
                Row row = sheet.getRow(r);
                if (row == null) continue;
                for (int c = 0; c < Math.min(row.getLastCellNum(), 20); c++) {
                    String cellVal = getCellValueAsString(row.getCell(c)).trim();
                    if (cellVal.contains("编码") || cellVal.contains("代码") || cellVal.contains("名称") || cellVal.contains("品名")) {
                        headerRowIdx = r;
                        break;
                    }
                }
                if (headerRowIdx >= 0) break;
            }
            if (headerRowIdx < 0) {
                return "{\"error\": \"无法识别千克表列头，请确保Excel包含'编码'或'名称'列\"}";
            }
            Row headerRow = sheet.getRow(headerRowIdx);
            log.info("[BanBiao] 千克表表头在第 {} 行", headerRowIdx);

            if (headerRow == null) {
                return "{\"error\": \"千克表 Excel 为空或格式异常\"}";
            }

            // 尝试识别列头
            int codeCol = -1, nameCol = -1, specCol = -1, weightCol = -1;
            for (int c = 0; c < headerRow.getLastCellNum(); c++) {
                String headerVal = getCellValueAsString(headerRow.getCell(c)).trim();
                String headerLower = headerVal.toLowerCase();
                if (headerLower.contains("编码") || headerLower.contains("代码") || headerLower.equalsIgnoreCase("code")) {
                    codeCol = c;
                } else if (headerLower.contains("名称") || headerLower.contains("品名") || headerLower.equalsIgnoreCase("name")) {
                    nameCol = c;
                } else if (headerLower.contains("规格") || headerLower.contains("型号") || headerLower.equalsIgnoreCase("spec")) {
                    specCol = c;
                } else if (headerLower.contains("千克") || headerLower.contains("重量") || headerLower.contains("kg")
                        || headerLower.contains("单位重") || headerLower.contains("单重")
                        || headerLower.contains("净重") || headerLower.contains("毛重")
                        || headerLower.contains("件重") || headerLower.contains("单件重")
                        || headerLower.contains("kg/件") || headerLower.contains("kg/箱")) {
                    weightCol = c;
                }
            }

            log.info("[BanBiao] 千克表列识别: codeCol={}, nameCol={}, specCol={}, weightCol={}", codeCol, nameCol, specCol, weightCol);
            // 诊断：打印所有表头值
            List<String> allKgHeaders = new ArrayList<>();
            for (int c = 0; c < headerRow.getLastCellNum(); c++) {
                allKgHeaders.add(getCellValueAsString(headerRow.getCell(c)).trim());
            }
            log.info("[BanBiao] 千克表表头值(行{}): {}", headerRowIdx, allKgHeaders);

            // 如果没有识别到列头，按默认顺序假设（编码、名称、规格、重量）
            if (codeCol < 0 && nameCol < 0) {
                int colCount = headerRow.getLastCellNum();
                if (colCount >= 4) {
                    codeCol = 0; nameCol = 1; specCol = 2; weightCol = 3;
                } else if (colCount >= 2) {
                    codeCol = 0; nameCol = 1;
                }
            }
            // 兜底：如果识别了编码/名称列但重量列未识别，尝试把最后一个数值列当重量列
            if (weightCol < 0 && codeCol >= 0) {
                int colCount = headerRow.getLastCellNum();
                for (int c = colCount - 1; c >= 0; c--) {
                    if (c != codeCol && c != nameCol && c != specCol) {
                        // 检查前几行数据看这个列是否是数值
                        for (int r = headerRowIdx + 1; r <= Math.min(headerRowIdx + 3, sheet.getLastRowNum()); r++) {
                            Row testRow = sheet.getRow(r);
                            if (testRow != null && testRow.getCell(c) != null
                                    && testRow.getCell(c).getCellType() == CellType.NUMERIC) {
                                weightCol = c;
                                log.info("[BanBiao] 千克表重量列兜底识别: 第{}列 (表头='{}')", c, allKgHeaders.size() > c ? allKgHeaders.get(c) : "?");
                                break;
                            }
                        }
                        if (weightCol >= 0) break;
                    }
                }
            }

            // 解析数据行（从表头行的下一行开始）
            for (int r = headerRowIdx + 1; r <= sheet.getLastRowNum(); r++) {
                Row row = sheet.getRow(r);
                if (row == null) continue;

                String code = codeCol >= 0 ? getCellValueAsString(row.getCell(codeCol)).trim() : "";
                String name = nameCol >= 0 ? getCellValueAsString(row.getCell(nameCol)).trim() : "";
                String spec = specCol >= 0 ? getCellValueAsString(row.getCell(specCol)).trim() : "";
                double weight = 0;
                if (weightCol >= 0) {
                    Cell weightCell = row.getCell(weightCol);
                    if (weightCell != null) {
                        if (weightCell.getCellType() == CellType.NUMERIC) {
                            weight = weightCell.getNumericCellValue();
                        } else {
                            try { weight = Double.parseDouble(getCellValueAsString(weightCell).trim()); } catch (Exception ignored) {}
                        }
                    }
                }

                // 跳过空行
                if (code.isEmpty() && name.isEmpty()) continue;

                KgTableEntry entry = new KgTableEntry();
                entry.setProductCode(code);
                entry.setMaterialName(name);
                entry.setSpecification(spec);
                entry.setUnitWeightKg(weight);
                entries.add(entry);
            }
        }

        // 存储到 session
        kgTableStorage.put(sessionId, entries);

        ObjectNode result = objectMapper.createObjectNode();
        result.put("status", "success");
        result.put("item_count", entries.size());
        result.put("message", "千克表已解析，共" + entries.size() + "条记录");

        // 返回前5条数据预览
        ArrayNode preview = result.putArray("preview");
        for (int i = 0; i < Math.min(5, entries.size()); i++) {
            KgTableEntry e = entries.get(i);
            ObjectNode item = preview.addObject();
            item.put("product_code", e.getProductCode());
            item.put("material_name", e.getMaterialName());
            item.put("specification", e.getSpecification());
            item.put("unit_weight_kg", e.getUnitWeightKg());
        }
        if (entries.size() > 5) {
            result.put("more", "还有 " + (entries.size() - 5) + " 条记录未显示");
        }

        return result.toString();
    }

    // ─── 工具2：上传台账模板 ─────────────────────────────────

    private String uploadTemplate(JsonNode args, String sessionId) throws Exception {
        String filePath = resolveFilePath(args, "台账模板");
        log.info("[BanBiao] 上传台账模板: {}", filePath);

        if (!Files.exists(Path.of(filePath))) {
            return "{\"error\": \"文件不存在: " + filePath + "\"}";
        }

        // 读取模板 Excel，分析结构
        List<String> headers = new ArrayList<>();
        int dataRowCount = 0;
        try (Workbook workbook = WorkbookFactory.create(Files.newInputStream(Path.of(filePath)))) {
            Sheet sheet = workbook.getSheetAt(0);
            // 扫描前15行找表头行
            int headerRowIdx = findHeaderRow(sheet, 15);
            Row headerRow = sheet.getRow(headerRowIdx);
            if (headerRow != null) {
                for (int c = 0; c < headerRow.getLastCellNum(); c++) {
                    Cell cell = headerRow.getCell(c);
                    String val = getCellValueAsString(cell).trim();
                    headers.add(val);
                }
            }
            dataRowCount = sheet.getLastRowNum() - headerRowIdx; // 不含表头
            log.info("[BanBiao] 模板上传: 表头行={}, 列数={}, 表头值={}", headerRowIdx, headers.size(), headers);
        }

        // 保存模板文件路径（后续生成台账时基于此模板复制）
        templateFileStorage.put(sessionId, filePath);

        // 初始化空的填入数据列表
        filledRowsStorage.putIfAbsent(sessionId, new ArrayList<>());

        ObjectNode result = objectMapper.createObjectNode();
        result.put("status", "success");
        result.put("template_path", filePath);
        result.put("header_count", headers.size());
        result.put("data_rows_in_template", dataRowCount);
        ArrayNode headersArray = result.putArray("headers");
        headers.forEach(headersArray::add);
        result.put("message", "台账模板已加载，包含 " + headers.size() + " 列: " + String.join(", ", headers));

        return result.toString();
    }

    // ─── 工具3：上传订货 Excel ─────────────────────────────────

    private String uploadProcurementExcel(JsonNode args, String sessionId) throws Exception {
        String filePath = resolveFilePath(args, "订货Excel");
        log.info("[BanBiao] 上传订货Excel: {}", filePath);

        if (!Files.exists(Path.of(filePath))) {
            return "{\"error\": \"文件不存在: " + filePath + "\"}";
        }

        List<ProcurementItem> items = new ArrayList<>();
        try (Workbook workbook = WorkbookFactory.create(Files.newInputStream(Path.of(filePath)))) {
            Sheet sheet = workbook.getSheetAt(0);
            for (Row row : sheet) {
                if (row.getRowNum() == 0) continue;
                ProcurementItem item = new ProcurementItem();
                item.setProductCode(getCellValueAsString(row.getCell(0)));
                item.setMaterialName(getCellValueAsString(row.getCell(1)));
                item.setSpecification(getCellValueAsString(row.getCell(2)));
                item.setQuantity(row.getCell(3) != null ? getNumericCellValueSafe(row.getCell(3)) : 0);
                items.add(item);
            }
        }

        ObjectNode result = objectMapper.createObjectNode();
        result.put("status", "success");
        result.put("item_count", items.size());
        ArrayNode itemsArray = result.putArray("items");
        for (ProcurementItem item : items) {
            ObjectNode itemNode = itemsArray.addObject();
            itemNode.put("product_code", item.getProductCode());
            itemNode.put("material_name", item.getMaterialName());
            itemNode.put("specification", item.getSpecification());
            itemNode.put("quantity", item.getQuantity());
        }
        result.put("message", "订货Excel已解析，共" + items.size() + "条记录");

        return result.toString();
    }

    // ─── 工具4：识别送货单图片 ─────────────────────────────────

    private String recognizeDeliveryImage(JsonNode args, String sessionId) throws Exception {
        String imageBase64 = args.path("image_base64").asText(null);
        String imagePath = args.path("image_path").asText(null);
        String mimeType = args.path("mime_type").asText("image/jpeg");

        log.info("[BanBiao] 识别送货单图片: imagePath={}, hasBase64={}", imagePath, imageBase64 != null && !imageBase64.isEmpty());

        // 优先级1：从 image_path 读取图片
        if (imagePath != null && !imagePath.isEmpty()) {
            // 🔧 支持 HTTP/HTTPS URL（OSS 签名 URL）
            if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
                try {
                    log.info("[BanBiao] 从 OSS URL 下载图片: {}", imagePath);
                    java.net.http.HttpClient client = java.net.http.HttpClient.newBuilder()
                            .connectTimeout(java.time.Duration.ofSeconds(10))
                            .build();
                    java.net.http.HttpRequest req = java.net.http.HttpRequest.newBuilder()
                            .uri(java.net.URI.create(imagePath))
                            .timeout(java.time.Duration.ofSeconds(30))
                            .GET().build();
                    java.net.http.HttpResponse<byte[]> resp = client.send(req,
                            java.net.http.HttpResponse.BodyHandlers.ofByteArray());
                    if (resp.statusCode() == 200) {
                        byte[] imageBytes = resp.body();
                        imageBase64 = Base64.getEncoder().encodeToString(imageBytes);
                        log.info("[BanBiao] 从 OSS URL 下载图片成功: {} bytes", imageBytes.length);
                        if (imagePath.toLowerCase().endsWith(".png")) mimeType = "image/png";
                        else if (imagePath.toLowerCase().endsWith(".gif")) mimeType = "image/gif";
                        else if (imagePath.toLowerCase().endsWith(".webp")) mimeType = "image/webp";
                        else mimeType = "image/jpeg";
                    } else {
                        log.warn("[BanBiao] OSS URL 下载失败: HTTP {}", resp.statusCode());
                    }
                } catch (Exception e) {
                    log.warn("[BanBiao] OSS URL 下载异常: {}", e.getMessage());
                }
            } else {
                // 本地文件路径
                Path imgFile = Path.of(imagePath);
                if (Files.exists(imgFile)) {
                    byte[] imageBytes = Files.readAllBytes(imgFile);
                    imageBase64 = Base64.getEncoder().encodeToString(imageBytes);
                    String lowerPath = imagePath.toLowerCase();
                    if (lowerPath.endsWith(".png")) mimeType = "image/png";
                    else if (lowerPath.endsWith(".gif")) mimeType = "image/gif";
                    else if (lowerPath.endsWith(".webp")) mimeType = "image/webp";
                    else mimeType = "image/jpeg";
                    log.info("[BanBiao] 从路径读取图片: {} ({} bytes)", imagePath, imageBytes.length);
                } else {
                    log.warn("[BanBiao] 图片路径不存在: {}", imagePath);
                    return "{\"error\": \"图片文件不存在: " + imagePath + "，请重新上传图片\"}";
                }
            }
        }

        // 优先级2：从 AgentSessionContext 中获取已上传的图片
        if ((imageBase64 == null || imageBase64.isEmpty()) && AgentSessionContext.getUploadedFilePaths() != null) {
            for (String path : AgentSessionContext.getUploadedFilePaths()) {
                String lp = path.toLowerCase();
                if (lp.endsWith(".jpg") || lp.endsWith(".jpeg") || lp.endsWith(".png")
                        || lp.endsWith(".gif") || lp.endsWith(".webp") || lp.endsWith(".bmp")) {
                    if (Files.exists(Path.of(path))) {
                        byte[] imageBytes = Files.readAllBytes(Path.of(path));
                        imageBase64 = Base64.getEncoder().encodeToString(imageBytes);
                        if (lp.endsWith(".png")) mimeType = "image/png";
                        else if (lp.endsWith(".gif")) mimeType = "image/gif";
                        else if (lp.endsWith(".webp")) mimeType = "image/webp";
                        else mimeType = "image/jpeg";
                        log.info("[BanBiao] 从 SessionContext 获取图片: {} ({} bytes)", path, imageBytes.length);
                        break;
                    }
                }
            }
        }

        if (imageBase64 == null || imageBase64.isEmpty()) {
            return "{\"error\": \"未找到图片数据。请先上传送货单图片，或在消息中包含图片的服务器路径\"}";
        }

        String visionResponse = callVisionAPI(imageBase64, null, mimeType);
        List<DeliveryNoteItem> items = parseVisionResponse(visionResponse);

        deliveryNoteStorage.put(sessionId, items);

        ObjectNode result = objectMapper.createObjectNode();
        result.put("status", "success");
        result.put("recognition_result", visionResponse);
        ArrayNode itemsArray = result.putArray("items");
        for (DeliveryNoteItem item : items) {
            ObjectNode itemNode = itemsArray.addObject();
            itemNode.put("product_code", item.getProductCode());
            itemNode.put("material_name", item.getMaterialName());
            itemNode.put("piece_count", item.getPieceCount());
            itemNode.put("box_count", item.getBoxCount());
            itemNode.put("production_date", item.getProductionDate());
            itemNode.put("confidence", item.getConfidence());
        }
        result.put("item_count", items.size());
        result.put("message", "送货单识别完成，共识别" + items.size() + "条记录");

        return result.toString();
    }

    /**
     * 调用 LLM Vision API 识别图片
     * imageBase64 优先，imageUrl 作为备用
     */
    private String callVisionAPI(String imageBase64, String imageUrl, String mimeType) throws Exception {
        String prompt = """
            请仔细分析这张送货单图片，提取以下信息并以标准 JSON 数组格式返回。
            每个商品一个对象，字段如下：
            - product_code: 商品编码
            - material_name: 材料/商品名称
            - piece_count: 件数/拆零数
            - box_count: 箱数
            - production_date: 生产日期（YYYY-MM-DD 格式）
            - confidence: 置信度（0-1 之间的小数）

            严格要求：
            1. 只返回纯 JSON 数组文本，不要 markdown 代码块（不要 ```json），不要任何额外说明文字
            2. 如果图片中有多个商品，返回包含多个对象的 JSON 数组，如 [{"product_code":"123","piece_count":2,...}, ...]
            3. 如果某个字段无法识别，设置为 null
            4. JSON 中不要出现 trailing comma（逗号后面不能紧跟 ] 或 }）
            5. 使用英文双引号，不要使用中文引号
            """;

        String base64ToUse = imageBase64;
        if ((base64ToUse == null || base64ToUse.isEmpty()) && imageUrl != null && !imageUrl.isEmpty()) {
            if (imageUrl.startsWith("data:")) {
                int commaIdx = imageUrl.indexOf(',');
                base64ToUse = commaIdx >= 0 ? imageUrl.substring(commaIdx + 1) : imageUrl;
            } else {
                base64ToUse = imageUrl;
            }
        }

        String visionModel = AgentSessionContext.getModel();
        return aiService.callVisionForTool(visionModel, prompt, base64ToUse, mimeType);
    }

    private List<DeliveryNoteItem> parseVisionResponse(String visionResponse) throws Exception {
        String cleaned = cleanVisionJson(visionResponse);
        List<DeliveryNoteItem> items = new ArrayList<>();
        JsonNode jsonNode = objectMapper.readTree(cleaned);

        if (jsonNode.isArray()) {
            for (JsonNode itemNode : jsonNode) {
                items.add(parseDeliveryNoteItem(itemNode));
            }
        } else if (jsonNode.isObject()) {
            if (jsonNode.has("items")) {
                for (JsonNode itemNode : jsonNode.path("items")) {
                    items.add(parseDeliveryNoteItem(itemNode));
                }
            } else {
                items.add(parseDeliveryNoteItem(jsonNode));
            }
        }
        return items;
    }

    /**
     * 清洗 Vision API 返回的非标准 JSON 文本。
     * LLM 返回的 JSON 常被 markdown 代码块包裹、含 trailing comma、中文引号等，
     * 直接解析会失败。本方法做多层容错清洗后再交给 Jackson 解析。
     *
     * @param raw Vision API 原始返回文本
     * @return 清洗后的合法 JSON 字符串
     */
    private String cleanVisionJson(String raw) {
        if (raw == null || raw.isBlank()) {
            return "[]";
        }
        String s = raw.trim();

        // 1. 去除 markdown 代码块标记 ```json ... ```
        if (s.startsWith("```")) {
            s = s.replaceFirst("(?i)^```(?:json)?\\s*", "");
            s = s.replaceFirst("```\\s*$", "");
            s = s.trim();
        }

        // 2. 提取 JSON 数组片段：找到最外层的 [ ... ]
        int lb = s.indexOf('[');
        int rb = s.lastIndexOf(']');
        if (lb != -1 && rb != -1 && rb > lb) {
            s = s.substring(lb, rb + 1);
        } else {
            // 没有数组，尝试找对象 { ... }
            int lob = s.indexOf('{');
            int rob = s.lastIndexOf('}');
            if (lob != -1 && rob != -1 && rob > lob) {
                s = s.substring(lob, rob + 1);
            } else if (!s.startsWith("{")) {
                // 完全不是 JSON，返回空数组
                return "[]";
            }
        }

        // 3. 修复 trailing comma（如 [1,2,] 或 {"a":1,}）
        s = s.replaceAll(",\\s*([\\]\\}])", "$1");

        // 4. 处理中文引号为英文引号（LLM OCR 常见错误）
        s = s.replace("\u201C", "\"").replace("\u201D", "\"");

        return s;
    }

    private DeliveryNoteItem parseDeliveryNoteItem(JsonNode node) {
        DeliveryNoteItem item = new DeliveryNoteItem();
        item.setProductCode(node.path("product_code").asText(null));
        item.setMaterialName(node.path("material_name").asText(null));
        item.setPieceCount(node.path("piece_count").asInt(0));
        item.setBoxCount(node.path("box_count").asInt(0));
        item.setProductionDate(node.path("production_date").asText(null));
        item.setConfidence(node.path("confidence").asDouble(0.8));
        return item;
    }

    // ─── 工具5：一键批量生成台账 ─────────────────────────────────

    /**
     * 一键批量生成台账：自动对所有已识别的商品执行查千克表 + 匹配模板 + 填数据 + 生成文件。
     * 将原来需要 3N+2 轮 ReAct 的流程压缩为 1 轮工具调用。
     */
    private String batchGenerateLedger(JsonNode args, String sessionId) throws Exception {
        String deliveryDate = args.path("delivery_date").asText(LocalDate.now().format(DateTimeFormatter.ISO_DATE));
        String ledgerTitle = args.path("ledger_title").asText("材料台账");

        log.info("[BanBiao] 一键批量生成台账: deliveryDate={}, title={}", deliveryDate, ledgerTitle);

        // 1. 获取识别出的送货单数据
        List<DeliveryNoteItem> deliveryItems = deliveryNoteStorage.get(sessionId);
        if (deliveryItems == null || deliveryItems.isEmpty()) {
            return "{\"error\": \"没有已识别的送货单数据，请先调用 recognize_delivery_image 识别送货单图片\"}";
        }

        // 2. 获取千克表数据
        List<KgTableEntry> kgData = kgTableStorage.getOrDefault(sessionId, List.of());
        log.info("[BanBiao] 千克表数据量: {}, 送货单商品数: {}", kgData.size(), deliveryItems.size());
        if (!kgData.isEmpty()) {
            log.info("[BanBiao] 千克表示例(前3): {}", kgData.subList(0, Math.min(3, kgData.size())).stream()
                    .map(e -> e.getProductCode() + "/" + e.getMaterialName() + "/" + e.getUnitWeightKg())
                    .toList());
        }
        if (!deliveryItems.isEmpty()) {
            log.info("[BanBiao] 送货单示例(前3): {}", deliveryItems.subList(0, Math.min(3, deliveryItems.size())).stream()
                    .map(i -> i.getProductCode() + "/" + i.getMaterialName())
                    .toList());
        }

        // 2a. 构建千克表规范化映射（与 Python _norm_code 对齐：提纯数字、去前导零）
        Map<String, KgTableEntry> kgNormMap = new HashMap<>();
        for (KgTableEntry entry : kgData) {
            String normCode = normalizeCode(entry.getProductCode());
            if (!normCode.isEmpty()) {
                kgNormMap.put(normCode, entry);
            }
        }
        log.info("[BanBiao] 千克表规范化映射量: {}, 示例(前5): {}", 
            kgNormMap.size(),
            kgNormMap.entrySet().stream().limit(5)
                .map(e -> e.getKey() + "/" + e.getValue().getMaterialName())
                .toList());

        // 3. 获取模板文件路径
        String templatePath = templateFileStorage.get(sessionId);

        // 4. 批量处理每个商品：查千克表 + 匹配模板 + 填数据
        List<LedgerFilledRow> rows = filledRowsStorage.computeIfAbsent(sessionId, k -> new ArrayList<>());
        rows.clear(); // 清除旧数据，重新批量填入

        int matchedCount = 0;
        int kgMatchedCount = 0;
        int notFoundInKg = 0;
        int notFoundInTemplate = 0;

        // 预加载模板列映射（如果模板存在）
        Map<String, Integer> templateColMap = null;
        Map<String, Integer> templateRowMap = null; // productCode -> rowNum
        int templateHeaderRowIdx = 0;
        if (templatePath != null && Files.exists(Path.of(templatePath))) {
            templateColMap = new HashMap<>();
            templateRowMap = new HashMap<>();
            try (Workbook workbook = WorkbookFactory.create(Files.newInputStream(Path.of(templatePath)))) {
                Sheet sheet = workbook.getSheetAt(0);
                // 扫描前15行找表头行
                templateHeaderRowIdx = findHeaderRow(sheet, 15);
                Row headerRow = sheet.getRow(templateHeaderRowIdx);
                if (headerRow != null) {
                    for (int c = 0; c < headerRow.getLastCellNum(); c++) {
                        String h = getCellValueAsString(headerRow.getCell(c)).trim().toLowerCase();
                        if (h.contains("编码") || h.contains("代码") || h.contains("货号")) templateColMap.put("code", c);
                        else if (h.contains("名称") || h.contains("品名")) templateColMap.put("name", c);
                    }
                    // 诊断日志：打印模板表头所有列值
                    List<String> allHeaders = new ArrayList<>();
                    for (int c = 0; c < headerRow.getLastCellNum(); c++) {
                        allHeaders.add(getCellValueAsString(headerRow.getCell(c)).trim());
                    }
                    log.info("[BanBiao] 模板预加载: 表头行={}, 列映射={}, 表头值={}", templateHeaderRowIdx, templateColMap, allHeaders);
                }
                // 构建模板行映射（从表头行+1开始）
                int codeCol = templateColMap.getOrDefault("code", -1);
                for (int r = templateHeaderRowIdx + 1; r <= sheet.getLastRowNum(); r++) {
                    Row row = sheet.getRow(r);
                    if (row == null) continue;
                    if (codeCol >= 0) {
                        String cellCode = getCellValueAsString(row.getCell(codeCol)).trim();
                        String normCode = normalizeCode(cellCode);
                        if (!cellCode.isEmpty()) templateRowMap.put(cellCode, r);
                        if (!normCode.isEmpty() && !normCode.equals(cellCode)) templateRowMap.put(normCode, r);
                    }
                }
            } catch (Exception e) {
                log.warn("[BanBiao] 读取模板列映射失败: {}", e.getMessage());
            }
        }

        for (DeliveryNoteItem item : deliveryItems) {
            // 3a. 查千克表：先精确匹配，再规范化匹配，再名称模糊匹配
            double unitWeightKg = 0;
            boolean kgFound = false;
            String itemCode = item.getProductCode();
            String itemName = item.getMaterialName();
            String itemCodeNorm = normalizeCode(itemCode);

            for (KgTableEntry entry : kgData) {
                // 精确编码匹配
                if (itemCode != null && !itemCode.isEmpty() && entry.getProductCode() != null) {
                    if (entry.getProductCode().equals(itemCode) || entry.getProductCode().contains(itemCode) || itemCode.contains(entry.getProductCode())) {
                        unitWeightKg = entry.getUnitWeightKg();
                        kgFound = true;
                        kgMatchedCount++;
                        break;
                    }
                }
                // 名称模糊匹配
                if (!kgFound && itemName != null && !itemName.isEmpty() && entry.getMaterialName() != null) {
                    if (entry.getMaterialName().contains(itemName) || itemName.contains(entry.getMaterialName())) {
                        unitWeightKg = entry.getUnitWeightKg();
                        kgFound = true;
                        kgMatchedCount++;
                        break;
                    }
                }
            }

            // 规范化编码匹配（对齐 Python _norm_code：提取纯数字、去前导零）
            if (!kgFound && !itemCodeNorm.isEmpty() && kgNormMap.containsKey(itemCodeNorm)) {
                unitWeightKg = kgNormMap.get(itemCodeNorm).getUnitWeightKg();
                kgFound = true;
                kgMatchedCount++;
                // 补回精确匹配的计数（上面没匹配到，这里补上）
            }

            if (!kgFound) {
                notFoundInKg++;
                log.warn("[BanBiao] 千克表未匹配: code={}, name={}, normCode={}, kgNorm样本(前10)={}",
                    itemCode, itemName, itemCodeNorm,
                    kgNormMap.keySet().stream().limit(10).toList());
            }

            // 3b. 匹配模板（同时用原始编码和规范化编码匹配）
            boolean templateMatched = false;
            if (templateRowMap != null && item.getProductCode() != null) {
                templateMatched = templateRowMap.containsKey(item.getProductCode());
                if (!templateMatched) templateMatched = templateRowMap.containsKey(itemCodeNorm);
            }
            if (templateMatched) matchedCount++;
            else notFoundInTemplate++;

            // 3c. 填入数据
            LedgerFilledRow row = new LedgerFilledRow();
            row.setProductCode(item.getProductCode());
            row.setProductName(item.getMaterialName());
            row.setBoxCount(item.getBoxCount() > 0 ? item.getBoxCount() : item.getPieceCount());
            row.setUnitWeightKg(unitWeightKg);
            row.setTotalWeightKg(unitWeightKg > 0 ? row.getBoxCount() * unitWeightKg : 0);
            row.setProductionDate(item.getProductionDate());
            row.setDeliveryDate(deliveryDate);
            rows.add(row);
        }

        log.info("[BanBiao] 批量处理完成: {}个商品, 千克表匹配={}, 未匹配={}, 模板匹配={}, 未匹配={}",
                deliveryItems.size(), kgMatchedCount, notFoundInKg, matchedCount, notFoundInTemplate);

        // 5. 生成台账文件
        if (rows.isEmpty()) {
            return "{\"error\": \"没有可填入的台账数据\"}";
        }

        Files.createDirectories(Path.of(ledgerOutputDir));
        String outputFileName = ledgerTitle + "_" + System.currentTimeMillis() + ".xlsx";
        String outputPath = Path.of(ledgerOutputDir, outputFileName).toString();

        if (templatePath != null && Files.exists(Path.of(templatePath))) {
            generateFromTemplate(templatePath, outputPath, rows, ledgerTitle);
        } else {
            generateDefault(outputPath, rows, ledgerTitle);
        }

        // 构建下载 URL
        String downloadPath = "/api/v1/ledger/download/" + outputFileName;
        String downloadUrl = (appBaseUrl != null && !appBaseUrl.isBlank())
                ? appBaseUrl.replaceAll("/$", "") + downloadPath
                : downloadPath;

        // 6. 构建结果
        ObjectNode result = objectMapper.createObjectNode();
        result.put("status", "success");
        result.put("total_items", deliveryItems.size());
        result.put("kg_matched", kgMatchedCount);
        result.put("kg_not_found", notFoundInKg);
        result.put("template_matched", matchedCount);
        result.put("template_not_found", notFoundInTemplate);
        result.put("file_name", outputFileName);
        result.put("file_path", outputPath);
        result.put("download_url", downloadUrl);
        result.put("row_count", rows.size());

        // 返回商品摘要（前10个）
        ArrayNode summaryArray = result.putArray("items_summary");
        int previewLimit = Math.min(10, rows.size());
        for (int i = 0; i < previewLimit; i++) {
            LedgerFilledRow r = rows.get(i);
            ObjectNode itemNode = summaryArray.addObject();
            itemNode.put("product_code", r.getProductCode());
            itemNode.put("product_name", r.getProductName());
            itemNode.put("box_count", r.getBoxCount());
            itemNode.put("unit_weight_kg", r.getUnitWeightKg());
            itemNode.put("total_weight_kg", r.getTotalWeightKg());
        }
        if (rows.size() > 10) {
            result.put("more_items", "还有 " + (rows.size() - 10) + " 个商品未显示");
        }

        result.put("message", "台账已批量生成！共 " + rows.size() + " 条记录" +
                (notFoundInKg > 0 ? "（" + notFoundInKg + " 个商品在千克表中未找到匹配，单位重量默认为0）" : "") +
                "。download_url 字段可直接点击下载。");

        return result.toString();
    }

    // ─── 工具6：查询千克表（保留供单独使用） ─────────────────────────────────

    private String queryKgTable(JsonNode args, String sessionId) throws Exception {
        String materialName = args.path("material_name").asText();
        String productCode = args.path("product_code").asText(null);

        log.info("[BanBiao] 查询千克表: material={}, code={}", materialName, productCode);

        List<KgTableEntry> kgData = kgTableStorage.get(sessionId);
        if (kgData == null || kgData.isEmpty()) {
            return "{\"status\": \"no_data\", \"message\": \"千克表未上传或数据为空，请先上传千克表 Excel 文件\"}";
        }

        // 查询匹配（精确 → 规范化 → 名称模糊）
        List<KgTableEntry> matches = new ArrayList<>();
        String queryCodeNorm = normalizeCode(productCode);
        for (KgTableEntry entry : kgData) {
            // 精确编码匹配
            boolean codeMatch = productCode != null && !productCode.isEmpty()
                    && entry.getProductCode() != null
                    && (entry.getProductCode().equals(productCode) || entry.getProductCode().contains(productCode) || productCode.contains(entry.getProductCode()));
            // 规范化编码匹配
            boolean normCodeMatch = !queryCodeNorm.isEmpty()
                    && normalizeCode(entry.getProductCode()).equals(queryCodeNorm);
            // 名称模糊匹配
            boolean nameMatch = materialName != null && !materialName.isEmpty()
                    && entry.getMaterialName() != null
                    && (entry.getMaterialName().contains(materialName) || materialName.contains(entry.getMaterialName()));

            if (codeMatch || normCodeMatch || nameMatch) {
                matches.add(entry);
            }
        }

        ObjectNode result = objectMapper.createObjectNode();
        result.put("status", "success");
        result.put("query", materialName);
        result.put("query_code", productCode != null ? productCode : "");
        result.put("kg_table_size", kgData.size());
        ArrayNode matchesArray = result.putArray("matches");
        for (KgTableEntry entry : matches) {
            ObjectNode match = matchesArray.addObject();
            match.put("product_code", entry.getProductCode());
            match.put("material_name", entry.getMaterialName());
            match.put("specification", entry.getSpecification());
            match.put("unit_weight_kg", entry.getUnitWeightKg());
        }
        result.put("match_count", matches.size());

        if (matches.isEmpty()) {
            result.put("message", "在千克表中未找到匹配项，请检查商品编码或名称是否正确");
        }

        return result.toString();
    }

    // ─── 工具6：匹配台账模板 ─────────────────────────────────

    private String matchLedgerTemplate(JsonNode args, String sessionId) throws Exception {
        String productCode = args.path("product_code").asText();
        String materialName = args.path("material_name").asText(null);

        log.info("[BanBiao] 匹配台账模板: code={}, name={}", productCode, materialName);

        String templatePath = templateFileStorage.get(sessionId);
        if (templatePath == null) {
            return "{\"status\": \"no_template\", \"matched\": false, \"message\": \"台账模板未上传，请先上传台账模板 Excel 文件。生成台账时将使用默认格式。\"}";
        }

        // 读取模板，查找匹配行
        // 模板中通常有商品编码列，我们尝试找到匹配的行
        int matchedRow = -1;
        String matchedName = "";
        try (Workbook workbook = WorkbookFactory.create(Files.newInputStream(Path.of(templatePath)))) {
            Sheet sheet = workbook.getSheetAt(0);

            // 扫描前15行找表头行
            int headerRowIdx = findHeaderRow(sheet, 15);

            // 识别商品编码列和名称列
            Row headerRow = sheet.getRow(headerRowIdx);
            int codeCol = -1, nameCol = -1;
            if (headerRow != null) {
                for (int c = 0; c < headerRow.getLastCellNum(); c++) {
                    String headerVal = getCellValueAsString(headerRow.getCell(c)).trim().toLowerCase();
                    if (headerVal.contains("编码") || headerVal.contains("代码") || headerVal.contains("货号")) codeCol = c;
                    else if (headerVal.contains("名称") || headerVal.contains("品名")) nameCol = c;
                }
            }
            log.info("[BanBiao] matchLedgerTemplate: 表头行={}, codeCol={}, nameCol={}", headerRowIdx, codeCol, nameCol);

            // 从表头行的下一行开始搜索
            for (int r = headerRowIdx + 1; r <= sheet.getLastRowNum(); r++) {
                Row row = sheet.getRow(r);
                if (row == null) continue;

                if (codeCol >= 0) {
                    String cellCode = getCellValueAsString(row.getCell(codeCol)).trim();
                    if (cellCode.equals(productCode) || cellCode.contains(productCode)) {
                        matchedRow = r;
                        if (nameCol >= 0) matchedName = getCellValueAsString(row.getCell(nameCol)).trim();
                        break;
                    }
                }
                if (matchedRow < 0 && nameCol >= 0 && materialName != null) {
                    String cellName = getCellValueAsString(row.getCell(nameCol)).trim();
                    if (cellName.contains(materialName) || materialName.contains(cellName)) {
                        matchedRow = r;
                        matchedName = cellName;
                        break;
                    }
                }
            }
        }

        ObjectNode result = objectMapper.createObjectNode();
        if (matchedRow >= 0) {
            result.put("status", "success");
            result.put("matched", true);
            result.put("template_row", matchedRow);
            result.put("product_code", productCode);
            result.put("material_name", matchedName);
            result.put("message", "在模板第 " + (matchedRow + 1) + " 行找到匹配: " + matchedName);
        } else {
            result.put("status", "not_found");
            result.put("matched", false);
            result.put("message", "在模板中未找到商品编码 " + productCode + " 的匹配行，该商品将追加到台账末尾");
        }

        return result.toString();
    }

    // ─── 工具7：填入台账数据 ─────────────────────────────────

    private String fillLedgerTemplate(JsonNode args, String sessionId) throws Exception {
        String productCode = args.path("product_code").asText();
        String productName = args.path("product_name").asText();
        double boxCount = args.path("box_count").asDouble();
        double unitWeightKg = args.path("unit_weight_kg").asDouble(0);
        String productionDate = args.path("production_date").asText(null);
        String deliveryDate = args.path("delivery_date").asText(null);

        log.info("[BanBiao] 填入台账数据: code={}, name={}, qty={}, unitKg={}",
                productCode, productName, boxCount, unitWeightKg);

        List<LedgerFilledRow> rows = filledRowsStorage.computeIfAbsent(sessionId, k -> new ArrayList<>());

        LedgerFilledRow row = new LedgerFilledRow();
        row.setProductCode(productCode);
        row.setProductName(productName);
        row.setBoxCount(boxCount);
        row.setUnitWeightKg(unitWeightKg);
        row.setTotalWeightKg(unitWeightKg > 0 ? boxCount * unitWeightKg : 0);
        row.setProductionDate(productionDate);
        row.setDeliveryDate(deliveryDate != null ? deliveryDate : LocalDate.now().format(DateTimeFormatter.ISO_DATE));
        rows.add(row);

        ObjectNode result = objectMapper.createObjectNode();
        result.put("status", "success");
        result.put("product_code", productCode);
        result.put("product_name", productName);
        result.put("box_count", boxCount);
        result.put("unit_weight_kg", unitWeightKg);
        result.put("total_weight_kg", row.getTotalWeightKg());
        result.put("filled_rows_so_far", rows.size());
        result.put("message", "已填入: " + productName + " (" + boxCount + "箱" +
                (unitWeightKg > 0 ? " x " + unitWeightKg + "kg = " + row.getTotalWeightKg() + "kg" : "") + ")");

        return result.toString();
    }

    // ─── 工具8：生成台账文件 ─────────────────────────────────

    private String generateLedgerFile(JsonNode args, String sessionId) throws Exception {
        String ledgerTitle = args.path("ledger_title").asText("材料台账");

        log.info("[BanBiao] 生成台账文件: title={}", ledgerTitle);

        List<LedgerFilledRow> rows = filledRowsStorage.get(sessionId);
        if (rows == null || rows.isEmpty()) {
            return "{\"error\": \"没有已填入的台账数据，请先使用 fill_ledger_template 填入数据\"}";
        }

        // 确保输出目录存在
        Files.createDirectories(Path.of(ledgerOutputDir));

        String outputFileName = ledgerTitle + "_" + System.currentTimeMillis() + ".xlsx";
        String outputPath = Path.of(ledgerOutputDir, outputFileName).toString();

        String templatePath = templateFileStorage.get(sessionId);

        if (templatePath != null && Files.exists(Path.of(templatePath))) {
            // 基于模板生成：复制模板文件，然后在对应行填入数据
            generateFromTemplate(templatePath, outputPath, rows, ledgerTitle);
        } else {
            // 无模板：生成默认格式台账
            generateDefault(outputPath, rows, ledgerTitle);
        }

        // 构建下载 URL：优先使用配置的基础域名，否则返回相对路径
        String downloadPath = "/api/v1/ledger/download/" + outputFileName;
        String downloadUrl = (appBaseUrl != null && !appBaseUrl.isBlank())
                ? appBaseUrl.replaceAll("/$", "") + downloadPath
                : downloadPath;

        ObjectNode result = objectMapper.createObjectNode();
        result.put("status", "success");
        result.put("file_name", outputFileName);
        result.put("file_path", outputPath);
        result.put("download_url", downloadUrl);
        result.put("row_count", rows.size());
        result.put("message", "台账文件已生成！共 " + rows.size() + " 条记录。download_url 字段可直接点击下载。");

        return result.toString();
    }

    /**
     * 基于模板生成台账：使用 Python openpyxl 绕过 POI 命名范围问题。
     * Python 对 Excel 命名范围更宽容，能正确处理 LOCAL_YEAR_FORMAT 等引用。
     */
    private void generateFromTemplate(String templatePath, String outputPath,
                                       List<LedgerFilledRow> rows, String title) throws Exception {
        log.info("[BanBiao] [Python桥接] 开始生成台账: template={}, output={}, rows={}",
                templatePath, outputPath, rows.size());

        // 1. 将 rows 数据转为 JSON
        String rowsJson = objectMapper.writeValueAsString(rows);

        // 2. 写入临时 JSON 文件
        Path rowsFile = Path.of(outputPath + ".rows.json");
        Files.writeString(rowsFile, rowsJson);

        // 3. 定位 Python 桥接脚本
        String scriptPath = resolvePythonScript("generate_ledger_bridge.py");
        log.info("[BanBiao] Python脚本路径: {}", scriptPath);

        // 4. 构建并执行 Python 命令（优先 python3，降级 python）
        String pythonExe = "python3";
        try {
            new ProcessBuilder(pythonExe, "--version").start().waitFor();
        } catch (Exception e) {
            pythonExe = "python";
        }
        ProcessBuilder pb = new ProcessBuilder(
                pythonExe, scriptPath,
                templatePath, outputPath,
                rowsFile.toString()
        );
        pb.redirectErrorStream(true);
        log.info("[BanBiao] [Python桥接] 执行命令: {} {} {} {} {}",
                pythonExe, scriptPath, templatePath, outputPath, "...");

        Process proc = pb.start();
        StringBuilder output = new StringBuilder();
        try (var reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(proc.getInputStream(), java.nio.charset.StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
                log.info("[Python] {}", line);
            }
        }
        int exitCode = proc.waitFor();
        log.info("[BanBiao] [Python桥接] 完成, exitCode={}", exitCode);

        // 5. 清理临时文件
        Files.deleteIfExists(rowsFile);

        if (exitCode != 0) {
            log.error("[BanBiao] [Python桥接] 输出:\n{}", output);
            throw new RuntimeException("Python 脚本执行失败, exitCode=" + exitCode + ", output=" + output);
        }

        if (!Files.exists(Path.of(outputPath))) {
            throw new RuntimeException("Python 脚本未生成输出文件: " + outputPath);
        }

        log.info("[BanBiao] [Python桥接] 台账文件已生成: {}", outputPath);
    }

    /**
     * 定位 Python 脚本：依次在当前目录、backend 目录、resources 目录中查找
     */
    private String resolvePythonScript(String scriptName) {
        // 1. 当前工作目录
        Path p1 = Path.of(scriptName);
        if (Files.exists(p1)) return p1.toAbsolutePath().toString();

        // 2. backend 目录（本地开发时脚本在 backend/ 下）
        Path p2 = Path.of("backend", scriptName);
        if (Files.exists(p2)) return p2.toAbsolutePath().toString();

        // 3. jar 同级目录
        try {
            var codeSource = getClass().getProtectionDomain().getCodeSource();
            if (codeSource != null) {
                Path jarDir = Path.of(codeSource.getLocation().toURI()).getParent();
                Path p3 = jarDir.resolve(scriptName);
                if (Files.exists(p3)) return p3.toAbsolutePath().toString();
                // 3b. jar 同级的 backend/ 子目录
                Path p3b = jarDir.resolve("backend").resolve(scriptName);
                if (Files.exists(p3b)) return p3b.toAbsolutePath().toString();
            }
        } catch (Exception ignored) {}

        // 4. classpath resources
        try {
            var url = getClass().getClassLoader().getResource("python/" + scriptName);
            if (url != null) return url.getFile();
        } catch (Exception ignored) {}

        // 5. 用户主目录
        try {
            Path p5 = Path.of(System.getProperty("user.home"), scriptName);
            if (Files.exists(p5)) return p5.toAbsolutePath().toString();
        } catch (Exception ignored) {}

        // 兜底：返回当前目录下的路径（可能会失败，但错误信息清晰）
        log.warn("[BanBiao] 未找到 Python 脚本: {}, 将使用当前目录路径", scriptName);
        return p1.toAbsolutePath().toString();
    }

    /**
     * 判断字符串是否像商品编码（对齐 Python _is_code_like_raw）
     * 规则：只含数字和分隔符(空格/./-//)，数字5-8位
     */
    private boolean isCodeLike(String s) {
        if (s == null || s.trim().isEmpty()) return false;
        String t = s.trim();
        String digits = t.replaceAll("[^0-9]", "");
        String others = t.replaceAll("[0-9\\s.\\-/]", "");
        if (!others.isEmpty()) return false;
        return digits.length() >= 5 && digits.length() <= 8;
    }

    /**
     * 生成默认格式台账（无模板时）
     */
    private void generateDefault(String outputPath, List<LedgerFilledRow> rows, String title) throws Exception {
        try (Workbook workbook = new XSSFWorkbook();
             FileOutputStream fos = new FileOutputStream(outputPath)) {

            Sheet sheet = workbook.createSheet("台账");

            // 表头
            String[] headers = {"商品编码", "商品名称", "箱数/件数", "单位重量(kg)", "总重量(kg)", "生产日期", "进货日期"};
            Row headerRow = sheet.createRow(0);
            CellStyle headerStyle = workbook.createCellStyle();
            Font headerFont = workbook.createFont();
            headerFont.setBold(true);
            headerStyle.setFont(headerFont);
            headerStyle.setFillForegroundColor(IndexedColors.PALE_BLUE.getIndex());
            headerStyle.setFillPattern(FillPatternType.SOLID_FOREGROUND);

            for (int i = 0; i < headers.length; i++) {
                Cell cell = headerRow.createCell(i);
                cell.setCellValue(headers[i]);
                cell.setCellStyle(headerStyle);
            }

            // 数据行
            int rowNum = 1;
            for (LedgerFilledRow data : rows) {
                Row row = sheet.createRow(rowNum++);
                row.createCell(0).setCellValue(data.getProductCode());
                row.createCell(1).setCellValue(data.getProductName());
                row.createCell(2).setCellValue(data.getBoxCount());
                row.createCell(3).setCellValue(data.getUnitWeightKg());
                row.createCell(4).setCellValue(data.getTotalWeightKg());
                row.createCell(5).setCellValue(data.getProductionDate() != null ? data.getProductionDate() : "");
                row.createCell(6).setCellValue(data.getDeliveryDate() != null ? data.getDeliveryDate() : "");
            }

            // 自动调整列宽
            for (int i = 0; i < headers.length; i++) {
                sheet.autoSizeColumn(i);
            }

            workbook.write(fos);
        }
    }

    // ─── 工具9：外网上报 ─────────────────────────────────

    private String externalUpload(JsonNode args, String sessionId) throws Exception {
        String filePath = args.path("file_path").asText();
        String externalSystem = args.path("external_system").asText("TastyQube");

        log.info("[BanBiao] 外网上报: file={}, system={}", filePath, externalSystem);

        ObjectNode result = objectMapper.createObjectNode();
        result.put("status", "success");
        result.put("external_system", externalSystem);
        result.put("file_path", filePath);
        result.put("message", "台账文件已上报到 " + externalSystem + " (mock)");
        result.put("note", "TODO: 实现真实的上报逻辑");

        return result.toString();
    }

    // ─── 辅助方法 ─────────────────────────────────────────

    /**
     * 规范化商品编码（对齐 Python _norm_code 逻辑）
     * 1. 去除 Excel 数字文本中的 ".0" 后缀（如 "101015.0" → "101015"）
     * 2. 提取纯数字部分
     * 3. 去除前导零
     * 例："0101554" → "101554"，"101554" → "101554"，"72-001" → "72001" → "72001"
     */
    private String normalizeCode(String code) {
        if (code == null || code.isBlank()) return "";
        String s = code.trim();
        // 1. 去除 Excel 数字文本中的 ".0" 后缀（含 .00 .000 等）
        s = s.replaceAll("\\.0+$", "");
        // 2. 提取纯数字部分
        String digits = s.replaceAll("[^0-9]", "");
        if (digits.isEmpty()) return s; // 非数字编码原样返回
        // 3. 去除前导零
        String stripped = digits.replaceFirst("^0+", "");
        return stripped.isEmpty() ? "0" : stripped;
    }

    /**
     * 扫描 Sheet 前N行，找到包含"编码/代码/名称/品名"等关键词的表头行。
     * 如果找不到，返回 0（兼容旧行为）。
     */
    private int findHeaderRow(Sheet sheet, int maxScanRows) {
        for (int r = 0; r <= Math.min(maxScanRows, sheet.getLastRowNum()); r++) {
            Row row = sheet.getRow(r);
            if (row == null) continue;
            int matchCount = 0;
            for (int c = 0; c < Math.min(row.getLastCellNum(), 30); c++) {
                String val = getCellValueAsString(row.getCell(c)).trim().toLowerCase();
                if (val.contains("编码") || val.contains("代码") || val.contains("货号")
                        || val.contains("名称") || val.contains("品名") || val.contains("编号")) {
                    matchCount++;
                }
            }
            // 至少匹配2个关键词才认为是表头行（避免误匹配标题行含单个"名称"的情况）
            if (matchCount >= 2) return r;
        }
        // 降低门槛：只要匹配1个也返回
        for (int r = 0; r <= Math.min(maxScanRows, sheet.getLastRowNum()); r++) {
            Row row = sheet.getRow(r);
            if (row == null) continue;
            for (int c = 0; c < Math.min(row.getLastCellNum(), 30); c++) {
                String val = getCellValueAsString(row.getCell(c)).trim().toLowerCase();
                if (val.contains("编码") || val.contains("代码") || val.contains("名称") || val.contains("品名")) {
                    return r;
                }
            }
        }
        return 0; // fallback
    }

    /**
     * 解析文件路径：优先从参数获取，否则从 AgentSessionContext 获取
     */
    private String resolveFilePath(JsonNode args, String fileType) {
        String filePath = args.path("file_path").asText();

        // 如果参数没提供路径，尝试从上下文获取已上传文件
        if ((filePath == null || filePath.isEmpty()) && AgentSessionContext.getUploadedFilePaths() != null) {
            List<String> paths = AgentSessionContext.getUploadedFilePaths();
            if (!paths.isEmpty()) {
                filePath = paths.get(0); // 取第一个上传文件
                log.info("[BanBiao] 从上下文获取文件路径: {}", filePath);
            }
        }

        if (filePath == null || filePath.isEmpty()) return null;

        // 🔧 如果是 OSS HTTP URL，下载到临时文件再处理
        if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
            try {
                log.info("[BanBiao] 从 OSS URL 下载{}: {}", fileType, filePath);
                java.net.http.HttpClient client = java.net.http.HttpClient.newBuilder()
                        .connectTimeout(java.time.Duration.ofSeconds(10)).build();
                java.net.http.HttpRequest req = java.net.http.HttpRequest.newBuilder()
                        .uri(java.net.URI.create(filePath))
                        .timeout(java.time.Duration.ofSeconds(60))
                        .GET().build();
                java.net.http.HttpResponse<byte[]> resp = client.send(req,
                        java.net.http.HttpResponse.BodyHandlers.ofByteArray());
                if (resp.statusCode() != 200) {
                    log.error("[BanBiao] {} OSS 下载失败: HTTP {}", fileType, resp.statusCode());
                    return filePath; // 返回原始 URL，让调用方报告错误
                }
                // 写入临时文件（保留原始扩展名以正确解析）
                String suffix = ".tmp";
                int dotIdx = filePath.lastIndexOf('.');
                if (dotIdx > 0) {
                    String ext = filePath.substring(dotIdx);
                    if (ext.length() <= 8) suffix = ext; // 防止包含查询参数
                }
                java.nio.file.Path tmpFile = java.nio.file.Files.createTempFile("ledger_", suffix);
                java.nio.file.Files.write(tmpFile, resp.body());
                String tempPath = tmpFile.toAbsolutePath().toString();
                log.info("[BanBiao] {} OSS 下载成功: {} -> {} ({} bytes)", fileType, filePath, tempPath,
                        resp.body().length);
                return tempPath;
            } catch (Exception e) {
                log.error("[BanBiao] {} OSS 下载异常: {}", fileType, e.getMessage());
                return filePath; // 返回原始 URL，让调用方报告错误
            }
        }

        return filePath;
    }

    /**
     * 安全读取单元格数值，处理 ERROR/FORMULA 错误值
     * 对齐 Python pandas 的 NaN 处理：无法解析的值返回 0
     */
    private double getNumericCellValueSafe(Cell cell) {
        if (cell == null) return 0;
        try {
            CellType type = cell.getCellType();
            if (type == CellType.ERROR) return 0;
            if (type == CellType.NUMERIC) return cell.getNumericCellValue();
            if (type == CellType.STRING) {
                String s = cell.getStringCellValue().trim();
                if (!s.isEmpty() && !s.startsWith("#")) {
                    try { return Double.parseDouble(s); } catch (Exception ignored) {}
                }
                return 0;
            }
            if (type == CellType.FORMULA) {
                // 检查公式的缓存结果类型
                CellType cachedType = cell.getCachedFormulaResultType();
                if (cachedType == CellType.ERROR) return 0;
                if (cachedType == CellType.NUMERIC) return cell.getNumericCellValue();
                if (cachedType == CellType.STRING) {
                    String s = cell.getStringCellValue().trim();
                    if (!s.isEmpty() && !s.startsWith("#")) {
                        try { return Double.parseDouble(s); } catch (Exception ignored) {}
                    }
                }
                return 0;
            }
            return 0;
        } catch (Exception e) {
            return 0;
        }
    }

    private String getCellValueAsString(Cell cell) {
        if (cell == null) return "";
        return switch (cell.getCellType()) {
            case STRING -> cell.getStringCellValue();
            case NUMERIC -> {
                double val = cell.getNumericCellValue();
                // 如果是整数，不显示小数点
                yield val == (long) val ? String.valueOf((long) val) : String.valueOf(val);
            }
            case BOOLEAN -> String.valueOf(cell.getBooleanCellValue());
            case FORMULA -> {
                // 先检查公式缓存结果类型，避免 ERROR 单元格抛异常
                try {
                    CellType cachedType = cell.getCachedFormulaResultType();
                    if (cachedType == CellType.ERROR) {
                        yield "";
                    }
                    if (cachedType == CellType.STRING) {
                        yield cell.getStringCellValue();
                    }
                    if (cachedType == CellType.NUMERIC) {
                        double val = cell.getNumericCellValue();
                        yield val == (long) val ? String.valueOf((long) val) : String.valueOf(val);
                    }
                } catch (Exception ignored) {}
                // 兜底：直接尝试读取
                try { yield cell.getStringCellValue(); }
                catch (Exception e) {
                    try {
                        double val = cell.getNumericCellValue();
                        yield val == (long) val ? String.valueOf((long) val) : String.valueOf(val);
                    } catch (Exception e2) { yield ""; }
                }
            }
            default -> "";
        };
    }

    private void safeSetCellValue(Row row, int col, String value) {
        if (col >= 0 && value != null) {
            row.createCell(col).setCellValue(value);
        }
    }

    // ─── 内部数据结构 ─────────────────────────────────────

    private static class ProcurementItem {
        private String productCode;
        private String materialName;
        private String specification;
        private double quantity;

        public String getProductCode() { return productCode; }
        public void setProductCode(String productCode) { this.productCode = productCode; }
        public String getMaterialName() { return materialName; }
        public void setMaterialName(String materialName) { this.materialName = materialName; }
        public String getSpecification() { return specification; }
        public void setSpecification(String specification) { this.specification = specification; }
        public double getQuantity() { return quantity; }
        public void setQuantity(double quantity) { this.quantity = quantity; }
    }

    private static class DeliveryNoteItem {
        private String productCode;
        private String materialName;
        private int pieceCount;
        private int boxCount;
        private String productionDate;
        private double confidence;

        public String getProductCode() { return productCode; }
        public void setProductCode(String productCode) { this.productCode = productCode; }
        public String getMaterialName() { return materialName; }
        public void setMaterialName(String materialName) { this.materialName = materialName; }
        public int getPieceCount() { return pieceCount; }
        public void setPieceCount(int pieceCount) { this.pieceCount = pieceCount; }
        public int getBoxCount() { return boxCount; }
        public void setBoxCount(int boxCount) { this.boxCount = boxCount; }
        public String getProductionDate() { return productionDate; }
        public void setProductionDate(String productionDate) { this.productionDate = productionDate; }
        public double getConfidence() { return confidence; }
        public void setConfidence(double confidence) { this.confidence = confidence; }
    }

    private static class KgTableEntry {
        private String productCode;
        private String materialName;
        private String specification;
        private double unitWeightKg;

        public String getProductCode() { return productCode; }
        public void setProductCode(String productCode) { this.productCode = productCode; }
        public String getMaterialName() { return materialName; }
        public void setMaterialName(String materialName) { this.materialName = materialName; }
        public String getSpecification() { return specification; }
        public void setSpecification(String specification) { this.specification = specification; }
        public double getUnitWeightKg() { return unitWeightKg; }
        public void setUnitWeightKg(double unitWeightKg) { this.unitWeightKg = unitWeightKg; }
    }

    private static class LedgerFilledRow {
        private String productCode;
        private String productName;
        private double boxCount;
        private double unitWeightKg;
        private double totalWeightKg;
        private String productionDate;
        private String deliveryDate;

        public String getProductCode() { return productCode; }
        public void setProductCode(String productCode) { this.productCode = productCode; }
        public String getProductName() { return productName; }
        public void setProductName(String productName) { this.productName = productName; }
        public double getBoxCount() { return boxCount; }
        public void setBoxCount(double boxCount) { this.boxCount = boxCount; }
        public double getUnitWeightKg() { return unitWeightKg; }
        public void setUnitWeightKg(double unitWeightKg) { this.unitWeightKg = unitWeightKg; }
        public double getTotalWeightKg() { return totalWeightKg; }
        public void setTotalWeightKg(double totalWeightKg) { this.totalWeightKg = totalWeightKg; }
        public String getProductionDate() { return productionDate; }
        public void setProductionDate(String productionDate) { this.productionDate = productionDate; }
        public String getDeliveryDate() { return deliveryDate; }
        public void setDeliveryDate(String deliveryDate) { this.deliveryDate = deliveryDate; }
    }
}
