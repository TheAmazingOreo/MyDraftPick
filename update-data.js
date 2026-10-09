#!/usr/bin/env node
/* Auto-update job for the Fantasy Command Center.
   Runs on GitHub's servers every 30 minutes (see .github/workflows/live-data.yml), fetches the
   same public sources the app uses (Sleeper, ESPN, FantasyCalc), and writes one JSON file the
   app reads as a backup. Running on GitHub's side means it works even if a site blocks
   requests coming from a web page, and the data is ready the moment you open the app.

   It reuses the exact data code inside index.html, so the app and this job can never drift.
   No API keys or passwords are involved - every source is public.

   Usage: node update-data.js [previous.json] [output.json]
   Optional environment: SLEEPER_LEAGUE_ID (also snapshot your Sleeper league's rosters),
   LEAGUE_SIZE (default 10). */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');

const prevPath = process.argv[2] || 'prev.json';
const outPath = process.argv[3] || 'live.json';

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
  const res = await fetch(url, { headers:{ 'User-Agent':'fantasy-command-center/1.0 (personal league tool)' }, signal: AbortSignal.timeout(45000) });
  if(!res.ok) throw new Error('HTTP '+res.status);
  return res.json();
}

(async function main(){
  const E = loadEngine();
  let prev = {};
  try{ prev = JSON.parse(fs.readFileSync(prevPath, 'utf8')); }catch(e){ /* first run */ }
  const D = await E.loadSources(getJSON, prev, { via:'auto', numTeams: Number(process.env.LEAGUE_SIZE)||10 },
    { msg:function(m){ if(m) console.log('- '+m); }, getText: process.env.FFCC_MOCK ? null : getText });
  const leagueId = (process.env.SLEEPER_LEAGUE_ID||'').trim();
  if(leagueId){
    try{ D.league = await E.syncSleeperLeague(getJSON, leagueId, null); console.log('- league rosters: '+D.league.teams.length+' teams'); }
    catch(e){ console.log('! league sync failed: '+e.message); D.league = prev.league || null; }
  }
  D.snapshotAt = Date.now();
  fs.writeFileSync(outPath, JSON.stringify(D));
  const keys = E.SOURCE_KEYS.filter(function(k){ return D.sources[k]; });
  const bad = keys.filter(function(k){ return !D.sources[k].ok; });
  keys.forEach(function(k){ const s=D.sources[k]||{}; console.log((s.ok?'OK   ':'FAIL ')+k+' ('+(s.count||0)+')'+(s.error?' - '+s.error:'')); });
  console.log('Wrote '+outPath+' ('+Math.round(fs.statSync(outPath).size/1024)+' KB), week '+D.currentWeek);
  if(bad.length===keys.length){ console.error('Every source failed.'); process.exit(1); }
})().catch(function(e){ console.error(e); process.exit(1); });
