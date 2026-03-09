## API Discovery

### Target
- URL: `https://www.seloger.com/classified-search?distributionTypes=Rent&estateTypes=Apartment&locations=AD02FR1`
- Date tested: 2026-03-09

### Discovery Summary
1. Direct HTTP fetch to SeLoger search URL returned DataDome challenge (JS/captcha interstitial), not listing JSON.
2. URLScan public scans for `seloger.com` mostly showed challenge flow for current scans, with no stable public JSON endpoint that could be called directly without protection/session context.
3. Browser execution revealed a rich structured payload in:
   - `window.__UFRN_FETCHER__.data["classified-serp-init-data"]`
4. This payload is compressed and can be decoded using `LZString.decompressFromBase64(...)` into JSON containing:
   - `pageProps.classifieds` (listing IDs)
   - `pageProps.classifiedsData` (full listing objects)
   - `pageProps.page`
   - `pageProps.totalCount`
   - search model fields and metadata

### Selected Data Source
- Endpoint/Source: `window.__UFRN_FETCHER__.data["classified-serp-init-data"]` (executed in browser context)
- Method: Browser page load + payload decode
- Auth: No explicit auth token, but requires browser/session context due anti-bot layer
- Pagination: URL parameter `page=<n>`
- Field coverage: High (pricing, hard facts, media, provider data, location, tags)

### API Scoring (Adapted)
- Returns structured JSON after decode: +30
- More than 15 unique fields: +25
- No static token management required: +10
- Pagination support: +15
- Extends legacy field coverage: +10
- **Total: 90/100**

### Decision
Use Playwright-based extraction with decoded structured payload. This provides stable, rich data and avoids brittle HTML selectors under anti-bot protection.
