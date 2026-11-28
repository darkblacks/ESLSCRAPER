// Interpreta as restrições fornecidas pelo ESL, sem inventar uma leitura.
export function kmInteiro(v) {
  if (v == null || String(v).trim() === '') return null;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null;
  let s = String(v).trim();
  if (/^\d{1,3}(?:\.\d{3})+(?:,0+)?$/.test(s)) s = s.replace(/\./g, '');
  s = s.replace(/,0+$/, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
export function restricaoHodometro(texto, atual = null) {
  const raw = String(texto || '');
  const limites = [];
  const re = /hod[oô]metro\s+atual\s+n[aã]o\s+pode\s+ser\s+(maior|menor)\s+que\s+([^(\n|]+)\(\s*(?:hod[oô]metro|km(?:\s+sa[ií]da\/chegada)?)\s*:\s*([\d.,]+)\s*\)/gi;
  for (const m of raw.matchAll(re)) {
    const km = kmInteiro(m[3]);
    if (km !== null) limites.push({ tipo: m[1].toLowerCase() === 'maior' ? 'max' : 'min', km, origem: m[2].trim() });
  }
  if (!limites.length && !/hod[oô]metro|quilometragem/i.test(raw)) return null;
  const maxs = limites.filter(x => x.tipo === 'max').map(x => x.km);
  const mins = limites.filter(x => x.tipo === 'min').map(x => x.km);
  const max = maxs.length ? Math.min(...maxs) : null;
  const min = mins.length ? Math.max(...mins) : null;
  const n = kmInteiro(atual);
  const conflitante = min !== null && max !== null && min > max;
  const sugestao = conflitante || !limites.length ? null : n === null ? (max ?? min) : Math.min(max ?? Infinity, Math.max(min ?? 0, n));
  return { limites, min, max, sugestao, conflitante, mensagem: raw };
}
