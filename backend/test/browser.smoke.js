// Smoke test do Playwright/Chromium headless no servidor. Uso: node test/browser.smoke.js [--esl]
// --esl: abre também a TELA DE LOGIN do ESL (só leitura: não preenche nem envia nada).
import { chromium } from 'playwright';

const t0 = Date.now();
const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' })).newPage();
  await page.setContent('<html><body><input id="x"><script>document.getElementById("x").value = "ok-" + (1 + 1)</script></body></html>');
  const v = await page.inputValue('#x');
  if (v !== 'ok-2') throw new Error('JavaScript não executou no Chromium');
  await page.screenshot({ type: 'jpeg', quality: 50 });
  console.log(`OK chromium ${browser.version()} headless (${Date.now() - t0} ms)`);
  if (process.argv.includes('--esl')) {
    const base = process.env.ESL_BASE || 'https://transmassa.eslcloud.com.br';
    const r = await page.goto(`${base}/users/sign_in`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const temForm = !!(await page.$('#user_email')) && !!(await page.$('#user_password'));
    if (!temForm) throw new Error(`Tela de login do ESL não reconhecida (HTTP ${r?.status()})`);
    console.log(`OK ESL alcançável: ${base}/users/sign_in (HTTP ${r?.status()}, formulário de login encontrado; nada foi enviado)`);
  }
} finally {
  await browser.close();
}
