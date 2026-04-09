FROM node:20-slim

USER node
WORKDIR /home/node/app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5000
ENV DATA_DIR=/home/node/app/data
ENV CHUNK_DIR=/home/node/app/secure_asset_chunks

EXPOSE 5000

CMD ["npm", "start"]
