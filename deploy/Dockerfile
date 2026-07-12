# Образ для Telegram-бота (мост в Claude Agent).
# Сборка из корня проекта:
#   docker build -f deploy/Dockerfile -t wb-telegram-bot .
#   docker run --rm --env-file .env wb-telegram-bot
FROM node:20-slim

# git нужен для команд /diff /commit /push
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Сначала зависимости (кэш слоёв)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Затем код
COPY . .

# .env можно прокинуть через --env-file или -e; бот также читает ./.env
ENV NODE_ENV=production
CMD ["node", "telegram-bot.js"]
