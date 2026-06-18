const allowedModes = new Set([
  'lady',
  'poetic',
  'comedy',
  'chuunibyou',
  'business',
  'samurai',
  'news',
  'philosopher',
  'demonlord',
  'classical'
]);

const allowedAvatars = new Set([
  'longnose',
  'roundears',
  'firebox',
  'oneeye',
  'boxhead',
  'snail'
]);

const APP_PAUSED = false;
const PAUSE_MESSAGE = 'The app is temporarily paused.';
const HIDDEN_SOURCE = 'hidden';
const FALLBACK_USERNAME = 'anonymous';

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

  if (APP_PAUSED) {
    res.setHeader('Retry-After', '3600');
    sendError(res, 503, PAUSE_MESSAGE);
    return;
  }

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
    Authorization: `Bearer ${config.secretKey}`,
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
        sendError(res, response.status, data.message || 'Failed to fetch posts.');
        return;
      }

      res.status(200).json({ posts: data });
      return;
    }

    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const source = typeof body.source === 'string' ? body.source.trim() : '';
    const mode = typeof body.mode === 'string' ? body.mode : '';
    const usernameInput = typeof body.username === 'string' ? body.username.trim() : '';
    const username = usernameInput && usernameInput.length <= 20 ? usernameInput : FALLBACK_USERNAME;
    const avatar = typeof body.avatar === 'string' ? body.avatar : '';

    if (!text || text.length > 500) {
      sendError(res, 400, 'Text must be between 1 and 500 characters.');
      return;
    }

    if (source.length > 500) {
      sendError(res, 400, 'Source must be 500 characters or fewer.');
      return;
    }

    if (!allowedModes.has(mode)) {
      sendError(res, 400, 'Invalid mode.');
      return;
    }

    if (!allowedAvatars.has(avatar)) {
      sendError(res, 400, 'Invalid avatar.');
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
        source: source || HIDDEN_SOURCE,
        mode,
        username,
        avatar
      })
    });
    const data = await response.json();

    if (!response.ok) {
      sendError(res, response.status, data.message || 'Failed to save post.');
      return;
    }

    res.status(201).json({ post: data[0] });
  } catch (error) {
    sendError(res, 500, 'Server error while handling posts.');
  }
};
