const allowedModes = new Set(['lady', 'poetic', 'comedy']);
const allowedAvatars = new Set([
  'longnose',
  'roundears',
  'firebox',
  'oneeye',
  'boxhead',
  'snail'
]);

function getSupabaseConfig() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').trim();
  const secretKey = (process.env.SUPABASE_SECRET_KEY || '').trim();

  if (!url || !secretKey) {
    throw new Error('Supabase is not configured in Vercel.');
  }

  return { url, secretKey };
}

function sendError(res, status, message) {
  res.status(status).json({ error: { message } });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  let config;

  try {
    config = getSupabaseConfig();
  } catch (error) {
    sendError(res, 500, error.message);
    return;
  }

  const headers = {
    apikey: config.secretKey,
    'Content-Type': 'application/json'
  };

  try {
    if (req.method === 'GET') {
      const response = await fetch(
        `${config.url}/rest/v1/posts?select=id,text,source,mode,username,avatar,created_at&order=created_at.desc&limit=100`,
        { headers }
      );
      const data = await response.json();

      if (!response.ok) {
        sendError(res, response.status, data.message || '投稿を取得できませんでした。');
        return;
      }

      res.status(200).json({ posts: data });
      return;
    }

    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const source = typeof body.source === 'string' ? body.source.trim() : '';
    const mode = typeof body.mode === 'string' ? body.mode : '';
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const avatar = typeof body.avatar === 'string' ? body.avatar : '';

    if (!text || text.length > 500) {
      sendError(res, 400, '投稿本文は1文字以上500文字以内にしてください。');
      return;
    }

    if (source.length > 500) {
      sendError(res, 400, '元ネタは500文字以内にしてください。');
      return;
    }

    if (!allowedModes.has(mode)) {
      sendError(res, 400, '投稿モードが正しくありません。');
      return;
    }

    if (!username || username.length > 20) {
      sendError(res, 400, '名前は1文字以上20文字以内にしてください。');
      return;
    }

    if (!allowedAvatars.has(avatar)) {
      sendError(res, 400, 'アイコンが正しくありません。');
      return;
    }

    const response = await fetch(`${config.url}/rest/v1/posts`, {
      method: 'POST',
      headers: {
        ...headers,
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        text,
        source: source || '非公開',
        mode,
        username,
        avatar
      })
    });
    const data = await response.json();

    if (!response.ok) {
      sendError(res, response.status, data.message || '投稿を保存できませんでした。');
      return;
    }

    res.status(201).json({ post: data[0] });
  } catch (error) {
    sendError(res, 500, 'データベースに接続できませんでした。');
  }
};
