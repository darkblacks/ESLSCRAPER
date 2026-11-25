// Helpers de interação com as telas do ESL (jQuery + select2 + modais Bootstrap/Vue).
// Mapeados nas telas reais em 25/11/2026.
import { goto } from './esl.js';

export const shot = async (page, fullPage = true) =>
  (await page.screenshot({ fullPage, type: 'jpeg', quality: 55 })).toString('base64');

/* ---------------- trilha de telas (o que o ESL mostrava a cada Salvar) ---------------- */
/** Define o contexto das próximas capturas (ex.: "NF 72753 · Entrada · item 3 (567016)"). */
export function ctx(page, label) {
  page._ctx = label;
}
/** Tira um print da tela atual e guarda na trilha da página (se a trilha estiver ligada). */
export async function capture(page, etapa) {
  if (!page._trail) return;
  try {
    const img = (await page.screenshot({ type: 'jpeg', quality: 45 })).toString('base64');
    const t = { em: new Date().toISOString(), legenda: `${page._ctx ? page._ctx + ' — ' : ''}${etapa}`, img };
    page._trail.push(t);
    page._onShot?.(t);
  } catch {}
}

export async function waitJq(page) {
  await page.waitForFunction(() => window.jQuery && window.jQuery.fn.select2, null, { timeout: 20_000 });
}

export async function open(page, route) {
  await goto(page, route);
  await waitJq(page);
  await page.waitForTimeout(500);
}

/** Seleciona um valor num select2 pelo id exato (cria a <option> se ela vier por AJAX). */
export async function setSelect2(page, name, id, text, scope = '') {
  const ok = await page.evaluate(
    ({ name, id, text, scope }) => {
      const $ = window.jQuery;
      const el = $(`${scope} [name="${name}"]`.trim()).first();
      if (!el.length) return false;
      if (!el.find(`option[value="${id}"]`).length) el.append(new Option(text, id, true, true));
      el.val(String(id)).trigger('change').trigger({ type: 'select2:select', params: { data: { id, text } } });
      el[0].dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    { name, id: String(id), text: String(text || id), scope }
  );
  if (!ok) throw new Error(`Campo não encontrado: ${name}`);
}

/** Seleciona uma opção estática pelo texto (ex.: filial "TRANSMASSA - SBC"). Devolve o value escolhido. */
export async function selectByLabel(page, name, label, scope = '') {
  const v = await page.evaluate(
    ({ name, label, scope }) => {
      const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
      const el = document.querySelector(`${scope} [name="${name}"]`.trim());
      if (!el) return { err: 'campo' };
      const opt = [...el.options].find((o) => norm(o.text) === norm(label)) || [...el.options].find((o) => o.value && norm(o.text).includes(norm(label)));
      if (!opt) return { err: 'opcao', options: [...el.options].map((o) => o.text.trim()).filter(Boolean).slice(0, 30) };
      const $ = window.jQuery;
      $(el).val(opt.value).trigger('change').trigger({ type: 'select2:select', params: { data: { id: opt.value, text: opt.text } } });
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { value: opt.value };
    },
    { name, label, scope }
  );
  if (v.err === 'campo') throw new Error(`Campo não encontrado: ${name}`);
  if (v.err) throw new Error(`Opção "${label}" não existe em ${name}. Opções: ${v.options.join(', ')}`);
  return v.value;
}

export async function setText(page, name, value, scope = '') {
  const sel = `${scope} [name="${name}"]`.trim();
  await page.waitForSelector(sel, { state: 'attached', timeout: 10_000 });
  await page.$eval(
    sel,
    (e, v) => {
      e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      e.dispatchEvent(new Event('blur', { bubbles: true }));
      if (window.jQuery) window.jQuery(e).trigger('change');
    },
    String(value ?? '')
  );
}

export async function setCheckbox(page, name, checked, scope = '') {
  await page.evaluate(
    ({ name, checked, scope }) => {
      const el = [...document.querySelectorAll(`${scope} [name="${name}"]`.trim())].find((e) => e.type === 'checkbox');
      if (el && el.checked !== checked) el.click();
    },
    { name, checked, scope }
  );
}

export async function formErrors(page) {
  return page.$$eval(
    '.has-error .help-block, .field_with_errors, .invalid-feedback, .alert-danger, .toast-error, .toast-message',
    (els) => [...new Set(els.filter((e) => e.offsetParent !== null).map((e) => e.innerText.trim()).filter(Boolean))].slice(0, 20)
  );
}


/**
 * Depois de clicar em Salvar, o ESL pode pedir "Você tem certeza que deseja gravar?" (SweetAlert2 v8, botões Sim/Cancelar).
 * Confirma só esse tipo de pergunta, e só logo após um clique de salvar feito pela automação. Também aceita confirm() nativo.
 * Retorna os textos das perguntas confirmadas.
 */
const PERGUNTA_OK = /(certeza|deseja|confirma).*(gravar|salvar|incluir|adicionar|lan[cç]ar|continuar)|deseja (realmente )?(gravar|salvar|continuar)/i;
const PERGUNTA_NAO = /exclu|remov|apag|cancelar a|estornar/i;

export async function confirmDialogs(page, ms = 4000) {
  const confirmadas = [];
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const st = await page.evaluate(() => {
      const S = window.Swal || window.swal;
      if (!S || !S.isVisible || !S.isVisible()) return null;
      const pop = S.getPopup && S.getPopup();
      return { texto: (pop ? pop.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 200), temConfirmar: !!document.querySelector('.swal2-confirm') };
    }).catch(() => null);
    if (st) {
      if (/sucesso|salv[oa] com|gravad[oa]/i.test(st.texto) && !PERGUNTA_OK.test(st.texto)) {
        await page.evaluate(() => (window.Swal || window.swal).clickConfirm()).catch(() => {});
        confirmadas.push(st.texto);
        break;
      }
      const isErro = !st.temConfirmar || /erro|inválid|não pode|obrigat/i.test(st.texto) && !PERGUNTA_OK.test(st.texto);
      if (PERGUNTA_NAO.test(st.texto) && !PERGUNTA_OK.test(st.texto)) {
        await page.evaluate(() => (window.Swal || window.swal).clickCancel()).catch(() => {});
        throw new Error(`O ESL perguntou algo que a automação não confirma sozinha: "${st.texto}"`);
      }
      if (isErro) {
        await page.evaluate(() => (window.Swal || window.swal).clickConfirm()).catch(() => {});
        throw new Error(`O ESL respondeu: ${st.texto}`);
      }
      if (!PERGUNTA_OK.test(st.texto)) {
        await page.evaluate(() => (window.Swal || window.swal).clickCancel()).catch(() => {});
        throw new Error(`O ESL fez uma pergunta não prevista (cancelada por segurança): "${st.texto}"`);
      }
      await page.evaluate(() => (window.Swal || window.swal).clickConfirm());
      confirmadas.push(st.texto);
      await page.waitForTimeout(600);
      continue; // pode vir outra pergunta em seguida
    }
    if (confirmadas.length) break; // já confirmou e não veio outra
    await page.waitForTimeout(250);
  }
  return confirmadas;
}

/** Clica e trata a confirmação (SweetAlert do ESL ou confirm() nativo). */
export async function clickAndConfirm(page, clickFn) {
  const onDialog = (d) => (d.type() === 'confirm' || d.type() === 'alert' ? d.accept() : d.dismiss()).catch(() => {});
  page.on('dialog', onDialog);
  try {
    await clickFn();
    return await confirmDialogs(page);
  } finally {
    page.off('dialog', onDialog);
  }
}

/** Clica no botão principal "Salvar" da página (fora de modais) e espera ir para /:id/edit. */
export async function saveMainForm(page, urlRegex) {
  const before = page.url();
  const marked = await page.evaluate(() => {
    document.querySelectorAll('[data-esl-save]').forEach((e) => e.removeAttribute('data-esl-save'));
    const b = [...document.querySelectorAll('button, input[type=submit], a.btn')].find(
      (e) => /^\s*Salvar\s*$/.test(e.innerText || e.value || '') && !e.closest('.modal') && e.offsetWidth > 0
    );
    if (b) b.setAttribute('data-esl-save', '1');
    return !!b;
  });
  if (!marked) throw new Error('Botão Salvar não encontrado.');
  await capture(page, 'preenchido, antes de salvar');
  const jaEditando = urlRegex.test(before); // editar registro existente: o ESL salva e continua na mesma tela
  const nav = jaEditando ? Promise.resolve() : page.waitForURL(urlRegex, { timeout: 25_000 }).catch(() => {});
  await clickAndConfirm(page, () => page.click('[data-esl-save="1"]'));
  await nav;
  if (jaEditando) {
    // espera a mensagem do ESL ("Registro atualizado com sucesso.") ou um erro
    const r = await page
      .waitForFunction(() => {
        const vis = [...document.querySelectorAll('.toast-message, .toast, .alert, .has-error .help-block, .invalid-feedback')]
          .filter((e) => e.offsetParent !== null).map((e) => e.innerText.trim()).filter(Boolean);
        const ok = vis.find((t) => /sucesso/i.test(t));
        const err = vis.find((t) => /erro|não pode|inválid|obrigat/i.test(t));
        return ok ? { ok } : err ? { err } : null;
      }, null, { timeout: 20_000, polling: 300 })
      .then((h) => h.jsonValue())
      .catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await capture(page, r?.ok ? 'salvo (ESL confirmou)' : 'ESL não confirmou');
    if (!r?.ok) {
      const errs = await formErrors(page);
      const e = new Error(`Alteração não confirmada pelo ESL${r?.err ? ': ' + r.err : errs.length ? ': ' + errs.join(' | ') : ' (sem mensagem de sucesso)'}.`);
      e.formErrors = errs;
      throw e;
    }
    return before.match(urlRegex)[1];
  }
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  const m = page.url().match(urlRegex);
  await capture(page, m && page.url() !== before ? 'salvo (ESL abriu o registro)' : 'ESL não salvou');
  if (!m || page.url() === before) {
    const errs = await formErrors(page);
    const e = new Error(`Registro não foi salvo${errs.length ? ': ' + errs.join(' | ') : ''}.`);
    e.formErrors = errs;
    throw e;
  }
  return m[1];
}

/** Abre uma aba da página pelo texto (ex.: "Serviços", "Produtos e Peças", "Entrada no Estoque"). */
export async function openTab(page, text) {
  const tab = page.locator(`a:has-text("${text}"), li:has-text("${text}") > a, [role=tab]:has-text("${text}")`).first();
  if (await tab.count()) {
    await tab.click().catch(() => {});
    await page.waitForTimeout(700);
  }
}

/** Clica no botão visível (fora de modal) com o texto informado (ex.: "Novo item") e espera o modal. */
export async function openModal(page, buttonText, modalId) {
  const btn = page.locator(`button:visible:has-text("${buttonText}"), a.btn:visible:has-text("${buttonText}")`).first();
  if (!(await btn.count())) throw new Error(`Botão "${buttonText}" não encontrado (registro pode estar bloqueado para edição).`);
  await btn.click();
  const modal = page.locator(`#${modalId}`);
  await modal.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(300);
  return modal;
}

/** Salva o modal (botão "Salvar" exato) e espera fechar. Lança erro com as mensagens do ESL se não fechar. */
export async function saveModal(page, modalId) {
  const modal = page.locator(`#${modalId}`);
  await capture(page, 'item preenchido, antes de salvar');
  await clickAndConfirm(page, () => modal.locator('button:visible').filter({ hasText: /^\s*Salvar\s*$/ }).first().click());
  try {
    await modal.waitFor({ state: 'hidden', timeout: 15_000 });
  } catch {
    const errs = await modal.locator('.has-error, .invalid-feedback, .help-block, .alert-danger').allInnerTexts().catch(() => []);
    const page_errs = await formErrors(page);
    await capture(page, 'ESL não aceitou o item');
    await modal.locator('button:visible').filter({ hasText: /Fechar/ }).first().click().catch(() => {});
    throw new Error(`O ESL não aceitou o item: ${[...errs, ...page_errs].filter(Boolean).join(' | ') || 'modal não fechou'}`);
  }
  await page.waitForTimeout(700);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await capture(page, 'item salvo');
}

/** Número no formato do ESL: 1234,56 (sem milhar). */
export const brNum = (n, dec = 2) =>
  Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: false });

/** "dd/mm/aaaa" e "hh:mm" de agora (fuso de São Paulo). */
export function nowBr() {
  const d = new Date(Date.now() - 3 * 3600_000);
  const p = (x) => String(x).padStart(2, '0');
  return { date: `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` };
}

/** Confere no DOM se o campo ficou com o valor esperado (pega campo que o ESL ignorou antes de salvar). */
export async function assertValue(page, name, expected, label, scope = '') {
  const v = await page.evaluate(({ name, scope }) => {
    const el = document.querySelector(`${scope} select[name="${name}"], ${scope} input:not([type=hidden])[name="${name}"], ${scope} textarea[name="${name}"]`.trim());
    return el ? el.value : null;
  }, { name, scope });
  if (String(v ?? '') !== String(expected ?? '')) throw new Error(`Campo "${label || name}" não ficou preenchido (esperado ${expected}, ficou "${v ?? ''}").`);
}
