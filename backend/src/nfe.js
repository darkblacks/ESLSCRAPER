// Leitura de XML de NF-e (modelo 55, layout 4.00) — só o que a manutenção precisa.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false, // mantém códigos/CNPJ como texto (zeros à esquerda)
  isArray: (name) => ['det', 'dup', 'obsCont', 'vol', 'detPag'].includes(name),
});

const num = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v));

/** Extrai um possível código OEM/fabricante do começo da descrição: "9584770015-FILTRO ..." → "9584770015" */
function oemFromDescription(desc) {
  const m = String(desc || '').match(/^\s*([A-Z0-9.\-\/]{5,})\s*[-–]\s*(.+)$/i);
  return m ? { oem: m[1].replace(/[.\-\/]/g, ''), name: m[2].trim() } : { oem: null, name: String(desc || '').trim() };
}

export function parseNfe(xml) {
  const doc = parser.parse(xml);
  const proc = doc.nfeProc || doc;
  const nfe = proc.NFe || doc.NFe;
  if (!nfe?.infNFe) throw new Error('XML não é uma NF-e válida (infNFe não encontrado).');
  const inf = nfe.infNFe;
  const chave = (inf['@Id'] || '').replace(/^NFe/, '') || proc.protNFe?.infProt?.chNFe;
  const prot = proc.protNFe?.infProt;

  const items = (inf.det || []).map((d, idx) => {
    const p = d.prod;
    const { oem, name } = oemFromDescription(p.xProd);
    return {
      // padrão é atributo (<det nItem="1">), mas há emissores que mandam <nItem> como elemento; sem nenhum, usa a posição
      nItem: Number(d['@nItem'] ?? d.nItem) || idx + 1,
      cProd: String(p.cProd),
      cProdBase: String(p.cProd).split('-')[0], // "VA32634-143" → "VA32634"
      oem,
      descricao: String(p.xProd),
      nomeLimpo: name,
      ncm: p.NCM,
      cfop: p.CFOP,
      unidade: p.uCom,
      quantidade: num(p.qCom),
      // valor de tabela (bruto) por item — escolha do usuário; descontos/frete vão no cabeçalho da NF de entrada
      valorUnitario: num(p.vUnCom),
      valorTotal: num(p.vProd),
      desconto: num(p.vDesc),
      frete: num(p.vFrete),
      outras: num(p.vSeg) + num(p.vOutro),
      valorLiquido: Math.round((num(p.vProd) - num(p.vDesc) + num(p.vFrete) + num(p.vSeg) + num(p.vOutro)) * 100) / 100,
      ean: p.cEAN && p.cEAN !== 'SEM GTIN' ? p.cEAN : null,
    };
  });

  const tot = inf.total?.ICMSTot || {};
  const infCpl = inf.infAdic?.infCpl || '';
  return {
    chave,
    numero: String(inf.ide.nNF),
    serie: String(inf.ide.serie),
    emissao: inf.ide.dhEmi, // ISO com fuso
    naturezaOperacao: inf.ide.natOp,
    autorizada: prot ? String(prot.cStat) === '100' : null,
    protocolo: prot?.nProt || null,
    emitente: {
      cnpj: inf.emit.CNPJ || inf.emit.CPF,
      nome: inf.emit.xNome,
      fantasia: inf.emit.xFant || null,
      cidade: inf.emit.enderEmit?.xMun,
      uf: inf.emit.enderEmit?.UF,
    },
    destinatario: { cnpj: inf.dest?.CNPJ || inf.dest?.CPF, nome: inf.dest?.xNome },
    valorProdutos: num(tot.vProd),
    valorNota: num(tot.vNF),
    valorFrete: num(tot.vFrete),
    valorDesconto: num(tot.vDesc),
    vencimentos: (inf.cobr?.dup || []).map((d) => ({ numero: d.nDup, vencimento: d.dVenc, valor: num(d.vDup) })),
    pagamentos: (inf.pag?.detPag || []).map((d) => ({ tipo: d.tPag != null ? String(d.tPag).padStart(2, '0') : null, indicador: d.indPag != null ? String(d.indPag) : null, valor: num(d.vPag) })),
    infoComplementar: infCpl,
    // Pistas que às vezes vêm no texto livre (pedido, placa)
    pedidoNoTexto: (infCpl.match(/PEDIDO:\s*([A-Z0-9\-]+)/i) || [])[1] || null,
    placaNoTexto: (infCpl.toUpperCase().match(/\b([A-Z]{3}-?\d[A-Z0-9]\d{2})\b/) || [])[1]?.replace('-', '') || null,
    items,
  };
}

/**
 * Condição de pagamento padronizada para o pedido de compra no ESL — sempre um dos textos que já existem lá:
 * "A PRAZO" | "CARTAO CREDITO" | "A VISTA". Nunca em branco: sem informação na NF → "A PRAZO" (padrão de fornecedor).
 * Regras (NF-e 4.00): tPag 03 = cartão de crédito; parcela com vencimento depois da emissão, indPag 1, boleto (15)
 * ou crédito loja (05) = a prazo; dinheiro (01), cheque (02), débito (04), PIX (17/20) e afins = à vista.
 * Devolve { condicao, motivo }.
 */
export function condicaoPagamentoDe(nf) {
  const pags = nf?.pagamentos || [];
  const emissao = String(nf?.emissao || '').slice(0, 10);
  const tipos = pags.map((p) => p.tipo).filter(Boolean);
  if (tipos.includes('03')) return { condicao: 'CARTAO CREDITO', motivo: 'NF paga com cartão de crédito' };
  const futuras = (nf?.vencimentos || []).filter((v) => v.vencimento && (!emissao || String(v.vencimento).slice(0, 10) > emissao));
  if (futuras.length) return { condicao: 'A PRAZO', motivo: `${futuras.length} parcela(s) com vencimento` };
  if (pags.some((p) => p.indicador === '1') || tipos.some((t) => ['05', '15'].includes(t))) return { condicao: 'A PRAZO', motivo: 'NF indica pagamento a prazo/boleto' };
  if (tipos.some((t) => ['01', '02', '04', '16', '17', '18', '20'].includes(t)) || pags.some((p) => p.indicador === '0')) return { condicao: 'A VISTA', motivo: 'NF indica pagamento à vista' };
  return { condicao: 'A PRAZO', motivo: 'NF sem forma de pagamento — padrão A PRAZO' };
}

/** "2026-11-09T15:01:00-02:00" → { date: "09/11/2026", time: "15:01" } (horário local da nota) */
export function splitEmissao(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? { date: `${m[3]}/${m[2]}/${m[1]}`, time: `${m[4]}:${m[5]}` } : { date: null, time: null };
}
