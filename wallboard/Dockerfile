FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci 2>/dev/null || npm install

FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache openssl
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
RUN mkdir -p .next/cache && chown -R nextjs:nodejs .next/cache
RUN chown -R nextjs:nodejs node_modules/.prisma
USER nextjs
EXPOSE 3000 3100
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["sh", "-c", "ENCODED_PW=$(echo -n \"$POSTGRES_PASSWORD\" | sed 's/#/%23/g; s/@/%40/g; s/:/%3A/g') && export DATABASE_URL=\"postgresql://${POSTGRES_USER}:${ENCODED_PW}@${POSTGRES_HOST:-db}:5432/${POSTGRES_DB}\" && node node_modules/prisma/build/index.js db push --accept-data-loss && node server.js"]
