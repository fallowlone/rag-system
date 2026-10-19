# ---- Stage 1: Build ----
FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: Run ----
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# py3-reportlab pulls python3 in as a dependency — PdfService (src/pdf/pdf.service.ts)
# spawns `python3` and imports reportlab to generate official-letter PDFs; without
# this the feature silently degrades (isAvailable() returns false, no error surfaced).
# ttf-dejavu: Helvetica has no Cyrillic glyphs (letters render as WinAnsi digit
# soup) — the PDF script picks DejaVuSans for Cyrillic paragraphs.
RUN apk add --no-cache openssl wget py3-reportlab ttf-dejavu

COPY package*.json ./
RUN npm ci --omit=dev && \
    npm cache clean --force && \
    find /app/node_modules -name "*.d.ts" -delete && \
    find /app/node_modules -name "*.map" -delete

COPY --from=builder /app/node_modules/.prisma            ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma           ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma             ./node_modules/prisma
COPY --from=builder /app/node_modules/.bin/prisma        ./node_modules/.bin/prisma

COPY --from=builder /app/dist ./dist
COPY prisma ./prisma

RUN chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
    CMD wget -qO- "http://localhost:${PORT:-3000}/health/ready" || exit 1

CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/main"]
