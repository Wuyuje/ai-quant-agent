FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY index.html style.css i18n.js i18n-runtime.js app.js accounts.js phase3.js server.mjs ./
COPY images ./images
RUN mkdir -p /app/state
ENV PORT=18080
EXPOSE 18080
CMD ["node", "server.mjs"]
