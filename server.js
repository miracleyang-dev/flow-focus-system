const http = require('http');
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

const redisUrl = process.env.REDIS_URL || process.env.REDIS_PRIVATE_URL || process.env.REDIS_PUBLIC_URL;
const redis = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: 2, connectTimeout: 10000 }) : null;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

if (redis) {
  redis.on('error', err => console.error('Redis 错误:', err.message));
} else {
  console.warn('未配置 Redis，云端数据暂不可用');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function handleDataRequest(req, res) {
  if (!redis) {
    sendJson(res, 503, { error: '未配置 Railway Redis' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const data = await redis.get('app_data');
      sendJson(res, 200, data ? JSON.parse(data) : {});
      return;
    }

    if (req.method === 'POST') {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) {
          sendJson(res, 413, { error: '数据超过 5MB 限制' });
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const data = JSON.parse(body);
      await redis.set('app_data', JSON.stringify(data));
      sendJson(res, 200, { ok: true });
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    sendJson(res, 405, { error: 'Method Not Allowed' });
  } catch (err) {
    console.error('数据接口错误:', err.message);
    sendJson(res, 500, { error: '云端数据操作失败' });
  }
}

const server = http.createServer((req, res) => {
  const requestPath = (req.url || '/').split('?')[0];
  if (requestPath === '/api/data') {
    handleDataRequest(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('405 Method Not Allowed');
    return;
  }

  const filePath = requestPath === '/' ? '/index.html' : requestPath;
  const resolved = path.resolve(path.join(__dirname, filePath));
  if (!resolved.startsWith(__dirname + path.sep)) {
    res.writeHead(403);
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(resolved, (err, content) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? '404' : '500');
      return;
    }
    const ext = path.extname(resolved);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    if (req.method === 'HEAD') res.end();
    else res.end(content);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('服务启动：端口 ' + PORT);
});
