# Built from the root of the repository:
#   docker build -f packages/mailbox-service/Dockerfile .
FROM node:26-slim
RUN npm install --global pnpm@9.15.9 && mkdir /data && chown node:node /data
WORKDIR /suite
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter @estoc/mailbox-service...
USER node
ENV MAILBOX_HOST=0.0.0.0 \
    MAILBOX_PORT=8080 \
    MAILBOX_PRIVATE_STORE=/data/private.db \
    MAILBOX_DATABASE=/data/service.db
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["node", "packages/mailbox-service/src/main.ts"]
