#!/bin/bash
# AutoCode 后端重启（通过 systemd，安全重启 + restart-on-failure 保护）
# 部署脚本 deploy.ps1 upload-autocode 调用此脚本
set -e
cd /opt/autocode
mkdir -p /var/log/autocode

cat > /etc/systemd/system/autocode.service << 'SVCEOF'
[Unit]
Description=AutoCode Agent Platform
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/autocode
Environment="PYTHONUNBUFFERED=1"
ExecStartPre=/bin/sleep 2
ExecStart=/opt/autocode/venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 --ws-ping-interval 60 --ws-ping-timeout 120
Restart=on-failure
RestartSec=10
TimeoutStopSec=60
StandardOutput=append:/var/log/autocode/app.log
StandardError=append:/var/log/autocode/error.log

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
echo "==> Restarting AutoCode via systemd..."
systemctl restart autocode
sleep 1
echo "==> Service status:"
systemctl status autocode --no-pager -l --lines=8
echo "==> Done."
