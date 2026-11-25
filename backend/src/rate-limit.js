// Limitação de requisições em memória, por IP (sem dependências). Janela fixa por IP.
export function rateLimit({ janelaMs, max, msg = 'Muitas requisições. Aguarde um pouco e tente de novo.', pular = () => false }) {
  const hits = new Map(); // ip -> { n, reinicia }
  setInterval(() => {
    const agora = Date.now();
    for (const [ip, h] of hits) if (h.reinicia <= agora) hits.delete(ip);
  }, Math.max(janelaMs, 60_000)).unref();
  return (req, res, next) => {
    if (req.method === 'OPTIONS' || pular(req)) return next();
    const agora = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.reinicia <= agora) hits.set(req.ip, (h = { n: 0, reinicia: agora + janelaMs }));
    h.n++;
    if (h.n > max) {
      res.set('Retry-After', String(Math.ceil((h.reinicia - agora) / 1000)));
      return res.status(429).json({ error: msg, code: 'rate_limit' });
    }
    next();
  };
}
