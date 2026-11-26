<script setup>
import { ref } from 'vue';
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
      hint.value = r.message;
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
    msg.value = r.message;
    if (r.ok) startCooldown();
  } catch (e) {
    msg.value = e.message;
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
          <p class="muted small">{{ hint || 'Enviamos um código de 6 dígitos para o seu e-mail.' }} Ele expira em 10 minutos.</p>
          <label>Código de verificação
            <input v-model="code" class="code-input" inputmode="numeric" maxlength="6" pattern="\d{6}" placeholder="000000"
              autocomplete="one-time-code" required autofocus />
          </label>
          <button class="primary" :disabled="loading || code.length !== 6"><span v-if="loading" class="spin" />{{ loading ? 'Validando…' : 'Confirmar' }}</button>
          <div class="login-links">
            <button type="button" class="ghost" :disabled="cooldown > 0" @click="resend">
              {{ cooldown > 0 ? `Reenviar em ${cooldown}s` : 'Reenviar código' }}
            </button>
            <button type="button" class="ghost" @click="step = 'credentials'; code = ''">Voltar</button>
          </div>
        </form>
      </Transition>

      <Transition name="fade"><p v-if="msg" class="msg">{{ msg }}</p></Transition>
      <button v-if="fechavel" type="button" class="ghost" style="margin-top: 8px" @click="emit('fechar')">Cancelar</button>
      <p v-if="!modal" class="credit">criado por <b>Victor Ferreira</b></p>
    </section>
  </div>
</template>
