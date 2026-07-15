// 构建后注入版本时间戳到 index.html
const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'dist', 'index.html');
if (!fs.existsSync(indexPath)) {
  console.error('dist/index.html not found! Run vite build first.');
  process.exit(1);
}

let html = fs.readFileSync(indexPath, 'utf-8');
const buildTime = new Date().toISOString();
html = html.replace(/BUILD_TIME/g, buildTime);

fs.writeFileSync(indexPath, html, 'utf-8');
console.log(`Build time injected: ${buildTime}`);
console.log(`File updated: ${indexPath}`);
