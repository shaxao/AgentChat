package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import jakarta.servlet.http.HttpServletRequest;
import lombok.extern.slf4j.Slf4j;
import org.apache.poi.hssf.usermodel.HSSFWorkbook;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFParagraph;
import org.apache.poi.xwpf.usermodel.XWPFTable;
import org.apache.poi.xwpf.usermodel.XWPFTableCell;
import org.apache.poi.xwpf.usermodel.XWPFTableRow;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.util.List;

/**
 * 文件预览控制器
 * 将上传的 Office 文件转为 HTML 片段，供前端 iframe 嵌入预览。
 */
@Slf4j
@RestController
@RequestMapping("/api/util")
public class FilePreviewController {

    /**
     * Excel 预览：读取所有 sheet，返回 HTML <table> 片段
     */
    @PostMapping("/preview-xlsx")
    public String previewXlsx(@RequestParam("file") MultipartFile file) throws IOException {
        if (file.isEmpty()) {
            return htmlError("文件为空");
        }

        String filename = file.getOriginalFilename();
        log.info("[preview-xlsx] 接收文件: {}", filename);

        try (InputStream is = file.getInputStream()) {
            Workbook workbook;
            if (filename != null && filename.toLowerCase().endsWith(".xls")) {
                workbook = new HSSFWorkbook(is);
            } else {
                workbook = new XSSFWorkbook(is);
            }

            StringBuilder html = new StringBuilder();
            html.append("<!DOCTYPE html><html><head><meta charset='utf-8'><style>")
                .append("body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#333;padding:12px;}")
                .append("table{border-collapse:collapse;width:100%;margin-bottom:20px;}")
                .append("th,td{border:1px solid #d0d5dd;padding:6px 10px;text-align:left;white-space:nowrap;}")
                .append("th{background:#f5f6f8;font-weight:600;color:#1a1a2e;}")
                .append("tr:hover{background:#f8f9fb;}")
                .append("h3{font-size:14px;color:#1a1a2e;margin:8px 0 4px;}")
                .append(".sheet-label{display:inline-block;background:#e8ecf1;color:#555;font-size:11px;padding:2px 8px;border-radius:4px;margin-bottom:6px;}")
                .append("</style></head><body>");

            int sheetCount = workbook.getNumberOfSheets();
            for (int s = 0; s < sheetCount; s++) {
                Sheet sheet = workbook.getSheetAt(s);
                String sheetName = sheet.getSheetName();
                html.append("<h3>").append(escapeHtml(sheetName)).append("</h3>");

                // 计算有效行列数
                int maxRow = sheet.getLastRowNum();
                if (maxRow < 0) {
                    html.append("<p style='color:#999'>（空工作表）</p>");
                    continue;
                }
                int maxCol = 0;
                for (int r = 0; r <= maxRow; r++) {
                    Row row = sheet.getRow(r);
                    if (row != null && row.getLastCellNum() > maxCol) {
                        maxCol = row.getLastCellNum();
                    }
                }
                if (maxCol == 0) {
                    html.append("<p style='color:#999'>（空工作表）</p>");
                    continue;
                }

                html.append("<span class='sheet-label'>").append(maxRow + 1).append(" 行 × ")
                    .append(maxCol).append(" 列</span>");
                html.append("<table><thead><tr>");
                // 表头
                Row headerRow = sheet.getRow(0);
                for (int c = 0; c < maxCol; c++) {
                    String val = getCellString(headerRow != null ? headerRow.getCell(c) : null);
                    html.append("<th>").append(escapeHtml(val)).append("</th>");
                }
                html.append("</tr></thead><tbody>");

                // 数据行（最多显示 200 行）
                int displayRows = Math.min(maxRow, 200);
                for (int r = 1; r <= displayRows; r++) {
                    Row row = sheet.getRow(r);
                    html.append("<tr>");
                    for (int c = 0; c < maxCol; c++) {
                        String val = getCellString(row != null ? row.getCell(c) : null);
                        html.append("<td>").append(escapeHtml(val)).append("</td>");
                    }
                    html.append("</tr>");
                }

                if (maxRow > 200) {
                    html.append("<tr><td colspan='").append(maxCol)
                        .append("' style='text-align:center;color:#999;padding:8px;'>")
                        .append("... 共 ").append(maxRow + 1).append(" 行，仅显示前 200 行 ...")
                        .append("</td></tr>");
                }

                html.append("</tbody></table>");
            }

            html.append("</body></html>");
            workbook.close();
            return html.toString();

        } catch (Exception e) {
            log.error("[preview-xlsx] 预览失败: {}", e.getMessage(), e);
            return htmlError("Excel 解析失败: " + e.getMessage());
        }
    }

    /**
     * Word 预览：提取段落和表格，返回 HTML 片段
     */
    @PostMapping("/preview-docx")
    public String previewDocx(@RequestParam("file") MultipartFile file) throws IOException {
        if (file.isEmpty()) {
            return htmlError("文件为空");
        }

        String filename = file.getOriginalFilename();
        log.info("[preview-docx] 接收文件: {}", filename);

        try (InputStream is = file.getInputStream()) {
            XWPFDocument doc = new XWPFDocument(is);

            StringBuilder html = new StringBuilder();
            html.append("<!DOCTYPE html><html><head><meta charset='utf-8'><style>")
                .append("body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#333;padding:16px;max-width:800px;margin:0 auto;line-height:1.7;}")
                .append("p{margin:6px 0;}")
                .append("table{border-collapse:collapse;width:100%;margin:10px 0;}")
                .append("th,td{border:1px solid #d0d5dd;padding:6px 10px;text-align:left;}")
                .append("th{background:#f5f6f8;font-weight:600;}")
                .append("h1{font-size:20px;}h2{font-size:17px;}h3{font-size:15px;}")
                .append("</style></head><body>");

            // 遍历 body elements（段落 + 表格交错的顺序）
            var bodyElements = doc.getBodyElements();
            for (var element : bodyElements) {
                if (element instanceof XWPFParagraph) {
                    XWPFParagraph para = (XWPFParagraph) element;
                    String text = para.getText();
                    if (text != null && !text.isBlank()) {
                        String style = para.getStyle();
                        if (style != null && style.contains("Heading")) {
                            html.append("<h3>").append(escapeHtml(text)).append("</h3>");
                        } else {
                            html.append("<p>").append(escapeHtml(text)).append("</p>");
                        }
                    }
                } else if (element instanceof XWPFTable) {
                    XWPFTable table = (XWPFTable) element;
                    html.append("<table>");
                    List<XWPFTableRow> rows = table.getRows();
                    boolean firstRow = true;
                    for (XWPFTableRow row : rows) {
                        html.append("<tr>");
                        List<XWPFTableCell> cells = row.getTableCells();
                        for (XWPFTableCell cell : cells) {
                            String tag = firstRow ? "th" : "td";
                            html.append("<").append(tag).append(">")
                                .append(escapeHtml(cell.getText()))
                                .append("</").append(tag).append(">");
                        }
                        html.append("</tr>");
                        firstRow = false;
                    }
                    html.append("</table>");
                }
            }

            html.append("</body></html>");
            doc.close();
            return html.toString();

        } catch (Exception e) {
            log.error("[preview-docx] 预览失败: {}", e.getMessage(), e);
            return htmlError("Word 解析失败: " + e.getMessage());
        }
    }

    // ─── 辅助方法 ────────────────────────────────────────

    private String getCellString(Cell cell) {
        if (cell == null) return "";
        try {
            switch (cell.getCellType()) {
                case STRING:
                    return cell.getStringCellValue();
                case NUMERIC:
                    if (DateUtil.isCellDateFormatted(cell)) {
                        return cell.getLocalDateTimeCellValue().toString();
                    }
                    double v = cell.getNumericCellValue();
                    if (v == Math.floor(v) && !Double.isInfinite(v)) {
                        return String.valueOf((long) v);
                    }
                    return String.valueOf(v);
                case BOOLEAN:
                    return String.valueOf(cell.getBooleanCellValue());
                case FORMULA:
                    try { return cell.getStringCellValue(); } catch (Exception e) {
                        try { return String.valueOf(cell.getNumericCellValue()); } catch (Exception e2) {}
                    }
                    return "";
                default:
                    return "";
            }
        } catch (Exception e) {
            return "";
        }
    }

    private String escapeHtml(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&#39;");
    }

    private String htmlError(String msg) {
        return "<!DOCTYPE html><html><head><meta charset='utf-8'></head>"
            + "<body style='font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:200px;color:#c0392b;'>"
            + "<p>" + escapeHtml(msg) + "</p></body></html>";
    }
}
