// scripts/lib/report-interactive.mjs — общий клиентский слой для отчётов и
// дашбордов: всплывающие подсказки на графиках (линии/бары/пончик) и сортировка
// таблиц по клику на заголовок. Один и тот же код в HTML-дашбордах и в веб-отчётах.

export const INTERACTIVE_CSS = `
.rt-tip{position:fixed;z-index:99999;pointer-events:none;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.20);padding:9px 11px;font-size:12px;min-width:130px;max-width:300px;line-height:1.5}
.rt-tip-h{font-weight:750;margin-bottom:5px}
.rt-tip-row{display:flex;align-items:center;gap:8px}
.rt-tip-dot{width:9px;height:9px;border-radius:2px;flex:none}
.rt-tip-n{color:var(--muted);margin-right:auto;white-space:nowrap}
.rt-tip-v{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.rt-cross{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3;pointer-events:none}
.rt-hit{cursor:crosshair;fill:transparent}
.rt-hit:hover{fill:color-mix(in srgb, var(--ink) 5%, transparent)}
table.sortable thead th{cursor:pointer;user-select:none}
table.sortable thead th.sort-asc::after{content:" ▲";font-size:9px;opacity:.75}
table.sortable thead th.sort-desc::after{content:" ▼";font-size:9px;opacity:.75}
table.sortable thead th.nosort{cursor:default}
/* Заморозка первых трёх столбцов + горизонтальный скролл (сводная подсорта). */
.frozen3{border-collapse:separate;border-spacing:0}
.frozen3 thead th:nth-child(-n+3){position:sticky;z-index:3;background:var(--surface)}
.frozen3 tbody td:nth-child(-n+3),.frozen3 tfoot td:nth-child(-n+3){position:sticky;z-index:2;background:var(--surface)}
.frozen3 th:nth-child(1),.frozen3 td:nth-child(1){left:0;min-width:44px;max-width:44px}
.frozen3 th:nth-child(2),.frozen3 td:nth-child(2){left:44px;min-width:140px;max-width:160px}
.frozen3 th:nth-child(3),.frozen3 td:nth-child(3){left:184px;min-width:48px;max-width:64px;box-shadow:2px 0 0 var(--line-2,var(--line))}
@media print{ .frozen3 th,.frozen3 td{position:static!important} .print-hide{display:none!important} }
.oscol{background:color-mix(in srgb, var(--muted) 7%, transparent)}
thead th.oscol{background:color-mix(in srgb, var(--muted) 12%, var(--surface))}
.blk-hint{font-size:12px;color:var(--muted);margin:0 0 8px} .blk-hint .os{color:var(--muted);font-weight:700} .blk-hint .ps{color:var(--accent-d);font-weight:700}
/* Динамика остатков: чипы-переключатели ФФ (работают как интерактивная легенда). */
.dyn-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;align-items:center}
.dyn-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--ink);font-size:12px;cursor:pointer;line-height:1.6;transition:opacity .12s}
.dyn-chip .dot{width:10px;height:10px;border-radius:3px;flex:none}
.dyn-chip:hover{border-color:var(--accent)}
.dyn-chip.off{opacity:.4;text-decoration:line-through}
.dyn-reset{font-weight:600}
`;

export const INTERACTIVE_JS = `
(function(){
  function ready(fn){ if(document.readyState!=='loading')fn(); else document.addEventListener('DOMContentLoaded',fn); }
  ready(function(){
    var tip;
    function T(){ if(!tip){tip=document.createElement('div');tip.className='rt-tip';tip.style.display='none';document.body.appendChild(tip);} return tip; }
    function show(html,x,y){ var t=T();t.innerHTML=html;t.style.display='block';var w=t.offsetWidth,h=t.offsetHeight;var nx=x+15,ny=y+15;if(nx+w>window.innerWidth-8)nx=x-w-15;if(ny+h>window.innerHeight-8)ny=y-h-15;t.style.left=(nx<4?4:nx)+'px';t.style.top=(ny<4?4:ny)+'px'; }
    function hide(){ if(tip)tip.style.display='none'; }
    function rows(arr){ return arr.map(function(d){return '<div class="rt-tip-row"><span class="rt-tip-dot" style="background:'+d.c+'"></span><span class="rt-tip-n">'+d.n+'</span><span class="rt-tip-v">'+d.v+'</span></div>';}).join(''); }

    function bindTip(el){
      el.addEventListener('mousemove',function(e){
        var arr; try{arr=JSON.parse(el.getAttribute('data-tip'));}catch(_){return;}
        var head=el.getAttribute('data-label')||'';
        show((head?'<div class="rt-tip-h">'+head+'</div>':'')+rows(arr),e.clientX,e.clientY);
        var svg=el.ownerSVGElement; var cx=el.getAttribute('data-cx');
        if(svg&&cx){var cr=svg.querySelector('.rt-cross');if(cr){cr.setAttribute('x1',cx);cr.setAttribute('x2',cx);cr.style.display='block';}}
      });
      el.addEventListener('mouseleave',function(){ hide(); var svg=el.ownerSVGElement; if(svg){var cr=svg.querySelector('.rt-cross');if(cr)cr.style.display='none';} });
    }
    function attachTips(root){ (root||document).querySelectorAll('[data-tip]').forEach(bindTip); }
    attachTips(document);

    var numRe=/^-?[0-9\\s.,]+$/;
    function val(cell){ if(!cell)return ''; var dv=cell.getAttribute('data-v'); return (dv!==null?dv:cell.textContent).trim(); }
    function num(s){ if(!numRe.test(s))return null; var x=parseFloat(s.replace(/\\s/g,'').replace(',','.')); return isNaN(x)?null:x; }
    document.querySelectorAll('table.sortable').forEach(function(tb){
      var head=tb.tHead; if(!head||!head.rows.length)return;
      var ths=head.rows[head.rows.length-1].cells;
      Array.prototype.forEach.call(ths,function(th,ci){
        if(th.classList.contains('nosort'))return;
        th.addEventListener('click',function(){
          var body=tb.tBodies[0]; if(!body)return;
          var rs=Array.prototype.slice.call(body.rows).filter(function(r){return !r.classList.contains('nosort')&&!r.classList.contains('tfoot');});
          var asc=th.getAttribute('data-sort')!=='asc';
          Array.prototype.forEach.call(ths,function(h){h.removeAttribute('data-sort');h.classList.remove('sort-asc','sort-desc');});
          th.setAttribute('data-sort',asc?'asc':'desc');th.classList.add(asc?'sort-asc':'sort-desc');
          rs.sort(function(a,b){var A=val(a.cells[ci]),B=val(b.cells[ci]);var na=num(A),nb=num(B);var r;if(na!==null&&nb!==null)r=na-nb;else if(na!==null)r=1;else if(nb!==null)r=-1;else r=A.localeCompare(B,'ru');return asc?r:-r;});
          rs.forEach(function(r){body.appendChild(r);});
        });
      });
    });

    // Динамика остатков: чипы включают/выключают линии ФФ; график перерисовывается
    // на клиенте (с пересчётом масштаба) — без перезагрузки, экран не дёргается.
    function fmtNum(v){ return Math.round(v).toLocaleString('ru-RU'); }
    document.querySelectorAll('.dyn[data-dyn]').forEach(function(host){
      var data; try{ data=JSON.parse(host.getAttribute('data-dyn')); }catch(_){ return; }
      var chart=host.querySelector('.dyn-chart'); if(!chart||!data||!data.lines) return;
      var visible=data.lines.map(function(){return true;});
      var W=760,H=280,pl=46,pr=14,pt=12,pb=40,iw=W-pl-pr,ih=H-pt-pb,n=data.labels.length;
      function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
      function render(){
        var max=0,min=0;
        data.lines.forEach(function(l,i){ if(visible[i]) l.values.forEach(function(v){ if(v>max)max=v; if(v<min)min=v; }); });
        if(max===min)max=min+1;
        function X(i){ return pl+(n<=1?iw/2:iw*i/(n-1)); }
        function Y(v){ return pt+ih*(1-(v-min)/(max-min)); }
        var g='';
        for(var t=0;t<=4;t++){ var val=min+(max-min)*t/4,yy=Y(val); g+='<line x1="'+pl+'" y1="'+yy.toFixed(1)+'" x2="'+(W-pr)+'" y2="'+yy.toFixed(1)+'" stroke="var(--line)"/><text x="'+(pl-6)+'" y="'+(yy+3).toFixed(1)+'" text-anchor="end" font-size="11" fill="var(--muted)">'+esc(fmtNum(val))+'</text>'; }
        if(min<0){ var yz=Y(0); g+='<line x1="'+pl+'" y1="'+yz.toFixed(1)+'" x2="'+(W-pr)+'" y2="'+yz.toFixed(1)+'" stroke="var(--muted)" stroke-dasharray="3 3"/>'; }
        var step=Math.max(1,Math.ceil(n/8));
        data.labels.forEach(function(lb,i){ if(i%step===0||i===n-1) g+='<text x="'+X(i).toFixed(1)+'" y="'+(H-pb+16)+'" text-anchor="middle" font-size="11" fill="var(--muted)">'+esc(lb)+'</text>'; });
        data.lines.forEach(function(l,i){
          if(!visible[i])return;
          if(n===1){ g+='<circle cx="'+X(0).toFixed(1)+'" cy="'+Y(l.values[0]).toFixed(1)+'" r="3" fill="'+l.color+'"/>'; return; }
          var pts=l.values.map(function(v,j){ return X(j).toFixed(1)+','+Y(v).toFixed(1); }).join(' ');
          g+='<polyline points="'+pts+'" fill="none" stroke="'+l.color+'" stroke-width="'+(l.bold?3.4:1.6)+'" stroke-linejoin="round" stroke-linecap="round"'+(l.bold?'':' opacity="0.92"')+'/>';
        });
        g+='<line class="rt-cross" x1="0" y1="'+pt+'" x2="0" y2="'+(pt+ih)+'" style="display:none"/>';
        var bw=n>1?iw/(n-1):iw;
        data.labels.forEach(function(lb,i){
          var tip=[]; data.lines.forEach(function(l,li){ if(visible[li]) tip.push({n:l.name,c:l.color,v:fmtNum(l.values[i]||0)}); });
          g+='<rect class="rt-hit" x="'+(X(i)-bw/2).toFixed(1)+'" y="'+pt+'" width="'+bw.toFixed(1)+'" height="'+ih+'" data-cx="'+X(i).toFixed(1)+'" data-label="'+esc(lb)+'" data-tip="'+esc(JSON.stringify(tip))+'"/>';
        });
        chart.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" class="mv-chart" preserveAspectRatio="xMidYMid meet" role="img">'+g+'</svg>';
        attachTips(chart);
      }
      host.querySelectorAll('[data-li]').forEach(function(chip){
        chip.addEventListener('click',function(){ var i=+chip.getAttribute('data-li'); if(i<0||i>=visible.length)return; visible[i]=!visible[i]; chip.classList.toggle('off',!visible[i]); render(); });
      });
      var allBtn=host.querySelector('[data-dyn-all]');
      if(allBtn) allBtn.addEventListener('click',function(){ visible=data.lines.map(function(){return true;}); host.querySelectorAll('[data-li]').forEach(function(c){c.classList.remove('off');}); render(); });
    });
  });
})();
`;
