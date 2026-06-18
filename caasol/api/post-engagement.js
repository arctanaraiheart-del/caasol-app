const allowedAvatars = new Set([
  'longnose',
  'roundears',
  'firebox',
  'oneeye',
  'boxhead',
  'snail'
]);

const allowedReactionTypes = new Set(['empathy', 'cheer']);
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

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
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
    const body = req.body || {};
    const postId = String(body.postId || '').trim();
    const reactionType = typeof body.reactionType === 'string' ? body.reactionType : '';
    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
    const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    const avatar = typeof body.avatar === 'string' ? body.avatar : '';
    const usernameInput = typeof body.username === 'string' ? body.username.trim() : '';
    const username = usernameInput && usernameInput.length <= 20 ? usernameInput : FALLBACK_USERNAME;

    if (!postId) {
      sendError(res, 400, 'postId is required.');
      return;
    }

    if (!/^\d+$/.test(postId)) {
      sendError(res, 400, 'Invalid postId.');
      return;
    }

    if (reactionType) {
      if (!allowedReactionTypes.has(reactionType)) {
        sendError(res, 400, 'Invalid reaction type.');
        return;
      }

      if (!clientId || clientId.length > 120) {
        sendError(res, 400, 'clientId is required.');
        return;
      }

      const checkUrl = `${config.url}/rest/v1/post_reactions?select=id&post_id=eq.${encodeURIComponent(postId)}&reaction_type=eq.${encodeURIComponent(reactionType)}&client_id=eq.${encodeURIComponent(clientId)}`;
      const existing = await fetchJson(checkUrl, { headers });
      if (!existing.response.ok) {
        sendError(res, existing.response.status, existing.data.message || 'Failed to check reaction.');
        return;
      }

      let active = false;

      if (Array.isArray(existing.data) && existing.data.length) {
        const deleteUrl = `${config.url}/rest/v1/post_reactions?post_id=eq.${encodeURIComponent(postId)}&reaction_type=eq.${encodeURIComponent(reactionType)}&client_id=eq.${encodeURIComponent(clientId)}`;
        const deleteResponse = await fetch(deleteUrl, {
          method: 'DELETE',
          headers
        });
        if (!deleteResponse.ok) {
          const deleteData = await deleteResponse.json();
          sendError(res, deleteResponse.status, deleteData.message || 'Failed to remove reaction.');
          return;
        }
      } else {
        const insert = await fetchJson(`${config.url}/rest/v1/post_reactions`, {
          method: 'POST',
          headers: {
            ...headers,
            Prefer: 'return=representation'
          },
          body: JSON.stringify({
            post_id: Number(postId),
            reaction_type: reactionType,
            client_id: clientId
          })
        });
        if (!insert.response.ok) {
          sendError(res, insert.response.status, insert.data.message || 'Failed to save reaction.');
          return;
        }
        active = true;
      }

      const reactionRows = await fetchJson(
        `${config.url}/rest/v1/post_reactions?select=reaction_type&post_id=eq.${encodeURIComponent(postId)}`,
        { headers }
      );
      if (!reactionRows.response.ok) {
        sendError(res, reactionRows.response.status, reactionRows.data.message || 'Failed to fetch reaction counts.');
        return;
      }

      const reactions = { empathy: 0, cheer: 0 };
      for (const row of reactionRows.data || []) {
        if (row.reaction_type === 'empathy') reactions.empathy += 1;
        if (row.reaction_type === 'cheer') reactions.cheer += 1;
      }

      res.status(200).json({ active, reactions });
      return;
    }

    if (!comment || comment.length > 240) {
      sendError(res, 400, 'Comment must be between 1 and 240 characters.');
      return;
    }

    if (!allowedAvatars.has(avatar)) {
      sendError(res, 400, 'Invalid avatar.');
      return;
    }

    const created = await fetchJson(`${config.url}/rest/v1/post_comments`, {
      method: 'POST',
      headers: {
        ...headers,
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        post_id: Number(postId),
        text: comment,
        username,
        avatar
      })
    });

    if (!created.response.ok) {
      sendError(res, created.response.status, created.data.message || 'Failed to save comment.');
      return;
    }

    const row = created.data[0];
    res.status(201).json({
      comment: {
        id: row.id,
        postId: row.post_id,
        text: row.text,
        avatar: row.avatar,
        createdAt: row.created_at
      }
    });
  } catch (error) {
    sendError(res, 500, 'Server error while handling post engagement.');
  }
};
