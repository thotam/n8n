FROM node:20-alpine

WORKDIR /app

# Cài dependencies trước (tận dụng Docker layer cache)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY server.js ./

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3456/health || exit 1

CMD ["node", "server.js"]
