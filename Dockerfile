FROM node:20-alpine
WORKDIR /app
COPY package.json server.js README.md ./
ENV PORT=5455
EXPOSE 5455
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5455/health || exit 1
CMD ["node", "server.js"]
