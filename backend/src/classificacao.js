// Classificação conservadora de descrições fiscais contra o catálogo real do ESL.
const normalize = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const stop = new Set('DE DA DO DAS DOS E EM COM PARA POR UM UMA SERVICO SERVICOS PECA PECAS PRODUTO PRODUTOS TROCA SUBSTITUICAO REPARO MANUTENCAO EXECUCAO VALOR REFERENTE NOTA NF'.split(' '));
const tokens = (s) => [...new Set(normalize(s).match(/[A-Z]{3,}/g) || [])].filter(w => !stop.has(w));
const rules = [
  ['FREIO', /\b(FREIOS?|LONAS?|PASTILHAS?|DISCOS? DE FREIO|CUI(CA|CAS)|TAMBOR DE FREIO)\b/],
  ['SUSPENSAO', /\b(SUSPENSAO|AMORTECEDOR(?:ES)?|MOLAS?|FEIXE|BUCHAS? DE MOLA)\b/],
  ['DIRECAO', /\b(DIRECAO|TERMINAL DE DIRECAO|BARRA DE DIRECAO|PIVO)\b/],
  ['ELETRICA', /\b(ELETRIC[AO]|ALTERNADOR|BATERIAS?|FAROIS?|FAROL|LANTERNAS?|MOTOR DE PARTIDA|CHICOTE)\b/],
  ['CABINE', /\b(CABINE|RETROVISOR(?:ES)?|PARABRISA|PARA BRISA|LIMPADOR|BANCO DO MOTORISTA)\b/],
  ['PNEU', /\b(PNEUS?|BORRACHARIA|RECAPAGEM|ALINHAMENTO|BALANCEAMENTO)\b/],
  ['TRANSMISSAO', /\b(TRANSMISSAO|EMBREAGEM|CARDAN|DIFERENCIAL|CAMBIO)\b/],
  ['AR CONDICIONADO', /\b(AR CONDICIONADO|CLIMATIZADOR)\b/],
  ['MOTOR', /\b(MOTOR|PISTAO|VIRABREQUIM|CABECOTE|INJETOR(?:ES)?)\b/],
  ['LUBRIFICACAO', /\b(LUBRIFICACAO|LUBRIFICANTE|OLEO LUBRIFICANTE|GRAXA)\b/],
  ['FILTRO', /\b(FILTROS?|ELEMENTO FILTRANTE)\b/],
];
export function temas(text) {
  const s = normalize(text).replace(/[^A-Z0-9]+/g, ' ');
  // Evita confundir motor de partida (elétrica) com motor do veículo.
  return rules.filter(([name,re]) => re.test(s) && !(name === 'MOTOR' && /MOTOR DE PARTIDA/.test(s))).map(([name]) => name);
}
export function rankCatalog(text, candidates, kind) {
  const words = tokens(text);
  const cats = temas(text);
  const input = normalize(text);
  const byId = new Map();
  for (const c of candidates) {
    if (!c?.id) continue;
    const label = c.nome || c.text;
    const ws = tokens(label);
    if (!ws.length) continue;
    const overlap = ws.filter(w => words.includes(w)).length;
    const cat = cats.length === 1 && normalize(label).includes(cats[0]);
    const exact = normalize(label).trim() === input.trim();
    let score = exact ? 100 : overlap * 12 + (overlap === ws.length ? 16 : 0) + (cat ? 20 : 0);
    if (kind === 'set' && cat && ws.some(w => words.includes(w) && !tokens(cats[0]).includes(w))) score += 18;
    if (kind === 'service' && overlap >= 2 && overlap === ws.length) score += 12;
    // Um grupo abrangente pode corresponder por categoria inequívoca.
    if (kind === 'group' && cat && ws.length === tokens(cats[0]).length) score = Math.max(score, 65);
    // Conjunto/item só pela categoria: deixa em dúvida se houver opções similares.
    if (kind === 'set' && cat && overlap === 0) score = Math.max(score, 20);
    if (kind === 'service' && !overlap && !exact) continue;
    if (score > 0) {
      const option = { id: c.id, text: c.text || c.nome, score, sub: 'Correspondência com a descrição do XML' };
      if (!byId.has(String(c.id)) || byId.get(String(c.id)).score < score) byId.set(String(c.id), option);
    }
  }
  const options = [...byId.values()].sort((a,b) => b.score-a.score).slice(0,8);
  const top = options[0], second = options[1];
  const min = kind === 'group' ? 45 : 48;
  const selected = top && top.score >= min && (!second || top.score-second.score >= 15) && cats.length <= 1 ? top : null;
  return { selected, options };
}
export function createClassifier({setItems, groups, services}) {
  const cache = new Map();
  async function search(kind, fn, term) {
    const k = kind + ':' + term;
    if (!cache.has(k)) cache.set(k, Promise.resolve().then(() => fn(term)).catch(() => []));
    return cache.get(k);
  }
  return async (text, kind, extra = []) => {
    const cats = temas(text);
    const words = tokens(text);
    const terms = [...new Set([...extra.filter(Boolean), ...cats, words.slice(0,2).join(' '), ...words.slice(0,2)].filter(t => t.length >= 3))].slice(0,5);
    const fn = {set:setItems,group:groups,service:services}[kind];
    const hits = (await Promise.all(terms.map(t => search(kind,fn,t)))).flat();
    return rankCatalog(text,hits,kind);
  };
}
