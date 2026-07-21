FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY . .

# Railway injects PORT env var
EXPOSE 3000

CMD ["node", "index.js"]
