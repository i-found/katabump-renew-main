FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

# Copy package files and install dependencies (use npm install since no lockfile)
COPY package.json ./
RUN npm install --omit=dev

# Copy application code
COPY . .

# Railway injects PORT env var
EXPOSE 3000

CMD ["node", "index.js"]
