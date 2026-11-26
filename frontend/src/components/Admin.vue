<script setup>
// /admin — 1) conexão DESTE navegador com o backend (endereço + chave da API, sem precisar refazer o build)
//          2) configuração do SERVIDOR (CORS, gravação, sessão, chave da API) com o login do ESL já feito no site.
import { ref, reactive, onMounted } from 'vue';
import { conexaoCfg, salvarConexao, padraoConexao, adminCall, chaveInvalida, sessionId } from '../api.js';
import Login from './Login.vue';

const con = reactive({ url: conexaoCfg.value.url, key: conexaoCfg.value.key });
const teste = ref(null); // { ok, msg }
const testando = ref(false);

async function testar() {
  testando.value = true;
  teste.value = null;
  const url = con.url.trim().replace(/\/+$/, '');
  try {
    const h = await fetch(url + '/api/health').then((r) => r.json());
    const k = await fetch(url + '/api/auth/status', { headers: { 'X-API-Key': con.key } });
    const kd = await k.json().catch(() => ({}));
    if (kd.code === 'api_key') teste.value = { ok: false, msg: 'O servidor respondeu, mas a chave da API está errada.' };
    else teste.value = { ok: true, msg: `Conectado. Gravação no ESL ${h.commitEnabled ? 'LIGADA' : 'desligada'}.` };
  } catch {
    teste.value = { ok: false, msg: 'Não consegui falar com o servidor. Confira o endereço — ou o CORS: este site precisa estar liberado no servidor (abra o admin do próprio servidor, link abaixo).' };
  } finally {
    testando.value = false;
  }
}
function salvarCon() {
  salvarConexao(con);
  chaveInvalida.value = false;
  teste.value = { ok: true, msg: 'Salvo neste navegador.' };
}
function restaurar() {
  Object.assign(con, padraoConexao);
  salvarConexao(con);
  teste.value = { ok: true, msg: 'Voltou para o endereço e a chave do build.' };
}

/* --------- servidor --------- */
const srv = ref(null);
const pedirLoginEsl = ref(false); // mostra o login do ESL por cima (sem sessão, ou sessão caiu)
const emailLogado = ref('');
const form = reactive({ cors: '', allowCommit: false, sessionTtlMin: 60 });
const chaveNova = ref('');
const erro = ref('');
const salvo = ref('');
const carregando = ref(false);

function aplicar(d) {
  srv.value = d;
  form.cors = (d.config.corsOrigins || []).join('\n');
  form.allowCommit = !!d.config.allowCommit;
  form.sessionTtlMin = d.config.sessionTtlMin;
  if (d.apiKeyNova) chaveNova.value = d.apiKeyNova;
}
/** Sem sessão ou login caído: limpa a tela do servidor e pede o login do ESL. */
function semSessao(e) {
  if (e.status === 401 && ['sem_sessao', 'reauth'].includes(e.code)) {
    srv.value = null;
    return true;
  }
  return false;
}
async function carregar() {
  erro.value = '';
  if (!sessionId.value) return;
  carregando.value = true;
  try {
    aplicar(await adminCall('GET'));
  } catch (e) {
    if (!semSessao(e)) erro.value = e.message === 'Failed to fetch' ? 'O servidor não respondeu a este site (provavelmente CORS). Use o admin do próprio servidor, no link abaixo.' : e.message;
  } finally {
    carregando.value = false;
  }
}
function onLogged(email) {
  emailLogado.value = email;
  pedirLoginEsl.value = false;
  carregar();
}
onMounted(carregar); // já logado no site (mesma aba): abre direto
async function salvarSrv(extra = {}) {
  erro.value = '';
  salvo.value = '';
  try {
    aplicar(await adminCall('PUT', {
      corsOrigins: form.cors.split(/\n+/).map((x) => x.trim()).filter(Boolean),
      allowCommit: form.allowCommit, sessionTtlMin: Number(form.sessionTtlMin), ...extra,
    }));
    salvo.value = 'Salvo — já está valendo no servidor.';
  } catch (e) {
    if (!semSessao(e)) erro.value = e.message;
  }
}
async function gerarChave() {
  if (!confirm('Gerar uma chave nova? A atual para de funcionar na hora.')) return;
  await salvarSrv({ gerarApiKey: true });
  if (chaveNova.value) {
    con.key = chaveNova.value;
    salvarConexao(con); // este navegador já passa a usar a chave nova
  }
}
const origemAtual = location.origin;
function liberarEsteSite() {
  const l = form.cors.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (!l.includes(origemAtual)) form.cors = [...l, origemAtual].join('\n');
}
const sair = () => (location.href = '/');
</script>

<template>
  <div class="admin">
    <div class="admin-head">
      <h2>Administração</h2>
      <span class="spacer" />
      <button class="ghost" @click="sair">← Voltar ao app</button>
    </div>

    <Transition name="fade"><p v-if="chaveInvalida" class="alertbox">O servidor recusou a chave da API deste navegador. Cole a chave atual abaixo.</p></Transition>

    <section class="card">
      <h3>Conexão deste navegador</h3>
      <p class="muted small">Fica salvo só neste navegador. Serve para apontar o site para outro servidor ou usar uma chave nova sem refazer o deploy no Netlify.</p>
      <div class="grid">
        <label class="wide">Endereço do backend<input v-model="con.url" placeholder="https://seu-backend.duckdns.org" /></label>
        <label class="wide">Chave da API<input v-model="con.key" type="password" autocomplete="off" /></label>
      </div>
      <div class="row" style="margin-top: 12px">
        <button @click="salvarCon">Salvar</button>
        <button class="ghost" :disabled="testando" @click="testar"><span v-if="testando" class="spin" /> Testar conexão</button>
        <button class="ghost" @click="restaurar">Usar o padrão do build</button>
      </div>
      <Transition name="fade"><p v-if="teste" :class="teste.ok ? 'okc' : 'msg'">{{ teste.msg }}</p></Transition>
    </section>

    <section class="card">
      <h3>Servidor</h3>
      <template v-if="!srv">
        <p v-if="carregando" class="muted small"><span class="spin" /> Carregando a configuração do servidor…</p>
        <template v-else>
          <p class="muted small">Usa o seu login do ESL — o mesmo do site, sem senha extra. Se você já entrou no site nesta aba, a configuração abre sozinha.</p>
          <button @click="pedirLoginEsl = true">Entrar com o login do ESL</button>
        </template>
      </template>
      <template v-else>
        <div class="grid">
          <label class="wide">Sites liberados (CORS) — um por linha
            <textarea v-model="form.cors" rows="4" placeholder="https://esl-scraper.netlify.app" />
            <small>Aceita curinga: <code>https://*.netlify.app</code>. <a class="link" @click="liberarEsteSite">adicionar este site ({{ origemAtual }})</a></small>
          </label>
          <label>Sessão do ESL fecha após (min sem uso)<input v-model="form.sessionTtlMin" type="number" min="10" max="1440" /></label>
          <label class="inline" style="align-self: end"><input v-model="form.allowCommit" type="checkbox" /> Gravação no ESL ligada</label>
        </div>
        <div class="row" style="margin-top: 12px">
          <button @click="salvarSrv()">Salvar no servidor</button>
          <button class="ghost" @click="gerarChave">Gerar nova chave da API</button>
          <span class="muted small">chave atual: {{ srv.config.apiKeyDefinida ? 'termina em ' + srv.config.apiKeyFinal : 'nenhuma' }}</span>
        </div>
        <Transition name="fade">
          <div v-if="chaveNova" class="alertbox" style="margin-top: 12px">
            Chave nova (copie agora, ela não aparece de novo). Este navegador já está usando ela — em outros, cole em "Conexão deste navegador":
            <code class="keybox">{{ chaveNova }}</code>
          </div>
        </Transition>
        <p v-if="salvo" class="okc">{{ salvo }}</p>
        <p v-if="emailLogado" class="muted small">Logado no ESL como {{ emailLogado }}.</p>
        <p class="muted small">
          Online desde {{ new Date(srv.status.desde).toLocaleString('pt-BR') }} · {{ srv.status.sessoes.length }} sessão(ões) do ESL abertas
          <span v-for="(x, i) in srv.status.sessoes" :key="i"> · {{ x.email }} ({{ x.status }}{{ x.emLote ? ', lote rodando' : '' }})</span>
        </p>
      </template>
      <p v-if="erro" class="msg">{{ erro }}</p>
      <p class="muted small">Se este site não conseguir falar com o servidor (CORS errado), use o admin do próprio servidor:
        <a :href="con.url + '/admin'" target="_blank" rel="noopener">{{ con.url }}/admin</a></p>
    </section>

    <Transition name="pop">
      <Login v-if="pedirLoginEsl" modal titulo="Entrar no ESL" motivo="Entre com o seu login do ESL para administrar o servidor." fechavel @logged="onLogged" @fechar="pedirLoginEsl = false" />
    </Transition>
  </div>
</template>
