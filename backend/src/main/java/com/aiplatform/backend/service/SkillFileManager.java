package com.aiplatform.backend.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;

/**
 * 技能文件管理器
 * <p>
 * 提供技能文件的CRUD操作，支持ZIP包和目录两种存储格式。
 * 优先使用目录格式，ZIP包在第一次编辑时自动解压。
 */
@Slf4j
@Service
public class SkillFileManager {

    /** 技能存储目录 */
    private static final String SKILL_STORAGE_DIR = "skills_storage";
    
    /** 临时解压目录 */
    private static final String TEMP_EXTRACT_DIR = "skills_temp";

    /**
     * 获取技能文件树
     * @param agentId 技能ID
     * @return 文件树结构
     */
    public List<FileNode> getFileTree(String agentId) throws IOException {
        Path skillPath = getSkillPath(agentId);
        
        if (Files.exists(skillPath) && Files.isDirectory(skillPath)) {
            // 目录格式：直接遍历
            return buildFileTree(skillPath);
        }
        
        // 尝试 ZIP 格式
        Path zipPath = getSkillZipPath(agentId);
        if (Files.exists(zipPath)) {
            Path extractDir = extractZipToTemp(agentId);
            return buildFileTree(extractDir);
        }
        
        // 两者都不存在：创建空目录，返回空文件树
        // 调用方应先通过 ensureSkillFiles 生成本地文件
        log.warn("[SkillFileManager] 技能文件不存在（目录和ZIP都没有），返回空树: {}", agentId);
        Files.createDirectories(skillPath);
        return new ArrayList<>();
    }

    /**
     * 确保技能目录存在，并写入 SKILL.md 内容
     * @param agentId 技能ID
     * @param skillMdContent SKILL.md 文件内容
     */
    public void ensureSkillDirectory(String agentId, String skillMdContent) throws IOException {
        Path skillPath = getSkillPath(agentId);
        if (!Files.exists(skillPath) || !Files.isDirectory(skillPath)) {
            // 检查是否有ZIP，有则解压
            Path zipPath = getSkillZipPath(agentId);
            if (Files.exists(zipPath)) {
                unzip(zipPath, skillPath);
                log.info("[SkillFileManager] ZIP已解压成目录: {} -> {}", zipPath, skillPath);
                return;
            }
            // 都不存在：创建新目录
            Files.createDirectories(skillPath);
        }
        // 如果 SKILL.md 不存在，写入
        Path skillMd = skillPath.resolve("SKILL.md");
        if (!Files.exists(skillMd) && skillMdContent != null && !skillMdContent.isBlank()) {
            Files.writeString(skillMd, skillMdContent, StandardCharsets.UTF_8);
            log.info("[SkillFileManager] 已生成 SKILL.md: {}", agentId);
        }
    }

    /**
     * 保存脚本文件到技能目录
     * @param agentId 技能ID
     * @param scriptName 脚本文件名
     * @param code 脚本内容
     */
    public void saveScriptFile(String agentId, String scriptName, String code) throws IOException {
        Path skillPath = getSkillPath(agentId);
        Files.createDirectories(skillPath);
        Path scriptsDir = skillPath.resolve("scripts");
        Files.createDirectories(scriptsDir);
        Path scriptFile = scriptsDir.resolve(scriptName);
        Files.writeString(scriptFile, code != null ? code : "", StandardCharsets.UTF_8);
        log.info("[SkillFileManager] 脚本已保存: {}/scripts/{}", agentId, scriptName);
    }

    /**
     * 读取技能文件内容
     * @param agentId 技能ID
     * @param filePath 文件路径（相对路径）
     * @return 文件内容
     */
    public String readFile(String agentId, String filePath) throws IOException {
        Path skillPath = getSkillPath(agentId);
        Path targetFile;
        
        if (Files.exists(skillPath) && Files.isDirectory(skillPath)) {
            // 目录格式
            targetFile = skillPath.resolve(filePath);
        } else {
            // ZIP格式：解压到临时目录
            Path extractDir = extractZipToTemp(agentId);
            targetFile = extractDir.resolve(filePath);
        }
        
        if (!Files.exists(targetFile)) {
            throw new FileNotFoundException("文件不存在: " + filePath);
        }
        
        return Files.readString(targetFile, StandardCharsets.UTF_8);
    }

    /**
     * 更新技能文件内容
     * @param agentId 技能ID
     * @param filePath 文件路径（相对路径）
     * @param content 新内容
     */
    public void updateFile(String agentId, String filePath, String content) throws IOException {
        // 确保是目录格式
        ensureDirectoryFormat(agentId);
        
        Path skillPath = getSkillDirectoryPath(agentId);
        Path targetFile = skillPath.resolve(filePath).normalize();
        
        // 安全检查：确保目标文件在技能目录内
        if (!targetFile.startsWith(skillPath)) {
            throw new SecurityException("非法文件路径: " + filePath);
        }
        
        // 创建父目录（如果不存在）
        Files.createDirectories(targetFile.getParent());
        
        // 写入文件
        Files.writeString(targetFile, content, StandardCharsets.UTF_8);
        log.info("[SkillFileManager] 文件已更新: {}/{}", agentId, filePath);
    }

    /**
     * 创建新文件或文件夹
     * @param agentId 技能ID
     * @param filePath 文件路径（相对路径）
     * @param content 文件内容（如果是文件夹则为null）
     * @param isDirectory 是否创建文件夹
     */
    public void createFile(String agentId, String filePath, String content, boolean isDirectory) throws IOException {
        // 确保是目录格式
        ensureDirectoryFormat(agentId);
        
        Path skillPath = getSkillDirectoryPath(agentId);
        Path targetPath = skillPath.resolve(filePath).normalize();
        
        // 安全检查
        if (!targetPath.startsWith(skillPath)) {
            throw new SecurityException("非法文件路径: " + filePath);
        }
        
        if (isDirectory) {
            // 创建文件夹
            Files.createDirectories(targetPath);
            log.info("[SkillFileManager] 文件夹已创建: {}/{}", agentId, filePath);
        } else {
            // 创建文件
            Files.createDirectories(targetPath.getParent());
            Files.writeString(targetPath, content != null ? content : "", StandardCharsets.UTF_8);
            log.info("[SkillFileManager] 文件已创建: {}/{}", agentId, filePath);
        }
    }

    /**
     * 删除文件或文件夹
     * @param agentId 技能ID
     * @param filePath 文件路径（相对路径）
     */
    public void deleteFile(String agentId, String filePath) throws IOException {
        // 确保是目录格式
        ensureDirectoryFormat(agentId);
        
        Path skillPath = getSkillDirectoryPath(agentId);
        Path targetPath = skillPath.resolve(filePath).normalize();
        
        // 安全检查
        if (!targetPath.startsWith(skillPath)) {
            throw new SecurityException("非法文件路径: " + filePath);
        }
        
        if (!Files.exists(targetPath)) {
            throw new FileNotFoundException("文件不存在: " + filePath);
        }
        
        // 递归删除
        deleteRecursive(targetPath);
        log.info("[SkillFileManager] 文件已删除: {}/{}", agentId, filePath);
    }

    /**
     * 将技能打包成ZIP（用于导出或备份）
     * @param agentId 技能ID
     * @return ZIP文件路径
     */
    public Path packageToZip(String agentId) throws IOException {
        Path skillPath = getSkillDirectoryPath(agentId);
        Path zipPath = Paths.get(SKILL_STORAGE_DIR, agentId + ".zip");
        
        try (ZipOutputStream zos = new ZipOutputStream(Files.newOutputStream(zipPath))) {
            Files.walk(skillPath)
                .filter(path -> !Files.isDirectory(path))
                .forEach(path -> {
                    try {
                        String entryName = skillPath.relativize(path).toString().replace("\\", "/");
                        zos.putNextEntry(new ZipEntry(entryName));
                        Files.copy(path, zos);
                        zos.closeEntry();
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                });
        }
        
        log.info("[SkillFileManager] 技能已打包成ZIP: {} -> {}", agentId, zipPath);
        return zipPath;
    }

    // ==================== 私有方法 ====================

    /**
     * 获取技能路径（可能是ZIP或目录）
     */
    private Path getSkillPath(String agentId) {
        return Paths.get(SKILL_STORAGE_DIR, agentId);
    }

    /**
     * 获取技能目录路径（目录格式）
     */
    private Path getSkillDirectoryPath(String agentId) {
        return Paths.get(SKILL_STORAGE_DIR, agentId);
    }

    /**
     * 获取技能ZIP路径
     */
    private Path getSkillZipPath(String agentId) {
        return Paths.get(SKILL_STORAGE_DIR, agentId + ".zip");
    }

    /**
     * 确保技能是目录格式（如果是ZIP则解压）
     */
    private void ensureDirectoryFormat(String agentId) throws IOException {
        Path zipPath = getSkillZipPath(agentId);
        Path dirPath = getSkillDirectoryPath(agentId);
        
        if (Files.exists(zipPath) && !Files.exists(dirPath)) {
            // ZIP存在但目录不存在：解压
            unzip(zipPath, dirPath);
            log.info("[SkillFileManager] ZIP已解压成目录: {} -> {}", zipPath, dirPath);
        } else if (!Files.exists(zipPath) && !Files.exists(dirPath)) {
            // 都不存在：创建新目录
            Files.createDirectories(dirPath);
            log.info("[SkillFileManager] 创建新技能目录: {}", dirPath);
        }
    }

    /**
     * 将ZIP解压到临时目录
     */
    private Path extractZipToTemp(String agentId) throws IOException {
        Path zipPath = getSkillZipPath(agentId);
        if (!Files.exists(zipPath)) {
            throw new FileNotFoundException("技能ZIP不存在: " + agentId);
        }
        
        Path tempDir = Paths.get(TEMP_EXTRACT_DIR, agentId);
        if (Files.exists(tempDir)) {
            // 已解压：直接返回
            return tempDir;
        }
        
        // 解压
        unzip(zipPath, tempDir);
        return tempDir;
    }

    /**
     * 解压ZIP文件
     */
    private void unzip(Path zipPath, Path targetDir) throws IOException {
        Files.createDirectories(targetDir);
        
        try (ZipInputStream zis = new ZipInputStream(Files.newInputStream(zipPath))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                Path entryPath = targetDir.resolve(entry.getName()).normalize();
                
                // 安全检查
                if (!entryPath.startsWith(targetDir)) {
                    throw new SecurityException("非法的ZIP条目: " + entry.getName());
                }
                
                if (entry.isDirectory()) {
                    Files.createDirectories(entryPath);
                } else {
                    Files.createDirectories(entryPath.getParent());
                    Files.copy(zis, entryPath, StandardCopyOption.REPLACE_EXISTING);
                }
                
                zis.closeEntry();
            }
        }
    }

    /**
     * 构建文件树（根路径无前缀）
     */
    private List<FileNode> buildFileTree(Path rootPath) throws IOException {
        return buildFileTree(rootPath, "");
    }

    /**
     * 构建文件树
     */
    private List<FileNode> buildFileTree(Path rootPath, String prefix) throws IOException {
        List<FileNode> nodes = new ArrayList<>();
        
        Files.walk(rootPath, 1)
            .filter(path -> !path.equals(rootPath))
            .sorted((a, b) -> {
                // 文件夹在前，文件在后
                boolean aIsDir = Files.isDirectory(a);
                boolean bIsDir = Files.isDirectory(b);
                if (aIsDir && !bIsDir) return -1;
                if (!aIsDir && bIsDir) return 1;
                return a.getFileName().compareTo(b.getFileName());
            })
            .forEach(path -> {
                String localName = rootPath.relativize(path).toString().replace("\\", "/");
                String relativePath = prefix.isEmpty() ? localName : prefix + "/" + localName;
                boolean isDirectory = Files.isDirectory(path);
                
                FileNode node = new FileNode();
                node.setName(path.getFileName().toString());
                node.setPath(relativePath);
                node.setDirectory(isDirectory);
                
                if (isDirectory) {
                    try {
                        node.setChildren(buildFileTree(path, relativePath));
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                } else {
                    try {
                        node.setSize(Files.size(path));
                    } catch (IOException e) {
                        node.setSize(0L);
                    }
                }
                
                nodes.add(node);
            });
        
        return nodes;
    }

    /**
     * 递归删除
     */
    private void deleteRecursive(Path path) throws IOException {
        if (Files.isDirectory(path)) {
            Files.walk(path)
                .sorted(Comparator.reverseOrder())
                .forEach(p -> {
                    try {
                        Files.delete(p);
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                });
        } else {
            Files.delete(path);
        }
    }

    /**
     * 文件节点（用于构建文件树）
     */
    public static class FileNode {
        private String name;
        private String path;
        @JsonProperty("isDirectory")
        private boolean isDirectory;
        private long size;
        private List<FileNode> children;

        // Getters and Setters
        public String getName() { return name; }
        public void setName(String name) { this.name = name; }

        public String getPath() { return path; }
        public void setPath(String path) { this.path = path; }

        public boolean isDirectory() { return isDirectory; }
        public void setDirectory(boolean directory) { isDirectory = directory; }

        public long getSize() { return size; }
        public void setSize(long size) { this.size = size; }

        public List<FileNode> getChildren() { return children; }
        public void setChildren(List<FileNode> children) { this.children = children; }
    }
}
