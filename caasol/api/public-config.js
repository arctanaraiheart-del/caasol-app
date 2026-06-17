module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: { message: 'Method Not Allowed' } });
    return;
  }

  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').trim();
  const publishableKey = (
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ''
  ).trim();

  if (!supabaseUrl || !publishableKey) {
    res.status(500).json({
      error: { message: 'Supabase publishable config is not configured in Vercel.' }
    });
    return;
  }

  res.status(200).json({
    supabaseUrl,
    publishableKey
  });
};
