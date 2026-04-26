const http = require('http');
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

// 自动连接 Railway Redis
let redis;
try {
  redis = new Redis(process.env.REDIS_URL);
  console.log('✅ Redis 连接成功：数据永久保存');
} catch (e) {
  console.log('❌ Redis 连接失败');
}

// 静态文件 MIME 类型
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

// 创建服务器
const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  // --------------------------
  // 🔴 API：获取数据（电脑/手机通用）
  // --------------------------
  if (url === '/api/data' && method === 'GET') {
    try {
      const data = await redis.get('app_data');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data || '{}');
    } catch (err) {
      res.end('{}');
    }
    return;
  }

  // --------------------------
  // 🟢 API：保存数据（自动同步）
  // --------------------------
  if (url === '/api/data' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        await redis.set('app_data', body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: 1, msg: '✅ 保存成功（永久存储）' }));
      } catch (err) {
        res.writeHead(500);
        res.end('error');
      }
    });
    return;
  }

  // --------------------------
  // 静态文件（PWA 正常访问）
  // --------------------------
  let filePath = url === '/' ? '/index.html' : url;
  const ext = path.extname(filePath);
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('404');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/html' });
    res.end(content, 'utf-8');
  });
});

// 端口适配 Railway
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 服务启动：端口 ' + PORT);
});