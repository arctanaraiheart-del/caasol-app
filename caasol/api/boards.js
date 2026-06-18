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

function normalizeBoard(board, messages = []) {
  return {
    id: board.id,
    title: board.title,
    note: board.note || '',
    mode: board.mode,
    username: board.username,
    avatar: board.avatar,
    createdAt: board.created_at,
    messages
  };
}

function normalizeMessage(message) {
  return {
    id: message.id,
    boardId: message.board_id,
    text: message.text,
    source: message.source || HIDDEN_SOURCE,
    mode: message.mode,
    username: message.username,
    avatar: message.avatar,
    createdAt: message.created_at
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
      const boardsResponse = await fetch(
        `${config.url}/rest/v1/boards?select=id,title,note,mode,username,avatar,created_at&closed=eq.false&order=created_at.desc&limit=100`,
        { headers }
      );
      const boardData = await boardsResponse.json();

      if (!boardsResponse.ok) {
        sendError(res, boardsResponse.status, boardData.message || 'Failed to fetch boards.');
        return;
      }

      if (!boardData.length) {
        res.status(200).json({ boards: [] });
        return;
      }

      const boardIds = boardData.map(board => board.id).join(',');
      const messagesResponse = await fetch(
        `${config.url}/rest/v1/board_messages?select=id,board_id,text,source,mode,username,avatar,created_at&board_id=in.(${boardIds})&hidden=eq.false&order=created_at.desc&limit=1000`,
        { headers }
      );
      const messageData = await messagesResponse.json();

      if (!messagesResponse.ok) {
        sendError(res, messagesResponse.status, messageData.message || 'Failed to fetch board messages.');
        return;
      }

      const messagesByBoard = messageData.reduce((map, message) => {
        const normalized = normalizeMessage(message);
        if (!map.has(normalized.boardId)) {
          map.set(normalized.boardId, []);
        }
        map.get(normalized.boardId).push(normalized);
        return map;
      }, new Map());

      res.status(200).json({
        boards: boardData.map(board => normalizeBoard(board, messagesByBoard.get(board.id) || []))
      });
      return;
    }

    const body = req.body || {};
    const boardId = typeof body.boardId === 'string' ? body.boardId.trim() : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const source = typeof body.source === 'string' ? body.source.trim() : '';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const mode = typeof body.mode === 'string' ? body.mode : '';
    const usernameInput = typeof body.username === 'string' ? body.username.trim() : '';
    const username = usernameInput && usernameInput.length <= 20 ? usernameInput : FALLBACK_USERNAME;
    const avatar = typeof body.avatar === 'string' ? body.avatar : '';

    if (!allowedModes.has(mode)) {
      sendError(res, 400, 'Invalid mode.');
      return;
    }

    if (!allowedAvatars.has(avatar)) {
      sendError(res, 400, 'Invalid avatar.');
      return;
    }

    if (boardId) {
      if (!text || text.length > 500) {
        sendError(res, 400, 'Text must be between 1 and 500 characters.');
        return;
      }

      if (source.length > 240) {
        sendError(res, 400, 'Source must be 240 characters or fewer.');
        return;
      }

      const boardCheckResponse = await fetch(
        `${config.url}/rest/v1/boards?select=id,closed&id=eq.${encodeURIComponent(boardId)}&limit=1`,
        { headers }
      );
      const boardCheckData = await boardCheckResponse.json();

      if (!boardCheckResponse.ok) {
        sendError(res, boardCheckResponse.status, boardCheckData.message || 'Failed to check board status.');
        return;
      }

      if (!boardCheckData.length || boardCheckData[0].closed) {
        sendError(res, 403, 'This board is closed.');
        return;
      }

      const messageResponse = await fetch(`${config.url}/rest/v1/board_messages`, {
        method: 'POST',
        headers: {
          ...headers,
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          board_id: boardId,
          text,
          source: source || HIDDEN_SOURCE,
          mode,
          username,
          avatar
        })
      });
      const messageData = await messageResponse.json();

      if (!messageResponse.ok) {
        sendError(res, messageResponse.status, messageData.message || 'Failed to save board message.');
        return;
      }

      res.status(201).json({ message: normalizeMessage(messageData[0]) });
      return;
    }

    if (!title || title.length > 40) {
      sendError(res, 400, 'Title must be between 1 and 40 characters.');
      return;
    }

    if (note.length > 120) {
      sendError(res, 400, 'Note must be 120 characters or fewer.');
      return;
    }

    const boardResponse = await fetch(`${config.url}/rest/v1/boards`, {
      method: 'POST',
      headers: {
        ...headers,
        Prefer: 'return=representation'
      },
      body: JSON.stringify({
        title,
        note,
        mode,
        username,
        avatar
      })
    });
    const boardData = await boardResponse.json();

    if (!boardResponse.ok) {
      sendError(res, boardResponse.status, boardData.message || 'Failed to save board.');
      return;
    }

    res.status(201).json({ board: normalizeBoard(boardData[0]) });
  } catch (error) {
    sendError(res, 500, 'Server error while handling boards.');
  }
};
