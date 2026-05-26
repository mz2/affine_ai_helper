FROM node:20-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm i --omit=dev

COPY server.js .

ENV PORT=4011

CMD ["node","server.js"]