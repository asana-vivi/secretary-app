// 自分専用の秘書アプリ - サーバー
// Node.js 標準モジュールのみで動作します（追加インストール不要）
// 起動: node server.js  → ブラウザで http://localhost:3000 を開く

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- データの読み書き ----
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      memos: Array.isArray(data.memos) ? data.memos : [],
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      reviews: Array.isArray(data.reviews) ? data.reviews : [],
    };
  } catch (e) {
    // ファイルが無い/壊れている場合は空データ
    return { memos: [], tasks: [], reviews: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// 簡易ID生成
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---- リクエストボディを読む ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy(); // 過大なボディを拒否
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---- 静的ファイル配信 ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  // ディレクトリトラバーサル防止
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---- API ハンドラ ----
async function handleApi(req, res) {
  const urlPath = req.url.split('?')[0];
  const data = loadData();

  // 一覧取得（ダッシュボード情報も含む）
  if (req.method === 'GET' && urlPath === '/api/state') {
    const pendingTasks = data.tasks.filter((t) => !t.done).length;
    // 振り返りは週（例: 2026-W46）の新しい順に並べる
    const reviews = [...data.reviews].sort((a, b) => (a.week < b.week ? 1 : a.week > b.week ? -1 : 0));
    const latestReview = reviews.length ? reviews[0] : null;
    return sendJson(res, 200, {
      memos: data.memos,
      tasks: data.tasks,
      reviews,
      stats: {
        memoCount: data.memos.length,
        taskCount: data.tasks.length,
        pendingTaskCount: pendingTasks,
        latestReview,
      },
    });
  }

  // メモ追加
  if (req.method === 'POST' && urlPath === '/api/memos') {
    const body = await readBody(req);
    const title = (body.title || '').toString().trim();
    const content = (body.content || '').toString().trim();
    if (!title && !content) {
      return sendJson(res, 400, { error: 'タイトルまたは本文を入力してください' });
    }
    const memo = { id: genId(), title, content, createdAt: new Date().toISOString() };
    data.memos.unshift(memo);
    saveData(data);
    return sendJson(res, 201, memo);
  }

  // メモ削除
  if (req.method === 'DELETE' && urlPath.startsWith('/api/memos/')) {
    const id = urlPath.slice('/api/memos/'.length);
    data.memos = data.memos.filter((m) => m.id !== id);
    saveData(data);
    return sendJson(res, 200, { ok: true });
  }

  // タスク追加
  if (req.method === 'POST' && urlPath === '/api/tasks') {
    const body = await readBody(req);
    const text = (body.text || '').toString().trim();
    if (!text) {
      return sendJson(res, 400, { error: 'タスク内容を入力してください' });
    }
    const task = { id: genId(), text, done: false, createdAt: new Date().toISOString() };
    data.tasks.unshift(task);
    saveData(data);
    return sendJson(res, 201, task);
  }

  // タスク完了状態の切り替え
  if (req.method === 'PATCH' && urlPath.startsWith('/api/tasks/')) {
    const id = urlPath.slice('/api/tasks/'.length);
    const body = await readBody(req);
    const task = data.tasks.find((t) => t.id === id);
    if (!task) return sendJson(res, 404, { error: '見つかりません' });
    task.done = typeof body.done === 'boolean' ? body.done : !task.done;
    saveData(data);
    return sendJson(res, 200, task);
  }

  // タスク削除
  if (req.method === 'DELETE' && urlPath.startsWith('/api/tasks/')) {
    const id = urlPath.slice('/api/tasks/'.length);
    data.tasks = data.tasks.filter((t) => t.id !== id);
    saveData(data);
    return sendJson(res, 200, { ok: true });
  }

  // 週次振り返りの記録（同じ週があれば上書き更新）
  if (req.method === 'POST' && urlPath === '/api/reviews') {
    const body = await readBody(req);
    const week = (body.week || '').toString().trim();
    const comment = (body.comment || '').toString().trim();
    if (!week) return sendJson(res, 400, { error: '週を選択してください' });
    if (!comment) return sendJson(res, 400, { error: '振り返りコメントを入力してください' });

    const existing = data.reviews.find((r) => r.week === week);
    let review;
    if (existing) {
      existing.comment = comment;
      existing.updatedAt = new Date().toISOString();
      review = existing;
    } else {
      review = { id: genId(), week, comment, createdAt: new Date().toISOString() };
      data.reviews.push(review);
    }
    saveData(data);
    return sendJson(res, 201, review);
  }

  // 振り返り削除
  if (req.method === 'DELETE' && urlPath.startsWith('/api/reviews/')) {
    const id = urlPath.slice('/api/reviews/'.length);
    data.reviews = data.reviews.filter((r) => r.id !== id);
    saveData(data);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Unknown API' });
}

// ---- サーバー本体 ----
const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      await handleApi(req, res);
    } else {
      serveStatic(req, res);
    }
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`秘書アプリを起動しました → http://localhost:${PORT}`);
  console.log('終了するには Ctrl + C を押してください。');
});
