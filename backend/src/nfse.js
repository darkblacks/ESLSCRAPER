// Leitura de XML de NOTA DE SERVIÇO. Aceita os layouts mais comuns:
//  - NFS-e Padrão Nacional (NFSe/infNFSe, chave de 50 posições no Id "NFS...")
//  - ABRASF 1.x/2.x (CompNfse/Nfse/InfNfse) — maioria das prefeituras
//  - Nota Fiscal Paulistana (SP) (NFe/ChaveNFe ... ValorServicos)
//  - NF-e modelo 55 com itens de serviço (usa o parser de NF-e)
// Como os layouts variam por prefeitura, a busca é feita por nome de tag em qualquer profundidade.
import { XMLParser } from 'fast-xml-parser';
import { parseNfe } from './nfe.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, removeNSPrefix: true });

const num = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  const s = String(typeof v === 'object' ? v['#text'] ?? '' : v).trim();
  return Number(s.includes(',') && !s.includes('.') ? s.replace(',', '.') : s) || 0;
};
const txt = (v) => (v === undefined || v === null ? null : String(typeof v === 'object' ? v['#text'] ?? '' : v).trim() || null);
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

/** Primeiro nó com algum dos nomes, em qualquer profundidade (busca em largura). */
function find(root, names, maxDepth = 12, exact = false) {
  const low = (n) => (exact ? n : n.toLowerCase());
  const want = new Set([].concat(names).map(low));
  const queue = [[root, 0]];
  while (queue.length) {
    const [node, d] = queue.shift();
    if (!node || typeof node !== 'object' || d > maxDepth) continue;
    for (const [k, v] of Object.entries(node)) {
      if (want.has(low(k))) return Array.isArray(v) ? v[0] : v;
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach((x) => queue.push([x, d + 1]));
      else if (v && typeof v === 'object') queue.push([v, d + 1]);
    }
  }
  return undefined;
}
const pick = (root, ...paths) => {
  for (const p of paths) {
    let node = root;
    for (const step of p.split('>')) {
      node = find(node, step.split('|'));
      if (node === undefined) break;
    }
    if (node !== undefined && txt(node) !== null) return node;
  }
  return undefined;
};

/** "2026-11-09T15:01:00-03:00" | "2026-11-09" | "09/11/2026" → { date: dd/mm/aaaa, time: hh:mm } */
export function splitDate(v) {
  const s = String(v || '');
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (m) return { date: `${m[3]}/${m[2]}/${m[1]}`, time: m[4] ? `${m[4]}:${m[5]}` : '08:00' };
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (m) return { date: `${m[1]}/${m[2]}/${m[3]}`, time: m[4] ? `${m[4]}:${m[5]}` : '08:00' };
  return { date: null, time: null };
}

/**
 * Retorna um documento de serviço normalizado:
 * { layout, chave, numero, serie, codigoVerificacao, emissao, prestador:{cnpj,nome}, tomador:{cnpj,nome},
 *   itens:[{nItem, codigo, descricao, quantidade, unidade, valorUnitario, valorTotal, codigoServico}],
 *   valorServicos, valorLiquido, valorIss, issRetido, discriminacao, municipio, faltando:[...] }
 */
export function parseServiceXml(xml) {
  const doc = parser.parse(xml);

  // NF-e modelo 55 com serviços (ISSQN) – reaproveita o parser de NF-e
  if (find(doc, 'infNFe', 12, true)) {
    const nf = parseNfe(xml);
    return normalize({
      layout: 'NF-e (modelo 55)',
      chave: nf.chave, numero: nf.numero, serie: nf.serie, emissao: nf.emissao,
      prestador: { cnpj: nf.emitente.cnpj, nome: nf.emitente.nome },
      tomador: nf.destinatario,
      itens: nf.items.map((i) => ({ nItem: i.nItem, codigo: i.cProd, descricao: i.descricao, quantidade: i.quantidade,
        unidade: i.unidade, valorUnitario: i.valorUnitario, valorTotal: i.valorTotal, codigoServico: null })),
      valorServicos: nf.valorProdutos, valorLiquido: nf.valorNota, discriminacao: nf.infoComplementar,
    });
  }

  // Padrão Nacional
  const infNFSe = find(doc, 'infNFSe', 12, true); // case-sensitive: ABRASF usa InfNfse
  if (infNFSe) {
    const dps = find(infNFSe, 'infDPS') || {};
    const id = txt(infNFSe['@Id']) || '';
    const desc = txt(pick(dps, 'serv>cServ>xDescServ', 'xDescServ'));
    const vServ = num(pick(dps, 'valores>vServPrest>vServ', 'vServ'));
    return normalize({
      layout: 'NFS-e Padrão Nacional',
      chave: id.replace(/^NFS/, '') || null,
      numero: txt(pick(infNFSe, 'nNFSe')),
      serie: txt(pick(dps, 'serie')),
      codigoVerificacao: null,
      emissao: txt(pick(infNFSe, 'dhProc')) || txt(pick(dps, 'dhEmi')),
      prestador: { cnpj: txt(pick(infNFSe, 'emit>CNPJ|CPF')) || txt(pick(dps, 'prest>CNPJ|CPF')), nome: txt(pick(infNFSe, 'emit>xNome')) || txt(pick(dps, 'prest>xNome')) },
      tomador: { cnpj: txt(pick(dps, 'toma>CNPJ|CPF')), nome: txt(pick(dps, 'toma>xNome')) },
      itens: [{ nItem: 1, codigo: txt(pick(dps, 'cTribNac')), descricao: desc, quantidade: 1, unidade: 'UN', valorUnitario: vServ, valorTotal: vServ, codigoServico: txt(pick(dps, 'cTribNac')) }],
      valorServicos: vServ,
      valorLiquido: num(pick(infNFSe, 'valores>vLiq', 'vLiq')) || vServ,
      valorIss: num(pick(infNFSe, 'vISSQN')),
      discriminacao: desc,
      municipio: txt(pick(infNFSe, 'xLocEmi')),
    });
  }

  // ABRASF
  const inf = find(doc, ['InfNfse']);
  if (inf) {
    const serv = find(inf, 'Servico') || find(doc, 'Servico') || {};
    const valores = find(serv, 'Valores') || {};
    const desc = txt(pick(serv, 'Discriminacao'));
    const vServ = num(pick(valores, 'ValorServicos'));
    const prest = find(inf, ['PrestadorServico', 'Prestador']) || find(doc, ['PrestadorServico', 'Prestador']) || {};
    const tom = find(inf, ['TomadorServico', 'Tomador']) || find(doc, ['TomadorServico', 'Tomador']) || {};
    const rps = find(doc, 'IdentificacaoRps');
    return normalize({
      layout: 'NFS-e ABRASF',
      chave: null,
      numero: txt(pick(inf, 'Numero')),
      serie: txt(pick(rps || {}, 'Serie')),
      codigoVerificacao: txt(pick(inf, 'CodigoVerificacao')),
      emissao: txt(pick(inf, 'DataEmissao')),
      prestador: { cnpj: txt(pick(prest, 'Cnpj|Cpf')) || txt(pick(doc, 'Prestador>Cnpj')), nome: txt(pick(prest, 'RazaoSocial')) || txt(pick(prest, 'NomeFantasia')) },
      tomador: { cnpj: txt(pick(tom, 'Cnpj|Cpf')), nome: txt(pick(tom, 'RazaoSocial')) },
      itens: [{ nItem: 1, codigo: txt(pick(serv, 'ItemListaServico')), descricao: desc, quantidade: 1, unidade: 'UN', valorUnitario: vServ, valorTotal: vServ, codigoServico: txt(pick(serv, 'CodigoTributacaoMunicipio')) || txt(pick(serv, 'ItemListaServico')) }],
      valorServicos: vServ,
      valorLiquido: num(pick(inf, 'ValorLiquidoNfse')) || vServ,
      valorIss: num(pick(valores, 'ValorIss')),
      issRetido: ['1', 'true'].includes(String(txt(pick(valores, 'IssRetido')) || '').toLowerCase()),
      discriminacao: desc,
      municipio: txt(pick(serv, 'CodigoMunicipio')),
    });
  }

  // Nota Fiscal Paulistana (São Paulo)
  const sp = find(doc, ['ChaveNFe']) ? (find(doc, 'NFe') || doc) : null;
  if (sp) {
    const vServ = num(pick(sp, 'ValorServicos'));
    const desc = txt(pick(sp, 'Discriminacao'));
    return normalize({
      layout: 'NFS-e Paulistana',
      chave: null,
      numero: txt(pick(sp, 'ChaveNFe>NumeroNFe', 'NumeroNFe')),
      serie: txt(pick(sp, 'ChaveRPS>SerieRPS')),
      codigoVerificacao: txt(pick(sp, 'ChaveNFe>CodigoVerificacao', 'CodigoVerificacao')),
      emissao: txt(pick(sp, 'DataEmissaoNFe')),
      prestador: { cnpj: txt(pick(sp, 'CPFCNPJPrestador>CNPJ|CPF')), nome: txt(pick(sp, 'RazaoSocialPrestador')) },
      tomador: { cnpj: txt(pick(sp, 'CPFCNPJTomador>CNPJ|CPF')), nome: txt(pick(sp, 'RazaoSocialTomador')) },
      itens: [{ nItem: 1, codigo: txt(pick(sp, 'CodigoServico')), descricao: desc, quantidade: 1, unidade: 'UN', valorUnitario: vServ, valorTotal: vServ, codigoServico: txt(pick(sp, 'CodigoServico')) }],
      valorServicos: vServ,
      valorLiquido: vServ - num(pick(sp, 'ValorISS')) * (String(txt(pick(sp, 'ISSRetido'))) === 'true' ? 1 : 0),
      valorIss: num(pick(sp, 'ValorISS')),
      discriminacao: desc,
    });
  }

  throw new Error('Layout de XML de serviço não reconhecido (esperado NFS-e Nacional, ABRASF, Paulistana ou NF-e).');
}

function normalize(d) {
  const out = {
    layout: d.layout, chave: d.chave || null, numero: d.numero ? String(Number(d.numero) || d.numero) : null,
    serie: d.serie || null, codigoVerificacao: d.codigoVerificacao || null, emissao: d.emissao || null,
    prestador: { cnpj: onlyDigits(d.prestador?.cnpj) || null, nome: d.prestador?.nome || null },
    tomador: { cnpj: onlyDigits(d.tomador?.cnpj) || null, nome: d.tomador?.nome || null },
    itens: (d.itens || []).filter((i) => i.descricao || i.valorTotal),
    valorServicos: d.valorServicos || 0, valorLiquido: d.valorLiquido || d.valorServicos || 0,
    valorIss: d.valorIss || 0, issRetido: !!d.issRetido, discriminacao: d.discriminacao || '', municipio: d.municipio || null,
    ...splitDate(d.emissao),
  };
  // Pistas comuns na discriminação: placa e OS
  const t = String(out.discriminacao || '').toUpperCase();
  out.placaNoTexto = (t.match(/\b([A-Z]{3}-?\d[A-Z0-9]\d{2})\b/) || [])[1]?.replace('-', '') || null;
  out.osNoTexto = (t.match(/\bO\.?S\.?\s*(?:N[º°O.]?\s*)?(\d{2,7})\b/) || [])[1] || null;
  out.faltando = [
    !out.numero && 'número',
    !out.prestador.cnpj && 'CNPJ do prestador',
    !out.prestador.nome && 'nome do prestador',
    !out.date && 'data de emissão',
    !out.valorServicos && 'valor do serviço',
  ].filter(Boolean);
  return out;
}
