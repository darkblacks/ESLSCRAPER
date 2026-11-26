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
  let ok;
  try {
    ok = await setSelect2Injetando(page, name, id, text, scope);
  } catch (e) {
    // o handler do ESL precisa dos dados completos do resultado da busca → escolhe digitando, como uma pessoa
    if (!/Cannot read propert|undefined|null/i.test(e.message)) throw e;
    await page.evaluate((sel) => { const $ = window.jQuery; $(sel).first().val(null).trigger('change.select2'); }, `${scope} [name="${name}"]`.trim()).catch(() => {});
    const termo = String(text || id).split(' - ')[0].trim();
    const r = await select2Pesquisar(page, name, termo, String(text || id), scope);
    if (String(r.valor) !== String(id)) throw new Error(`No campo ${name} a busca por "${termo}" escolheu outro registro (id ${r.valor}, esperado ${id}).`);
    return;
  }
  if (!ok) throw new Error(`Campo não encontrado: ${name}`);
}

async function setSelect2Injetando(page, name, id, text, scope) {
  return page.evaluate(
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
}

/**
 * Escolhe num select2 com busca AJAX como uma pessoa: clica no campo, digita o termo, espera os resultados do ESL e
 * clica no que bate (pelo texto exato ou, se não houver, pelo início do texto). Use quando o ESL precisa dos dados
 * completos do resultado (ex.: "Pedido de Compra" na NF de entrada: o handler lê campos que só vêm da busca — injetar
 * a opção com setSelect2 quebra com "Cannot read properties of undefined (reading 'id')").
 */
export async function select2Pesquisar(page, name, termo, textoEsperado, scope = '') {
  const sel = `${scope} [name="${name}"]`.trim();
  await page.waitForSelector(sel, { state: 'attached', timeout: 10_000 });
  // abre o select2 (o <select> fica escondido; o clique é no container irmão)
  const aberto = await page.evaluate((sel) => {
    const $ = window.jQuery;
    const el = $(sel).first();
    if (!el.length || !el.data('select2')) return false;
    el.select2('open');
    return true;
  }, sel);
  if (!aberto) {
    const cont = page.locator(`${sel} + .select2, ${sel} + .select2-container`).first();
    await cont.locator('.select2-selection').click();
  }
  const busca = page.locator('.select2-container--open .select2-search__field, .select2-drop-active input.select2-input').first();
  await busca.waitFor({ state: 'visible', timeout: 5000 });
  await busca.fill('');
  await busca.type(String(termo), { delay: 60 });
  const alvo = String(textoEsperado ?? termo).trim();
  // espera os resultados da busca (sem "carregando…")
  const handle = await page.waitForFunction(({ alvo, termo }) => {
    const ops = [...document.querySelectorAll('.select2-container--open .select2-results__option, .select2-drop-active .select2-result')]
      .filter((o) => o.offsetParent !== null);
    if (!ops.length || ops.some((o) => /loading|carregando|buscando/i.test(o.className + ' ' + o.innerText))) return null;
    const txt = (o) => o.innerText.replace(/\s+/g, ' ').trim();
    const ok = ops.filter((o) => !/select2-results__message|select2-no-results/.test(o.className));
    if (!ok.length) return { nenhum: ops.map(txt).join(' | ') };
    const i = ok.findIndex((o) => txt(o) === alvo);
    let j = i >= 0 ? i : ok.findIndex((o) => txt(o).startsWith(alvo + ' ') || txt(o).startsWith(alvo + ' -'));
    if (j < 0) { const k = ok.filter((o) => txt(o) === termo || txt(o).startsWith(termo + ' ')); if (k.length === 1) j = ok.indexOf(k[0]); } // só se for único
    if (j < 0) return { semMatch: ok.map(txt).slice(0, 10).join(' | ') };
    ok.forEach((o) => o.removeAttribute('data-esl-opt'));
    ok[j].setAttribute('data-esl-opt', '1');
    return { ok: txt(ok[j]) };
  }, { alvo, termo: String(termo).trim() }, { timeout: 15_000, polling: 300 }).catch(() => null);
  const r = handle ? await handle.jsonValue() : null;
  if (!r || !r.ok) {
    await page.keyboard.press('Escape').catch(() => {});
    throw new Error(`Não achei "${alvo}" na busca do campo ${name}` + (r?.nenhum ? ` (ESL respondeu: ${r.nenhum})` : r?.semMatch ? ` (resultados: ${r.semMatch})` : ' (a busca não respondeu)') + '.');
  }
  await page.locator('[data-esl-opt="1"]').first().hover().catch(() => {});
  await page.locator('[data-esl-opt="1"]').first().click();
  await page.waitForTimeout(800); // o ESL carrega os dados do item escolhido
  const valor = await page.$eval(sel, (e) => e.value).catch(() => '');
  if (!valor) throw new Error(`Cliquei em "${r.ok}" mas o campo ${name} ficou vazio.`);
  return { valor, texto: r.ok };
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

/** Texto da janela SweetAlert visível (ou null). */
export async function swalTexto(page) {
  return page.evaluate(() => {
    const S = window.Swal || window.swal;
    if (!S || !S.isVisible || !S.isVisible()) return null;
    const pop = S.getPopup && S.getPopup();
    return (pop ? pop.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 200);
  }).catch(() => null);
}

/**
 * Confirma a janela SweetAlert aberta como uma pessoa faria: clica em "Sim/OK" e, se ela não fechar,
 * foca o botão de confirmar e dá ENTER (no ESL às vezes o clique programático não fecha a janela).
 * Devolve true se a janela com esse texto fechou.
 */
export async function swalConfirmar(page) {
  const antes = await swalTexto(page);
  if (!antes) return true;
  await page.evaluate(() => (window.Swal || window.swal).clickConfirm()).catch(() => {});
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    await page.waitForTimeout(500);
    const agora = await swalTexto(page);
    if (agora !== antes) return true; // fechou ou já é outra janela
    const btn = page.locator('.swal2-confirm:visible').first();
    if (tentativa === 0) {
      await btn.focus().catch(() => {});
      await page.keyboard.press('Enter');
    } else await btn.click({ timeout: 2000 }).catch(() => {});
  }
  return (await swalTexto(page)) !== antes;
}

/** Fecha avisos de sucesso que o ESL mostra depois de gravar/excluir ("...com sucesso" › OK/Enter). Erro → lança. */
export async function fecharAvisosSwal(page, ms = 3000) {
  const fim = Date.now() + ms;
  const vistos = [];
  while (Date.now() < fim) {
    const t = await swalTexto(page);
    if (!t) {
      if (vistos.length) break;
      await page.waitForTimeout(250);
      continue;
    }
    if (/erro|não (foi possível|pode)|inválid|falh/i.test(t)) {
      await swalConfirmar(page);
      throw new Error(`O ESL respondeu: ${t}`);
    }
    if (!/sucesso|exclu[ií]d[oa]|removid[oa]|salv[oa]|gravad[oa]|atualizad[oa]/i.test(t)) break; // não é aviso: quem chamou decide
    vistos.push(t);
    await swalConfirmar(page);
  }
  return vistos;
}

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
        await swalConfirmar(page);
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
      if (!(await swalConfirmar(page))) throw new Error(`Não consegui confirmar a pergunta do ESL (nem com Enter): "${st.texto}"`);
      confirmadas.push(st.texto);
      await page.waitForTimeout(300);
      continue; // pode vir outra pergunta (ou o aviso de sucesso) em seguida
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
