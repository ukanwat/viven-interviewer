// A static HTML viewer over a graded set, and the review tool in one (evalite-style export; Hamel's
// review-UI rules). Each conversation shows every line with the judge's labels, each answer with its
// depth and gap (the judge's and the interviewer's own live read), the notes with their support, and
// the twin's answers. In review you mark each conversation pass/fail with a note on its FIRST failure,
// and click a label to correct the judge; "Download labels" saves a file `run.ts review-import` turns
// into calibration labels for `meta`.
import { LINE_DEFS } from './grade.ts';
import { METRICS } from './score.ts';
import type { GradedSet } from './report.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function viewHtml(set: GradedSet): string {
  const data = JSON.stringify({ set, defs: LINE_DEFS, metrics: METRICS }).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>${esc(set.label)} · eval</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#222;background:#faf9f7}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 18px;display:flex;gap:16px;align-items:center;z-index:2}
main{display:grid;grid-template-columns:260px 1fr;min-height:100vh}
nav{border-right:1px solid #ddd;padding:8px;overflow:auto;max-height:calc(100vh - 50px);position:sticky;top:50px}
nav div{padding:6px 8px;border-radius:6px;cursor:pointer}nav div:hover,nav div.on{background:#eee}
nav small{color:#777;display:block}
section{padding:18px 26px;max-width:980px}
.q,.a{padding:8px 10px;margin:6px 0;border-radius:8px}.q{background:#eef3fb}.a{background:#fff;border:1px solid #e5e5e5}
.chip{display:inline-block;font-size:11px;padding:1px 7px;margin:2px 3px 0 0;border-radius:10px;background:#eee;color:#666;cursor:pointer;user-select:none}
.chip.y{background:#ffe3d6;color:#a3401a}.chip.good.y{background:#dff3e3;color:#1f6b33}.chip.h{outline:2px solid #333}
.gap{color:#555;font-size:12.5px;margin-top:4px}.gap b{color:#333}
.sess{color:#999;font-size:12px;margin:14px 0 4px}
table{border-collapse:collapse;font-size:12.5px}td,th{padding:3px 8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
.ok{color:#1f6b33}.bad{color:#a3401a}.mid{color:#8a6d00}
.review{background:#fff;border:1px solid #ddd;border-radius:8px;padding:10px;margin:10px 0}
textarea{width:100%;min-height:50px;font:inherit}
button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid #bbb;background:#fff;cursor:pointer}button.on{background:#222;color:#fff}
</style>
<header><b>${esc(set.label)}</b><span id=prog></span><span style="flex:1"></span><span style="color:#777">click a label to correct the judge · j/k next/prev · p/f pass/fail</span><button id=dl>Download labels</button></header>
<main><nav id=nav></nav><section id=main></section></main>
<script>
const {set,defs,metrics}=${data};
const KEY='eval-review-'+set.label;
const R=JSON.parse(localStorage.getItem(KEY)||'{}'); // id -> {pass, note, lines:{q:{label:bool}}}
const save=()=>{localStorage.setItem(KEY,JSON.stringify(R));prog()};
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pct=(x,k)=>x==null?'–':metrics[k]?.count?x.toFixed(1):Math.round(x*100)+'%';
const GOOD=new Set(['open','reaction']);
let cur=0;
function prog(){document.getElementById('prog').textContent=Object.values(R).filter(r=>r.pass!=null).length+' of '+set.items.length+' reviewed'}
function nav(){document.getElementById('nav').innerHTML=set.items.map((it,i)=>'<div class="'+(i===cur?'on':'')+'" onclick="show('+i+')">'+(R[it.id]?.pass===true?'✓ ':R[it.id]?.pass===false?'✗ ':'')+esc(it.id)+'<small>'+(it.source==='sim'?'twin '+pct(it.metrics.twin,'twin')+' · ':'')+'coverage '+pct(it.metrics.coverage,'coverage')+' · restates '+pct(it.metrics.restates,'restates')+'</small></div>').join('')}
function show(i){cur=i;nav();const it=set.items[i],d=it.detail||{},c=it.conv||{lines:[],notes:[]};const r=R[it.id]??={lines:{}};
 const L=d.conversation?.lines||[],A=d.conversation?.answers||[];let q=0,a=0,h='';
 h+='<h2>'+esc(it.name)+' <small style="color:#888">'+esc(it.id)+'</small></h2>';
 h+='<div class=review><button id=pass class="'+(r.pass===true?'on':'')+'">Pass</button> <button id=fail class="'+(r.pass===false?'on':'')+'">Fail</button> <span style="color:#777">Fail = its first real failure (Hamel: note only the first, upstream errors cascade)</span><textarea id=note placeholder="First failure, in your words, with #tags for its type (e.g. #restates #missed-story): run.ts triage counts them">'+esc(r.note||'')+'</textarea></div>';
 h+='<table><tr>'+Object.keys(metrics).filter(k=>it.metrics[k]!=null).map(k=>'<th title="'+esc(metrics[k].what)+'">'+k+'</th>').join('')+'</tr><tr>'+Object.keys(metrics).filter(k=>it.metrics[k]!=null).map(k=>'<td>'+pct(it.metrics[k],k)+'</td>').join('')+'</tr></table>';
 c.lines.forEach((l,j)=>{if(j===0||c.lines[j-1].session!==l.session)h+='<div class=sess>session '+l.session+'</div>';
  if(l.role==='agent'){q++;const lab=L.find(x=>x.q===q)||{};const hum=r.lines[q]||{};
   h+='<div class=q><b>Q'+q+'</b> '+esc(l.text)+'<div>'+Object.keys(defs).map(k=>{const v=k in hum?hum[k]:!!lab[k];return '<span class="chip '+(GOOD.has(k)?'good ':'')+(v?'y ':'')+(k in hum?'h':'')+'" title="'+esc(defs[k])+'" onclick="flip('+q+',\\''+k+'\\','+!!lab[k]+')">'+k+'</span>'}).join('')+'</div></div>'}
  else{a++;const an=A.find(x=>x.a===a);const live=c.liveGaps?.[a-1];
   h+='<div class=a><b>A'+a+'</b>'+(l.annoyance?' <small>(annoyance '+l.annoyance+')</small>':'')+' '+esc(l.text)+(an?'<div class=gap><b>'+an.depth+'</b>'+(an.gap?' · judge: a fuller answer would add '+esc(an.gap):'')+'</div>':'')+(live?'<div class=gap><b>live read</b> · '+esc(live)+'</div>':'')+'</div>'}});
 const sup=d.notes?.notes||[];h+='<h3>Notes</h3>'+(c.notes||[]).map((n,j)=>{const s=sup.find(x=>x.n===j+1)?.support;return '<div class="gap '+(s==='yes'?'ok':s==='no'?'bad':'mid')+'">'+(s||'?')+' · '+esc(n)+'</div>'}).join('');
 if(d.notes?.missed?.length)h+='<p class=gap><b>Said but not kept:</b> '+d.notes.missed.map(esc).join(' · ')+'</p>';
 if(c.gaps?.length)h+='<h3>Gaps file</h3><div class=gap>'+c.gaps.map(esc).join('<br>')+'</div>';
 const tw=(d.twin?.asks||[]).map(t=>'<tr><td>'+esc(t.q)+'</td><td>'+esc(t.answer)+'</td><td>'+esc(t.gold)+'</td><td class="'+(t.grade==='right'?'ok':t.grade==='partial'?'mid':'bad')+'">'+t.grade+'</td></tr>').join('');
 if(tw)h+='<h3>Twin test (gold)</h3><table><tr><th>question</th><th>twin</th><th>truth</th><th></th></tr>'+tw+'</table>';
 const cv=(d.coverage?.asks||[]).map(t=>'<tr><td>'+esc(t.q)+'</td><td>'+esc(t.answer)+'</td><td class="'+(t.grade==='grounded'?'ok':t.grade==='partly'?'mid':'bad')+'">'+t.grade+'</td></tr>').join('');
 if(cv)h+='<h3>Coverage (generated outsider questions)</h3><table><tr><th>question</th><th>twin</th><th></th></tr>'+cv+'</table>';
 const fx=(d.facts?.facts||[]).map(f=>'<tr><td>'+f.n+'</td><td>'+f.said+'</td><td>'+f.saved+'</td><td>'+esc(f.evidence)+'</td></tr>').join('');
 if(fx)h+='<h3>Hidden facts</h3><table><tr><th>#</th><th>said</th><th>saved</th><th>evidence</th></tr>'+fx+'</table>';
 const m=document.getElementById('main');m.innerHTML=h;scrollTo(0,0);
 m.querySelector('#pass').onclick=()=>{r.pass=true;save();show(cur)};m.querySelector('#fail').onclick=()=>{r.pass=false;save();show(cur)};
 m.querySelector('#note').oninput=e=>{r.note=e.target.value;save()};}
function flip(q,k,judge){const r=R[set.items[cur].id];const h=r.lines[q]??={};h[k]=k in h?!h[k]:!judge;save();show(cur)}
document.onkeydown=e=>{if(e.target.tagName==='TEXTAREA')return;if(e.key==='j')show(Math.min(cur+1,set.items.length-1));if(e.key==='k')show(Math.max(cur-1,0));if(e.key==='p')document.getElementById('pass').click();if(e.key==='f')document.getElementById('fail').click()};
document.getElementById('dl').onclick=()=>{
 // Once a conversation is marked pass/fail, every line in it counts as reviewed: labels you corrected
 // as you set them, the rest as the judge had them (you saw them and let them stand).
 const out={set:set.label,at:new Date().toISOString(),reviews:[],lines:[]};
 for(const it of set.items){const r=R[it.id];if(!r||r.pass==null)continue;out.reviews.push({id:it.id,pass:r.pass,note:r.note||''});
  for(const lab of it.detail?.conversation?.lines||[]){const hum=r.lines?.[lab.q]||{};out.lines.push({id:it.id,q:lab.q,labels:Object.fromEntries(Object.keys(defs).map(k=>[k,k in hum?hum[k]:!!lab[k]]))})}}
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,1)],{type:'application/json'}));a.download='labels-'+set.label+'.json';a.click()};
prog();show(0);
</script>`;
}
