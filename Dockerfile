FROM node:20-slim

# better-sqlite3 a besoin des outils de compilation natifs
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

# Données persistées (base SQLite) hors de l'image
ENV DATA_DIR=/data
VOLUME ["/data"]

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

CMD ["node", "src/server.js"]
