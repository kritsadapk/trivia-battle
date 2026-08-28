FROM oven/bun:1.3-slim

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY . .

# คลังคำถาม (SQLite) — บน Railway ให้ mount volume ที่ /data แล้วตั้ง DB_PATH=/data/trivia.db
ENV DB_PATH=/data/trivia.db

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
