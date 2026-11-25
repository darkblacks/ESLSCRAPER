<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { api, sessionId, setSession, authNeeded, chaveInvalida } from './api.js';
import Admin from './components/Admin.vue';
import Login from './components/Login.vue';
import Explorer from './components/Explorer.vue';
import Manutencao from './components/Manutencao.vue';
import LancamentoXml from './components/LancamentoXml.vue';

const view = ref('xml');
const emAdmin = location.pathname.replace(/\/+$/, '') === '/admin';
const email = ref('');
const commitEnabled = ref(false);
const backendOk = ref(null);
const logado = ref(false); // depois do 1º login a tela nunca é desmontada (não perde a lista de XMLs)
const conexao = ref('ok'); // ok | caiu | offline

async function checar() {
  try {
    const h = await api.health();
    backendOk.value = true;
    commitEnabled.value = h.commitEnabled;
  } catch {
    backendOk.value = false;
    conexao.value = 'offline';
    return;
  }
  if (!sessionId.value) {
    if (logado.value) authNeeded.value ||= { motivo: 'Sua sessão terminou. Entre de novo.', reuse: null };
    return;
  }
  const s = await api.status().catch(() => ({ status: 'none' }));
  if (s.status === 'ok') {
    email.value = s.email;
    logado.value = true;
    conexao.value = 'ok';
    authNeeded.value = null;
  } else if (s.status === 'none') {
    // backend reiniciou: a sessão antiga não existe mais
    conexao.value = 'caiu';
    if (logado.value) authNeeded.value ||= { motivo: 'O backend foi reiniciado e a sessão se perdeu. Entre de novo (a lista de XMLs continua aqui).', reuse: null };
    else setSession('');
  } else {
    // a sessão existe, mas o ESL deslogou: reloga na MESMA sessão (mesmo depois de recarregar a página)
    conexao.value = 'caiu';
    email.value = s.email || email.value;
    logado.value = true;
    authNeeded.value ||= {
      motivo: s.emLote ? 'O login no ESL caiu no meio do lote.' : 'O login no ESL caiu.',
      reuse: sessionId.value,
    };
  }
}

let hb;
onMounted(async () => {
  if (emAdmin) return;
  await checar();
  hb = setInterval(checar, 20_000); // front e back conversando: percebe quando o login cai
});
onUnmounted(() => clearInterval(hb));

function onLogged(e) {
  email.value = e;
  logado.value = true;
  conexao.value = 'ok';
  authNeeded.value = null;
}
async function logout() {
  await api.logout().catch(() => {});
  setSession('');
  logado.value = false;
  authNeeded.value = null;
}
const TABS = [['xml', 'Lançamento de XML'], ['mnt', 'Manutenção · XML → OS'], ['explorer', 'Explorador de telas']];
</script>

<template>
  <div class="bg-swirl" aria-hidden="true"><span /><span /><span /></div>

  <header class="topbar">
    <div class="brand">
      <img src="/swirl.png" alt="" class="brand-mark" />
      <span class="brand-name"><b>ESL</b> Scraper</span>
    </div>
    <span class="host">transmassa.eslcloud.com.br</span>
    <span class="spacer" />
    <Transition name="fade">
      <span v-if="backendOk === false" class="badge err pulse">backend offline</span>
    </Transition>
    <a v-if="chaveInvalida && !emAdmin" href="/admin" class="badge err pulse">chave da API recusada — corrigir</a>
    <span v-if="logado && !emAdmin" class="conn" :class="conexao" :title="conexao === 'ok' ? 'conectado ao ESL' : 'login caiu'">
      <i />{{ conexao === 'ok' ? 'ESL conectado' : conexao === 'offline' ? 'sem backend' : 'login caiu' }}
    </span>
    <span v-if="commitEnabled" class="badge warn">gravação LIGADA</span>
    <a v-if="!emAdmin" href="/admin" class="gear" title="Administração">⚙</a>
    <template v-if="logado && !emAdmin">
      <span class="user">{{ email }}</span>
      <button class="ghost" @click="logout">Sair</button>
    </template>
  </header>

  <main>
    <Admin v-if="emAdmin" />
    <Transition v-else name="rise" mode="out-in">
      <Login v-if="!logado" key="login" @logged="onLogged" />
      <div v-else key="app" class="app-body">
        <nav class="maintabs">
          <button v-for="[k, t] in TABS" :key="k" :class="{ active: view === k }" @click="view = k">{{ t }}</button>
          <span class="tab-ink" :style="{ '--i': TABS.findIndex((x) => x[0] === view) }" />
        </nav>
        <Transition name="slide" mode="out-in">
          <KeepAlive>
            <LancamentoXml v-if="view === 'xml'" :commit-enabled="commitEnabled" />
            <Manutencao v-else-if="view === 'mnt'" :commit-enabled="commitEnabled" />
            <Explorer v-else :commit-enabled="commitEnabled" />
          </KeepAlive>
        </Transition>
      </div>
    </Transition>
  </main>

  <footer class="footer">
    <img src="/fox.png" alt="" class="footer-fox" />
    <span><b>ESL Scraper</b> · automação do ESL Cloud · criado por <b>Victor Ferreira</b></span>
  </footer>

  <Transition name="pop">
    <Login v-if="logado && authNeeded && !emAdmin" modal :reuse="authNeeded.reuse" :motivo="authNeeded.motivo" :email-inicial="email" @logged="onLogged" />
  </Transition>
</template>
