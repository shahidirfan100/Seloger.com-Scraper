# SeLoger.com Scraper

Extract property listings from SeLoger search pages in a fast, repeatable way. Collect structured rental or sale listing data including price, surface, location, listing URL, agency details, media links, and listing attributes. This actor is built for market research, portfolio monitoring, and automated real estate data pipelines.

---

## Features

- **Search URL based extraction** - Start from any SeLoger search URL.
- **Paginated collection** - Automatically gathers listings across multiple result pages.
- **Rich listing fields** - Captures pricing, location, property facts, agency info, and images.
- **Null-free dataset output** - Omits empty values to keep data clean.
- **Production-ready output** - Structured records suitable for BI tools and downstream APIs.

---

## Use Cases

### Rental Market Tracking
Track listing volume and pricing trends by city, ZIP code, district, or property type. Build recurring snapshots to monitor market shifts over time.

### Lead Enrichment
Collect listing and agency attributes for brokerage operations, CRM enrichment, and lead qualification workflows.

### Portfolio Benchmarking
Compare asking prices and listing characteristics against your own assets or target investment zones.

### PropTech Analytics
Feed consistent real estate listing data into dashboards, automation workflows, and internal data products.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `startUrl` | String | No | SeLoger rental apartment search URL | Search URL to start scraping from. |
| `results_wanted` | Integer | No | `20` | Maximum number of listings to collect. |
| `max_pages` | Integer | No | `10` | Safety limit for pagination depth. |
| `proxyConfiguration` | Object | No | `{"useApifyProxy": false}` | Optional proxy settings for blocked environments. |

---

## Output Data

Each dataset item can contain:

| Field | Type | Description |
|---|---|---|
| `id` | String | SeLoger listing identifier. |
| `url` | String | Absolute listing URL. |
| `title` | String | Listing type label (for example apartment for rent). |
| `price` | Number | Raw numeric price. |
| `price_formatted` | String | Human-readable price text. |
| `price_additional_information` | String | Additional price context (for example charges included). |
| `rooms` | Number | Number of rooms when available. |
| `living_area_m2` | Number | Main living area in square meters. |
| `land_area_m2` | Number | Plot area when available. |
| `energy_class` | String | Energy class indicator. |
| `city` | String | City name. |
| `zip_code` | String | Postal code. |
| `district` | String | District or neighborhood text. |
| `agency_name` | String | Listing agency name. |
| `agency_profile_url` | String | Agency profile URL. |
| `agency_address` | String | Agency address text. |
| `phone_numbers` | Array | Contact phone numbers when available. |
| `image_urls` | Array | Listing image URLs. |
| `image_count` | Number | Number of images extracted. |
| `is_new` | Boolean | Indicates newly published listing. |
| `has_3d_visit` | Boolean | Indicates 3D visit availability. |
| `is_exclusive` | Boolean | Indicates exclusive listing status. |
| `page` | Number | Search result page number. |
| `total_results` | Number | Total matching results for the search query. |
| `scraped_at` | String | ISO timestamp of extraction. |

---

## Usage Examples

### Basic Run

```json
{
    "startUrl": "https://www.seloger.com/classified-search?distributionTypes=Rent&estateTypes=Apartment&locations=AD02FR1",
    "results_wanted": 20
}
```

### Deeper Pagination

```json
{
    "startUrl": "https://www.seloger.com/classified-search?distributionTypes=Rent&estateTypes=Apartment&locations=AD02FR1",
    "results_wanted": 120,
    "max_pages": 8
}
```

### Run with Proxy

```json
{
    "startUrl": "https://www.seloger.com/classified-search?distributionTypes=Rent&estateTypes=Apartment&locations=AD02FR1",
    "results_wanted": 50,
    "max_pages": 5,
    "proxyConfiguration": {
        "useApifyProxy": true
    }
}
```

---

## Sample Output

```json
{
    "id": "26NCXJ5QX7WQ",
    "url": "https://www.seloger.com/annonces/locations/appartement/paris-15eme-75/georges-brassens/262418943.htm",
    "title": "Appartement à louer",
    "price": 1350,
    "price_formatted": "1 350 €/mois",
    "rooms": 1,
    "living_area_m2": 29,
    "energy_class": "D",
    "city": "Paris 15ème arrondissement",
    "zip_code": "75015",
    "district": "Georges Brassens",
    "agency_name": "YFRI pour CSO",
    "image_count": 10,
    "image_urls": [
        "https://.../image1.jpg",
        "https://.../image2.jpg"
    ],
    "is_new": true,
    "has_3d_visit": true,
    "page": 1,
    "total_results": 86297,
    "scraped_at": "2026-03-09T13:21:45.000Z"
}
```

---

## Tips for Best Results

### Use Stable Search URLs
- Start from a final search URL with all filters already applied.
- Keep URL parameters explicit for repeatable runs.

### Control Run Size
- Use `results_wanted: 20` for quick validation.
- Increase gradually for larger production runs.

### Handle Blocking
- Enable `proxyConfiguration` when you see inconsistent loading.
- Keep `max_pages` realistic to reduce unnecessary requests.

---

## Integrations

- **Google Sheets** - Export CSV data for quick analysis.
- **Airtable** - Build searchable listing databases.
- **Make** - Trigger automations from new listing snapshots.
- **Zapier** - Connect listing updates to your existing workflows.
- **Webhooks** - Deliver fresh data to your own API endpoints.

### Export Formats

- **JSON** for APIs and development workflows
- **CSV** for spreadsheet analysis
- **Excel** for reporting
- **XML** for integration pipelines

---

## FAQ

### Why are some fields missing on certain listings?
Listings vary by advertiser and listing completeness. The actor excludes empty values to keep data clean.

### Can I scrape sales instead of rentals?
Yes. Use a SeLoger sale search URL in `startUrl`.

### Can I target specific cities or districts?
Yes. Apply filters on SeLoger first, then use that URL as input.

---

## Legal Notice

Use this actor in accordance with SeLoger terms, local laws, and data protection regulations. You are responsible for how you collect, store, and use the extracted data.
