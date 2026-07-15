# ---- Stage 1: Build ----
FROM maven:3.9.6-eclipse-temurin-17-alpine AS builder

WORKDIR /build

# 阿里云 Maven 镜像加速
RUN mkdir -p /root/.m2 && cat > /root/.m2/settings.xml << 'EOF'
<settings>
  <mirrors>
    <mirror>
      <id>aliyun</id>
      <name>Aliyun Maven Mirror</name>
      <mirrorOf>central</mirrorOf>
      <url>https://maven.aliyun.com/repository/public</url>
    </mirror>
  </mirrors>
</settings>
EOF

# 先复制 pom.xml 缓存依赖层
COPY pom.xml .
RUN mvn dependency:go-offline -q

# 再复制源码编译
COPY src ./src
RUN mvn clean package -DskipTests -q

# ---- Stage 2: Runtime ----
FROM eclipse-temurin:17-jre-alpine

WORKDIR /app

# 安装 curl（健康检查用）、Python 3 + openpyxl（台账生成桥接）、时区工具
# 阿里云 Alpine 镜像 + pip 镜像加速
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
    && apk add --no-cache curl python3 py3-pip tzdata \
    && pip3 install --no-cache-dir --break-system-packages -i https://mirrors.aliyun.com/pypi/simple/ openpyxl \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && apk del tzdata

# 从构建阶段复制 jar
COPY --from=builder /build/target/backend-1.0.0.jar app.jar

# 复制 Python 桥接脚本（台账生成用，绕过 POI 命名范围问题）
COPY generate_ledger_bridge.py /app/generate_ledger_bridge.py

# 创建日志目录
RUN mkdir -p /app/logs

# 暴露端口
EXPOSE 8080

# JVM 调优参数（适合容器环境）
# -Xms1g: 初始堆内存 1GB
# -Xmx2g: 最大堆内存 2GB（防止 OOM）
# -XX:+HeapDumpOnOutOfMemoryError: OOM 时自动生成 heap dump
# -XX:HeapDumpPath: heap dump 文件路径
# -XX:+PrintGCDetails -Xlog:gc: GC 日志（用于分析内存泄漏）
# -XX:ErrorFile: JVM 崩溃日志路径
ENV JAVA_OPTS="-Xms1g -Xmx2g -XX:+UseContainerSupport -XX:MaxRAMPercentage=75.0 -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/app/logs/heapdump -Xlog:gc*:file=/app/logs/gc.log:time,level,tags -XX:ErrorFile=/app/logs/hs_err_pid%p.log"

# 启动命令：激活 prod profile
ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS -jar app.jar --spring.profiles.active=prod"]
