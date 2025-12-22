FROM node:20-slim

# Instalar dependencias para Playwright
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    libxss1 \
    libxtst6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar package.json primero para aprovechar cache
COPY package*.json ./

# Instalar dependencias
RUN npm install

# Instalar Playwright browsers
RUN npx playwright install chromium
RUN npx playwright install-deps chromium

# Copiar el resto del código
COPY . .

# Exponer puerto
EXPOSE 3000

# Iniciar servidor
CMD ["npm", "start"]
