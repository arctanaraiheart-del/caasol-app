const allowedEntityTypes = new Set([
  'post',
  'post_comment',
  'board',
  'board_message'
]);

const APP_PAUSED = false;

function getConfig() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').trim();
  const secretKey = (process.env.SUPABASE_SECRET_KEY || '').trim();
  const adminKey = (process.env.ADMIN_MOD_KEY || '').trim();

  if (!url || !secretKey) {
    throw new Error('Supabase is not configured in Vercel.');
  }

  return { url, secretKey, adminKey };
}

function sendError(res, status, message) {
  res.status(status).json({ error: { message } });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  return { response, data };
}

function getHeaders(secretKey) {
  return {
    apikey: secretKey,
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/json'
  };
}

function requireAdmin(req, res, adminKey) {
  const provided = String(req.headers['x-admin-key'] || '').trim();
  if (!adminKey || !provided || provided !== adminKey) {
    sendError(res, 403, 'Admin authentication failed.');
    return false;
  }
  return true;
}

function targetConfig(entityType) {
  switch (entityType) {
    case 'post':
      return { table: 'posts', column: 'hidden' };
    case 'post_comment':
      return { table: 'post_comments', column: 'hidden' };
    case 'board':
      return { table: 'boards', column: 'closed' };
    case 'board_message':
      return { table: 'board_messages', column: 'hidden' };
    default:
      return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (APP_PAUSED) {
    sendError(res, 503, 'The app is temporarily paused.');
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  let config;

  try {
    config = getConfig();
  } catch (error) {
    sendError(res, 500, error.message);
    return;
  }

  const headers = getHeaders(config.secretKey);
  const body = req.body || {};
  const action = typeof body.action === 'string' ? body.action : '';

  try {
    if (action === 'admin-check') {
      if (!requireAdmin(req, res, config.adminKey)) return;
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'report') {
      const entityType = typeof body.entityType === 'string' ? body.entityType : '';
      const entityId = String(body.entityId || '').trim();
      const preview = typeof body.preview === 'string' ? body.preview.trim().slice(0, 280) : '';
      const reason = typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim().slice(0, 200)
        : 'user-report';

      if (!allowedEntityTypes.has(entityType) || !entityId) {
        sendError(res, 400, 'Invalid report target.');
        return;
      }

      const { response, data } = await fetchJson(`${config.url}/rest/v1/reports`, {
        method: 'POST',
        headers: {
          ...headers,
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          entity_type: entityType,
          entity_id: entityId,
          reason,
          preview
        })
      });

      if (!response.ok) {
        sendError(res, response.status, data.message || 'Failed to save report.');
        return;
      }

      res.status(201).json({ ok: true });
      return;
    }

    if (action === 'moderate') {
      if (!requireAdmin(req, res, config.adminKey)) return;

      const entityType = typeof body.entityType === 'string' ? body.entityType : '';
      const entityId = String(body.entityId || '').trim();
      const configForTarget = targetConfig(entityType);

      if (!configForTarget || !entityId) {
        sendError(res, 400, 'Invalid moderation target.');
        return;
      }

      const { response, data } = await fetchJson(
        `${config.url}/rest/v1/${configForTarget.table}?id=eq.${encodeURIComponent(entityId)}`,
        {
          method: 'PATCH',
          headers: {
            ...headers,
            Prefer: 'return=representation'
          },
          body: JSON.stringify({
            [configForTarget.column]: true
          })
        }
      );

      if (!response.ok) {
        sendError(res, response.status, data.message || 'Failed to moderate target.');
        return;
      }

      res.status(200).json({ ok: true, item: Array.isArray(data) ? data[0] : null });
      return;
    }

    sendError(res, 400, 'Invalid action.');
  } catch (error) {
    sendError(res, 500, 'Server error while handling moderation.');
  }
};
