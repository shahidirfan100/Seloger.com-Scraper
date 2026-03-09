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

async function buildProxyCandidates() {
    const candidates = [];

    if (proxyConfig) {
        try {
            const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);
            if (proxyConfiguration && typeof proxyConfiguration.newUrl === 'function') {
                const proxyUrl = await proxyConfiguration.newUrl();
                const proxy = parseProxyForPlaywright(proxyUrl);
                if (proxy) {
                    candidates.push({ label: 'input-proxy', proxy });
                } else {
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
                const fallbackProxyConfiguration = await Actor.createProxyConfiguration({ useApifyProxy: true });
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
    // Warm up cookies on root first.
    try {
        await page.goto('https://www.seloger.com/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
        await sleep(1_200);
    } catch {
        // Continue with target URL anyway.
    }

    for (let attempt = 1; attempt <= 4; attempt += 1) {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
        await sleep(1_200);
        await dismissCookieBanner(page);
        await sleep(700);

        const blocked = await isChallengePage(page);
        if (!blocked) return true;

        log.warning(`Challenge page detected during warmup (attempt ${attempt}/4).`);
        await sleep(2_000 * attempt);
    }

    return false;
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
    for (let attempt = 1; attempt <= retries; attempt += 1) {
        lastResult = await fn();
        if (lastResult?.status === 200 && lastResult?.data) {
            return lastResult;
        }

        log.warning(`${label} failed (attempt ${attempt}/${retries}), status ${lastResult?.status}.`);
        if (attempt < retries) {
            if (onRetry) await onRetry(lastResult, attempt);
            await sleep(waitMs);
        }
    }
    return lastResult;
}

async function runWithCandidate(criteria, candidate) {
    log.info(`Using browser strategy: ${candidate.label}`);

    const browser = await chromium.launch({
        headless: true,
        channel: 'chrome',
        proxy: candidate.proxy,
        args: ['--disable-blink-features=AutomationControlled'],
    });

    let blockedByChallenge = false;

    try {
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

        const warmupOk = await warmUpSession(page, initialUrl);
        if (!warmupOk) {
            blockedByChallenge = true;
            log.warning('Warmup could not pass challenge page.');
            return { blockedByChallenge };
        }

        for (let pageNumber = 1; pageNumber <= maxPages && totalSaved < resultsWanted; pageNumber += 1) {
            log.info(`Fetching search page ${pageNumber}...`);

            const searchResult = await fetchWithRetries(
                () => fetchSearchPage(page, criteria, pageNumber),
                {
                    retries: 4,
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
                    retries: 4,
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
    } finally {
        await browser.close();
    }

    return { blockedByChallenge };
}

try {
    const criteria = parseSearchCriteria(initialUrl);
    log.info(`Using criteria: ${JSON.stringify(criteria)}`);
    log.info(`Run limits: resultsWanted=${resultsWanted}, maxPages=${maxPages}.`);

    const candidates = await buildProxyCandidates();
    log.info(`Proxy candidates: ${candidates.map((c) => c.label).join(', ')}`);

    let blockedEverywhere = false;
    let triedAny = false;

    for (const candidate of candidates) {
        triedAny = true;
        const before = totalSaved;
        const result = await runWithCandidate(criteria, candidate);

        if (result.blockedByChallenge) {
            blockedEverywhere = true;
        }

        if (totalSaved >= resultsWanted) break;
        if (totalSaved > before) {
            // Got some data with this strategy, no need to rotate.
            break;
        }

        // If not blocked, likely legitimate no-result criteria. Stop trying.
        if (!result.blockedByChallenge) {
            break;
        }
    }

    if (triedAny && totalSaved === 0 && blockedEverywhere) {
        throw new Error(
            'Blocked by SeLoger anti-bot protection (DataDome). Run again with Apify Proxy enabled, preferably RESIDENTIAL.',
        );
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
