FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
EXPOSE 3030
CMD ["node", "server.js"]
