// Núcleo do scraping: sessões Playwright por usuário + funções de leitura/inserção no ESL.
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import * as C from './config.js';

const BASE = process.env.ESL_BASE || 'https://transmassa.eslcloud.com.br';
const HEADLESS = process.env.HEADLESS !== 'false';

let browser;
async function getBrowser() {
  if (!browser || !browser.isConnected()) browser = await chromium.launch({ headless: HEADLESS });
  return browser;
}

/** sessionId -> { context, page, status, email, codeSelector, lastUsed, busy } */
const sessions = new Map();

setInterval(async () => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.busy || s.emLote) continue; // lote rodando: nunca fecha (o navegador pode estar fechado / PC do usuário dormindo)
    if (now - s.lastUsed > C.get().sessionTtlMin * 60_000) await closeSession(id);
  }
}, 60_000).unref();

// Mantém o login do ESL vivo enquanto há lote rodando ou sessão recente (evita cair no meio da madrugada).
setInterval(async () => {
  for (const s of sessions.values()) {
    if (s.status !== 'ok' || s.busy) continue;
    try {
      await apiGet(s, '/storage/invoice/products.json?per=1');
    } catch (e) {
      if (e.status === 401) s.status = 'expirada';
    }
  }
}, 10 * 60_000).unref();

/** Resumo das sessões abertas (para o /admin) — sem dados sensíveis. */
export function listSessions() {
  return [...sessions.values()].map((s) => ({ email: s.email, status: s.status, emLote: !!s.emLote, ocioso_min: Math.round((Date.now() - s.lastUsed) / 60000) }));
}

export function getSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  s.lastUsed = Date.now();
  return s;
}

export async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  await s.context.close().catch(() => {});
}

/** Encerra todas as sessões e o Chromium (SIGTERM do Docker / reinício). */
export async function shutdown() {
  for (const id of [...sessions.keys()]) await closeSession(id);
  if (browser) await browser.close().catch(() => {});
}

export { BASE };

/** GET JSON no ESL com os cookies da sessão (endpoints de autocomplete etc.). Não usa a página. */
export async function apiGet(s, path) {
  s.lastUsed = Date.now();
  const r = await s.context.request.get(BASE + path, {
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (r.url().includes('/users/sign_in')) {
    s.status = 'expirada';
    const e = new Error('Sessão expirada no ESL. Faça login de novo.');
    e.status = 401;
    throw e;
  }
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Resposta não-JSON em ${path} (HTTP ${r.status()})`);
  }
}

// Serializa operações de uma mesma sessão (uma página por sessão).
export async function withPage(s, fn) {
  while (s.busy) await s.busy;
  let release;
  s.busy = new Promise((r) => (release = r));
  s.lastUsed = Date.now();
  try {
    return await fn(s.page);
  } catch (e) {
    if (e.status === 401) s.status = 'expirada'; // ESL mandou para o login: front pede login de novo
    throw e;
  } finally {
    s.busy = null;
    s.lastUsed = Date.now();
    release();
  }
}

/* ------------------------------------------------------------------ */
/* Login                                                              */
/* ------------------------------------------------------------------ */

// Procura um campo visível de código (2FA / verificação) na página atual.
async function findCodeInput(page) {
  return page.evaluate(() => {
    const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    const inputs = [...document.querySelectorAll('input')].filter(
      (e) => visible(e) && ['text', 'number', 'tel', 'password', ''].includes(e.type) &&
        !/email|password\]$|search|pesquis/i.test(e.name + ' ' + e.id + ' ' + e.placeholder)
    );
    const pref = inputs.find((e) => /code|codigo|código|otp|token|two_factor|verifica|auth/i.test(
      `${e.name} ${e.id} ${e.placeholder} ${e.closest('form')?.innerText || ''}`
    ));
    const el = pref || (inputs.length === 1 ? inputs[0] : null);
    if (!el) return null;
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `input[name="${el.name}"]`;
    return null;
  });
}

async function pageMessage(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.alert, .flash, .toast-message, .notice, .error, .help-block, .invalid-feedback');
    return el ? el.innerText.trim().slice(0, 300) : null;
  });
}

/**
 * O ESL mandou o código por e-mail? Lê a tela de código:
 *  - erro: aviso de erro do ESL (classe de erro ou texto de falha), ex.: falha no envio, limite de tentativas;
 *  - confirmado: o ESL mostra "Enviamos um código ... para vic***@gmail.com" e não há erro.
 * Não dá para saber se o e-mail chegou na caixa de entrada — só o que o ESL informa.
 */
async function envioCodigo(page) {
  const r = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.alert, .flash, .toast-message, .notice, .error, .help-block, .invalid-feedback')]
      .filter((e) => e.innerText.trim());
    const falha = /erro|falh|não foi possível|nao foi possivel|tente novamente|limite|bloquead|excedid|indispon/i;
    const err = els.find((e) => /danger|error|invalid|alert-warning/i.test(e.className) || falha.test(e.innerText));
    const p = [...document.querySelectorAll('p, span, div')].find((e) => /Enviamos um código/i.test(e.innerText) && e.children.length < 3);
    return { erro: err ? err.innerText.trim().replace(/\s+/g, ' ').slice(0, 300) : null, hint: p ? p.innerText.trim().replace(/\s+/g, ' ').slice(0, 200) : null };
  }).catch(() => ({ erro: null, hint: null }));
  return { confirmado: !!r.hint && !r.erro, erro: r.erro, mensagem: r.hint, em: new Date().toISOString() };
}

// Etapa de código do ESL: /email_otp  (form POST /email_otp, input name="code" id="code", 6 dígitos)
const OTP_PATH = '/email_otp';
const OTP_INPUT = 'form[action="/email_otp"] #code';
const OTP_SUBMIT = 'form[action="/email_otp"] [type=submit]';
const OTP_RESEND = 'form[action="/email_otp/resend"] [type=submit]';

const pathOf = (page) => new URL(page.url()).pathname;

async function isLoggedIn(page) {
  return !/\/users\/sign_in|\/email_otp|\/two_factor|\/verify|\/otp/i.test(pathOf(page));
}

// Texto "Enviamos um código ... para vic****@gmail.com" (e-mail mascarado pelo próprio ESL)
async function otpHint(page) {
  return page.evaluate(() => {
    const p = [...document.querySelectorAll('p, span, div')].find((e) => /Enviamos um código/i.test(e.innerText) && e.children.length < 3);
    return p ? p.innerText.trim().replace(/\s+/g, ' ').slice(0, 200) : null;
  });
}

/**
 * Passo 1: e-mail + senha. Retorna { sessionId, status: 'ok' | 'code_required' | 'error', message }
 * As credenciais só passam por aqui (não são gravadas em disco nem em log).
 */
export async function startLogin(email, password, reuse = null) {
  // Relogin: reaproveita a MESMA sessão (mesmo id e mesmo navegador) — o lote que estava pausado continua nela.
  if (reuse && sessions.has(reuse.id)) {
    const s = reuse;
    while (s.busy) await s.busy;
    s.status = 'pending';
    s.email = email;
    s.codeSelector = null;
    s.lastUsed = Date.now();
    try {
      if (s.page.isClosed()) s.page = await s.context.newPage();
      await s.context.clearCookies();
      await s.page.goto(`${BASE}/users/sign_in`, { waitUntil: 'domcontentloaded' });
      await s.page.fill('#user_email', email);
      await s.page.fill('#user_password', password);
      await Promise.all([
        s.page.waitForLoadState('networkidle').catch(() => {}),
        s.page.click('form[action="/users/sign_in"] [type=submit]'),
      ]);
      await s.page.waitForTimeout(800);
      return { sessionId: s.id, ...(await resolveLoginState(s)) };
    } catch (err) {
      s.status = 'expirada';
      return { sessionId: s.id, status: 'error', message: err.message };
    }
  }

  const b = await getBrowser();
  const context = await b.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await context.newPage();
  const id = crypto.randomUUID();
  const s = { id, context, page, status: 'pending', email, codeSelector: null, lastUsed: Date.now(), busy: null };
  sessions.set(id, s);

  try {
    await page.goto(`${BASE}/users/sign_in`, { waitUntil: 'domcontentloaded' });
    await page.fill('#user_email', email);
    await page.fill('#user_password', password);
    await Promise.all([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.click('form[action="/users/sign_in"] [type=submit]'),
    ]);
    await page.waitForTimeout(800);
    return { sessionId: id, ...(await resolveLoginState(s)) };
  } catch (err) {
    await closeSession(id);
    return { sessionId: null, status: 'error', message: err.message };
  }
}

async function resolveLoginState(s) {
  const { page } = s;
  if (pathOf(page) === OTP_PATH && (await page.$(OTP_INPUT))) {
    s.status = 'code_required';
    s.codeSelector = OTP_INPUT;
    const err = await pageMessage(page);
    const envio = await envioCodigo(page);
    return { status: 'code_required', message: err || (await otpHint(page)) || 'Informe o código de 6 dígitos enviado por e-mail.', envio };
  }
  // Fallback genérico caso o ESL mude a tela de verificação
  const codeSel = await findCodeInput(page);
  if (codeSel) {
    s.status = 'code_required';
    s.codeSelector = codeSel;
    return { status: 'code_required', message: (await pageMessage(page)) || 'Informe o código de autenticação.' };
  }
  if (await isLoggedIn(page)) {
    s.status = 'ok';
    return { status: 'ok', url: page.url() };
  }
  s.status = 'error';
  return { status: 'error', message: (await pageMessage(page)) || 'Login não concluído (verifique e-mail/senha).' };
}

/** Passo 2 (se houver): código de autenticação. */
export async function submitCode(s, code) {
  if (s.status !== 'code_required') return { status: s.status, message: 'Sessão não está aguardando código.' };
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) return { status: 'code_required', message: 'O código tem 6 dígitos.' };
  return withPage(s, async (page) => {
    await page.fill(s.codeSelector, clean);
    const isOtp = s.codeSelector === OTP_INPUT;
    const submit = await page.$(isOtp ? OTP_SUBMIT : 'form [type=submit], form button:not([type=button])');
    await Promise.all([
      page.waitForNavigation({ timeout: 15_000 }).catch(() => {}),
      submit ? submit.click() : page.press(s.codeSelector, 'Enter'),
    ]);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    const r = await resolveLoginState(s);
    // Continuou na tela de OTP = código errado/expirado
    if (r.status === 'code_required' && pathOf(page) === OTP_PATH) {
      r.message = (await pageMessage(page)) || 'Código inválido ou expirado. Confira o e-mail ou peça reenvio.';
    }
    return r;
  });
}

/** Reenvia o código (o ESL só libera depois de alguns segundos — botão "Reenviar em Ns"). */
export async function resendCode(s) {
  if (s.status !== 'code_required') return { ok: false, message: 'Sessão não está aguardando código.' };
  return withPage(s, async (page) => {
    const btn = await page.$(OTP_RESEND);
    if (!btn) return { ok: false, message: 'Botão de reenvio não encontrado.' };
    if (await btn.isDisabled()) {
      const label = (await btn.getAttribute('value')) || '';
      return { ok: false, message: `Ainda não liberado (${label.trim() || 'aguarde'}).` };
    }
    await Promise.all([page.waitForLoadState('networkidle').catch(() => {}), btn.click()]);
    await page.waitForTimeout(800);
    const envio = await envioCodigo(page);
    if (envio.erro) return { ok: false, message: `O ESL não reenviou o código: ${envio.erro}`, envio };
    return { ok: true, message: (await pageMessage(page)) || envio.mensagem || 'Código reenviado.', envio };
  });
}

/** Cookies da sessão — para o seu servidor reaproveitar com fetch/axios se preferir. */
export async function exportState(s) {
  return s.context.storageState();
}

/* ------------------------------------------------------------------ */
/* Leitura                                                            */
/* ------------------------------------------------------------------ */

export async function goto(page, route) {
  const resp = await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  if (/\/users\/sign_in/.test(page.url())) {
    const e = new Error('Sessão expirada no ESL. Faça login de novo.');
    e.status = 401;
    throw e;
  }
  return resp;
}

/** Menu do módulo (tms | fleet | purchase), ignorando "Cadastros". */
export async function scrapeMenu(s, moduleRoot) {
  return withPage(s, async (page) => {
    await goto(page, moduleRoot);
    return page.evaluate(() => {
      const out = [];
      document.querySelectorAll('a').forEach((a) => {
        const href = (a.getAttribute('href') || '').split('?')[0];
        if (!href || href === '#' || href.startsWith('javascript') || href.startsWith('http')) return;
        const chain = [];
        let el = a.parentElement;
        while (el && el !== document.body) {
          const own = el.querySelector(':scope > a, :scope > span, :scope > button');
          if (el.tagName === 'LI' && own && own !== a) chain.unshift(own.innerText.trim().split('\n')[0]);
          el = el.parentElement;
        }
        if (!chain.length || chain[0] === 'Cadastros') return;
        out.push({ path: [...chain, a.innerText.trim().split('\n')[0]], route: href });
      });
      return out;
    });
  });
}

/**
 * Lista de uma tela: colunas + linhas da tabela, links de cada linha
 * e as chamadas XHR/JSON que a página fez (útil p/ descobrir a API interna do ESL).
 */
export async function scrapeList(s, route) {
  return withPage(s, async (page) => {
    const xhr = [];
    const onResp = async (r) => {
      const ct = r.headers()['content-type'] || '';
      if (!ct.includes('json') || r.request().resourceType() === 'document') return;
      let sample = null;
      try {
        const body = await r.json();
        sample = JSON.stringify(body).slice(0, 1500);
      } catch {}
      xhr.push({ method: r.request().method(), url: r.url().replace(BASE, ''), status: r.status(), sample });
    };
    page.on('response', onResp);
    try {
      await goto(page, route);
      await page.waitForTimeout(1000);
      const data = await page.evaluate(() => {
        const table = [...document.querySelectorAll('table')].sort(
          (a, b) => b.querySelectorAll('tbody tr').length - a.querySelectorAll('tbody tr').length
        )[0];
        if (!table) return { columns: [], rows: [] };
        const columns = [...table.querySelectorAll('thead th')].map((t) => t.innerText.trim());
        const rows = [...table.querySelectorAll('tbody tr')].map((tr) => {
          const cells = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim().replace(/\s+/g, ' '));
          const links = [...tr.querySelectorAll('a[href]')]
            .map((a) => (a.getAttribute('href') || '').split('?')[0])
            .filter((h) => h.startsWith('/'));
          return { cells, links: [...new Set(links)] };
        });
        const newLink = [...document.querySelectorAll('a[href]')].find(
          (a) => /\/new$/.test((a.getAttribute('href') || '').split('?')[0]) || /^(novo|nova|adicionar|incluir)/i.test(a.innerText.trim())
        );
        const pager = document.querySelector('.pagination, .dataTables_info, .pagy');
        return {
          title: document.title,
          columns,
          rows,
          newHref: newLink ? newLink.getAttribute('href').split('?')[0] : null,
          pager: pager ? pager.innerText.trim().replace(/\s+/g, ' ').slice(0, 200) : null,
        };
      });
      return { route, ...data, xhr };
    } finally {
      page.off('response', onResp);
    }
  });
}

const FORM_FIELDS_JS = () => {
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const form = [...document.querySelectorAll('form')]
    .filter((f) => !/sign_out|search|pesquis/i.test(f.action + f.className))
    .sort((a, b) => b.elements.length - a.elements.length)[0];
  if (!form) return { action: null, fields: [] };
  const fields = [...form.querySelectorAll('input, select, textarea')]
    .filter((e) => e.name && !['utf8', 'authenticity_token', '_method'].includes(e.name))
    .filter((e) => e.type !== 'hidden' || /_id\]?$/.test(e.name) || e.classList.contains('select2-hidden-accessible'))
    .map((e) => {
      const lbl = (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) ||
        e.closest('.form-group, .field, .col, div')?.querySelector('label');
      const label = lbl ? lbl.innerText.trim() : null;
      const cls = e.className || '';
      return {
        name: e.name,
        id: e.id || null,
        tag: e.tagName.toLowerCase(),
        type: e.type,
        label,
        required: e.required || /\*/.test(label || ''),
        visible: visible(e),
        kind: cls.includes('select2') || e.dataset.url || e.dataset.source ? 'autocomplete'
          : e.tagName === 'SELECT' ? 'select' : e.type === 'checkbox' ? 'checkbox' : 'input',
        dataUrl: e.dataset.url || e.dataset.source || e.dataset.ajaxUrl || null,
        options: e.tagName === 'SELECT' && !cls.includes('select2')
          ? [...e.options].slice(0, 60).map((o) => ({ value: o.value, text: o.text.trim() }))
          : undefined,
      };
    });
  const submits = [...form.querySelectorAll('[type=submit], button')].map((b) => (b.innerText || b.value || '').trim()).filter(Boolean);
  return { action: form.getAttribute('action'), method: form.getAttribute('method'), fields, submits };
};

/** Campos do formulário de criação (abre newHref da listagem ou route/new). */
export async function scrapeForm(s, route, newHref) {
  return withPage(s, async (page) => {
    const target = newHref || `${route.replace(/\/$/, '')}/new`;
    const resp = await goto(page, target);
    await page.waitForTimeout(600);
    const form = await page.evaluate(FORM_FIELDS_JS);
    return { route, target, httpStatus: resp?.status() ?? null, ...form };
  });
}

/* ------------------------------------------------------------------ */
/* Inserção                                                           */
/* ------------------------------------------------------------------ */

async function fillField(page, name, value) {
  const sel = `[name="${name.replace(/"/g, '\\"')}"]`;
  const el = await page.$(sel);
  if (!el) throw new Error(`Campo não encontrado: ${name}`);
  const info = await el.evaluate((e) => ({ tag: e.tagName, type: e.type, cls: e.className || '' }));

  if (info.cls.includes('select2')) {
    // Autocomplete select2: abre, digita, espera resultado e escolhe o 1º
    await el.evaluate((e) => {
      const c = e.nextElementSibling?.querySelector('.select2-selection, .select2-choice');
      c?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      c?.click();
    });
    await page.keyboard.type(String(value), { delay: 40 });
    await page.waitForSelector('.select2-results__option:not(.loading-results), .select2-result', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
  } else if (info.tag === 'SELECT') {
    const byValue = await page.selectOption(sel, String(value)).catch(() => null);
    if (!byValue?.length) await page.selectOption(sel, { label: String(value) });
  } else if (info.type === 'checkbox' || info.type === 'radio') {
    if (value) await page.check(sel); else await page.uncheck(sel);
  } else {
    await page.fill(sel, String(value));
    await el.evaluate((e) => e.dispatchEvent(new Event('change', { bubbles: true })));
  }
}

/**
 * Preenche o formulário de criação com `data` ({ "campo[name]": valor }).
 * commit=false → só preenche e devolve screenshot (NÃO salva).
 * commit=true  → clica em salvar e devolve URL/mensagem resultante.
 */
export async function insertRecord(s, { route, newHref, data, commit }) {
  return withPage(s, async (page) => {
    const target = newHref || `${route.replace(/\/$/, '')}/new`;
    await goto(page, target);
    const errors = [];
    for (const [name, value] of Object.entries(data || {})) {
      try {
        await fillField(page, name, value);
      } catch (e) {
        errors.push({ field: name, error: e.message });
      }
    }
    const shot = (await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 })).toString('base64');
    if (!commit) return { committed: false, target, errors, screenshot: shot };

    if (errors.length) return { committed: false, target, errors, screenshot: shot, message: 'Não salvo: há campos com erro.' };
    const before = page.url();
    const { clickAndConfirm } = await import('./ui.js'); // confirma o "Tem certeza que deseja salvar?" do ESL
    await clickAndConfirm(page, () => page.click('form [type=submit]'));
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1000);
    const after = page.url();
    const formErrors = await page.$$eval('.has-error, .is-invalid, .field_with_errors, .help-block, .invalid-feedback',
      (els) => els.map((e) => e.innerText.trim()).filter(Boolean).slice(0, 20));
    return {
      committed: after !== before && !formErrors.length,
      url: after,
      message: await pageMessage(page),
      formErrors,
      screenshot: (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64'),
    };
  });
}
