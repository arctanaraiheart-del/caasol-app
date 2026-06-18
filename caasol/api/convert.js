const APP_PAUSED = false;
const PAUSE_MESSAGE = 'The app is temporarily paused.';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (APP_PAUSED) {
    res.setHeader('Retry-After', '3600');
    res.status(503).json({ error: { message: PAUSE_MESSAGE } });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method Not Allowed' } });
    return;
  }

  const apiKey = (process.env.OPENAI_API_KEY || '').replace(/\u3000/g, '').trim();

  if (!apiKey) {
    res.status(500).json({
      error: { message: 'OPENAI_API_KEY is not configured in Vercel.' }
    });
    return;
  }

  const body = req.body || {};

  if (!Array.isArray(body.messages)) {
    res.status(400).json({ error: { message: 'messages is required.' } });
    return;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 400,
        messages: body.messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      res.status(response.status).json(data);
      return;
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
};
