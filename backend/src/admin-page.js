// Página /admin servida pelo PRÓPRIO backend (mesmo domínio): funciona mesmo quando o CORS está errado
// e o site do Netlify não consegue falar com o servidor. Criado por Victor Ferreira.
export const adminPage = () => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESL Scraper · Admin do servidor</title>
<style>
:root{--bg:#05070d;--card:#101729;--line:rgba(120,150,220,.22);--text:#e8eefc;--muted:#8b97b4;--brand:#2f6bff;--ok:#34d399;--err:#f87171;--warn:#fbbf24}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(900px 500px at 85% -10%,#0d1f4d,transparent 60%),var(--bg);color:var(--text);font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;padding:24px}
.card{width:min(620px,100%);background:var(--card);border:1px solid var(--line);border-radius:18px;padding:26px;box-shadow:0 30px 80px rgba(0,0,0,.5);animation:r .4s ease both}
@keyframes r{from{opacity:0;transform:translateY(10px)}}
h1{margin:0 0 4px;font-size:20px}h1 b{color:#3f7dff;font-style:italic}p.m{color:var(--muted);margin:0 0 18px}
label{display:grid;gap:6px;color:var(--muted);font-size:13px;margin-bottom:14px}
input,textarea{background:#060a16;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:9px 11px;font:inherit;width:100%}
textarea{min-height:96px;font-family:ui-monospace,monospace;font-size:13px}
input:focus,textarea:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(47,107,255,.25)}
button{background:linear-gradient(180deg,#3a76ff,#0b47d6);color:#fff;border:0;border-radius:10px;padding:10px 16px;font:inherit;font-weight:600;cursor:pointer}
button.g{background:transparent;border:1px solid var(--line);color:#7fa8ff}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.msg{padding:10px 12px;border-radius:10px;margin:12px 0;font-size:13px}.ok{background:rgba(52,211,153,.12);color:var(--ok)}.er{background:rgba(248,113,113,.12);color:var(--err)}
.key{font-family:ui-monospace,monospace;background:#060a16;border:1px dashed var(--warn);color:#fde68a;padding:10px;border-radius:10px;word-break:break-all}
small{color:var(--muted)}.sw{display:flex;gap:8px;align-items:center;color:var(--text);margin-bottom:14px}.foot{text-align:center;color:var(--muted);font-size:12px;margin-top:18px}
</style></head><body>
<div class="card">
  <h1><b>ESL</b> Scraper · Admin do servidor</h1>
  <p class="m">Altera a configuração sem reiniciar. Salvo em <code>data/config.json</code>.</p>
  <div id="login">
    <label>Senha de administrador (ADMIN_PASSWORD)<input id="pw" type="password" autocomplete="current-password"></label>
    <button onclick="entrar()">Entrar</button>
  </div>
  <div id="cfg" hidden>
    <label>Origens liberadas no CORS — uma por linha (endereço do site no Netlify, ex.: https://esl-scraper.netlify.app · aceita https://*.netlify.app)
      <textarea id="cors"></textarea></label>
    <div class="sw"><input type="checkbox" id="commit" style="width:auto"> <span>Gravação no ESL ligada</span></div>
    <label>Minutos sem uso até fechar a sessão do ESL<input id="ttl" type="number" min="10" max="1440"></label>
    <div class="row"><button onclick="salvar()">Salvar</button><button class="g" onclick="gerar()">Gerar nova chave da API</button></div>
    <p><small id="chave"></small></p>
    <div id="nova"></div>
    <p><small id="st"></small></p>
  </div>
  <div id="m"></div>
  <div class="foot">ESL Scraper · criado por <b>Victor Ferreira</b></div>
</div>
<script>
let pw='';const $=(i)=>document.getElementById(i);
const msg=(t,ok)=>{$('m').innerHTML=t?'<div class="msg '+(ok?'ok':'er')+'">'+t+'</div>':''};
async function call(method,body){const r=await fetch('/api/admin/config',{method,headers:{'Content-Type':'application/json','X-Admin-Password':pw},body:body?JSON.stringify(body):undefined});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d}
function mostrar(d){$('login').hidden=true;$('cfg').hidden=false;const c=d.config;$('cors').value=(c.corsOrigins||[]).join('\\n');$('commit').checked=!!c.allowCommit;$('ttl').value=c.sessionTtlMin;
$('chave').textContent=c.apiKeyDefinida?'Chave da API atual termina em '+c.apiKeyFinal:'Sem chave da API definida (qualquer um com o endereço usa a API).';
$('st').textContent='Online desde '+new Date(d.status.desde).toLocaleString('pt-BR')+' · '+d.status.sessoes.length+' sessão(ões) do ESL abertas';
$('nova').innerHTML=d.apiKeyNova?'<p class="msg ok">Chave nova — copie agora, ela não aparece de novo. Cole em <b>Configurações</b> no site (ou no VITE_API_KEY do Netlify):</p><div class="key">'+d.apiKeyNova+'</div>':''}
async function entrar(){pw=$('pw').value;try{mostrar(await call('GET'));msg('')}catch(e){msg(e.message)}}
async function salvar(){try{mostrar(await call('PUT',{corsOrigins:$('cors').value.split(/\\n+/).map(s=>s.trim()).filter(Boolean),allowCommit:$('commit').checked,sessionTtlMin:+$('ttl').value}));msg('Salvo. Já está valendo.',1)}catch(e){msg(e.message)}}
async function gerar(){if(!confirm('Gerar uma chave nova? A atual para de funcionar na hora e o site precisa receber a nova.'))return;try{mostrar(await call('PUT',{gerarApiKey:true}));msg('Chave trocada.',1)}catch(e){msg(e.message)}}
$('pw').addEventListener('keydown',e=>{if(e.key==='Enter')entrar()});
</script></body></html>`;
