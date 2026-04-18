const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const STATIC_DIR = path.join(__dirname);
const DATA_FILE = path.join(__dirname, 'data.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Read request body helper
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers (for local dev)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  // ===== API: Load data =====
  if (url === '/api/data' && req.method === 'GET') {
    try {
      const data = fs.existsSync(DATA_FILE)
        ? fs.readFileSync(DATA_FILE, 'utf-8')
        : '{}';
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(data);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{}');
    }
    return;
  }

  // ===== API: Save data =====
  if (url === '/api/data' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      // validate it's valid JSON & pretty print it for readability
      const parsed = JSON.parse(body);
      const prettyJson = JSON.stringify(parsed, null, 2);
      fs.writeFileSync(DATA_FILE, prettyJson, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}');
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"error":"Invalid JSON"}');
    }
    return;
  }

  // ===== Static files =====
  let filePath = url === '/' ? '/index.html' : url;
  const fullPath = path.join(STATIC_DIR, filePath);

  // security: prevent path traversal
  if (!fullPath.startsWith(STATIC_DIR)) { res.writeHead(403); res.end(); return; }

  fs.readFile(fullPath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
