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

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  return { response, data };
}

function normalizeComment(comment) {
  return {
    id: comment.id,
    postId: comment.post_id,
    text: comment.text,
    avatar: comment.avatar,
    createdAt: comment.created_at
  };
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
      const { response, data } = await fetchJson(
        `${config.url}/rest/v1/posts?select=id,text,source,mode,username,avatar,created_at&hidden=eq.false&order=created_at.desc&limit=100`,
        { headers }
      );

      if (!response.ok) {
        sendError(res, response.status, data.message || 'Failed to fetch posts.');
        return;
      }

      if (!data.length) {
        res.status(200).json({ posts: [] });
        return;
      }

      const postIds = data.map(post => post.id).join(',');

      let reactionRows = [];
      try {
        const reactionResult = await fetchJson(
          `${config.url}/rest/v1/post_reactions?select=post_id,reaction_type&post_id=in.(${postIds})`,
          { headers }
        );
        if (reactionResult.response.ok) {
          reactionRows = Array.isArray(reactionResult.data) ? reactionResult.data : [];
        }
      } catch (error) {}

      let commentRows = [];
      try {
        const commentResult = await fetchJson(
          `${config.url}/rest/v1/post_comments?select=id,post_id,text,avatar,created_at&post_id=in.(${postIds})&hidden=eq.false&order=created_at.asc`,
          { headers }
        );
        if (commentResult.response.ok) {
          commentRows = Array.isArray(commentResult.data) ? commentResult.data : [];
        }
      } catch (error) {}

      const reactionsByPost = reactionRows.reduce((map, row) => {
        const postId = String(row.post_id);
        const current = map.get(postId) || { empathy: 0, cheer: 0 };
        if (row.reaction_type === 'empathy') current.empathy += 1;
        if (row.reaction_type === 'cheer') current.cheer += 1;
        map.set(postId, current);
        return map;
      }, new Map());

      const commentsByPost = commentRows.reduce((map, row) => {
        const postId = String(row.post_id);
        if (!map.has(postId)) map.set(postId, []);
        map.get(postId).push(normalizeComment(row));
        return map;
      }, new Map());

      res.status(200).json({
        posts: data.map(post => {
          const postId = String(post.id);
          const comments = commentsByPost.get(postId) || [];
          return {
            ...post,
            reactions: reactionsByPost.get(postId) || { empathy: 0, cheer: 0 },
            comments,
            commentCount: comments.length
          };
        })
      });
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

    const { response, data } = await fetchJson(`${config.url}/rest/v1/posts`, {
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

    if (!response.ok) {
      sendError(res, response.status, data.message || 'Failed to save post.');
      return;
    }

    res.status(201).json({
      post: {
        ...data[0],
        reactions: { empathy: 0, cheer: 0 },
        comments: [],
        commentCount: 0
      }
    });
  } catch (error) {
    sendError(res, 500, 'Server error while handling posts.');
  }
};
