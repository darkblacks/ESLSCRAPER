#!/usr/bin/env bash
# Atualiza o backend a partir do GitHub (branch main), com testes, backup e volta automática à versão anterior.
#
#   sudo /opt/esl-scraper-git/ops/deploy.sh            # atualiza se houver commit novo no GitHub
#   sudo /opt/esl-scraper-git/ops/deploy.sh --check    # só mostra se há atualização
#   sudo /opt/esl-scraper-git/ops/deploy.sh --rebuild  # reconstrói/testa/reinicia mesmo sem commit novo
#   sudo ALVO=<commit> ops/deploy.sh                   # vai para um commit específico (precisa ser continuação do atual)
#
# Preserva: .env, backend-data/ (histórico/configurações) e certificados (volume caddy-data).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
BRANCH=main
IMG=esl-scraper-backend
MODO="${1:-}"
log() { printf '\n\033[1m[deploy %s] %s\033[0m\n' "$(date +%H:%M:%S)" "$*"; }
falha() { printf '\n\033[31m[deploy] ERRO: %s\033[0m\n' "$*" >&2; exit 1; }

exec 9>/var/lock/esl-scraper-deploy.lock
flock -n 9 || falha "já existe um deploy em andamento."

# 1-2) situação do repositório
log "Validando o repositório"
[ -f .env ] || falha ".env não encontrado em $REPO"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || falha "repositório não está na branch $BRANCH"
git diff --quiet && git diff --cached --quiet || falha "há alterações locais não commitadas (git status). Commit/push ou descarte antes."
git fetch --quiet origin "$BRANCH"
ATUAL=$(git rev-parse HEAD); NOVO=$(git rev-parse "${ALVO:-origin/$BRANCH}^{commit}")
if [ "$ATUAL" = "$NOVO" ] && [ "$MODO" != "--rebuild" ]; then echo "Já está na versão mais recente ($(git rev-parse --short HEAD))."; exit 0; fi
git merge-base --is-ancestor "$ATUAL" "$NOVO" || falha "o GitHub não é continuação da versão local (histórico divergente). Nada foi alterado."
if [ "$MODO" = "--check" ]; then echo "Atualização disponível: $(git rev-parse --short "$ATUAL") → $(git rev-parse --short "$NOVO")"; git log --oneline "$ATUAL..$NOVO"; exit 0; fi

# reiniciar o backend encerra as sessões ESL e interrompe lotes em andamento
LOTES=$(docker compose exec -T backend node -e "fetch('http://127.0.0.1:3333/internal/lotes').then(r=>r.json()).then(j=>console.log(j.lotes||0)).catch(()=>console.log(0))" 2>/dev/null || echo 0)
if [ "${LOTES:-0}" != "0" ] && [ "${FORCAR:-0}" != "1" ]; then
  falha "há $LOTES lote(s) em andamento — reiniciar agora interromperia o lote. Espere terminar ou use FORCAR=1."
fi

# 3) backup
log "Backup dos dados"
"$REPO/ops/backup.sh" "pre-deploy-$(git rev-parse --short "$ATUAL")"
docker image inspect "$IMG:latest" >/dev/null 2>&1 && docker tag "$IMG:latest" "$IMG:previous"

REINICIADO=0
voltar() {
  log "FALHOU — voltando para $(git rev-parse --short "$ATUAL")"
  git reset --quiet --hard "$ATUAL"
  if docker image inspect "$IMG:previous" >/dev/null 2>&1; then docker tag "$IMG:previous" "$IMG:latest"; fi
  if [ "$REINICIADO" = 1 ]; then   # só mexe nos containers se a versão nova chegou a subir
    GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --no-build --force-recreate backend
    docker compose up -d --force-recreate caddy
    esperar_saude || echo "ATENÇÃO: a versão anterior também não respondeu. Veja: docker compose logs --tail 200 backend"
  else
    echo "O backend em execução não foi tocado (continua na versão $(git rev-parse --short HEAD))."
  fi
  falha "atualização desfeita: $1"
}
esperar_saude() {
  local dom; dom=$(grep -E '^DOMINIO=' .env | cut -d= -f2-)
  for _ in $(seq 1 60); do
    if [ "$(docker inspect -f '{{.State.Health.Status}}' esl-scraper-backend-1 2>/dev/null)" = healthy ] \
       && curl -fsS -m 10 "https://$dom/api/health" >/dev/null 2>&1; then
      echo "health OK: https://$dom/api/health → $(curl -fsS -m 10 "https://$dom/api/health")"; return 0
    fi
    sleep 3
  done
  return 1
}

# 4) código
log "Atualizando código $(git rev-parse --short "$ATUAL") → $(git rev-parse --short "$NOVO")"
git merge --quiet --ff-only "$NOVO"
export GIT_COMMIT; GIT_COMMIT=$(git rev-parse --short HEAD)

# 5) dependências + 7) build (npm ci dentro da imagem, a partir do package-lock.json)
log "Construindo a imagem (instala dependências)"
docker compose build backend || voltar "build da imagem"

# 6) testes — na imagem nova, SEM os dados reais e SEM acesso ao .env (modo simulação)
log "Testes automatizados"
docker run --rm --init "$IMG:latest" npm test || voltar "testes automatizados"
log "Smoke test do Chromium headless"
docker run --rm --init --shm-size=1g "$IMG:latest" npm run -s test:browser || voltar "Chromium/Playwright"
log "Validando o Caddyfile"
docker run --rm -v "$REPO/Caddyfile:/etc/caddy/Caddyfile:ro" -e DOMINIO=exemplo.invalid caddy:2 caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || voltar "Caddyfile inválido"

# 8) reinício
log "Reiniciando o backend"
REINICIADO=1
docker compose up -d --remove-orphans backend caddy || voltar "docker compose up"
# Caddyfile é montado como arquivo: o git cria um arquivo novo, então o Caddy precisa ser recriado para enxergar
if ! git diff --quiet "$ATUAL" HEAD -- Caddyfile docker-compose.yml; then
  log "Caddyfile/compose mudou — recriando o Caddy"
  docker compose up -d --force-recreate caddy || voltar "recriar Caddy"
fi

# 9) health check (10: volta sozinho se falhar)
log "Health check"
esperar_saude || voltar "health check não respondeu em 3 min"
docker image prune -f >/dev/null 2>&1 || true
log "Deploy concluído: versão $GIT_COMMIT"
