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
// O ESL pode renderizar o mesmo erro no resumo, no campo ou em várias linhas.
export function mensagensHodometro(texto) {
  const s = String(texto || '').replace(/[\u00a0\u202f]/g, ' ').replace(/[‐‑–—]/g, '-');
  const field = /n[aã]o\s+pode\s+ser\s+(?:maior|menor)\s+(?:do\s+)?que\s+[^()\n|]*(?:abastecimento|manifesto|hod[oô]metro)[^()]*\(\s*(?:hod[oô]metro|km|quilometragem)[^()]*\)/gi;
  const normalizado = s.replace(field, (m, offset) => /hod[oô]metro(?:\s+atual)?\s*$/i.test(s.slice(Math.max(0,offset-50),offset)) ? m : 'Hodômetro Atual ' + m);
  const matches = [...normalizado.matchAll(/hod[oô]metro(?:\s+atual)?\s+n[aã]o\s+pode\s+ser\s+(?:maior|menor)\s+(?:do\s+)?que\b[\s\S]*?(?=hod[oô]metro(?:\s+atual)?\s+n[aã]o\s+pode\s+ser|$)/gi)];
  return [...new Set(matches.map(m => {
    const str = m[0];
    // Limita a captura ao texto do erro, antes do restante do formulário.
    const end = str.search(/\(\s*(?:hod[oô]metro|km|quilometragem)[^()]*\)/i);
    if (end >= 0) return str.slice(0, str.indexOf(')',end)+1).replace(/\s+/g,' ').trim();
    return str.split(/\n|\|/)[0].trim().slice(0,400);
  }).filter(Boolean))];
}
export function restricaoHodometro(texto, atual = null) {
  const raw = String(texto || '');
  const msgs = mensagensHodometro(raw);
  const limites = [];
  for (const msg of msgs) {
    const d = msg.match(/\b(maior|menor)\s+(?:do\s+)?que\s+(.+?)\s*\(\s*(?:hod[oô]metro|km|quilometragem)[^():\d]*[:=]?\s*([\d][\d.,]*)(?:\s*km)?\s*\)/i);
    if (!d) continue;
    const km = kmInteiro(d[3]);
    if (km !== null) limites.push({ tipo: d[1].toLowerCase() === 'maior' ? 'max' : 'min', km, origem: d[2].trim() });
  }
  if (!limites.length && !msgs.length && !/hod[oô]metro|quilometragem/i.test(raw)) return null;
  const unicos = [...new Map(limites.map(x => [x.tipo+'|'+x.km+'|'+x.origem,x])).values()];
  const maxs = unicos.filter(x => x.tipo === 'max').map(x => x.km);
  const mins = unicos.filter(x => x.tipo === 'min').map(x => x.km);
  const max = maxs.length ? Math.min(...maxs) : null;
  const min = mins.length ? Math.max(...mins) : null;
  const n = kmInteiro(atual);
  const conflitante = min !== null && max !== null && min > max;
  const sugestao = conflitante || !unicos.length ? null : n === null ? (max ?? min) : Math.min(max ?? Infinity, Math.max(min ?? 0, n));
  return { limites: unicos, min, max, sugestao, conflitante, mensagem: msgs.length ? msgs.join('\n') : raw.slice(0,1500) };
}
// Reinterpreta erros antigos que foram armazenados sem limites numéricos.
export function recuperarRestricao(reg) {
  const saved = reg?.hodometroCorrecao;
  if (saved?.limites?.length) return saved;
  const r = restricaoHodometro([saved?.mensagem, reg?.erro].filter(Boolean).join('\n'));
  return r ? { ...saved, ...r } : saved || null;
}

// Conserve limites da mesma tentativa lógica (mesma placa, data e hora).
export function acumularRestricoes(anterior, nova) {
  if (!nova) return anterior || null;
  const placa = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
  // Sem identidade conhecida não combine dados potencialmente de outro veículo/data.
  if (!anterior || !anterior.placa || !nova.placa || placa(anterior.placa) !== placa(nova.placa) ||
      !anterior.data || anterior.data !== nova.data || !anterior.hora || anterior.hora !== nova.hora) return nova;
  const limites = [...new Map([...(anterior.limites || []), ...(nova.limites || [])].map(x => [x.tipo+'|'+x.km+'|'+x.origem, x])).values()];
  const maxs = limites.filter(x=>x.tipo==='max').map(x=>x.km);
  const mins = limites.filter(x=>x.tipo==='min').map(x=>x.km);
  const max = maxs.length ? Math.min(...maxs) : null;
  const min = mins.length ? Math.max(...mins) : null;
  const conflitante = min !== null && max !== null && min > max;
  const n = kmInteiro(nova.sugestao ?? anterior.sugestao);
  const sugestao = conflitante || !limites.length ? null : n === null ? (max ?? min) : Math.min(max ?? Infinity, Math.max(min ?? 0, n));
  return { ...nova, limites, max, min, conflitante, sugestao, mensagem: [...new Set([anterior.mensagem,nova.mensagem].filter(Boolean))].join('\n') };
}
