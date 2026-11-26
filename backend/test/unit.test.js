// Testes de unidade (offline): parsing de XML, histórico/duplicidade/retomada, CORS e modo simulação.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpCwd, sessaoProibida, NFE, NFSE_ABRASF } from './helpers.js';

tmpCwd(); // ANTES dos imports dinâmicos: ledger/config usam ./data relativo ao diretório atual
process.env.CORS_ORIGINS = 'https://meu-site.netlify.app,https://*.preview.example';
const { parseNfe, splitEmissao } = await import('../src/nfe.js');
const { parseServiceXml } = await import('../src/nfse.js');
const L = await import('../src/ledger.js');
const C = await import('../src/config.js');
const { checkServiceDuplicate, lancarServico } = await import('../src/lancamento-servicos.js');
const { lancarPecas, checkPartsDuplicate } = await import('../src/lancamento-pecas.js');

test('NF-e de peças: cabeçalho, itens e pistas do texto', () => {
  const nf = parseNfe(NFE);
  assert.equal(nf.chave, '35261100000000000191550010000012341000012345');
  assert.equal(nf.numero, '1234');
  assert.equal(nf.autorizada, true);
  assert.equal(nf.emitente.cnpj, '00000000000191');
  assert.equal(nf.items.length, 2);
  assert.deepEqual(nf.items.map((i) => i.nItem), [1, 2]);
  assert.equal(nf.items[0].cProdBase, 'VA32634');
  assert.equal(nf.items[0].oem, '9584770015');
  assert.equal(nf.items[0].valorLiquido, 90);
  assert.equal(nf.items[1].ean, '7890000000000');
  assert.equal(nf.placaNoTexto, 'ABC1D23');
  assert.deepEqual(splitEmissao(nf.emissao), { date: '09/11/2026', time: '15:01' });
});

test('NFS-e ABRASF: prestador, número e valor', () => {
  const d = parseServiceXml(NFSE_ABRASF);
  assert.equal(d.numero, '987');
  assert.equal(d.prestador.cnpj, '22222222000122');
  assert.equal(d.valorServicos, 350.5);
});

test('NF-e modelo 55 também é aceita como nota de serviço', () => {
  const d = parseServiceXml(NFE);
  assert.equal(d.numero, '1234');
  assert.equal(d.itens.length, 2);
});

test('XML inválido é recusado', () => {
  assert.throws(() => parseNfe('<qualquer><coisa/></qualquer>'), /NF-e válida/);
});

test('docKey: chave de acesso, ou CNPJ+número+série', () => {
  assert.equal(L.docKey({ chave: 'NFe 3526 1100 0000 0000 0191 5500 1000 0012 3410 0001 2345' }), '35261100000000000191550010000012341000012345');
  assert.equal(L.docKey({ cnpj: '22.222.222/0001-22', numero: '000987', serie: '1', tipo: 'nfse' }), 'nfse:22222222000122:987:1');
});

test('duplicidade (serviço): concluída bloqueia; com erro fica retomável — sem tocar o ESL', async () => {
  const doc = parseServiceXml(NFSE_ABRASF);
  let r = await checkServiceDuplicate(sessaoProibida, doc, null, null);
  assert.equal(r.bloqueado, false);
  assert.equal(r.retomavel, null);

  L.begin(r.docKey, { tipo: 'servico', numero: doc.numero });
  L.step(r.docKey, 'os', { id: 10, numero: 'OS-10' });
  L.step(r.docKey, 'servicos', { ok: [1] });
  L.finish(r.docKey, 'erro', { erro: 'queda simulada' });
  r = await checkServiceDuplicate(sessaoProibida, doc, null, null);
  assert.equal(r.bloqueado, false);
  assert.deepEqual(r.retomavel.servicosOk, [1]);
  assert.equal(r.retomavel.os.id, 10);

  L.finish(r.docKey, 'concluido');
  r = await checkServiceDuplicate(sessaoProibida, doc, null, null);
  assert.equal(r.bloqueado, true);
  assert.match(r.motivos[0], /já lançada/);
  assert.equal(L.all().length, 1, 'histórico persistido');
  assert.equal(L.get(r.docKey).erro, undefined, 'erro antigo limpo ao concluir');
});

test('trava impede dois lançamentos simultâneos do mesmo XML', () => {
  L.lock('x');
  assert.throws(() => L.lock('x'), (e) => e.status === 409);
  L.unlock('x');
  L.lock('x');
  L.unlock('x');
});

test('de-para de peças: aprende e descarta associação suspeita', () => {
  L.learnPart('123', 'A', { id: 1, text: 'P1' });
  assert.deepEqual(L.learnedPart('123', 'A'), { id: 1, text: 'P1' });
  L.learnPart('123', 'B', { id: 1, text: 'P1' }); // outro código → mesma peça = suspeito
  assert.equal(L.learnedPart('123', 'A'), null);
  assert.equal(L.limparDeParaSuspeito(), 2);
});

test('CORS: origem exata, curinga, e bloqueio de origem desconhecida', () => {
  assert.equal(C.origemPermitida('https://meu-site.netlify.app'), true);
  assert.equal(C.origemPermitida('https://meu-site.netlify.app/'), true);
  assert.equal(C.origemPermitida('https://abc-1.preview.example'), true);
  assert.equal(C.origemPermitida('https://a.b.preview.example'), false);
  assert.equal(C.origemPermitida('https://malicioso.netlify.app'), false);
  assert.equal(C.origemPermitida(undefined), true); // curl / mesmo domínio
});

test('MODO SIMULAÇÃO: serviço completo com commit=false não grava nada nem toca o ESL', async () => {
  const doc = parseServiceXml(NFSE_ABRASF);
  const r = await lancarServico(sessaoProibida, {
    doc: { ...doc, numero: '555' }, fornecedor: { id: 1, nome: 'X' }, os: { modo: 'existente', id: 9 },
    servicos: [{ nItem: 1, setItemId: 1, productId: 2, valor: 10 }],
  }, { commit: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /Gravação desativada/);
  assert.equal(L.all().filter((x) => x.numero === '555').length, 0, 'nada no histórico');
});

test('MODO SIMULAÇÃO: peças completas com commit=false não gravam nada nem tocam o ESL', async () => {
  const nf = parseNfe(NFE);
  const r = await lancarPecas(sessaoProibida, {
    nf: { ...nf, numero: '556' }, fornecedor: { id: 1 }, filial: 1, date: '09/11/2026', almoxarifado: { id: 1 },
    itens: nf.items.map((i, k) => ({ ...i, produto: { id: 100 + k, text: 'P' } })), os: { modo: 'existente', id: 9 },
  }, { commit: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /Gravação desativada/);
});

test('peças: tipo da NF de entrada inválido é recusado antes de tocar o ESL', async () => {
  const nf = parseNfe(NFE);
  const r = await lancarPecas(sessaoProibida, {
    nf: { ...nf, numero: '557' }, fornecedor: { id: 1 }, filial: 1, date: '09/11/2026', almoxarifado: { id: 1 }, tipoEntrada: 'consignado',
    itens: nf.items.map((i, k) => ({ ...i, produto: { id: 100 + k, text: 'P' } })), os: { modo: 'existente', id: 9 },
  }, { commit: true });
  assert.equal(r.etapa, 'validação');
  assert.match(r.error, /tipo da NF de entrada/);
});

test('validação: payload incompleto é recusado antes de qualquer etapa', async () => {
  const r = await lancarServico(sessaoProibida, { servicos: [] }, { commit: true });
  assert.equal(r.etapa, 'validação');
  assert.match(r.error, /Faltam/);
});

/* ---------- refazer como Pedido (nota lançada aqui como Avulsa) ---------- */
// Sessão falsa só de LEITURA: responde JSON por rota; qualquer outra coisa (página, gravação) quebra o teste.
const sessaoLeitura = (rotas) => new Proxy({ lastUsed: 0, context: { request: { get: async (url) => {
  const hit = Object.entries(rotas).find(([k]) => url.includes(k));
  return { url: () => url, status: () => 200, text: async () => JSON.stringify(hit ? hit[1] : []) };
} } } }, { get(t, p) { if (p in t || p === 'then') return t[p]; throw new Error(`tocou a sessão: ${String(p)}`); }, set(t, p, v) { t[p] = v; return true; } });

function semearNota(nf, invoiceId, etapasExtras = {}) {
  const key = L.docKey({ chave: nf.chave, cnpj: nf.emitente.cnpj, numero: nf.numero, serie: nf.serie, tipo: 'nfe' });
  L.begin(key, { tipo: 'pecas', numero: nf.numero });
  L.step(key, 'entrada', { invoiceId, ok: true });
  for (const [k, v] of Object.entries(etapasExtras)) L.step(key, k, v);
  L.finish(key, 'concluido');
  return key;
}
// itens da NF de entrada no ESL iguais aos do XML (conferência de "já lançada" bate)
const movsDe = (nf) => nf.items.map((i, k) => ({ id: k + 1, purchase_product_code: i.cProd, amount: i.quantidade, unitary_value: i.valorUnitario, total_value: i.valorTotal }));
const nfDe = (numero) => { const nf = parseNfe(NFE); return { ...nf, numero, chave: nf.chave.slice(0, -4) + numero.padStart(4, '0') }; };

test('refazer como Pedido: nota lançada aqui como Avulsa (só entrada) pode ser refeita; a avulsa não conta como duplicidade', async () => {
  const nf = nfDe('7001');
  semearNota(nf, 143540);
  const s = sessaoLeitura({ '/storage/invoices/143540/movements': movsDe(nf), '/storage/invoice/products/143540.json': { id: 143540, invoice_type_formatted: 'Avulsa' }, '/storage/invoice/products.json': [{ id: 143540, number: '7001', invoice_type_formatted: 'Avulsa' }] });
  const preview = await checkPartsDuplicate(s, nf, 1);
  assert.equal(preview.bloqueado, true);
  assert.deepEqual(preview.refazivel, { invoiceId: 143540, tipo: 'Avulsa' });
  const ref = await checkPartsDuplicate(s, nf, 1, { refazer: true });
  assert.equal(ref.bloqueado, false, ref.motivos.join(' '));
  assert.equal(ref.refazer.invoiceId, 143540);
});

test('tipo da NF de entrada pelo JSON real do detalhe (sem invoice_type_formatted)', async () => {
  const { tipoDaEntrada } = await import('../src/lancamento-pecas.js');
  assert.equal(tipoDaEntrada({ invoice_type: 'order', purchase_order_id: 23738, purchase_invoice_id: null }), 'Pedido');
  assert.equal(tipoDaEntrada({ invoice_type: 'single', purchase_order_id: null, purchase_invoice_id: null }), 'Avulsa');
  assert.equal(tipoDaEntrada({ invoice_type: null, purchase_order_id: null, purchase_invoice_id: null }), 'Avulsa');
  assert.equal(tipoDaEntrada({ invoice_type: 'purchase_invoice', purchase_order_id: null, purchase_invoice_id: 9 }), 'Nota de Compra');
  assert.equal(tipoDaEntrada({ invoice_type_formatted: 'Avulsa' }), 'Avulsa');
  assert.equal(tipoDaEntrada(null), null);
});

test('refazer como Pedido: reconhece a avulsa pelo JSON real do detalhe (sem o texto "Avulsa")', async () => {
  const nf = nfDe('7009');
  semearNota(nf, 143541);
  const s = sessaoLeitura({ '/storage/invoices/143541/movements': movsDe(nf), '/storage/invoice/products/143541.json': { id: 143541, invoice_type: 'single', purchase_order_id: null, purchase_invoice_id: null }, '/storage/invoice/products.json': [{ id: 143541, number: '7009', invoice_type_formatted: 'Avulsa' }] });
  const r = await checkPartsDuplicate(s, nf, 1);
  assert.deepEqual(r.refazivel, { invoiceId: 143541, tipo: 'Avulsa' });
  const ref = await checkPartsDuplicate(s, nf, 1, { refazer: true });
  assert.equal(ref.bloqueado, false, ref.motivos.join(' '));
});

test('refazer como Pedido: NÃO vale se já é Pedido, se teve OS/baixa, ou se existe outra NF de entrada da nota', async () => {
  const a = nfDe('7002'); semearNota(a, 500);
  const jaPedido = sessaoLeitura({ '/storage/invoices/500/movements': movsDe(a), '/storage/invoice/products/500.json': { id: 500, invoice_type_formatted: 'Pedido' } });
  assert.equal((await checkPartsDuplicate(jaPedido, a, 1)).refazivel, undefined);
  assert.equal((await checkPartsDuplicate(jaPedido, a, 1, { refazer: true })).bloqueado, true);

  const b = nfDe('7003'); semearNota(b, 501, { os: { id: 1, numero: 9 }, baixa: { withdrawalId: 3 } });
  const comOs = sessaoLeitura({ '/storage/invoices/501/movements': movsDe(b), '/storage/invoice/products/501.json': { id: 501, invoice_type_formatted: 'Avulsa' } });
  assert.equal((await checkPartsDuplicate(comOs, b, 1)).refazivel, undefined);
  assert.equal((await checkPartsDuplicate(comOs, b, 1, { refazer: true })).bloqueado, true);

  const c = nfDe('7004'); semearNota(c, 502);
  const outra = sessaoLeitura({ '/storage/invoices/502/movements': movsDe(c), '/storage/invoice/products/502.json': { id: 502, invoice_type_formatted: 'Avulsa' }, '/storage/invoice/products.json': [{ id: 999, number: '7004', invoice_type_formatted: 'Pedido' }] });
  const r = await checkPartsDuplicate(outra, c, 1, { refazer: true });
  assert.equal(r.bloqueado, true, 'NF de entrada feita à mão (id 999) continua bloqueando');
  assert.ok(r.existentes.some((x) => x.id === 999));
});

test('refazer como Pedido: lançar nota que não é refazível é recusado antes de gravar', async () => {
  const nf = nfDe('7005');
  const s = sessaoLeitura({});
  const r = await lancarPecas(s, {
    nf, fornecedor: { id: 1, nome: 'F' }, filial: 'X', date: '09/11/2026', almoxarifado: { id: 1, nome: 'A' }, refazerComoPedido: true,
    itens: nf.items.map((i, k) => ({ ...i, acao: 'existente', produto: { id: 100 + k, text: 'P' } })), os: { modo: 'nenhuma' },
  }, { commit: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /Refazer como Pedido só vale/);
});

/* ---------- condição de pagamento padronizada do pedido (A PRAZO | CARTAO CREDITO | A VISTA) ---------- */
test('condição de pagamento: deduzida do XML e nunca em branco', async () => {
  const { condicaoPagamentoDe } = await import('../src/nfe.js');
  const base = { emissao: '2026-11-17T13:53:35-03:00' };
  // NF 35029 (EMG): boleto (15) em 2 parcelas com vencimento depois da emissão
  assert.equal(condicaoPagamentoDe({ ...base, pagamentos: [{ tipo: '15', valor: 830 }, { tipo: '15', valor: 830 }], vencimentos: [{ vencimento: '2026-12-17' }, { vencimento: '2027-01-01' }] }).condicao, 'A PRAZO');
  assert.equal(condicaoPagamentoDe({ ...base, pagamentos: [{ tipo: '03', valor: 100 }] }).condicao, 'CARTAO CREDITO');
  assert.equal(condicaoPagamentoDe({ ...base, pagamentos: [{ tipo: '03' }], vencimentos: [{ vencimento: '2026-12-17' }] }).condicao, 'CARTAO CREDITO');
  assert.equal(condicaoPagamentoDe({ ...base, pagamentos: [{ tipo: '01' }] }).condicao, 'A VISTA');
  assert.equal(condicaoPagamentoDe({ ...base, pagamentos: [{ tipo: '17' }] }).condicao, 'A VISTA');
  assert.equal(condicaoPagamentoDe({ ...base, pagamentos: [{ tipo: '04' }] }).condicao, 'A VISTA');
  assert.equal(condicaoPagamentoDe({ ...base, pagamentos: [{ tipo: '99', indicador: '1' }] }).condicao, 'A PRAZO');
  // parcela que vence no mesmo dia da emissão não é "a prazo"
  assert.equal(condicaoPagamentoDe({ ...base, pagamentos: [{ tipo: '01' }], vencimentos: [{ vencimento: '2026-11-17' }] }).condicao, 'A VISTA');
  // sem nada na NF (ou nota lida por versão antiga) → padrão A PRAZO, nunca vazio
  assert.equal(condicaoPagamentoDe({ ...base }).condicao, 'A PRAZO');
  assert.equal(condicaoPagamentoDe({ ...base, pagamentos: [{ tipo: '90' }] }).condicao, 'A PRAZO');
  assert.equal(condicaoPagamentoDe(null).condicao, 'A PRAZO');
});

test('NF-e: lê as formas de pagamento (pag/detPag) com o tipo em 2 dígitos', () => {
  const nf = parseNfe(NFE);
  assert.ok(Array.isArray(nf.pagamentos));
  for (const p of nf.pagamentos) assert.ok(p.tipo === null || /^\d{2}$/.test(p.tipo));
});

/* ---------- impressão dos pedidos: ID de lote e PDF único ---------- */
// PDF mínimo no mesmo formato do Chromium (xref clássica), para testar o juntador sem navegador
function pdfMinimo(texto, paginas = 1) {
  const objs = [];
  const kids = [];
  objs[1] = '<</Type /Catalog /Pages 2 0 R>>';
  for (let i = 0; i < paginas; i++) {
    const conteudo = `BT /F1 12 Tf 50 700 Td (${texto} p${i + 1}) Tj ET`;
    const pag = 3 + i * 2;
    objs[pag] = `<</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${pag + 1} 0 R /Resources <</Font <</F1 <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>>>>>>>`;
    objs[pag + 1] = `<</Length ${conteudo.length}>>\nstream\n${conteudo}\nendstream`;
    kids.push(`${pag} 0 R`);
  }
  objs[2] = `<</Type /Pages /Count ${paginas} /Kids [${kids.join(' ')}]>>`;
  let out = '%PDF-1.4\n';
  const off = [];
  for (let n = 1; n < objs.length; n++) { off[n] = out.length; out += `${n} 0 obj\n${objs[n]}\nendobj\n`; }
  const x = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + off.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<</Size ${objs.length} /Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('PDF único: junta os pedidos na ordem, com todas as páginas', async () => {
  const { mesclarPdfs, contarPaginas } = await import('../src/pdf.js');
  const a = pdfMinimo('PEDIDO 4107', 1);
  const b = pdfMinimo('PEDIDO 4121', 2);
  assert.equal(contarPaginas(a), 1);
  assert.equal(contarPaginas(b), 2);
  const m = mesclarPdfs([a, b, a]);
  assert.equal(m.subarray(0, 5).toString(), '%PDF-');
  assert.equal(contarPaginas(m), 4);
  const txt = m.toString('latin1');
  assert.ok(txt.indexOf('PEDIDO 4107 p1') < txt.indexOf('PEDIDO 4121 p1') && txt.indexOf('PEDIDO 4121 p2') < txt.lastIndexOf('PEDIDO 4107 p1'), 'ordem dos pedidos');
  assert.throws(() => mesclarPdfs([]), /Nenhum PDF/);
});

test('ID do lote: LOTE-AAAAMMDD-XXXX e a nota guarda o último e todos os lotes', () => {
  const id = L.novoLoteId(new Date('2026-11-26T15:00:00Z'));
  assert.match(id, /^LOTE-20261126-[0-9A-F]{4}$/);
  const key = 'teste:lote:1';
  L.begin(key, { tipo: 'pecas', numero: '1' });
  L.marcarLote(key, 'LOTE-20261126-AAAA');
  L.marcarLote(key, 'LOTE-20261126-BBBB');
  L.marcarLote(key, 'LOTE-20261126-AAAA');
  assert.equal(L.get(key).lote, 'LOTE-20261126-AAAA');
  assert.deepEqual(L.get(key).lotes, ['LOTE-20261126-AAAA', 'LOTE-20261126-BBBB']);
});
