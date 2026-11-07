# Long-running worker: schedules the daily run with RUN_CRON in TZ.
# Configuration comes from the container environment (no .env.local inside the image).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
# One-off commands: `node dist/main.js --once` or `node dist/seed/remoteintech.js`.
CMD ["node", "dist/main.js"]
