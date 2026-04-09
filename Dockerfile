FROM node:20-slim

USER node
WORKDIR /home/user/app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=7860
ENV DATA_DIR=/home/user/app/data
ENV CHUNK_DIR=/home/user/app/secure_asset_chunks

EXPOSE 7860

CMD ["npm", "start"]
