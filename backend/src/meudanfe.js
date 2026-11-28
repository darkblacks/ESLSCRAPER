// Consulta pública do Meu DANFE. Contexto separado do ESL; não contorna desafios do site.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
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
    const input = page.getByRole('textbox', { name: /chave de acesso/i }).or(page.getByPlaceholder(/chave de acesso/i)).or(page.locator('input[maxlength="44"]')).first();
    await input.fill(chave, { timeout: 15000 });
    await page.getByText('BUSCAR', { exact: true }).first().click({ timeout: 15000 });
    const link = page.getByText('Baixar XML', { exact: true }).first();
    await link.waitFor({ state: 'visible', timeout: 60000 });
    // Captura somente download normal iniciado pelo botão público.
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    const [download] = await Promise.all([downloadPromise, link.click({ timeout: 10000 })]);
    const path = await download.path();
    const content = await readFile(path, 'utf8');
    if (content.length > 5_000_000 || XMLValidator.validate(content) !== true) throw fail('O Meu DANFE não retornou um XML válido.');
    const doc = new XMLParser({ ignoreAttributes: false, parseTagValue: false, removeNSPrefix: true }).parse(content);
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
