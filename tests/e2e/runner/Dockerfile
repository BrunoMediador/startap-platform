FROM mcr.microsoft.com/playwright:v1.55.1-noble

WORKDIR /e2e
COPY runner/package.json runner/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY playwright.config.ts ./playwright.config.ts
COPY known-broken.config.ts ./known-broken.config.ts
COPY known-broken.json ./known-broken.json
COPY specs ./specs
COPY known-broken ./known-broken
COPY scripts/known-broken-contract.mjs ./scripts/known-broken-contract.mjs
COPY scripts/run-known-broken.mjs ./scripts/run-known-broken.mjs

RUN mkdir -p /artifacts && chown -R pwuser:pwuser /e2e /artifacts
USER pwuser
CMD ["npx", "playwright", "test", "--config", "playwright.config.ts"]
