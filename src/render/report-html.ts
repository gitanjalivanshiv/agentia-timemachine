/**
 * Renders the Time Machine report as one self-contained HTML file (no network, no external assets).
 */
import type {ReportData} from '../core/report.js'

export function renderReportHtml(data: ReportData): string {
  // `<` is escaped so no template text can close the script tag.
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Time Machine · template history</title>
<style>
:root{
  --bg:#f6f7f9; --panel:#ffffff; --ink:#16181d; --muted:#5d6472; --line:#e3e6eb; --soft:#eef1f5;
  --accent:#3b5bdb; --add:#1f8a4c; --add-bg:#e8f6ee; --del:#c92a2a; --del-bg:#fdecec; --chg:#b35c00; --chg-bg:#fff4e5;
  --ok:#1f8a4c; --warn:#b35c00; --bad:#c92a2a; --shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.08);
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0f1115; --panel:#171a21; --ink:#e7e9ee; --muted:#9aa3b2; --line:#272c36; --soft:#1e222b;
    --accent:#7b93ff; --add:#4fd18b; --add-bg:#12301f; --del:#ff7b7b; --del-bg:#3a1717; --chg:#ffb35c; --chg-bg:#33240f;
    --ok:#4fd18b; --warn:#ffb35c; --bad:#ff7b7b; --shadow:none;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
header{position:sticky;top:0;z-index:2;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.bar{max-width:1040px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.brand{font-weight:700;font-size:17px;letter-spacing:-.01em}
.brand span{color:var(--accent)}
.meta{color:var(--muted);font-size:13px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.tab{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:999px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}
.tab[aria-selected="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
main{max-width:1040px;margin:0 auto;padding:24px}
h1{font-size:26px;letter-spacing:-.02em;margin:4px 0 6px}
.sub{color:var(--muted);margin:0 0 18px}
.pills{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 20px}
.pill{font-size:12.5px;font-weight:600;padding:4px 10px;border-radius:999px;background:var(--soft);color:var(--muted)}
.pill.ok{background:var(--add-bg);color:var(--ok)} .pill.warn{background:var(--chg-bg);color:var(--warn)} .pill.bad{background:var(--del-bg);color:var(--bad)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:22px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px 18px;box-shadow:var(--shadow)}
.card h3{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.big{font-size:28px;font-weight:700;letter-spacing:-.02em}
.small{color:var(--muted);font-size:13px}
.alert{border-color:color-mix(in srgb,var(--warn) 45%,var(--line));background:linear-gradient(0deg,var(--panel),var(--panel)) padding-box}
.alert h3{color:var(--warn)}
.timeline{position:relative;margin:8px 0 40px;padding-left:28px}
.timeline:before{content:"";position:absolute;left:9px;top:6px;bottom:6px;width:2px;background:var(--line)}
.v{position:relative;margin-bottom:14px}
.v:before{content:"";position:absolute;left:-24px;top:20px;width:12px;height:12px;border-radius:50%;background:var(--panel);border:2px solid var(--accent)}
.v.first:before{background:var(--accent)}
.v .card{padding:14px 16px}
.vhead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.ref{font-family:var(--mono);font-size:13px;background:var(--soft);padding:2px 7px;border-radius:6px}
.when{color:var(--muted);font-size:13px}
.reason{margin:6px 0 8px;font-style:italic}
.chips{display:flex;gap:6px;margin-left:auto}
.chip{font-family:var(--mono);font-size:12px;padding:2px 7px;border-radius:6px}
.chip.a{background:var(--add-bg);color:var(--add)} .chip.r{background:var(--del-bg);color:var(--del)} .chip.c{background:var(--chg-bg);color:var(--chg)}
ul.st{list-style:none;margin:8px 0 0;padding:0;font-family:var(--mono);font-size:13.5px}
ul.st li{padding:3px 8px;border-radius:6px;margin:2px 0;white-space:pre-wrap}
li.s-plus{background:var(--add-bg);color:var(--add)} li.s-minus{background:var(--del-bg);color:var(--del)} li.s-tilde{background:var(--chg-bg);color:var(--chg)} li.s-move{color:var(--muted)}
.cmd{display:flex;align-items:center;gap:8px;margin-top:10px}
.cmd code{flex:1;font-family:var(--mono);font-size:12.5px;background:var(--soft);padding:6px 9px;border-radius:8px;overflow:auto;white-space:nowrap}
.cmd button,.more{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:5px 10px;font:inherit;font-size:12.5px;cursor:pointer}
.more{margin-top:6px}
.lint li{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;font-size:13.5px}
.lint .sev{font-family:var(--mono)}
.sev{font-weight:700;margin-right:6px}
.sev.error{color:var(--bad)} .sev.warning{color:var(--warn)} .sev.info{color:var(--muted)}
h2{font-size:15px;margin:26px 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
footer{color:var(--muted);font-size:12.5px;text-align:center;padding:30px}
.empty{color:var(--muted);font-style:italic}
</style>
</head>
<body>
<header><div class="bar"><div class="brand">⏱ Time <span>Machine</span></div><div class="meta" id="meta"></div><nav class="tabs" id="tabs" role="tablist"></nav></div></header>
<main id="app"></main>
<footer>Generated by <code>agentia timemachine report</code> · template versions live in this workspace's git history</footer>
<script type="application/json" id="data">${json}</script>
<script>
(function(){
  var data = JSON.parse(document.getElementById('data').textContent);
  var esc = function(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
  var fmtDate = function(iso){ try { return new Date(iso).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}); } catch(e){ return iso; } };
  var cls = {'+':'s-plus','-':'s-minus','~':'s-tilde','↕':'s-move'};
  var statements = function(list, max){
    if (!list.length) return '';
    var shown = max ? list.slice(0, max) : list;
    var html = '<ul class="st">' + shown.map(function(s){ return '<li class="'+cls[s.sign]+'">'+esc(s.sign+' '+s.text)+'</li>'; }).join('') + '</ul>';
    if (max && list.length > max) html += '<button class="more" data-more>Show '+(list.length-max)+' more</button><ul class="st" hidden>' + list.slice(max).map(function(s){ return '<li class="'+cls[s.sign]+'">'+esc(s.sign+' '+s.text)+'</li>'; }).join('') + '</ul>';
    return html;
  };
  var chips = function(s){ var h=''; if(s.added) h+='<span class="chip a">+'+s.added+'</span>'; if(s.removed) h+='<span class="chip r">−'+s.removed+'</span>'; if(s.changed) h+='<span class="chip c">~'+s.changed+'</span>'; return h; };
  var cmd = function(c){ return '<div class="cmd"><code>'+esc(c)+'</code><button data-copy="'+esc(c)+'">Copy</button></div>'; };

  function template(t){
    var live = t.live, h = '';
    h += '<h1>'+esc(t.name)+'</h1><p class="sub">'+(t.mainObject ? esc(t.mainObject)+' · ' : '')+t.versions.length+' version'+(t.versions.length===1?'':'s')+' in history</p>';
    h += '<div class="pills">';
    if (live && !live.error){
      var state = {'in-sync':['ok','In sync with Copado'],'drifted':['warn','Changed in Copado since the last snapshot'],'never':['warn','Never snapshotted'],'unknown':['','Live state unknown']}[live.state];
      h += '<span class="pill '+state[0]+'">'+state[1]+'</span>';
      h += live.saveable ? '<span class="pill ok">Ready to edit</span>' : '<span class="pill bad">'+(live.format==='legacy'?'Legacy: needs v2 conversion':'Copado would reject saves')+'</span>';
      if (live.verify) h += live.verify.aligned ? '<span class="pill ok">✓ Copado uses this version</span>' : '<span class="pill bad">Copado uses a different configuration</span>';
    } else if (live && live.error) { h += '<span class="pill bad">'+esc(live.error)+'</span>'; }
    else { h += '<span class="pill">Offline report (git history only)</span>'; }
    var e = t.lint.filter(function(f){return f.severity==='error';}).length, w = t.lint.filter(function(f){return f.severity==='warning';}).length;
    h += '<span class="pill '+(e?'bad':w?'warn':'ok')+'">'+(e||w ? (e+' error'+(e===1?'':'s')+' · '+w+' warning'+(w===1?'':'s')) : 'No lint problems')+'</span>';
    h += '</div>';

    h += '<div class="cards">';
    var last = t.versions[0];
    h += '<div class="card"><h3>Latest version</h3><div class="big">'+(last ? esc(last.ref) : '—')+'</div><div class="small">'+(last ? esc(fmtDate(last.date))+' · '+esc(last.author) : 'no snapshots yet')+'</div></div>';
    if (live && live.verify){
      var v = live.verify;
      h += '<div class="card"><h3>What Copado will deploy</h3><div class="big">'+v.fields+' fields</div><div class="small">'+(v.filters.length ? esc(v.filters.join(' AND ')) : 'no filter')+' · limit '+(v.limit==null?'not set':v.limit.toLocaleString())+(v.matchingRecords!=null ? ' · '+v.matchingRecords+' matching record'+(v.matchingRecords===1?'':'s') : '')+'</div>'+(v.problems.length?'<ul class="st">'+v.problems.map(function(p){return '<li class="s-minus">'+esc(p)+'</li>';}).join('')+'</ul>':'')+'</div>';
    }
    if (live && live.fixes.length) h += '<div class="card alert"><h3>Before you can save</h3>'+live.fixes.map(function(f){return '<div class="small">'+esc(f)+'</div>';}).join('')+'</div>';
    h += '</div>';

    if (live && live.state === 'drifted'){
      h += '<div class="card alert" style="margin-bottom:18px"><h3>Changed in Copado since the last snapshot</h3>'+statements(live.drift)+cmd('agentia timemachine snapshot "'+t.name+'" --reason "<why>"')+'</div>';
    }

    h += '<h2>Timeline</h2>';
    if (!t.versions.length) h += '<p class="empty">No snapshots yet. Run <code>agentia timemachine snapshot --all</code>.</p>';
    h += '<div class="timeline">' + t.versions.map(function(v){
      return '<div class="v'+(v.first?' first':'')+'"><div class="card"><div class="vhead"><span class="ref">'+esc(v.ref)+'</span><span class="when">'+esc(fmtDate(v.date))+' · '+esc(v.author)+'</span><span class="chips">'+(v.first?'<span class="chip">first snapshot</span>':chips(v.summary))+'</span></div>'
        + (v.reason ? '<div class="reason">“'+esc(v.reason)+'”</div>' : '')
        + (v.first ? '' : (v.statements.length ? statements(v.statements, 8) : '<p class="empty">No configuration change (filters or formulas only, or a re-snapshot).</p>'))
        + cmd(v.restore) + '</div></div>';
    }).join('') + '</div>';

    if (t.lint.length){
      h += '<h2>Checks</h2><div class="card"><ul class="st lint">' + t.lint.map(function(f){ return '<li><span class="sev '+f.severity+'">'+esc(f.rule)+'</span>'+esc(f.message)+' <span class="small">→ '+esc(f.fix)+'</span></li>'; }).join('') + '</ul></div>';
    }
    return h;
  }

  var tabs = document.getElementById('tabs'), app = document.getElementById('app');
  document.getElementById('meta').textContent = data.templates.length+' template'+(data.templates.length===1?'':'s')+' · generated '+fmtDate(data.generatedAt);
  function show(i){
    app.innerHTML = data.templates.length ? template(data.templates[i]) : '<p class="empty">No templates are tracked yet.</p>';
    Array.prototype.forEach.call(tabs.children, function(b, j){ b.setAttribute('aria-selected', String(j===i)); });
    try { localStorage.setItem('tm-report-tab', String(i)); } catch(e){}
  }
  data.templates.forEach(function(t, i){ var b = document.createElement('button'); b.className='tab'; b.setAttribute('role','tab'); b.textContent=t.name; b.onclick=function(){show(i);}; tabs.appendChild(b); });
  if (data.templates.length < 2) tabs.hidden = true;
  var start = 0; try { start = Math.min(Number(localStorage.getItem('tm-report-tab'))||0, Math.max(0,data.templates.length-1)); } catch(e){}
  show(start);
  document.addEventListener('click', function(ev){
    var b = ev.target.closest('[data-copy]');
    if (b){ var text=b.getAttribute('data-copy'); var done=function(){ b.textContent='Copied'; setTimeout(function(){b.textContent='Copy';},1200); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done); else done(); }
    var m = ev.target.closest('[data-more]');
    if (m){ m.nextElementSibling.hidden=false; m.remove(); }
  });
})();
</script>
</body>
</html>
`
}
