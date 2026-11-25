import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

const app = createApp(App);

// Um erro de render (ex.: uma linha com dado inesperado) não pode passar em silêncio:
// registra no console e mostra um aviso visível, em vez de só a tela "sumir".
let avisoTimer;
function avisar(msg) {
  let el = document.getElementById('erro-app');
  if (!el) {
    el = document.createElement('div');
    el.id = 'erro-app';
    el.setAttribute('role', 'alert');
    el.style.cssText =
      'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;max-width:min(560px,calc(100vw - 32px));' +
      'background:#b42318;color:#fff;padding:10px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);font:14px/1.4 system-ui,sans-serif;cursor:pointer';
    el.title = 'clique para fechar';
    el.onclick = () => el.remove();
    document.body.appendChild(el);
  }
  el.textContent = msg;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => el.remove(), 15_000);
}

app.config.errorHandler = (err, instance, info) => {
  const nome = instance?.$options?.__name || instance?.$options?.name || 'componente';
  console.error(`[erro em ${nome} · ${info}]`, err);
  avisar(`Erro na tela (${nome}): ${err?.message || err}. Detalhes no console (F12).`);
};

app.mount('#app');
