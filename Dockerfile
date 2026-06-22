FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --production

# Install Playwright browsers (Chromium only to keep image small)
RUN npx playwright install chromium

COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
