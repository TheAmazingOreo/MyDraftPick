#!/usr/bin/env node
/* Auto-update job for the Fantasy Command Center.
   Runs on GitHub's servers every 30 minutes (see .github/workflows/live-data.yml), fetches the
   same public sources the app uses (Sleeper, FantasyCalc, nflverse), checks the result,
   and writes one JSON file the app reads as a backup. It reuses the exact data code inside
   index.html, so the app and this job can never drift. No API keys or passwords are involved.

   Safety rules (the published file is only replaced when ALL of these hold):
     - the new file passes a schema check (season, week, players, stats, sources);
     - it is not older than the copy already published (season/week never go backwards,
       and a snapshot never replaces a newer one);
     - at least one source actually worked this run (otherwise the last good copy stays).
   The file is written to a temporary name, re-read and re-checked, then renamed - so a crash
   can never leave a half-written file. Every run prints a per-source report.

   Real trades (v11): each run also reads accepted trades from real Sleeper redraft leagues
   (crawlTrades in the engine): it starts from your league (SLEEPER_LEAGUE_ID) and/or
   TRADE_SEED_USERS, follows league members to their other public leagues, and keeps the last
   4 weeks of player-for-player trades. The crawl bookkeeping (league and user ids) is kept in
   crawl.json, which the workflow stores in GitHub's private Actions cache - it is never
   published. The published file only holds each trade's date, league format and player ids.

   Usage: node update-data.js [previous.json] [output.json] [crawl.json]
   Writes publish.flag (next to the output) only when the new file should be published.
   Optional environment: SLEEPER_LEAGUE_ID, LEAGUE_SIZE (default 10), LEAGUE_PPR (1, 0.5 or 0),
   LEAGUE_SUPERFLEX (1/0), TRADE_SEED_USERS (comma-separated Sleeper usernames), TRADE_CALL_BUDGET (default 900). */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');

const prevPath = process.argv[2] || 'prev.json';
const outPath = process.argv[3] || 'live.json';
const crawlPath = process.argv[4] || 'crawl.json';
const flagPath = path.join(path.dirname(path.resolve(outPath)), 'publish.flag');

function loadEngine(){
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if(!m) throw new Error('index.html has no <script> block');
  const tmp = path.join(os.tmpdir(), 'ffcc_engine_'+process.pid+'.js');
  fs.writeFileSync(tmp, m[1]);
  try{ return require(tmp).INSEASON; } finally { fs.unlinkSync(tmp); }
}

async function getText(url){
  const res = await fetch(url, { headers:{ 'User-Agent':'fantasy-command-center/1.0 (personal league tool)' }, signal: AbortSignal.timeout(90000), redirect:'follow' });
  if(!res.ok) throw new Error('HTTP '+res.status);
  return res.text();
}
async function getJSON(url){
  if(process.env.FFCC_MOCK) return require(path.resolve(process.env.FFCC_MOCK))(url);
  if(/api\.sleeper\.app/.test(url)) await pace();
  const res = await fetch(url, { headers:{ 'User-Agent':'fantasy-command-center/1.0 (personal league tool)' }, signal: AbortSignal.timeout(45000) });
  if(!res.ok) throw new Error('HTTP '+res.status);
  return res.json();
}

// Sleeper asks for under 1000 calls a minute: stay near 450 (one call every ~130 ms)
let lastCall = 0;
async function pace(){ const wait = lastCall + 130 - Date.now(); if(wait > 0) await new Promise(function(r){ setTimeout(r, wait); }); lastCall = Date.now(); }

/* Real trades: crawl, fit to your league's format, check on held-out trades. Never throws. */
async function realTrades(E, D, prev, leagueId){
  const now = Date.now();
  let crawlPrev = null; try{ crawlPrev = JSON.parse(fs.readFileSync(crawlPath, 'utf8')); }catch(e){ console.log('- trades: no crawl state yet (first run or cache expired)'); }
  const seedUsers = (process.env.TRADE_SEED_USERS||'').split(',').map(function(x){ return x.trim(); }).filter(Boolean);
  const keepPrev = function(err){
    // keep the previously published trades (dropping any older than 4 weeks)
    const cut = now - E.TRADE_MKT.keepDays*864e5;
    D.trades = (prev.trades||[]).filter(function(t){ return t.at >= cut; }); D.tradesMeta = prev.tradesMeta || null;
    const old = prev.sources && prev.sources.realTrades;
    D.sources.realTrades = { ok:false, count: D.trades.length, error: err, at: old && old.at || null, via:'auto', lastTry: now };
  };
  if(!leagueId && !seedUsers.length && !(crawlPrev && Object.keys(crawlPrev.leagues||{}).length)){ keepPrev('no seed: set SLEEPER_LEAGUE_ID or TRADE_SEED_USERS'); console.log('- trades: skipped (no seed league or users)'); return; }
  try{
    const res = await E.crawlTrades(getJSON, crawlPrev, { season: D.season, week: D.currentWeek, players: D.players, now: now,
      seedLeagues: leagueId ? [leagueId] : [], seedUsers: seedUsers, budget: Number(process.env.TRADE_CALL_BUDGET)||900 });
    console.log('- trades: '+res.calls+' calls, '+res.leagues+' redraft leagues ('+res.newLeagues+' new), '+res.added+' new trades, '+res.trades.length+' in the last 4 weeks'+(res.errors? ', '+res.errors+' errors (last: '+res.lastError+')' : ''));
    const tmp = crawlPath+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(res.state)); fs.renameSync(tmp, crawlPath);
    if(!res.calls || res.errors >= res.calls){ keepPrev(res.lastError || 'no calls succeeded'); return; }
    D.trades = res.trades;
    const fmt = { n: Number(process.env.LEAGUE_SIZE)||10, ppr: process.env.LEAGUE_PPR!=null && process.env.LEAGUE_PPR!=='' ? Number(process.env.LEAGUE_PPR) : 1, sf: process.env.LEAGUE_SUPERFLEX==='1' ? 1 : 0 };
    const prior = {}; Object.keys(D.market||{}).forEach(function(p){ if(D.market[p].value>0) prior[p] = D.market[p].value; });
    const fit = E.fitTradeMarket(res.trades, prior, { now: now, fmt: fmt });
    const hold = E.tradeMarketHoldout(res.trades, prior, { now: now, fmt: fmt });
    console.log('- trade value fit: '+(fit.ok ? fit.used+' trades used, two-for-one discount '+fit.k+', median gap '+fit.medianGapBefore.toFixed(3)+' -> '+fit.medianGapAfter.toFixed(3) : 'not fitted ('+fit.reason+')'));
    if(hold.ok) console.log('- held-out check ('+hold.test+' newest trades): median gap FantasyCalc '+hold.gapBefore.toFixed(3)+' vs real-trade values '+hold.gapAfter.toFixed(3)+'; called fair '+Math.round(100*hold.fairBefore)+'% vs '+Math.round(100*hold.fairAfter)+'%');
    D.tradesMeta = { at: now, leagues: res.leagues, calls: res.calls, added: res.added, fit: E.publishableFit(fit, fmt), holdout: hold.ok ? hold : null };
    D.sources.realTrades = { ok:true, count: res.trades.length, error: res.errors ? res.errors+' calls failed' : null, at: now, via:'auto' };
  }catch(e){ console.log('! trades failed: '+e.message); keepPrev(e.message); }
}

/* Schema check: returns a list of problems (empty = valid). */
function validate(D, E){
  const p = [];
  if(!D || typeof D!=='object') return ['not an object'];
  if(!(Number(D.season)>=2020 && Number(D.season)<=2100)) p.push('season missing or invalid ('+D.season+')');
  if(!(Number(D.currentWeek)>=1 && Number(D.currentWeek)<=18)) p.push('currentWeek missing or invalid ('+D.currentWeek+')');
  if(!D.players || Object.keys(D.players).length < 500) p.push('player list too small ('+(D.players? Object.keys(D.players).length : 0)+')');
  if(!D.stats || typeof D.stats!=='object') p.push('stats missing');
  else Object.keys(D.stats).forEach(function(w){ if(!(Number(w)>=1 && Number(w)<Number(D.currentWeek))) p.push('stats for week '+w+' is not a finished week'); });
  if(!D.sources || typeof D.sources!=='object') p.push('sources missing');
  else E.SOURCE_KEYS.forEach(function(k){ const s = D.sources[k]; if(s && (typeof s.ok!=='boolean')) p.push('source '+k+' has no ok flag'); });
  if(!(Number(D.fetchedAt)>0)) p.push('fetchedAt missing');
  if(D.trades!=null && (!Array.isArray(D.trades) || D.trades.some(function(t){ return !t || !t.id || !Array.isArray(t.a) || !Array.isArray(t.b) || !(t.at>0); }))) p.push('trades malformed');
  return p;
}
/* Is the new snapshot at least as current as the published one? */
function notOlder(D, prev){
  if(!prev || !prev.season) return null;
  if(Number(D.season) < Number(prev.season)) return 'season went backwards ('+prev.season+' -> '+D.season+')';
  if(Number(D.season)===Number(prev.season) && Number(D.currentWeek) < Number(prev.currentWeek)) return 'week went backwards ('+prev.currentWeek+' -> '+D.currentWeek+')';
  if((prev.snapshotAt||0) > (D.snapshotAt||0)) return 'published copy is newer than this run';
  return null;
}

async function main(){
  const E = loadEngine();
  try{ fs.unlinkSync(flagPath); }catch(e){}
  let prev = {};
  try{ prev = JSON.parse(fs.readFileSync(prevPath, 'utf8')); }catch(e){ console.log('- no previous copy (first run)'); }
  const prevProblems = prev && prev.season ? validate(prev, E) : ['none'];
  if(prev && prev.season && prevProblems.length){ console.log('! previous copy failed the schema check, starting fresh: '+prevProblems.join('; ')); prev = {}; }

  const D = await E.loadSources(getJSON, prev, { via:'auto', numTeams: Number(process.env.LEAGUE_SIZE)||10, ppr: process.env.LEAGUE_PPR!=null && process.env.LEAGUE_PPR!=='' ? Number(process.env.LEAGUE_PPR) : 1 },
    { msg:function(m){ if(m) console.log('- '+m); }, getText: process.env.FFCC_MOCK ? null : getText });
  const leagueId = (process.env.SLEEPER_LEAGUE_ID||'').trim();
  if(leagueId){
    try{ D.league = await E.syncSleeperLeague(getJSON, leagueId, null); console.log('- league rosters: '+D.league.teams.length+' teams'); }
    catch(e){ console.log('! league sync failed: '+e.message+' (keeping the previous rosters, marked with their date)'); D.league = prev.league || null; }
  }
  await realTrades(E, D, prev, leagueId);
  D.snapshotAt = Date.now();

  // Per-source report
  const keys = E.SOURCE_KEYS.filter(function(k){ return D.sources[k]; });
  const fresh = keys.filter(function(k){ return D.sources[k].ok && D.sources[k].at===D.fetchedAt; });
  const bad = keys.filter(function(k){ return !D.sources[k].ok; });
  keys.forEach(function(k){ const s=D.sources[k]||{}; console.log((s.ok?'OK   ':'FAIL ')+k+' ('+(s.count||0)+')'+(s.error?' - '+s.error:'')+(s.ok && s.at!==D.fetchedAt ? ' [kept from '+new Date(s.at).toISOString()+']' : '')); });
  if(D.idMapping && D.idMapping.nflverse){ const m = D.idMapping.nflverse;
    console.log('ID mapping (nflverse -> Sleeper): stats '+m.statMapped+'/'+m.statRows+', snaps '+m.snapMapped+'/'+m.snapRows+(m.unmapped.length? ' - unmapped e.g. '+m.unmapped.slice(0,5).join(', ') : '')); }
  D.pipeline = { at: D.snapshotAt, fresh: fresh, failed: bad, runner: process.env.GITHUB_RUN_ID || null };

  const problems = validate(D, E);
  const older = notOlder(D, prev);
  if(problems.length){ console.error('NOT PUBLISHED - schema check failed: '+problems.join('; ')); process.exitCode = 1; return; }
  if(older){ console.error('NOT PUBLISHED - '+older+'. The last good copy stays.'); return; }
  if(!fresh.length){ console.error('NOT PUBLISHED - every source failed this run. The last good copy stays.'); process.exitCode = 1; return; }

  // Atomic write: temp file -> re-read + re-check -> rename
  const tmp = outPath+'.tmp-'+process.pid;
  fs.writeFileSync(tmp, JSON.stringify(D));
  const back = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  const p2 = validate(back, E);
  if(p2.length){ fs.unlinkSync(tmp); console.error('NOT PUBLISHED - file did not survive the round trip: '+p2.join('; ')); process.exitCode = 1; return; }
  fs.renameSync(tmp, outPath);
  fs.writeFileSync(flagPath, String(D.snapshotAt));
  console.log('Wrote '+outPath+' ('+Math.round(fs.statSync(outPath).size/1024)+' KB), season '+D.season+' week '+D.currentWeek+' - ready to publish');
}

if(require.main===module) main().catch(function(e){ console.error(e); process.exitCode = 1; });
module.exports = { validate: validate, notOlder: notOlder };
