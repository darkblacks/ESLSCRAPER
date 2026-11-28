// Consulta pública do Meu DANFE. Contexto separado do ESL; não contorna desafios do site.
import { chromium } from 'playwright';
import { readFile, stat } from 'node:fs/promises';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const SITE = 'https://meudanfe.com.br/';
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
export function validarChave(value) {
  const chave = String(value ?? '').trim().replace(/\s/g, '');
  if (!/^\d{44}$/.test(chave) || chave.slice(20, 22) !== '55')
    throw fail('Informe a chave de acesso de uma NF-e (modelo 55, 44 dígitos).', 400);
  let soma = 0;
  for (let i = 42, peso = 2; i >= 0; i--, peso = peso === 9 ? 2 : peso + 1) soma += Number(chave[i]) * peso;
  const resto = soma % 11;
  if (Number(chave[43]) !== (resto < 2 ? 0 : 11 - resto)) throw fail('Dígito verificador da chave inválido.', 400);
  return chave;
}

// Também aceita uma resposta XML aberta diretamente no navegador. Não
// refaz requisições nem executa chamadas privadas do fornecedor.
async function baixarArquivo(context, page, link) {
  let timer;
  const attached = new Set();
  let resolveFile, rejectFile;
  const result = new Promise((resolve, reject) => { resolveFile = resolve; rejectFile = reject; });
  const onDownload = async (download) => {
    try {
      const path = await download.path();
      if (!path || (await stat(path)).size > 5_000_000) throw fail('XML ausente ou maior que 5 MB.');
      resolveFile(await readFile(path, 'utf8'));
    } catch (e) { rejectFile(e); }
  };
  const onPage = (p) => {
    if (attached.has(p)) return;
    attached.add(p);
    p.on('download', onDownload);
  };
  const onResponse = async (response) => {
    try {
      if (!response.ok() || !/^(?:application|text)\/(?:[\w.+-]*\+)?xml(?:;|$)/i.test(response.headers()['content-type'] || '')) return;
      if (response.request().resourceType() !== 'document') return;
      if (Number(response.headers()['content-length']) > 5_000_000) return;
      const body = await response.body();
      if (body.length <= 5_000_000) resolveFile(body.toString('utf8'));
    } catch {}
  };
  context.on('page', onPage);
  context.on('response', onResponse);
  onPage(page);
  try {
    timer = setTimeout(() => rejectFile(fail('O Meu DANFE não disponibilizou o XML. Use o upload manual.')), 30000);
    const [content] = await Promise.all([result, link.click({ timeout: 10000 })]);
    return content;
  } finally {
    clearTimeout(timer);
    context.off('page', onPage);
    context.off('response', onResponse);
    for (const p of attached) p.off('download', onDownload);
  }
}

// O aviso de novidades pode aparecer a cada contexto novo do Chromium.
export async function fecharAvisoNovidades(page, timeout = 4000) {
  const depois = page.getByRole('button', { name: /^depois$/i }).and(page.locator(':visible')).first();
  try {
    await depois.waitFor({ state: 'visible', timeout });
  } catch (e) {
    if (e.name === 'TimeoutError') return false; // aviso opcional
    throw e;
  }
  await depois.click({ timeout: 10000 });
  await depois.waitFor({ state: 'hidden', timeout: 10000 });
  return true;
}

export async function consultarChave(page, chave) {
  await fecharAvisoNovidades(page);
  const input = page.getByPlaceholder(/chave de acesso/i)
    .or(page.getByRole('textbox', { name: /chave de acesso/i }))
    .or(page.locator('input[maxlength="44"]'))
    .and(page.locator('input:visible')).first();
  const buscar = page.getByRole('button', { name: /^buscar$/i })
    .or(page.getByText(/^buscar$/i)).and(page.locator(':visible')).first();
  await input.fill(chave, { timeout: 15000 });
  // Se o anúncio carregou depois do formulário, fecha antes de clicar.
  await fecharAvisoNovidades(page, 1000);
  try {
    await buscar.click({ trial: true, timeout: 5000 });
  } catch (e) {
    if (!(await fecharAvisoNovidades(page, 1000))) throw e;
  }
  // O trial acima não dispara o formulário; a busca é enviada uma única vez.
  await buscar.click({ timeout: 15000 });
  const link = page.getByRole('button', { name: /^baixar\s+xml$/i })
    .or(page.getByRole('link', { name: /^baixar\s+xml$/i }))
    .or(page.getByText(/^baixar\s+xml$/i))
    .and(page.locator(':visible')).first();
  await link.waitFor({ state: 'visible', timeout: 60000 });
  return link;
}

let active = 0;
export async function buscarXml(value) {
  const chave = validarChave(value);
  if (active >= 2) throw fail('Há consultas em andamento. Tente novamente em instantes.', 429);
  active++;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, timeout: 15000 });
    const context = await browser.newContext({ acceptDownloads: true, locale: 'pt-BR' });
    const page = await context.newPage();
    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const link = await consultarChave(page, chave);
    // O site informa que o botão pode abrir pop-up. Escuta downloads tanto
    // na aba original quanto nas novas, sem tentar contornar verificações.
    const content = await baixarArquivo(context, page, link);
    if (content.length > 5_000_000 || XMLValidator.validate(content) !== true) throw fail('O Meu DANFE não retornou um XML válido.');
    if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw fail('XML com declaração de entidade não permitido.');
    const doc = new XMLParser({ ignoreAttributes: false, parseTagValue: false, removeNSPrefix: true, processEntities: false }).parse(content);
    const inf = (doc.nfeProc?.NFe || doc.NFe)?.infNFe;
    if (inf?.['@_Id'] !== 'NFe' + chave) throw fail('O XML retornado não corresponde à chave informada.');
    return { name: chave + '.xml', content };
  } catch (e) {
    if (e.status) throw e;
    throw fail('Não foi possível baixar o XML pelo Meu DANFE. O site pode estar indisponível, exigir verificação humana ou abrir o download de outra forma. Use o upload manual.');
  } finally {
    try { await browser?.close(); } finally { active--; }
  }
}
