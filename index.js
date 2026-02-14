import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// Axiom cookie - update when expired
let AXIOM_COOKIE = process.env.AXIOM_COOKIE || '';

app.get('/fees/:pool', async (req, res) => {
  const pool = req.params.pool;
  
  if (!pool || pool.length < 30) {
    return res.json({ error: 'invalid pool', totalPairFeesPaid: 0 });
  }

  try {
    const url = `https://api3.axiom.trade/token-info?pairAddress=${pool}&v=${Date.now()}`;
    const response = await fetch(url, {
      headers: {
        'cookie': AXIOM_COOKIE,
        'referer': 'https://axiom.trade/',
        'origin': 'https://axiom.trade',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.log(`[${new Date().toISOString()}] Axiom ${response.status} for ${pool.slice(0, 8)}`);
      return res.json({ error: `axiom ${response.status}`, totalPairFeesPaid: 0 });
    }

    const data = await response.json();
    console.log(`[${new Date().toISOString()}] ✅ ${pool.slice(0, 8)} → fees: ${data.totalPairFeesPaid || 0}`);
    res.json(data);
  } catch (e) {
    console.log(`[${new Date().toISOString()}] ❌ ${pool.slice(0, 8)} → ${e.message}`);
    res.json({ error: e.message, totalPairFeesPaid: 0 });
  }
});

// Update cookie endpoint (protected with simple key)
app.post('/update-cookie', express.json(), (req, res) => {
  const key = req.headers['x-api-key'] || '';
  if (key !== (process.env.API_KEY || 'sniper2025')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  
  if (req.body.cookie) {
    AXIOM_COOKIE = req.body.cookie;
    console.log(`[${new Date().toISOString()}] 🔑 Cookie updated (${AXIOM_COOKIE.length} chars)`);
    res.json({ ok: true, length: AXIOM_COOKIE.length });
  } else {
    res.json({ error: 'no cookie provided' });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'axiom-proxy',
    hasCookie: AXIOM_COOKIE.length > 0,
    cookieLength: AXIOM_COOKIE.length
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Axiom Proxy running on port ${PORT}`);
  console.log(`🔑 Cookie: ${AXIOM_COOKIE ? `${AXIOM_COOKIE.length} chars` : 'NOT SET — use AXIOM_COOKIE env var'}`);
});