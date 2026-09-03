import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// ═══ Axiom Auth State ═══
let refreshToken = process.env.AXIOM_REFRESH_TOKEN || '';
let accessToken = '';
let cfBm = '';
let lastRefresh = 0;
// RH (robinhood-api2) cere cf_clearance (IP-bound) → stocăm cookie-ul RH COMPLET,
// exact cum îl trimite browserul, și-l trimitem verbatim. Hot-swap via /update-cookie {rhCookie}.
let rhCookie = '';

const REFRESH_INTERVAL = 14 * 60 * 1000;

async function refreshAccessToken() {
  try {
    console.log(`[${ts()}] 🔄 Refreshing access token...`);

    const res = await fetch('https://api3.axiom.trade/auth/refresh', {
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
    const url = `https://api7.axiom.trade/token-info-v2?pairAddress=${pool}&v=${Date.now()}`;
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

// ═══ Axiom Pair Info (real deployer / CTO detection) ═══
// Returns Axiom's full pair-info JSON. The field that matters for CTO detection is
// data.extra.pumpDeployerAddress = the ORIGINAL pump.fun deployer (pump.fun's own
// `creator` gets reassigned on a CTO, so only Axiom keeps the real one).
app.get('/pair-info/:pair', async (req, res) => {
  const pair = req.params.pair;
  if (!pair || pair.length < 30) {
    return res.json({ error: 'invalid pair' });
  }

  if (needsRefresh()) {
    await refreshAccessToken();
  }

  const url = `https://api7.axiom.trade/pair-info?pairAddress=${pair}&v=${Date.now()}`;
  const mkHeaders = () => ({
    'cookie': buildCookie(),
    'referer': 'https://axiom.trade/',
    'origin': 'https://axiom.trade',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'accept': 'application/json'
  });

  try {
    let response = await fetch(url, { headers: mkHeaders() });

    // same retry-on-auth-failure pattern as /fees
    if (!response.ok && (response.status === 401 || response.status === 403 || response.status === 404)) {
      console.log(`[${ts()}] ⚠️ pair-info ${response.status}, retrying with refresh...`);
      const refreshed = await refreshAccessToken();
      if (refreshed) response = await fetch(url, { headers: mkHeaders() });
    }

    if (!response.ok) {
      console.log(`[${ts()}] ❌ pair-info ${pair.slice(0, 8)} → ${response.status}`);
      return res.json({ error: `axiom ${response.status}` });
    }

    const data = await response.json();
    const dep = data?.extra?.pumpDeployerAddress || null;
    console.log(`[${ts()}] ✅ pair-info ${pair.slice(0, 8)} → deployer ${dep ? dep.slice(0, 8) : 'n/a'}`);
    res.json(data);
  } catch (e) {
    console.log(`[${ts()}] ❌ pair-info ${pair.slice(0, 8)} → ${e.message}`);
    res.json({ error: e.message });
  }
});

// ═══ Axiom Dev Tokens (COMPLETE cross-platform token list for a creator) ═══
// pump.fun's user-created-coins API only returns pump.fun tokens — it MISSES tokens a dev
// launched directly on Raydium / other launchpads. Axiom's dev-tokens-v5 returns ALL of them,
// so a good creator's real track record (winners, fees, ATH) isn't undercounted.
app.get('/dev-tokens/:wallet', async (req, res) => {
  const wallet = req.params.wallet;
  if (!wallet || wallet.length < 30) {
    return res.json({ error: 'invalid wallet', tokens: [] });
  }

  if (needsRefresh()) {
    await refreshAccessToken();
  }

  const url = `https://api7.axiom.trade/dev-tokens-v5?devAddress=${wallet}&v=${Date.now()}`;
  const mkHeaders = () => ({
    'cookie': buildCookie(),
    'referer': 'https://axiom.trade/',
    'origin': 'https://axiom.trade',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'accept': 'application/json'
  });

  try {
    let response = await fetch(url, { headers: mkHeaders() });

    // same retry-on-auth-failure pattern as /fees and /pair-info
    if (!response.ok && (response.status === 401 || response.status === 403 || response.status === 404)) {
      console.log(`[${ts()}] ⚠️ dev-tokens ${response.status}, retrying with refresh...`);
      const refreshed = await refreshAccessToken();
      if (refreshed) response = await fetch(url, { headers: mkHeaders() });
    }

    if (!response.ok) {
      console.log(`[${ts()}] ❌ dev-tokens ${wallet.slice(0, 8)} → ${response.status}`);
      return res.json({ error: `axiom ${response.status}`, tokens: [] });
    }

    const data = await response.json();
    const arr = Array.isArray(data) ? data : (data.tokens || data.data || []);
    console.log(`[${ts()}] ✅ dev-tokens ${wallet.slice(0, 8)} → ${arr.length} tokens`);
    res.json({ tokens: arr });
  } catch (e) {
    console.log(`[${ts()}] ❌ dev-tokens ${wallet.slice(0, 8)} → ${e.message}`);
    res.json({ error: e.message, tokens: [] });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROBINHOOD CHAIN (EVM) — Axiom servește datele RH pe host SEPARAT de Solana:
//   robinhood-api2.axiom.trade/dev-tokens?devAddress=0x...   (api7 e Solana-only → 500 pe EVM)
// Auth-ul (refresh/access/__cf_bm) e ACELAȘI cont → refolosim buildCookie().
// Toate hosturile Axiom sunt geo-gated (404 de pe IP datacenter regiunea VPS) → merge doar de pe Railway.
// ═══════════════════════════════════════════════════════════════════════════
const RH_AX = 'https://robinhood-api2.axiom.trade';
function rhHeaders() {
  // Trimite cookie-ul RH COMPLET (cu cf_clearance) dacă e setat; altfel fallback la buildCookie().
  return {
    'cookie': rhCookie || buildCookie(),
    'referer': 'https://robinhood.axiom.trade/',
    'origin': 'https://robinhood.axiom.trade',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'accept': 'application/json'
  };
}

// RH dev-tokens — TOATE tokenele lansate de un creator pe Robinhood Chain
app.get('/rh/dev-tokens/:dev', async (req, res) => {
  const dev = req.params.dev;
  if (!dev || !/^0x[0-9a-fA-F]{40}$/.test(dev)) return res.json({ error: 'invalid dev', tokens: [] });
  if (needsRefresh()) await refreshAccessToken();
  const url = `${RH_AX}/dev-tokens?devAddress=${dev}&v=${Date.now()}`;
  try {
    let r = await fetch(url, { headers: rhHeaders() });
    if (!r.ok && (r.status === 401 || r.status === 403 || r.status === 404)) {
      if (await refreshAccessToken()) r = await fetch(url, { headers: rhHeaders() });
    }
    if (!r.ok) { console.log(`[${ts()}] ❌ rh/dev-tokens ${dev.slice(0, 8)} → ${r.status}`); return res.json({ error: `axiom ${r.status}`, tokens: [] }); }
    const data = await r.json();
    const arr = Array.isArray(data) ? data : (data.tokens || data.data || []);
    console.log(`[${ts()}] ✅ rh/dev-tokens ${dev.slice(0, 8)} → ${arr.length}`);
    res.json({ tokens: arr });
  } catch (e) { console.log(`[${ts()}] ❌ rh/dev-tokens ${dev.slice(0, 8)} → ${e.message}`); res.json({ error: e.message, tokens: [] }); }
});

// RH passthrough generic (guarded) — descoperă token-info / fees RH fără alt redeploy.
//   GET /rh/ax?path=token-info?pairAddress=0x...      header  x-api-key: sniper2025
app.get('/rh/ax', async (req, res) => {
  if ((req.headers['x-api-key'] || '') !== (process.env.API_KEY || 'sniper2025')) return res.status(401).json({ error: 'unauthorized' });
  const path = req.query.path; if (!path) return res.json({ error: 'need ?path=' });
  if (needsRefresh()) await refreshAccessToken();
  const url = `${RH_AX}/${String(path).replace(/^\//, '')}`;
  try {
    let r = await fetch(url, { headers: rhHeaders() });
    if (!r.ok && (r.status === 401 || r.status === 403)) { if (await refreshAccessToken()) r = await fetch(url, { headers: rhHeaders() }); }
    const body = await r.text();
    res.json({ status: r.status, url, body: body.slice(0, 20000) });
  } catch (e) { res.json({ error: e.message }); }
});

// ═══ Manual Cookie Update ═══
app.post('/update-cookie', express.json(), (req, res) => {
  const key = req.headers['x-api-key'] || '';
  if (key !== (process.env.API_KEY || 'sniper2025')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (req.body.rhCookie) {
    // cookie RH COMPLET (cu cf_clearance) trimis verbatim la robinhood-api2
    rhCookie = req.body.rhCookie;
    // extrage și tokenele pt refresh Solana (bonus)
    const rt = req.body.rhCookie.match(/auth-refresh-token=([^;]+)/);
    const at = req.body.rhCookie.match(/auth-access-token=([^;]+)/);
    const cf = req.body.rhCookie.match(/__cf_bm=([^;]+)/);
    if (rt) refreshToken = rt[1];
    if (at) { accessToken = at[1]; lastRefresh = Date.now(); }
    if (cf) cfBm = cf[1];
    console.log(`[${ts()}] 🔑 RH cookie updated (len ${rhCookie.length})`);
    res.json({ ok: true, rhCookie: rhCookie.length });
  } else if (req.body.refreshToken) {
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
    endpoints: ['/fees/:pool', '/pair-info/:pair', '/dev-tokens/:wallet', '/rh/dev-tokens/:dev', '/rh/ax?path='],
    hasRefreshToken: refreshToken.length > 0,
    hasAccessToken: accessToken.length > 0,
    hasRhCookie: rhCookie.length > 0,
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
