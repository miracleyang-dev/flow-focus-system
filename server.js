const http = require('http');
const fs = require('fs');
const path = require('path');

// ===== Redis 连接（兼容 Railway 多种环境变量名） =====
let redis = null;
let redisReady = false;
let redisError = '';

function initRedis() {
  // Railway 可能注入不同的变量名
  const url = process.env.REDIS_URL
    || process.env.REDIS_PRIVATE_URL
    || process.env.REDIS_PUBLIC_URL;

  if (!url) {
    redisError = '未找到 REDIS_URL / REDIS_PRIVATE_URL / REDIS_PUBLIC_URL 环境变量';
    console.error('❌ ' + redisError);
    return;
  }

  console.log('🔄 正在连接 Redis...');
  const Redis = require('ioredis');
  redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 5) return null; // 超过 5 次停止重试
      return Math.min(times * 200, 2000);
    },
    connectTimeout: 10000,
  });

  redis.on('connect', () => {
    redisReady = true;
    redisError = '';
    console.log('✅ Redis 连接成功');
  });

  redis.on('ready', () => {
    redisReady = true;
    redisError = '';
  });

  redis.on('error', (err) => {
    redisReady = false;
    redisError = err.message || '连接错误';
    console.error('❌ Redis 错误:', err.message);
  });

  redis.on('close', () => {
    redisReady = false;
    console.log('⚠️ Redis 连接关闭');
  });
}

initRedis();

// ===== JSON 文件兜底存储 =====
const DATA_FILE = path.join(__dirname, 'data.json');

function readFileData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return fs.readFileSync(DATA_FILE, 'utf-8');
    }
  } catch (e) { /* ignore */ }
  return '{}';
}

function writeFileData(json) {
  try {
    fs.writeFileSync(DATA_FILE, json, 'utf-8');
  } catch (e) {
    console.error('⚠️ 文件写入失败:', e.message);
  }
}

// ===== 静态文件 MIME 类型 =====
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

// ===== 创建服务器 =====
const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  // CORS headers (对调试有用)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // --------------------------
  // 健康检查：前端可调用此接口判断后端和 Redis 状态
  // --------------------------
  if (url === '/api/health' && method === 'GET') {
    const status = {
      server: true,
      redis: redisReady,
      redisError: redisError || null,
      env: {
        REDIS_URL: !!process.env.REDIS_URL,
        REDIS_PRIVATE_URL: !!process.env.REDIS_PRIVATE_URL,
        REDIS_PUBLIC_URL: !!process.env.REDIS_PUBLIC_URL,
      },
      timestamp: new Date().toISOString(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  // --------------------------
  // API：获取数据
  // --------------------------
  if (url === '/api/data' && method === 'GET') {
    try {
      let data = null;
      if (redis && redisReady) {
        data = await redis.get('app_data');
      }
      // Redis 无数据或不可用时，从文件读取
      if (!data || data === '{}') {
        data = readFileData();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data || '{}');
    } catch (err) {
      console.error('❌ GET /api/data 错误:', err.message);
      // 降级到文件
      const fallback = readFileData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fallback);
    }
    return;
  }

  // --------------------------
  // API：保存数据
  // --------------------------
  if (url === '/api/data' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      let savedToRedis = false;
      let savedToFile = false;
      let error = '';

      // 1. 尝试写入 Redis
      try {
        if (redis && redisReady) {
          await redis.set('app_data', body);
          savedToRedis = true;
        }
      } catch (err) {
        error = 'Redis 写入失败: ' + err.message;
        console.error('❌ ' + error);
      }

      // 2. 同时写入文件作为备份
      try {
        writeFileData(body);
        savedToFile = true;
      } catch (err) {
        console.error('❌ 文件写入失败:', err.message);
      }

      if (savedToRedis || savedToFile) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: 1,
          redis: savedToRedis,
          file: savedToFile,
          msg: savedToRedis ? '保存成功（Redis + 文件双备份）' : '保存成功（仅文件备份，Redis 不可用）',
        }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: 0, msg: '保存失败: ' + error }));
      }
    });
    return;
  }

  // --------------------------
  // 静态文件
  // --------------------------
  let filePath = url === '/' ? '/index.html' : url.split('?')[0];
  const ext = path.extname(filePath);
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('404');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/html; charset=utf-8' });
    res.end(content);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 服务启动：端口 ' + PORT);
  console.log('📦 Redis 状态: ' + (redisReady ? '已连接' : '未连接 — ' + (redisError || '等待中...')));
});
