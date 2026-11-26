import { ref } from 'vue';

// Endereço do backend e chave da API: o que estiver salvo neste navegador (tela /admin) vale mais que o do build.
const ENV_API = import.meta.env.VITE_API_URL || 'http://localhost:3333';
const ENV_KEY = import.meta.env.VITE_API_KEY || '';
const lsGet = (k) => {
  try {
    return localStorage.getItem(k) || '';
  } catch {
    return '';
  }
};
export const conexaoCfg = ref({ url: lsGet('esl_api_url') || ENV_API, key: lsGet('esl_api_key') || ENV_KEY });
export function salvarConexao({ url, key }) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  try {
    if (u && u !== ENV_API) localStorage.setItem('esl_api_url', u);
    else localStorage.removeItem('esl_api_url');
    if (key && key !== ENV_KEY) localStorage.setItem('esl_api_key', key);
    else localStorage.removeItem('esl_api_key');
  } catch {}
  conexaoCfg.value = { url: u || ENV_API, key: key || ENV_KEY };
}
export const padraoConexao = { url: ENV_API, key: ENV_KEY };
/** Erro de chave da API (o servidor trocou a chave): o App manda para /admin. */
export const chaveInvalida = ref(false);

// sessão ESL fica só no sessionStorage (some ao fechar a aba)
export const sessionId = ref(sessionStorage.getItem('esl_session') || '');
/** Pedido de login vindo do backend: null | { reuse: sessionId|null, motivo } — o App mostra o login por cima, sem perder a tela. */
export const authNeeded = ref(null);
export function pedirLogin(motivo, reuse = null) {
  if (!authNeeded.value) authNeeded.value = { motivo, reuse };
}
export function setSession(id) {
  sessionId.value = id || '';
  if (id) sessionStorage.setItem('esl_session', id);
  else sessionStorage.removeItem('esl_session');
}

async function call(method, path, body) {
  const res = await fetch(conexaoCfg.value.url + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': conexaoCfg.value.key,
      ...(sessionId.value ? { 'X-Session-Id': sessionId.value } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.code === 'api_key') chaveInvalida.value = true;
  else if (res.status === 401 && !path.startsWith('/api/auth/')) {
    if (data.code === 'reauth') pedirLogin(data.error, sessionId.value); // mesma sessão: o lote pausado continua
    else if (sessionId.value) pedirLogin(data.error || 'Sua sessão terminou. Entre de novo.');
  }
  if (!res.ok) throw Object.assign(new Error(data.error || data.message || `HTTP ${res.status}`), { data, status: res.status });
  return data;
}

const q = (o) => '?' + new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString();

/** Chamadas do painel de administração do servidor: usa a sessão do ESL já logada (X-Session-Id), sem senha extra. */
export async function adminCall(method, body, url = conexaoCfg.value.url) {
  const res = await fetch(url + '/api/admin/config', {
    method,
    headers: { 'Content-Type': 'application/json', ...(sessionId.value ? { 'X-Session-Id': sessionId.value } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { code: data.code, status: res.status });
  return data;
}

export const api = {
  health: () => call('GET', '/api/health'),
  login: (email, password, sessionId) => call('POST', '/api/auth/login', { email, password, sessionId }),
  code: (sessionId, code) => call('POST', '/api/auth/code', { sessionId, code }),
  resend: (sessionId) => call('POST', '/api/auth/code/resend', { sessionId }),
  status: () => call('GET', '/api/auth/status'),
  logout: () => call('POST', '/api/auth/logout'),
  modules: () => call('GET', '/api/modules'),
  menu: (mod) => call('GET', `/api/menu/${mod}`),
  list: (route) => call('GET', '/api/list' + q({ route })),
  form: (route, newHref) => call('GET', '/api/form' + q({ route, newHref })),
  insert: (payload) => call('POST', '/api/insert', payload),
  mntPreview: (files) => call('POST', '/api/manutencao/preview', { files }),
  mntLancar: (payload) => call('POST', '/api/manutencao/lancar', payload),
  mntHistorico: () => call('GET', '/api/manutencao/historico'),
  vehicles: (term) => call('GET', '/api/lookup/vehicles' + q({ term })),
  products: (term, kind) => call('GET', '/api/lookup/products' + q({ term, kind })),
  people: (term) => call('GET', '/api/lookup/people' + q({ term })),
  employees: (term) => call('GET', '/api/lookup/employees' + q({ term })),
  setItems: (term) => call('GET', '/api/lookup/set-items' + q({ term })),
  warehouses: (term) => call('GET', '/api/lookup/warehouses' + q({ term })),
  groups: (term) => call('GET', '/api/lookup/groups' + q({ term })),
  units: () => call('GET', '/api/lookup/units'),
  filiais: () => call('GET', '/api/lookup/filiais'),
  serviceOrders: (term, status) => call('GET', '/api/lookup/service-orders' + q({ term, status })),
  serviceOrder: (id) => call('GET', `/api/lookup/service-orders/${id}`),
  xmlServicosPreview: (file) => call('POST', '/api/xml/servicos/preview', { file }),
  xmlServicosLancar: (payload) => call('POST', '/api/xml/servicos/lancar', payload),
  xmlPecasPreview: (file) => call('POST', '/api/xml/pecas/preview', { file }),
  xmlPecasLancar: (payload) => call('POST', '/api/xml/pecas/lancar', payload),
  loteStart: (tipo, notas) => call('POST', '/api/xml/lote', { tipo, notas }),
  loteStatus: (id) => call('GET', `/api/xml/lote/${id}`),
  loteTelas: (id, ref) => call('GET', `/api/xml/lote/${id}/telas/${ref}`),
  loteCancel: (id) => call('POST', `/api/xml/lote/${id}/cancelar`),
  xmlHistorico: (tipo) => call('GET', '/api/xml/historico' + q({ tipo })),
};
