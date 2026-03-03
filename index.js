import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// ═══ Axiom Auth State ═══
let refreshToken = process.env.AXIOM_REFRESH_TOKEN || '';
let accessToken = '';
let cfBm = '';
let lastRefresh = 0;

const REFRESH_INTERVAL = 14 * 60 * 1000;

async function refreshAccessToken() {
  try {
    console.log(`[${ts()}] 🔄 Refreshing access token...`);
    
    const res = await fetch('https://api9.axiom.trade/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cookie': `auth-refresh-token=${refreshToken}`,
        'referer': 'https://axiom.trade/',
        'origin': 'https://axiom.trade',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (res.status === 526) {
      console.log(`[${ts()}] ⏳ Axiom SSL issue — skipping refresh`);
      return false;
    }

    const setCookies = res.headers.getSetCookie?.() || [];
    const rawSetCookie = res.headers.get('set-cookie') || '';
    
    let newAccess = '';
    let newRefresh = '';
    let newCfBm = '';
    
    const allCookies = [...setCookies, ...rawSetCookie.split(',')];
    
    for (const c of allCookies) {
      const accessMatch = c.match(/auth-access-token=([^;]+)/);
      if (accessMatch) newAccess = accessMatch[1];
      
      const refreshMatch = c.match(/auth-refresh-token=([^;]+)/);
      if (refreshMatch) newRefresh = refreshMatch[1];
      
      const cfMatch = c.match(/__cf_bm=([^;]+)/);
      if (cfMatch) newCfBm = cfMatch[1];
    }
    
    try {
      const body = await res.text();
      if (body.includes('access')) {
        try {
          const data = JSON.parse(body);
          if (data.accessToken) newAccess = data.accessToken;
        } catch (e) {}
      }
    } catch (e) {}
    
    if (newAccess) {
      accessToken = newAccess;
      if (newRefresh) refreshToken = newRefresh;
      if (newCfBm) cfBm = newCfBm;
      lastRefresh = Date.now();
      console.log(`[${ts()}] ✅ Access token refreshed`);
      return true;
    }
    
    console.log(`[${ts()}] ⚠️ Refresh failed. Status: ${res.status}`);
    return false;
  } catch (e) {
    console.log(`[${ts()}] ❌ Refresh error: ${e.message}`);
    return false;
  }
}

function buildCookie() {
  let cookie = `auth-refresh-token=${refreshToken}`;
  if (accessToken) cookie += `; auth-access-token=${accessToken}`;
  if (cfBm) cookie += `; __cf_bm=${cfBm}`;
  return cookie;
}

function needsRefresh() {
  return !accessToken || (Date.now() - lastRefresh > REFRESH_INTERVAL);
}

function ts() {
  return new Date().toISOString().slice(11, 19);
}

// ═══ Axiom Fees ═══
app.get('/fees/:pool', async (req, res) => {
  const pool = req.params.pool;
  if (!pool || pool.length < 30) {
    return res.json({ error: 'invalid pool', totalPairFeesPaid: 0 });
  }

  if (needsRefresh()) {
    await refreshAccessToken();
  }

  try {
    const url = `https://api9.axiom.trade/token-info?pairAddress=${pool}&v=${Date.now()}`;
    const response = await fetch(url, {
      headers: {
        'cookie': buildCookie(),
        'referer': 'https://axiom.trade/',
        'origin': 'https://axiom.trade',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'accept': 'application/json'
      }
    });

    if (res.status === 526) {
      console.log(`[${ts()}] ⏳ Axiom SSL issue on fees`);
      return res.json({ error: 'ssl_issue', totalPairFeesPaid: 0 });
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        console.log(`[${ts()}] ⚠️ Axiom ${response.status}, retrying with refresh...`);
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          const res2 = await fetch(url, {
            headers: {
              'cookie': buildCookie(),
              'referer': 'https://axiom.trade/',
              'origin': 'https://axiom.trade',
              'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'accept': 'application/json'
            }
          });
          if (res2.ok) {
            const data = await res2.json();
            console.log(`[${ts()}] ✅ ${pool.slice(0, 8)} → fees: ${data.totalPairFeesPaid || 0} (retry)`);
            return res.json(data);
          }
        }
      }
      console.log(`[${ts()}] ❌ ${pool.slice(0, 8)} → ${response.status}`);
      return res.json({ error: `axiom ${response.status}`, totalPairFeesPaid: 0 });
    }

    const data = await response.json();
    console.log(`[${ts()}] ✅ ${pool.slice(0, 8)} → fees: ${data.totalPairFeesPaid || 0}`);
    res.json(data);
  } catch (e) {
    console.log(`[${ts()}] ❌ ${pool.slice(0, 8)} → ${e.message}`);
    res.json({ error: e.message, totalPairFeesPaid: 0 });
  }
});

// ═══ Manual Cookie Update ═══
app.post('/update-cookie', express.json(), (req, res) => {
  const key = req.headers['x-api-key'] || '';
  if (key !== (process.env.API_KEY || 'sniper2025')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (req.body.refreshToken) {
    refreshToken = req.body.refreshToken;
    accessToken = '';
    lastRefresh = 0;
    console.log(`[${ts()}] 🔑 Refresh token updated`);
    res.json({ ok: true });
  } else if (req.body.cookie) {
    const rt = req.body.cookie.match(/auth-refresh-token=([^;]+)/);
    const at = req.body.cookie.match(/auth-access-token=([^;]+)/);
    const cf = req.body.cookie.match(/__cf_bm=([^;]+)/);
    if (rt) refreshToken = rt[1];
    if (at) { accessToken = at[1]; lastRefresh = Date.now(); }
    if (cf) cfBm = cf[1];
    console.log(`[${ts()}] 🔑 Cookie updated`);
    res.json({ ok: true });
  } else {
    res.json({ error: 'provide refreshToken or cookie' });
  }
});

// ═══ Status ═══
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'axiom-fees-proxy',
    endpoint: '/fees/:pool',
    hasRefreshToken: refreshToken.length > 0,
    hasAccessToken: accessToken.length > 0,
    lastRefresh: lastRefresh > 0 ? `${Math.floor((Date.now() - lastRefresh) / 1000)}s ago` : 'never',
    needsRefresh: needsRefresh()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Axiom Fees Proxy running on port ${PORT}`);
  console.log(`🔑 Refresh token: ${refreshToken ? 'SET' : 'NOT SET'}`);
  
  if (refreshToken) {
    refreshAccessToken();
  }
});
