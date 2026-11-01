// GET /api/prey -> the biggest Hyperliquid longs closest to liquidation, right now.
// Pool: the 500 largest accounts on the Hyperliquid leaderboard. Candidates: open main-dex longs worth >= $1M
// with a liquidation price. "prey" = the candidate with the smallest distance to liquidation.
// Data: Hyperliquid's public leaderboard + info API. No keys. Cached 2 min at the edge.
const LB = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const INFO = 'https://api.hyperliquid.xyz/info';
const POOL = 500, MIN_NTL = 1e6;

const post = (body) => fetch(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => { if (!r.ok) throw new Error('info ' + r.status); return r.json(); });
const win = (row, k) => { const w = (row.windowPerformances || []).find((x) => x[0] === k); return w ? +w[1].pnl || 0 : 0; };

module.exports = async (req, res) => {
  try {
    const r = await fetch(LB, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('leaderboard ' + r.status);
    const d = await r.json();
    const rows = (d.leaderboardRows || [])
      .map((x) => ({ addr: String(x.ethAddress).toLowerCase(), av: +x.accountValue || 0, name: x.displayName || null, month: win(x, 'month'), all: win(x, 'allTime') }))
      .sort((a, b) => b.av - a.av)
      .slice(0, POOL);
    const out = [];
    let checked = 0;
    for (let i = 0; i < rows.length; i += 40) {
      await Promise.all(rows.slice(i, i + 40).map(async (w) => {
        try {
          const c = await post({ type: 'clearinghouseState', user: w.addr });
          checked++;
          const av = +(c.marginSummary && c.marginSummary.accountValue) || w.av;
          for (const { position: p } of c.assetPositions || []) {
            const szi = +p.szi, ntl = +p.positionValue, liq = p.liquidationPx == null ? null : +p.liquidationPx;
            if (!(szi > 0) || !(ntl >= MIN_NTL) || !(liq > 0)) continue;
            const mark = ntl / szi;
            if (!(liq < mark)) continue;
            out.push({ addr: w.addr, name: w.name, av, month: w.month, all: w.all, coin: p.coin, szi, ntl, entry: +p.entryPx, mark, liq, lev: (p.leverage && p.leverage.value) || null, upnl: +p.unrealizedPnl, dist: (mark - liq) / mark });
          }
        } catch (e) { /* skip this account */ }
      }));
    }
    out.sort((a, b) => a.dist - b.dist);
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({ at: Date.now(), pool: rows.length, checked, minNotional: MIN_NTL, prey: out[0] || null, circling: out.slice(0, 24) });
  } catch (e) {
    res.setHeader('Cache-Control', 's-maxage=30');
    res.status(502).json({ error: String(e.message || e) });
  }
};
