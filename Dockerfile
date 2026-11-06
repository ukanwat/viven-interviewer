# Runs anywhere that runs a container. Needs OPENAI_API_KEY, OPENROUTER_API_KEY; optional DATABASE_URL, PASSCODE.
FROM node:25-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
COPY public ./public
ENV HOST=0.0.0.0 PORT=8000
EXPOSE 8000
CMD ["node", "src/server.ts"]
