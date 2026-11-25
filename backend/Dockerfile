# Backend do ESL Scraper — imagem oficial do Playwright (Chromium + bibliotecas do Linux já instalados).
# A versão da imagem precisa ser a mesma do playwright no package-lock.json (hoje 1.65.1).
FROM mcr.microsoft.com/playwright:v1.65.1-noble

ENV NODE_ENV=production \
    TZ=America/Sao_Paulo \
    PORT=3333 \
    HEADLESS=true
WORKDIR /app/backend
COPY package.json package-lock.json ./
# o Chromium já vem na imagem: pula o "playwright install" do postinstall
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
# histórico, de-para de peças e config do /admin ficam aqui (volume no docker-compose)
VOLUME /app/backend/data
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://localhost:3333/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
