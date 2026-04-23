import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { chromium } from 'playwright';

const DEFAULT_START_URL =
    'https://www.seloger.com/classified-search?distributionTypes=Rent&estateTypes=Apartment&locations=AD02FR1';

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
];

const NAVIGATION_TIMEOUT_MS = 25_000;
const HOME_WARMUP_TIMEOUT_MS = 18_000;
const WARMUP_ATTEMPTS = 3;
const SEARCH_API_RETRIES = 3;
const DETAILS_API_RETRIES = 3;

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    startUrl,
    start_url,
    results_wanted: resultsWantedRaw = 20,
    max_pages: maxPagesRaw = 10,
    proxyConfiguration: proxyConfig,
} = input;

const initialUrl = startUrl || start_url || DEFAULT_START_URL;
const resultsWanted = toPositiveInteger(resultsWantedRaw, 20);
const maxPages = toPositiveInteger(maxPagesRaw, 10);
const pageSize = 30;
const seenIds = new Set();

let totalSaved = 0;
let runError;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function safeGoto(page, url, { timeoutMs, waitUntil = 'domcontentloaded', label = 'Navigation', retries = 1 } = {}) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            await page.goto(url, { waitUntil, timeout: timeoutMs });
            return { ok: true };
        } catch (error) {
            lastError = error;
            log.warning(`${label} failed (attempt ${attempt}/${retries}): ${error.message}`);

            if (attempt < retries) {
                await sleep(900 * attempt);
            }
        }
    }

    return { ok: false, error: lastError };
}

function toPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toAbsoluteUrl(url) {
    if (!url || typeof url !== 'string') return undefined;
    try {
        return new URL(url, 'https://www.seloger.com').href;
    } catch {
        return undefined;
    }
}

function cleanData(value) {
    if (value === null || value === undefined || value === '') return undefined;

    if (Array.isArray(value)) {
        const cleanedArray = value.map((entry) => cleanData(entry)).filter((entry) => entry !== undefined);
        return cleanedArray.length > 0 ? cleanedArray : undefined;
    }

    if (typeof value === 'object') {
        const cleanedEntries = Object.entries(value)
            .map(([key, val]) => [key, cleanData(val)])
            .filter(([, val]) => val !== undefined);
        return cleanedEntries.length > 0 ? Object.fromEntries(cleanedEntries) : undefined;
    }

    return value;
}

function mapListing(listing, { pageNumber, totalCount, searchUrl }) {
    const imageUrls = (listing?.gallery?.images || []).map((image) => image?.url).filter(Boolean);
    const hardFacts = listing?.hardFacts || {};

    return {
        id: listing?.id,
        url: toAbsoluteUrl(listing?.url),
        brand: listing?.brand,
        listing_type: listing?.display,
        seller_type: listing?.type,
        property_type: listing?.rawData?.propertyType,
        property_type_label: listing?.rawData?.propertyTypeLabel,
        distribution_type: listing?.rawData?.distributionType,
        title: hardFacts?.title,
        main_description_headline: listing?.mainDescription?.headline,
        description: listing?.mainDescription?.description,
        price: listing?.rawData?.price,
        price_formatted: hardFacts?.price?.formatted,
        price_additional_information: hardFacts?.price?.additionalInformation,
        rooms: listing?.rawData?.nbroom,
        living_area_m2: listing?.rawData?.surface?.main,
        land_area_m2: listing?.rawData?.surface?.plot,
        energy_class: listing?.energyClass,
        keyfacts: hardFacts?.keyfacts,
        facts: hardFacts?.facts,
        is_new: listing?.tags?.isNew,
        has_3d_visit: listing?.tags?.has3DVisit,
        is_exclusive: listing?.tags?.isExclusive,
        has_brokerage_fee: listing?.tags?.hasBrokerageFee,
        country: listing?.location?.address?.country,
        city: listing?.location?.address?.city,
        zip_code: listing?.location?.address?.zipCode,
        district: listing?.location?.address?.district,
        is_address_published: listing?.location?.isAddressPublished,
        agency_name: listing?.provider?.intermediaryCard?.title,
        agency_type: listing?.provider?.intermediaryCard?.subtitle,
        agency_profile_url: toAbsoluteUrl(listing?.provider?.intermediaryCard?.logoHref),
        agency_address: listing?.provider?.address,
        phone_numbers: listing?.provider?.phoneNumbers,
        image_count: imageUrls.length,
        image_urls: imageUrls,
        page: pageNumber,
        total_results: totalCount,
        search_url: searchUrl,
        scraped_at: new Date().toISOString(),
    };
}

function parseSearchCriteria(url) {
    const parsed = new URL(url);
    const getAll = (key) => parsed.searchParams.getAll(key).filter(Boolean);

    const path = parsed.pathname.toLowerCase();
    const pathSegments = path.split('/').filter(Boolean);
    const distributionFromPath = pathSegments.includes('location')
        ? 'Rent'
        : pathSegments.includes('achat')
          ? 'Buy'
          : undefined;

    const estateTypeMap = new Map([
        ['appartement', 'Apartment'],
        ['maison', 'House'],
        ['terrain', 'Plot'],
        ['parking', 'Parking'],
        ['bureau', 'Office'],
        ['bureaux', 'Office'],
        ['commerce', 'Trading'],
        ['commerces', 'Trading'],
    ]);
    const estateFromPath = pathSegments.find((segment) => estateTypeMap.has(segment));
    const placeIdFromPath =
        parsed.pathname.match(/\/(ad\d+fr\d+)(?:[/?#]|$)/i)?.[1]?.toUpperCase() ??
        pathSegments.find((segment) => /^ad\d+fr\d+$/i.test(segment))?.toUpperCase();

    const criteria = {
        distributionTypes: getAll('distributionTypes'),
        estateTypes: getAll('estateTypes'),
        location: {
            placeIds: getAll('locations').map((id) => id.toUpperCase()),
        },
        projectTypes: getAll('projectTypes'),
    };

    if (criteria.distributionTypes.length === 0 && distributionFromPath) {
        criteria.distributionTypes = [distributionFromPath];
    }
    if (criteria.estateTypes.length === 0 && estateFromPath) {
        criteria.estateTypes = [estateTypeMap.get(estateFromPath)];
    }
    if (criteria.location.placeIds.length === 0 && placeIdFromPath) {
        criteria.location.placeIds = [placeIdFromPath];
    }

    if (criteria.distributionTypes.length === 0) criteria.distributionTypes = ['Rent'];
    if (criteria.estateTypes.length === 0) criteria.estateTypes = ['Apartment'];
    if (criteria.location.placeIds.length === 0) {
        throw new Error('Could not detect SeLoger place ID from URL. Use a SeLoger search URL containing an AD*FR* token.');
    }
    if (criteria.projectTypes.length === 0 && criteria.distributionTypes.includes('Rent')) {
        criteria.projectTypes = ['Flatsharing', 'Stock'];
    }

    return criteria;
}

function parseProxyForPlaywright(proxyUrl) {
    if (!proxyUrl) return undefined;
    const parsed = new URL(proxyUrl);
    return {
        server: `${parsed.protocol}//${parsed.host}`,
        username: decodeURIComponent(parsed.username || ''),
        password: decodeURIComponent(parsed.password || ''),
    };
}

function normalizeProxyConfiguration(config) {
    if (!config || typeof config !== 'object') return config;

    const normalized = { ...config };

    if (!normalized.groups && Array.isArray(normalized.apifyProxyGroups)) {
        normalized.groups = normalized.apifyProxyGroups;
    }
    if (!normalized.countryCode && typeof normalized.apifyProxyCountry === 'string') {
        normalized.countryCode = normalized.apifyProxyCountry;
    }

    return normalized;
}

async function buildProxyCandidates() {
    const candidates = [];

    if (proxyConfig) {
        try {
            const proxyConfiguration = await Actor.createProxyConfiguration(normalizeProxyConfiguration(proxyConfig));
            if (proxyConfiguration && typeof proxyConfiguration.newUrl === 'function') {
                let addedProxy = false;
                for (let attempt = 1; attempt <= 3; attempt += 1) {
                    try {
                        const sessionId = `seloger_${Date.now()}_${attempt}_${Math.random().toString(36).slice(2, 8)}`;
                        const proxyUrl = await proxyConfiguration.newUrl(sessionId);
                        const proxy = parseProxyForPlaywright(proxyUrl);
                        if (proxy) {
                            candidates.push({ label: `input-proxy-${attempt}`, proxy });
                            addedProxy = true;
                        }
                    } catch (error) {
                        log.warning(`Could not create proxy URL for attempt ${attempt}: ${error.message}`);
                    }
                }

                if (!addedProxy) {
                    candidates.push({ label: 'input-no-proxy', proxy: undefined });
                }
            } else {
                candidates.push({ label: 'input-no-proxy', proxy: undefined });
            }
        } catch (error) {
            log.warning(`Could not initialize input proxy configuration: ${error.message}`);
            candidates.push({ label: 'input-no-proxy', proxy: undefined });
        }
    } else {
        candidates.push({ label: 'direct-no-proxy', proxy: undefined });
        if (Actor.isAtHome()) {
            try {
                const fallbackProxyConfiguration = await Actor.createProxyConfiguration({
                    useApifyProxy: true,
                    groups: ['RESIDENTIAL'],
                });
                if (fallbackProxyConfiguration && typeof fallbackProxyConfiguration.newUrl === 'function') {
                    const fallbackProxyUrl = await fallbackProxyConfiguration.newUrl();
                    const fallbackProxy = parseProxyForPlaywright(fallbackProxyUrl);
                    if (fallbackProxy) {
                        candidates.push({ label: 'apify-proxy-fallback', proxy: fallbackProxy });
                    }
                }
            } catch (error) {
                log.warning(`Could not initialize Apify proxy fallback: ${error.message}`);
            }
        }
    }

    if (Actor.isAtHome()) {
        const alreadyHasApifyFallback = candidates.some((candidate) => candidate.label.startsWith('apify-proxy-'));
        if (!alreadyHasApifyFallback) {
            try {
                const autoHealProxyConfiguration = await Actor.createProxyConfiguration({
                    useApifyProxy: true,
                    groups: ['RESIDENTIAL'],
                });

                if (autoHealProxyConfiguration && typeof autoHealProxyConfiguration.newUrl === 'function') {
                    const autoHealProxyUrl = await autoHealProxyConfiguration.newUrl();
                    const autoHealProxy = parseProxyForPlaywright(autoHealProxyUrl);
                    if (autoHealProxy) {
                        candidates.push({ label: 'apify-proxy-auto-heal', proxy: autoHealProxy });
                    }
                }
            } catch (error) {
                log.warning(`Could not initialize auto-heal proxy fallback: ${error.message}`);
            }
        }
    }

    if (!candidates.some((candidate) => !candidate.proxy)) {
        candidates.push({ label: 'direct-no-proxy-fallback', proxy: undefined });
    }

    // Remove exact duplicates.
    const seen = new Set();
    return candidates.filter((candidate) => {
        const key = JSON.stringify(candidate.proxy || {});
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function dismissCookieBanner(page) {
    try {
        await page.evaluate(() => {
            const candidates = Array.from(document.querySelectorAll('a,button'));
            const reject = candidates.find((el) => /Continuer sans accepter/i.test(el.textContent || ''));
            if (reject) {
                reject.click();
                return;
            }
            const ok = candidates.find((el) => /^OK$/i.test((el.textContent || '').trim()));
            if (ok) ok.click();
        });
    } catch {
        // Optional banner.
    }
}

function isChallengePreview(text) {
    if (!text) return false;
    return /Please enable JS and disable any ad blocker|captcha-delivery|var dd=\{/i.test(text);
}

async function isChallengePage(page) {
    return page.evaluate(() => {
        const bodyText = document.body?.innerText || '';
        const htmlStart = document.documentElement?.outerHTML?.slice(0, 6000) || '';
        return /Please enable JS and disable any ad blocker/i.test(bodyText) || /captcha-delivery|var dd=\{/i.test(htmlStart);
    });
}

async function warmUpSession(page, targetUrl) {
    let sawChallenge = false;
    let sawNavigationFailure = false;

    const homeWarmup = await safeGoto(page, 'https://www.seloger.com/', {
        timeoutMs: HOME_WARMUP_TIMEOUT_MS,
        waitUntil: 'commit',
        label: 'Home warmup',
        retries: 2,
    });
    if (homeWarmup.ok) {
        await sleep(900);
    } else {
        sawNavigationFailure = true;
    }

    for (let attempt = 1; attempt <= WARMUP_ATTEMPTS; attempt += 1) {
        const targetWarmup = await safeGoto(page, targetUrl, {
            timeoutMs: NAVIGATION_TIMEOUT_MS,
            waitUntil: 'commit',
            label: `Search warmup ${attempt}`,
            retries: 2,
        });

        if (!targetWarmup.ok) {
            sawNavigationFailure = true;
            await sleep(1_100 * attempt);
            continue;
        }

        await sleep(900);
        await dismissCookieBanner(page);
        await sleep(500);

        let blocked = false;
        try {
            blocked = await isChallengePage(page);
        } catch {
            sawNavigationFailure = true;
            blocked = true;
        }

        if (!blocked) {
            return { ok: true, blockedByChallenge: false, retryableFailure: false };
        }

        sawChallenge = true;
        log.warning(`Challenge page detected during warmup (attempt ${attempt}/${WARMUP_ATTEMPTS}).`);
        await sleep(1_500 * attempt);
    }

    return {
        ok: false,
        blockedByChallenge: sawChallenge,
        retryableFailure: sawNavigationFailure || sawChallenge,
    };
}

async function fetchSearchPage(page, criteria, pageNumber) {
    return page.evaluate(
        async ({ criteriaValue, pageNo, size }) => {
            const payload = {
                criteria: criteriaValue,
                paging: {
                    page: pageNo,
                    size,
                    order: 'Default',
                },
            };

            const response = await fetch('/serp-bff/search', {
                method: 'POST',
                headers: { 'content-type': 'application/json; charset=utf-8' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });

            const text = await response.text();
            let data;
            try {
                data = JSON.parse(text);
            } catch {
                data = null;
            }

            return {
                status: response.status,
                data,
                bodyPreview: text.slice(0, 400),
            };
        },
        { criteriaValue: criteria, pageNo: pageNumber, size: pageSize },
    );
}

async function fetchClassifiedList(page, ids) {
    return page.evaluate(async ({ idList }) => {
        const response = await fetch(`/classifiedList/${idList.join(',')}`, {
            method: 'GET',
            credentials: 'include',
        });

        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            data = null;
        }

        return {
            status: response.status,
            data,
            bodyPreview: text.slice(0, 400),
        };
    }, { idList: ids });
}

async function fetchWithRetries(fn, { retries = 4, waitMs = 2500, label, onRetry }) {
    let lastResult;
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            lastResult = await fn();
        } catch (error) {
            lastError = error;
            lastResult = {
                status: 0,
                data: null,
                bodyPreview: '',
                thrown: true,
                errorMessage: error.message,
            };
        }

        if (lastResult?.status === 200 && lastResult?.data) {
            return lastResult;
        }

        const statusInfo = lastResult?.status ?? 'unknown';
        const errorInfo = lastResult?.errorMessage ? ` Error: ${lastResult.errorMessage}` : '';
        log.warning(`${label} failed (attempt ${attempt}/${retries}), status ${statusInfo}.${errorInfo}`);

        if (attempt < retries) {
            if (onRetry) await onRetry(lastResult, attempt);
            await sleep(waitMs);
        }
    }

    return (
        lastResult || {
            status: 0,
            data: null,
            bodyPreview: '',
            thrown: true,
            errorMessage: lastError?.message || 'Unknown retry failure',
        }
    );
}

async function runWithCandidate(criteria, candidate) {
    log.info(`Using browser strategy: ${candidate.label}`);
    let browser;
    let blockedByChallenge = false;
    let retryableFailure = false;

    try {
        browser = await chromium.launch({
            headless: true,
            channel: 'chrome',
            proxy: candidate.proxy,
            args: ['--disable-blink-features=AutomationControlled'],
        });

        const context = await browser.newContext({
            userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
            viewport: { width: 1366, height: 768 },
            locale: 'fr-FR',
            timezoneId: 'Europe/Paris',
            extraHTTPHeaders: {
                'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            },
        });

        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        const page = await context.newPage();

        const warmupState = await warmUpSession(page, initialUrl);
        if (!warmupState.ok) {
            blockedByChallenge = warmupState.blockedByChallenge;
            retryableFailure = warmupState.retryableFailure;
            log.warning('Warmup could not establish a stable browsing session.');
            return { blockedByChallenge, retryableFailure };
        }

        for (let pageNumber = 1; pageNumber <= maxPages && totalSaved < resultsWanted; pageNumber += 1) {
            log.info(`Fetching search page ${pageNumber}...`);

            const searchResult = await fetchWithRetries(
                () => fetchSearchPage(page, criteria, pageNumber),
                {
                    retries: SEARCH_API_RETRIES,
                    waitMs: 2_000,
                    label: `Search API page ${pageNumber}`,
                    onRetry: async (res, attempt) => {
                        if (res?.status === 403 && isChallengePreview(res?.bodyPreview)) {
                            blockedByChallenge = true;
                            await sleep(1_000 * attempt);
                            try {
                                await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
                                await dismissCookieBanner(page);
                            } catch {
                                // Continue retries regardless.
                            }
                        }
                    },
                },
            );

            if (searchResult?.status !== 200 || !searchResult?.data) {
                if (searchResult?.status === 403 && isChallengePreview(searchResult?.bodyPreview)) {
                    blockedByChallenge = true;
                }
                if (searchResult?.thrown || searchResult?.status === 0 || (searchResult?.status >= 500 && searchResult?.status < 600)) {
                    retryableFailure = true;
                }
                log.warning(`Search API unavailable on page ${pageNumber}. Preview: ${searchResult?.bodyPreview || ''}`);
                break;
            }

            const totalCount = Number.isFinite(searchResult.data.totalCount) ? searchResult.data.totalCount : undefined;
            const ids = Array.isArray(searchResult.data.classifieds)
                ? searchResult.data.classifieds.map((item) => item?.id).filter(Boolean)
                : [];
            log.info(`Search page ${pageNumber} status ${searchResult.status}, ids ${ids.length}.`);

            if (ids.length === 0) {
                log.info(`No listing IDs returned for page ${pageNumber}.`);
                break;
            }

            const detailsResult = await fetchWithRetries(
                () => fetchClassifiedList(page, ids),
                {
                    retries: DETAILS_API_RETRIES,
                    waitMs: 1_500,
                    label: `Classified list page ${pageNumber}`,
                    onRetry: async (res, attempt) => {
                        if (res?.status === 403 && isChallengePreview(res?.bodyPreview)) {
                            blockedByChallenge = true;
                            await sleep(800 * attempt);
                        }
                    },
                },
            );

            if (detailsResult?.status !== 200 || !Array.isArray(detailsResult?.data)) {
                if (detailsResult?.status === 403 && isChallengePreview(detailsResult?.bodyPreview)) {
                    blockedByChallenge = true;
                }
                if (detailsResult?.thrown || detailsResult?.status === 0 || (detailsResult?.status >= 500 && detailsResult?.status < 600)) {
                    retryableFailure = true;
                }
                log.warning(`Classified list API unavailable on page ${pageNumber}. Preview: ${detailsResult?.bodyPreview || ''}`);
                break;
            }

            const records = [];
            for (const listing of detailsResult.data) {
                if (totalSaved + records.length >= resultsWanted) break;
                const listingId = listing?.id;
                if (!listingId || seenIds.has(listingId)) continue;

                const cleaned = cleanData(mapListing(listing, { pageNumber, totalCount, searchUrl: initialUrl }));
                if (!cleaned || Object.keys(cleaned).length === 0) continue;

                seenIds.add(listingId);
                records.push(cleaned);
            }

            if (records.length === 0) {
                log.info(`No new listings to save on page ${pageNumber}.`);
                continue;
            }

            await Dataset.pushData(records);
            totalSaved += records.length;
            log.info(`Saved ${records.length} listings from page ${pageNumber} (${totalSaved}/${resultsWanted}).`);

            if (ids.length < pageSize) break;
        }
    } catch (error) {
        retryableFailure = true;
        const message = error?.message || String(error);
        log.warning(`Strategy ${candidate.label} failed with recoverable error: ${message}`);
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch {
                // Browser may already be closed.
            }
        }
    }

    return { blockedByChallenge, retryableFailure };
}

try {
    const criteria = parseSearchCriteria(initialUrl);
    log.info(`Using criteria: ${JSON.stringify(criteria)}`);
    log.info(`Run limits: resultsWanted=${resultsWanted}, maxPages=${maxPages}.`);

    const candidates = await buildProxyCandidates();
    log.info(`Proxy candidates: ${candidates.map((c) => c.label).join(', ')}`);

    let blockedEverywhere = false;
    let triedAny = false;
    let sawRetryableFailure = false;

    for (const candidate of candidates) {
        triedAny = true;
        const before = totalSaved;
        const result = await runWithCandidate(criteria, candidate);

        if (result.blockedByChallenge) {
            blockedEverywhere = true;
        }
        if (result.retryableFailure) {
            sawRetryableFailure = true;
        }

        if (totalSaved >= resultsWanted) break;
        if (totalSaved > before) {
            // Got some data with this strategy, no need to rotate.
            break;
        }

        if (result.retryableFailure) {
            log.info(`Switching strategy after recoverable failure: ${candidate.label}.`);
            continue;
        }

        // If not blocked, likely legitimate no-result criteria. Stop trying.
        if (!result.blockedByChallenge) {
            break;
        }
    }

    if (triedAny && totalSaved === 0 && blockedEverywhere) {
        log.warning(
            'Blocked by SeLoger anti-bot protection (DataDome) across all strategies. Consider Apify Proxy RESIDENTIAL with fresh sessions.',
        );
    }

    if (triedAny && totalSaved === 0 && sawRetryableFailure && !blockedEverywhere) {
        log.warning('Run completed without crash, but transient navigation/API failures prevented data extraction this time.');
    }
} catch (error) {
    runError = error;
    log.error(`Run failed: ${error.stack || error.message}`);
} finally {
    log.info(`Finished. Saved ${totalSaved} listings.`);
    if (runError) {
        await Actor.fail(runError.message);
    } else {
        await Actor.exit();
    }
}
