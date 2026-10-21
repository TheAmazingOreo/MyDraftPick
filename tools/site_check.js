#!/usr/bin/env node
/* Deployment and health check for fantasycenterhq.com (no dependencies; Node 18+).
   Runs in GitHub Actions (.github/workflows/site-check.yml) after every push and every 6 hours,
   and can be run by hand.
     node tools/site_check.js files <repoDir>             the files in the repository are complete and safe
     node tools/site_check.js live <siteUrl> <repoDir>    the live site serves THAT build, over HTTPS, and its data is fresh
   Prints one line per check (OK / WARN / FAIL) and exits 1 if anything FAILED, so GitHub emails you.
   Settings (environment): SITE_DOMAIN (default fantasycenterhq.com), DATA_URL (auto-update file;
   default from GITHUB_REPOSITORY, else TheAmazingOreo/MyDraftPick), SEASON_CHECK=0 to skip the data-freshness check. */
'use strict';
const fs = require('fs'), path = require('path');
let fails = 0, warns = 0;
const ok = m => console.log('OK    ' + m), warn = m => { warns++; console.log('WARN  ' + m); }, bad = m => { fails++; console.log('FAIL  ' + m); };
const DOMAIN = process.env.SITE_DOMAIN || 'fantasycenterhq.com';
const buildIdOf = html => ((html || '').match(/<meta name="fcc-build" content="([^"]+)"/) || [])[1] || null;
const swIdOf = sw => ((sw || '').match(/const CACHE_VERSION = 'fantasy-([^']+)'/) || [])[1] || null;

function secretsIn(text){
  const found = [];
  if(/sb_secret_[A-Za-z0-9_-]{8,}/.test(text)) found.push('a Supabase secret key (sb_secret_…)');
  if(/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/.test(text) || /\bre_[A-Za-z0-9]{20,}/.test(text)) found.push('a Resend API key (re_…)');
  (text.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || []).forEach(t => {
    try { const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()); if(p.role === 'service_role') found.push('the service_role key'); } catch(e){}
  });
  return found;
}
const DEFAULT_REPO = 'TheAmazingOreo/MyDraftPick';

function checkFiles(dir){
  const need = ['index.html', 'sw.js', 'manifest.json', 'icon.svg', 'CNAME'];
  need.forEach(f => fs.existsSync(path.join(dir, f)) ? ok(f + ' present') : bad(f + ' is missing'));
  const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch(e){ return ''; } };
  const cname = read('CNAME').trim();
  if(cname) cname === DOMAIN ? ok('CNAME is ' + DOMAIN) : bad('CNAME says "' + cname + '", expected ' + DOMAIN);
  const html = read('index.html'), id = buildIdOf(html);
  id ? ok('index.html build ' + id) : bad('index.html has no build id (old version? rebuild with build.py)');
  const sw = read('sw.js');
  if(sw){ swIdOf(sw) === id ? ok('sw.js matches the build (offline copy will update)') : bad('sw.js is from a different build (' + swIdOf(sw) + '): upload the sw.js that came with index.html'); }
  // v11 has no sign-in, so config.js is no longer used: a leftover copy is only checked for secrets
  const cfg = read('config.js');
  if(cfg){ const s = secretsIn(cfg); s.length ? bad('config.js contains ' + s.join(' and ') + ': delete the file NOW and rotate that key') : warn('config.js is left over from v10 (no longer used): you can delete it'); }
  const s2 = secretsIn(html);
  s2.length ? bad('index.html contains ' + s2.join(' and ')) : ok('index.html has no secret keys');
  fs.readdirSync(dir).filter(f => /\.html$/.test(f) && f !== 'index.html').forEach(f => warn('extra page "' + f + '" is also public (delete it if it’s an old copy)'));
  fs.existsSync(path.join(dir, '.github', 'workflows', 'live-data.yml')) ? ok('auto-update workflow present') : warn('auto-update workflow (.github/workflows/live-data.yml) not found');
  fs.existsSync(path.join(dir, 'update-data.js')) && /publish\.flag/.test(read('update-data.js')) ? ok('update-data.js is the current version') : warn('update-data.js missing or an old version');
}

async function get(url, ms, headers){
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || 20000);
  try { const r = await fetch(url, { signal: ctl.signal, cache: 'no-store', headers: Object.assign({ 'Cache-Control': 'no-cache' }, headers || {}) }); return { status: r.status, text: await r.text(), url: r.url }; }
  catch(e){ return { status: 0, text: '', error: e.message }; } finally { clearTimeout(t); }
}
async function checkLive(site, dir){
  site = site.replace(/\/+$/, '');
  if(!/^https:\/\//.test(site) && !process.env.SITE_CHECK_ALLOW_HTTP) bad('site address must be https://');
  const local = dir ? buildIdOf(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')) : null;
  const home = await get(site + '/?check=' + Date.now());
  if(home.status !== 200){ bad('site did not load (status ' + (home.status || home.error) + ')'); return; }
  ok('site loads over ' + (site.startsWith('https') ? 'HTTPS' : 'HTTP (test)'));
  const live = buildIdOf(home.text);
  if(!live) bad('the live site is an old version with no build id: v11 is NOT deployed yet');
  else if(local && live !== local) bad('the live site runs ' + live + ' but the repository has ' + local + ' (GitHub Pages may still be publishing: try again in a few minutes)');
  else ok('live site runs build ' + live);
  const sw = await get(site + '/sw.js?check=' + Date.now());
  sw.status === 200 && swIdOf(sw.text) === live ? ok('live sw.js matches (phones will pick up this version)') : bad('live sw.js missing or from another build (offline copy won’t update)');
  const cfgR = await get(site + '/config.js?check=' + Date.now());
  if(cfgR.status === 200){ const s = secretsIn(cfgR.text); s.length ? bad('LIVE config.js contains ' + s.join(' and ') + ': delete it and rotate the key') : warn('a leftover config.js is still published (unused since v11)'); }
  const repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
  const dataUrl = process.env.DATA_URL || 'https://raw.githubusercontent.com/' + repo + '/data/live.json';
  if(process.env.SEASON_CHECK === '0'){ ok('data freshness check skipped'); return; }
  const d = await get(dataUrl + '?check=' + Date.now());
  let j = null; try { j = JSON.parse(d.text); } catch(e){}
  const m = new Date().getUTCMonth(), season = m >= 8 || m <= 0;
  if(!j){ (season ? bad : warn)('auto-update data not found (' + (d.status || d.error) + '): the GitHub data job hasn’t published yet'); return; }
  const ageH = (Date.now() - (j.snapshotAt || j.fetchedAt || 0)) / 3600e3;
  if(season && ageH > 3) bad('auto-update data is ' + Math.round(ageH) + ' hours old: the data job may be failing or paused (Actions › Live data)');
  else ok('auto-update data: ' + j.season + ' week ' + j.currentWeek + ', ' + Math.max(0, Math.round(ageH * 10) / 10) + ' hours old');
  if(j.pipeline && j.pipeline.failed && j.pipeline.failed.length) warn('sources that failed in the last data run: ' + j.pipeline.failed.join(', '));
  // real accepted trades (v11)
  const rt = j.sources && j.sources.realTrades, n = Array.isArray(j.trades) ? j.trades.length : 0;
  if(!rt) warn('no real-trade data yet: set SLEEPER_LEAGUE_ID or TRADE_SEED_USERS in .github/workflows/live-data.yml');
  else if(!n) warn('real-trade collection ran but found no trades yet' + (rt.error ? ' (' + rt.error + ')' : ''));
  else {
    const rtH = (Date.now() - (rt.at || 0)) / 3600e3;
    (season && rtH > 3 ? warn : ok)('real trades: ' + n + ' from the last 4 weeks, collected ' + Math.round(rtH * 10) / 10 + ' hours ago' + (j.tradesMeta && j.tradesMeta.fit ? ', value fit ready' : ''));
  }
}

(async function(){
  const [mode, a, b] = process.argv.slice(2);
  if(mode === 'files') checkFiles(a || '.');
  else if(mode === 'live') await checkLive(a || 'https://' + DOMAIN, b);
  else { console.log('usage: node tools/site_check.js files <repoDir> | live <siteUrl> [repoDir]'); process.exit(2); }
  console.log('\n' + (fails ? fails + ' problem(s)' : 'All checks passed') + (warns ? ', ' + warns + ' warning(s)' : ''));
  process.exit(fails ? 1 : 0);
})();
