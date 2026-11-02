FROM node:24-alpine

WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
RUN mkdir -p /app/server/data && chown node:node /app/server/data
USER node
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server/server.js"]
