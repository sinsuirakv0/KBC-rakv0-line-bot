FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/.npmrc ./.npmrc
COPY data ./data

RUN mkdir -p /app/storage /app/logs

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
	CMD node -e "const fs=require('fs'); const cmd=fs.readFileSync('/proc/1/cmdline','utf8'); process.exit(cmd.includes('dist/main.js') ? 0 : 1)"

CMD ["node", "dist/main.js"]
