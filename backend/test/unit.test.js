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
const { lancarPecas } = await import('../src/lancamento-pecas.js');

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
