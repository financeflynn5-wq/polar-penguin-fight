# Polar Penguin Fight: the game page and its online match server on one port ($PORT, default 8080).
# Works on any host that runs containers (Flynn's Hetzner box, Fly.io, Railway...).
#   docker build -t polar-penguin-fight .
#   docker run -d --restart unless-stopped -p 8080:8080 --name penguin polar-penguin-fight
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 MAX_PLAYERS=40
# the server is bundled into one file (ws included), so no node_modules are needed
COPY --from=build /app/dist ./dist
COPY --from=build /app/server-dist/main.mjs ./server-dist/main.mjs
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server-dist/main.mjs"]
