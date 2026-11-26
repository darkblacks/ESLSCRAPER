<script setup>
import { ref, onUnmounted } from 'vue';
import { api, setSession } from '../api.js';

// modal = login por cima da tela (sessão caiu); reuse = id da sessão a reaproveitar (lote pausado continua nela)
const props = defineProps({ modal: Boolean, reuse: String, motivo: String, emailInicial: String, titulo: String, fechavel: Boolean });
const emit = defineEmits(['logged', 'fechar']);
const step = ref('credentials'); // credentials | code
const email = ref(props.emailInicial || '');
const password = ref('');
const code = ref('');
const pendingId = ref('');
const msg = ref('');
const hint = ref('');
const loading = ref(false);
// Situação do envio do código pelo ESL: { tipo: 'ok' | 'aviso' | 'erro', texto }
const envio = ref(null);
const demorou = ref(false); // passou 1 min na tela do código: mostra dicas (spam, reenviar)
let demoraTimer;
const hora = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
function marcarEnvio(e, acao = 'enviado') {
  if (e?.erro) envio.value = { tipo: 'erro', texto: `O ESL informou um problema ao enviar o código: “${e.erro}”. Use “Reenviar código” ou volte e entre de novo.` };
  else if (e?.confirmado) envio.value = { tipo: 'ok', texto: `O ESL confirmou: código ${acao} às ${hora()}.` };
  else envio.value = { tipo: 'aviso', texto: `O ESL não confirmou o envio do código (${hora()}). Se não chegar em 1 minuto, use “Reenviar código”.` };
  demorou.value = false;
  clearTimeout(demoraTimer);
  demoraTimer = setTimeout(() => (demorou.value = true), 60_000);
}
onUnmounted(() => clearTimeout(demoraTimer));

async function submitCredentials() {
  loading.value = true;
  msg.value = '';
  try {
    const r = await api.login(email.value, password.value, props.reuse || undefined);
    password.value = '';
    if (r.status === 'ok') {
      setSession(r.sessionId);
      emit('logged', email.value);
    } else if (r.status === 'code_required') {
      pendingId.value = r.sessionId;
      step.value = 'code';
      hint.value = r.envio?.mensagem || r.message;
      marcarEnvio(r.envio);
      startCooldown(15);
    } else msg.value = r.message || 'Falha no login';
  } catch (e) {
    msg.value = e.data?.message || e.message;
  } finally {
    loading.value = false;
  }
}

const cooldown = ref(0);
let timer;
function startCooldown(sec = 30) {
  cooldown.value = sec;
  clearInterval(timer);
  timer = setInterval(() => (cooldown.value > 0 ? cooldown.value-- : clearInterval(timer)), 1000);
}

async function resend() {
  msg.value = '';
  try {
    const r = await api.resend(pendingId.value);
    if (r.ok) {
      if (r.envio?.mensagem) hint.value = r.envio.mensagem;
      marcarEnvio(r.envio || { confirmado: true }, 'reenviado');
      startCooldown();
    } else if (/Ainda não liberado/.test(r.message || '')) {
      envio.value = { tipo: 'aviso', texto: `O ESL ainda não libera o reenvio: ${r.message}` };
    } else {
      envio.value = { tipo: 'erro', texto: `O reenvio falhou: ${r.message || 'o ESL não respondeu.'}` };
    }
  } catch (e) {
    envio.value = { tipo: 'erro', texto: `Não consegui pedir o reenvio ao ESL: ${e.message}` };
    if (e.status === 401 && /Sessão/.test(e.message)) step.value = 'credentials';
  }
}

async function submitCode() {
  loading.value = true;
  msg.value = '';
  try {
    const r = await api.code(pendingId.value, code.value);
    if (r.status === 'ok') {
      setSession(r.sessionId);
      emit('logged', email.value);
    } else msg.value = r.message || 'Código inválido';
  } catch (e) {
    msg.value = e.data?.message || e.message;
    if (e.status === 401 && /Sessão/.test(msg.value)) step.value = 'credentials';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div :class="modal ? 'login-overlay' : 'login-stage'">
    <section class="login glass">
      <img v-if="!modal" src="/logo.png" alt="ESL Scraper" class="login-logo" />
      <img v-else src="/fox.png" alt="" class="login-fox" />

      <h2>{{ titulo || (modal ? 'Entre de novo no ESL' : 'Entrar no ESL Cloud') }}</h2>
      <p v-if="modal" class="alertbox">
        {{ motivo || 'O login no ESL caiu.' }}
        <b v-if="reuse">Nada foi perdido: se havia um lote rodando, ele está pausado e continua sozinho assim que você entrar.</b>
      </p>

      <Transition name="swap" mode="out-in">
        <form v-if="step === 'credentials'" key="cred" @submit.prevent="submitCredentials">
          <label>E-mail<input v-model="email" type="email" required autocomplete="username" /></label>
          <label>Senha<input v-model="password" type="password" required autocomplete="current-password" /></label>
          <button class="primary" :disabled="loading"><span v-if="loading" class="spin" />{{ loading ? 'Entrando…' : 'Entrar' }}</button>
        </form>

        <form v-else key="code" @submit.prevent="submitCode">
          <p class="muted small">{{ hint || 'Enviamos um código de 6 dígitos para o seu e-mail.' }}<template v-if="!/expira/i.test(hint)"> Ele expira em 10 minutos.</template></p>
          <p v-if="envio" class="envio" :class="envio.tipo" role="status">{{ envio.tipo === 'ok' ? '✓ ' : envio.tipo === 'erro' ? '✗ ' : '! ' }}{{ envio.texto }}</p>
          <p v-if="demorou && envio?.tipo !== 'erro'" class="muted small">Ainda não chegou? Confira o spam/lixo eletrônico e a aba Promoções. O código vai para o e-mail cadastrado no ESL e vale 10 minutos — use “Reenviar código”.</p>
          <label>Código de verificação
            <input v-model="code" class="code-input" inputmode="numeric" maxlength="6" pattern="\d{6}" placeholder="000000"
              autocomplete="one-time-code" required autofocus />
          </label>
          <button class="primary" :disabled="loading || code.length !== 6"><span v-if="loading" class="spin" />{{ loading ? 'Validando…' : 'Confirmar' }}</button>
          <div class="login-links">
            <button type="button" class="ghost" :disabled="cooldown > 0" @click="resend">
              {{ cooldown > 0 ? `Reenviar em ${cooldown}s` : 'Reenviar código' }}
            </button>
            <button type="button" class="ghost" @click="step = 'credentials'; code = ''; envio = null">Voltar</button>
          </div>
        </form>
      </Transition>

      <Transition name="fade"><p v-if="msg" class="msg">{{ msg }}</p></Transition>
      <button v-if="fechavel" type="button" class="ghost" style="margin-top: 8px" @click="emit('fechar')">Cancelar</button>
      <p v-if="!modal" class="credit">criado por <b>Victor Ferreira</b></p>
    </section>
  </div>
</template>
