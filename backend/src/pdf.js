// Junta vários PDFs num só, sem biblioteca externa.
// Feito para os PDFs que o próprio Chromium gera (page.pdf → Skia/PDF): tabela xref clássica, sem object streams.
// Renumera os objetos de cada arquivo, junta as páginas numa árvore nova e reescreve a xref.
// PDF com xref compactada (/XRef, /ObjStm) é recusado com erro claro — não tenta adivinhar.

const enc = (s) => Buffer.from(s, 'latin1');

/** Lê os objetos "n 0 obj … endobj" de um PDF (respeitando o /Length dos streams). */
function lerObjetos(buf) {
  const s = buf.toString('latin1');
  if (/\/Type\s*\/ObjStm|\/Type\s*\/XRef\b/.test(s)) throw new Error('PDF com xref compactada não é suportado pelo juntador.');
  const objs = new Map(); // num -> { dict, stream (Buffer|null), resto }
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = Number(m[1]);
    let i = re.lastIndex;
    const ini = i;
    // corpo até "stream" ou "endobj" (o que vier primeiro fora de string)
    const posStream = s.indexOf('stream', i);
    const posEnd = s.indexOf('endobj', i);
    if (posEnd < 0) throw new Error(`PDF inválido: objeto ${num} sem endobj.`);
    if (posStream >= 0 && posStream < posEnd && !/end$/.test(s.slice(posStream - 3, posStream))) {
      const cabeca = s.slice(ini, posStream);
      const len = cabeca.match(/\/Length\s+(\d+)(\s+\d+\s+R)?/);
      if (!len || len[2]) throw new Error(`PDF com /Length indireto no objeto ${num} não é suportado.`);
      let dados = posStream + 'stream'.length;
      if (s[dados] === '\r') dados++;
      if (s[dados] === '\n') dados++;
      const tam = Number(len[1]);
      const fimDados = dados + tam;
      const fimObj = s.indexOf('endobj', fimDados);
      objs.set(num, { cabeca, stream: buf.subarray(dados, fimDados) });
      re.lastIndex = fimObj + 6;
    } else {
      objs.set(num, { cabeca: s.slice(ini, posEnd), stream: null });
      re.lastIndex = posEnd + 6;
    }
  }
  const trailer = s.slice(s.lastIndexOf('trailer'));
  const root = Number((trailer.match(/\/Root\s+(\d+)\s+0\s+R/) || [])[1]);
  if (!root || !objs.has(root)) throw new Error('PDF inválido: catálogo não encontrado.');
  return { objs, root };
}

const refs = (txt) => [...txt.matchAll(/(\d+)\s+0\s+R/g)].map((x) => Number(x[1]));
const chave = (dict, nome) => {
  const m = dict.match(new RegExp(`/${nome}\\s*(\\[[^\\]]*\\]|<<(?:[^<>]|<<[^<>]*>>)*>>|\\d+\\s+0\\s+R|/?[\\w.+-]+)`));
  return m ? m[1] : null;
};

/** Páginas em ordem (percorre a árvore /Pages), com os atributos herdáveis copiados quando a página não tem. */
function paginas(doc) {
  const out = [];
  const pagesRoot = refs(chave(doc.objs.get(doc.root).cabeca, 'Pages') || '')[0];
  const HERDA = ['MediaBox', 'Resources', 'CropBox', 'Rotate'];
  const visitar = (num, herdado) => {
    const o = doc.objs.get(num);
    if (!o) return;
    if (/\/Type\s*\/Pages\b/.test(o.cabeca)) {
      const h = { ...herdado };
      for (const k of HERDA) { const v = chave(o.cabeca, k); if (v) h[k] = v; }
      for (const kid of refs(chave(o.cabeca, 'Kids') || '')) visitar(kid, h);
    } else if (/\/Type\s*\/Page\b/.test(o.cabeca)) {
      out.push({ num, herdado });
    }
  };
  visitar(pagesRoot, {});
  return out;
}

/**
 * Junta os PDFs (Buffers) na ordem dada. Devolve um Buffer com um PDF só.
 */
export function mesclarPdfs(buffers) {
  if (!buffers.length) throw new Error('Nenhum PDF para juntar.');
  const partes = [enc('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  let pos = partes[0].length;
  const offsets = []; // índice = número novo
  let proximo = 1;
  const kids = [];
  const docs = buffers.map((b) => lerObjetos(b));
  // reserva números: cada doc ganha um deslocamento
  const desloc = [];
  for (const d of docs) {
    desloc.push(proximo - 1);
    proximo += Math.max(...d.objs.keys());
  }
  const raizPages = proximo++;
  const catalogo = proximo++;
  const escrever = (num, corpo, stream) => {
    offsets[num] = pos;
    const ini = enc(`${num} 0 obj\n`);
    const chunks = [ini, enc(corpo)];
    if (stream) chunks.push(enc('stream\n'), stream, enc('\nendstream\n'));
    chunks.push(enc('endobj\n'));
    for (const c of chunks) { partes.push(c); pos += c.length; }
  };
  docs.forEach((d, k) => {
    const off = desloc[k];
    const renum = (txt) => txt.replace(/(\d+)(\s+)0(\s+)R/g, (_, n, a, b) => `${Number(n) + off}${a}0${b}R`);
    const pags = paginas(d);
    const ehPagina = new Map(pags.map((p) => [p.num, p.herdado]));
    const pagesNodes = new Set([...d.objs].filter(([, o]) => /\/Type\s*\/Pages\b/.test(o.cabeca)).map(([n]) => n));
    for (const [num, o] of d.objs) {
      if (num === d.root || pagesNodes.has(num)) continue; // catálogo e árvore antiga saem; a nova aponta para as páginas
      let corpo = renum(o.cabeca);
      if (ehPagina.has(num)) {
        corpo = corpo.replace(/\/Parent\s+\d+\s+0\s+R/, `/Parent ${raizPages} 0 R`);
        const herdado = ehPagina.get(num);
        for (const [k2, v] of Object.entries(herdado)) {
          if (!new RegExp(`/${k2}\\b`).test(corpo)) corpo = corpo.replace(/<</, `<</${k2} ${renum(v)} `);
        }
      }
      escrever(num + off, corpo, o.stream);
    }
    for (const p of pags) kids.push(p.num + off);
  });
  escrever(raizPages, `<</Type /Pages /Count ${kids.length} /Kids [${kids.map((n) => `${n} 0 R`).join(' ')}]>>\n`);
  escrever(catalogo, `<</Type /Catalog /Pages ${raizPages} 0 R>>\n`);
  const tamanho = proximo;
  const xrefPos = pos;
  let xref = `xref\n0 ${tamanho}\n0000000000 65535 f \n`;
  for (let n = 1; n < tamanho; n++) {
    xref += offsets[n] != null ? `${String(offsets[n]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n';
  }
  xref += `trailer\n<</Size ${tamanho} /Root ${catalogo} 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`;
  partes.push(enc(xref));
  return Buffer.concat(partes);
}

/** Quantas páginas um PDF tem (para conferência/testes). */
export function contarPaginas(buf) {
  return paginas(lerObjetos(buf)).length;
}
