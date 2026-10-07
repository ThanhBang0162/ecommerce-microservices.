FROM node:24-bookworm-slim

ARG APP_PATH
ENV NODE_ENV=production

WORKDIR /app/${APP_PATH}

COPY ${APP_PATH}/package*.json ./
RUN npm ci --omit=dev

COPY ${APP_PATH}/ ./
COPY proto/ /app/proto/

CMD ["node", "src/app.js"]