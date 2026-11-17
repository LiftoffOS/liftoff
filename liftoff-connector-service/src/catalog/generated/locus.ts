// FALLBACK-AUTHORED registry functions — Locus, an aggregator that resells
// key-based vendors per call on one prepaid credit balance the platform
// funds (Locus Pro catalog, read live 2026-09-20). CURATED to the people and
// company enrichment the platform has no vendor account for: people/company
// search and enrichment (Apollo behind it), professional email find, verify
// and domain listing (Hunter behind it), deep person and company profiles
// (People Data Labs behind it), LinkedIn-to-contact details (ContactOut
// behind it), the last two as Locus pass-throughs of the vendor's own API,
// and pay-per-use web page scrape, search, extract and site map (Firecrawl
// behind it: the platform's own Firecrawl key is a free plan with no
// pay-as-you-go, so this is the platform's per-call lane for it; a
// schema-guided extraction is a scrape in the `json` format, because
// Firecrawl's own /extract answers with a job id to poll), and page
// text and semantic web search resold from Exa's own x402 API (the overflow
// lane behind the platform's Exa key, whose plan is capped at 10 queries a
// second: taken only when that key is rate-limited), and startup, investor
// and funding-round data (Crunchbase behind it, through Locus's Parse
// endpoints at a fixed charge), and the stock statistics, fund holdings and
// ticker lookup the platform's keyless market-data card cannot read (Yahoo
// Finance behind it, through Locus's Parse endpoints; Yahoo refuses
// datacenter egress, so this is the only lane for it), and the daily closing
// exchange rate and commodity price (Chainlink behind it, listed FREE by the
// source, so free to the customer too because the charge booked is the one the
// aggregator reports). COMMODITIES are the platform's first coverage of any
// kind; EXCHANGE RATES are not — strale already serves a live `exchange_rate`
// and `currency_convert` at $0.0216, and these are a free DAILY CLOSE, which is
// a different reading rather than a cheaper one.
//
// MEASURED COVERAGE, and it is the whole capability: EUR-USD,
// GBP-USD, AUD-USD, XAU-USD and XAG-USD answer. Every other symbol tried — NZD,
// USD-JPY, USD-CAD, USD-CHF, the cross pairs, platinum, palladium and the base
// metals — answers 424 `owned_read_unavailable`, which the source's own note
// explains as the free tier ("full global coverage are available on request").
// The vendor's two DIRECTORY endpoints are deliberately NOT mapped: they list
// 48 symbols of which 5 answer, and they spell them in a form the price read
// rejects outright ("XAU/USD-USD" is a 400), so a directory here would send a
// model to a 400 and then to a wall of 424s. The symbols above are in the
// parameter descriptions instead, which is the coverage stated once and
// truthfully. Function names are the
// CAPABILITY, never the vendor: the model must not learn which supplier
// answers. Each name below is a case in src/clients/locus.ts
// (LOCUS_DISPATCH); the price is Locus's listed base price in USD, the figure
// booked only if Locus ever reports no charge (1 credit = $0.001). The
// customer's Operating Units are drawn from the charge Locus reports back. Request bodies are the provider's own, which is
// why the argument names below are the vendors' names for them. All read-only.
// Add a function by extending BOTH lists here and seeding its classification
// in platform-backend; the endpoint must also be ENABLED on the Locus account
// (they start disabled) or Locus answers ENDPOINT_DISABLED.

import type { ConnectorFunction } from '../../types.js';

export const LOCUS_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'people_search',
    description: 'Search for people by title, seniority, location, keywords and the companies they work at; profiles without contact details',
    inputSchema: {
      type: 'object',
      properties: {
        person_titles: { type: 'array', items: { type: 'string' }, description: 'Job titles to match, e.g. ["CFO", "VP Finance"]' },
        person_seniorities: { type: 'array', items: { type: 'string' }, description: 'Seniority levels: owner, founder, c_suite, vp, director, manager, senior, entry' },
        person_locations: { type: 'array', items: { type: 'string' }, description: 'Locations, e.g. ["Toronto, Canada"]' },
        q_organization_domains_list: { type: 'array', items: { type: 'string' }, description: 'Company web domains to search within, e.g. ["shopify.com"]' },
        q_keywords: { type: 'string', description: 'Free-text keywords' },
        per_page: { type: 'integer', description: 'Results per page (default 10, most 100)' },
        page: { type: 'integer', description: 'Page number, from 1' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'people_enrich',
    description: "Enrich one person into a full profile (title, company, location, work history, social profiles) from a name and company, an email, or a LinkedIn URL",
    inputSchema: {
      type: 'object',
      properties: {
        first_name: { type: 'string', description: 'Given name' },
        last_name: { type: 'string', description: 'Family name' },
        email: { type: 'string', description: 'A known email address' },
        domain: { type: 'string', description: "The person's company web domain" },
        organization_name: { type: 'string', description: 'Company name' },
        linkedin_url: { type: 'string', description: 'LinkedIn profile URL' },
        reveal_personal_emails: { type: 'boolean', description: 'Also return personal email addresses (charged extra)' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'company_search',
    description: 'Search for companies by name, location, size and keywords',
    inputSchema: {
      type: 'object',
      properties: {
        q_organization_name: { type: 'string', description: 'Company name to match' },
        organization_locations: { type: 'array', items: { type: 'string' }, description: 'Headquarters locations' },
        organization_num_employees_ranges: { type: 'array', items: { type: 'string' }, description: 'Employee-count ranges, e.g. ["51,200", "201,500"]' },
        q_organization_keyword_tags: { type: 'array', items: { type: 'string' }, description: 'Industry or keyword tags' },
        per_page: { type: 'integer', description: 'Results per page (default 10, most 100)' },
        page: { type: 'integer', description: 'Page number, from 1' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'company_enrich',
    description: 'Enrich a company from its web domain: description, industry, size, revenue range, funding, technologies, locations',
    inputSchema: {
      type: 'object',
      properties: { domain: { type: 'string', description: 'Company web domain, e.g. shopify.com' } },
      required: ['domain'],
    },
    categories: ['read'],
  },
  {
    name: 'company_job_postings',
    description: "A company's current job postings, by the company id a company search or enrichment returned",
    inputSchema: {
      type: 'object',
      properties: { organization_id: { type: 'string', description: 'The company id from company_search or company_enrich' } },
      required: ['organization_id'],
    },
    categories: ['read'],
  },
  {
    name: 'email_find',
    description: "Find a person's professional email address from their name and their company's domain",
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Company web domain' },
        company: { type: 'string', description: 'Company name, when the domain is not known' },
        first_name: { type: 'string', description: 'Given name' },
        last_name: { type: 'string', description: 'Family name' },
        full_name: { type: 'string', description: 'Full name, when the parts are not known separately' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'email_verify',
    description: 'Verify whether an email address is deliverable, with a confidence score',
    inputSchema: {
      type: 'object',
      properties: { email: { type: 'string', description: 'The address to verify' } },
      required: ['email'],
    },
    categories: ['read'],
  },
  {
    name: 'domain_emails',
    description: 'List the professional email addresses known at a company domain, with the pattern the company uses',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Company web domain' },
        company: { type: 'string', description: 'Company name, when the domain is not known' },
        department: { type: 'string', description: 'Restrict to a department, e.g. sales, it, finance' },
        limit: { type: 'integer', description: 'Most addresses to return (default 10)' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'person_profile_enrich',
    description: 'Enrich one person into a full profile from a LinkedIn URL, an email, a phone number, or a name with a company or location: work history, education, skills, locations, social profiles',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: 'LinkedIn profile URL' },
        email: { type: 'string', description: 'A known email address' },
        phone: { type: 'string', description: 'A known phone number' },
        name: { type: 'string', description: 'Full name' },
        first_name: { type: 'string', description: 'Given name' },
        last_name: { type: 'string', description: 'Family name' },
        company: { type: 'string', description: 'Current company name or web domain' },
        location: { type: 'string', description: 'A location, e.g. "Toronto, Canada"' },
        min_likelihood: { type: 'integer', description: 'Least match confidence to accept, 1–10 (default 2)' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'company_profile_enrich',
    description: 'Enrich one company into a full record from its web domain, name, LinkedIn URL or stock ticker: industry, size, founded, headquarters, funding, tags, social profiles',
    inputSchema: {
      type: 'object',
      properties: {
        website: { type: 'string', description: 'Company web domain, e.g. shopify.com' },
        name: { type: 'string', description: 'Company name' },
        profile: { type: 'string', description: 'Company LinkedIn URL' },
        ticker: { type: 'string', description: 'Stock ticker' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'linkedin_contact_details',
    description: "A person's work and personal email addresses (and, on request, phone numbers) from their LinkedIn profile URL",
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: 'LinkedIn profile URL' },
        include_phone: { type: 'boolean', description: 'Also return phone numbers (charged extra)' },
        email_type: { type: 'string', description: "'work' or 'personal'; both when omitted" },
      },
      required: ['profile'],
    },
    categories: ['read'],
  },
  {
    name: 'startup_search',
    description: 'Search startups and companies by name; each result carries the company id and permalink, a short description, categories, location, employee range, rank and operating status',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Company name keyword, e.g. 'stripe'; omit to list companies by rank" },
        limit: { type: 'integer', description: 'Results to return: 5, 10 or 15 (default 15)' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'startup_profile',
    description: "A startup or company's full profile by its permalink: description, categories, location, employee range, rank and funding status",
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: "The company permalink from startup_search, e.g. 'stripe', 'anthropic'" } },
      required: ['slug'],
    },
    categories: ['read'],
  },
  {
    name: 'startup_funding_rounds',
    description: "A company's funding rounds: investment type, money raised and the funded organization, by the company id from startup_search",
    inputSchema: {
      type: 'object',
      properties: {
        org_uuid: { type: 'string', description: 'The company id (UUID) from startup_search' },
        limit: { type: 'integer', description: 'Rounds to return: 5, 10 or 25 (default 25)' },
      },
      required: ['org_uuid'],
    },
    categories: ['read'],
  },
  {
    name: 'startup_people',
    description: "The people associated with a company: job title, primary organization, rank and location, by the company id from startup_search",
    inputSchema: {
      type: 'object',
      properties: {
        org_uuid: { type: 'string', description: 'The company id (UUID) from startup_search' },
        limit: { type: 'integer', description: 'People to return: 5, 10 or 25 (default 25)' },
      },
      required: ['org_uuid'],
    },
    categories: ['read'],
  },
  {
    name: 'investor_search',
    description: 'Search investors by name; each result carries the number of investments, exits, location and investor type',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Investor name keyword, e.g. 'sequoia'; omit to list investors by rank" },
        limit: { type: 'integer', description: 'Results to return: 5, 10 or 15 (default 15)' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'stock_key_statistics',
    description: "A stock's key statistics: valuation (P/E, PEG, price-to-book), trading data (52-week range, volume, moving averages), financial metrics (EPS, margins, return on equity) and dividend information, by ticker",
    inputSchema: {
      type: 'object',
      properties: { ticker: { type: 'string', description: 'Stock ticker symbol, e.g. AAPL, MSFT' } },
      required: ['ticker'],
    },
    categories: ['read'],
  },
  {
    name: 'fund_top_holdings',
    description: "An ETF's or mutual fund's top ten holdings with symbol, company name and portfolio weight, by ticker; a stock returns none",
    inputSchema: {
      type: 'object',
      properties: { ticker: { type: 'string', description: 'ETF or mutual fund ticker, e.g. SPY, QQQ, VTI' } },
      required: ['ticker'],
    },
    categories: ['read'],
  },
  {
    name: 'ticker_lookup',
    description: 'Find stock ticker symbols by company name, symbol or keyword; each match carries the company name, exchange, type, sector and industry',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Company name, ticker symbol or keyword' } },
      required: ['query'],
    },
    categories: ['read'],
  },
  {
    name: 'web_page_scrape',
    description: 'Fetch one web page and return its content as clean markdown (and other formats on request, including a structured object guided by a JSON schema), rendering JavaScript where needed',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The page URL' },
        formats: { type: 'array', items: { type: 'string' }, description: 'Formats to return, e.g. ["markdown"], ["markdown", "links"], ["html"], ["json"] (default markdown)' },
        jsonOptions: { type: 'object', description: 'With the "json" format: { "schema": <JSON schema of the object to extract>, "prompt": <what to extract, in words> }' },
        onlyMainContent: { type: 'boolean', description: 'Strip navigation, footers and boilerplate (default true)' },
        waitFor: { type: 'integer', description: 'Milliseconds to wait for the page to settle before reading' },
      },
      required: ['url'],
    },
    categories: ['read'],
  },
  {
    name: 'web_search_results',
    description: 'Search the web and return results with title, URL and description, optionally with each page\'s content',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'integer', description: 'Most results to return (default 5, most 20)' },
        lang: { type: 'string', description: 'Language code, e.g. en' },
        country: { type: 'string', description: 'Country code, e.g. us' },
        tbs: { type: 'string', description: 'Time filter, e.g. qdr:d (past day), qdr:w, qdr:m' },
      },
      required: ['query'],
    },
    categories: ['read'],
  },
  {
    name: 'web_page_text',
    description: 'The text of one or more web pages by URL, with optional highlights and an AI summary; the same read the platform serves on its own key, for when that key is at its rate limit',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'Page URLs to read' },
        text: { type: 'boolean', description: 'Return the full page text (default true)' },
        highlights: { type: 'boolean', description: 'Also return the most relevant passages' },
        summary: { type: 'boolean', description: 'Also return an AI-written summary' },
      },
      required: ['urls'],
    },
    categories: ['read'],
  },
  {
    name: 'web_semantic_search',
    description: 'Search the web by meaning and return up to ten results with title and URL, optionally with each page\'s text; the same search the platform serves on its own key, for when that key is at its rate limit',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        numResults: { type: 'integer', description: 'Results to return (most 10)' },
        type: { type: 'string', description: 'Search type: auto (default), keyword, neural, deep-lite, deep, deep-reasoning' },
        contents: { type: 'object', description: 'Content to include per result, e.g. { "text": true }' },
      },
      required: ['query'],
    },
    categories: ['read'],
  },
  {
    name: 'web_site_map',
    description: "List a website's URLs (its map), optionally filtered by a search term",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The site root or a starting URL' },
        search: { type: 'string', description: 'Only URLs matching this term' },
        limit: { type: 'integer', description: 'Most URLs to return' },
      },
      required: ['url'],
    },
    categories: ['read'],
  },
  // ── Crypto market data (CoinGecko behind it) ────────────────────────────
  {
    name: 'crypto_price_now',
    description: 'Current price of one or more coins in any supported currency, optionally with market cap, 24-hour volume and 24-hour change',
    inputSchema: { type: 'object', properties: {
      ids: { type: 'string', description: 'Comma-separated coin ids, e.g. "bitcoin,ethereum"' },
      vs_currencies: { type: 'string', description: 'Comma-separated currencies, e.g. "usd,eur"' },
      include_market_cap: { type: 'boolean', description: 'Include market capitalisation' },
      include_24hr_vol: { type: 'boolean', description: 'Include 24-hour trading volume' },
      include_24hr_change: { type: 'boolean', description: 'Include 24-hour price change' },
      include_last_updated_at: { type: 'boolean', description: 'Include the last-updated timestamp' },
      precision: { type: 'string', description: 'Decimal places for the price' },
    }, required: ['ids', 'vs_currencies'] },
    categories: ['read'],
  },
  {
    name: 'crypto_token_price_by_contract',
    description: 'Current price of a token identified by its contract address on a given chain',
    inputSchema: { type: 'object', properties: {
      platform_id: { type: 'string', description: 'Chain id, e.g. "ethereum", "solana"' },
      contract_addresses: { type: 'string', description: 'Comma-separated contract addresses' },
      vs_currencies: { type: 'string', description: 'Comma-separated currencies, e.g. "usd"' },
      include_market_cap: { type: 'boolean', description: 'Include market capitalisation' },
      include_24hr_vol: { type: 'boolean', description: 'Include 24-hour trading volume' },
      include_24hr_change: { type: 'boolean', description: 'Include 24-hour price change' },
    }, required: ['platform_id', 'contract_addresses', 'vs_currencies'] },
    categories: ['read'],
  },
  {
    name: 'crypto_market_table',
    description: 'Coins ranked by market data - price, market cap, volume and change - with paging and optional sparkline',
    inputSchema: { type: 'object', properties: {
      vs_currency: { type: 'string', description: 'Currency to price in, e.g. "usd"' },
      ids: { type: 'string', description: 'Only these comma-separated coin ids' },
      category: { type: 'string', description: 'Only coins in this category' },
      order: { type: 'string', description: 'Sort order, e.g. "market_cap_desc"' },
      per_page: { type: 'number', description: 'Rows per page, most 250' },
      page: { type: 'number', description: 'Page number, from 1' },
      sparkline: { type: 'boolean', description: 'Include a 7-day price sparkline' },
      price_change_percentage: { type: 'string', description: 'Change windows, e.g. "1h,24h,7d"' },
    }, required: ['vs_currency'] },
    categories: ['read'],
  },
  {
    name: 'crypto_coin_profile',
    description: 'Everything known about one coin: description, market data, community statistics and developer activity',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string', description: 'Coin id, e.g. "bitcoin"' },
      localization: { type: 'boolean', description: 'Include all translated descriptions' },
      tickers: { type: 'boolean', description: 'Include exchange tickers' },
      market_data: { type: 'boolean', description: 'Include market data' },
      community_data: { type: 'boolean', description: 'Include community statistics' },
      developer_data: { type: 'boolean', description: 'Include developer activity' },
      sparkline: { type: 'boolean', description: 'Include a 7-day price sparkline' },
    }, required: ['id'] },
    categories: ['read'],
  },
  {
    name: 'crypto_coin_directory',
    description: 'The full list of supported coins with their ids, names and symbols, for resolving a name to an id',
    inputSchema: { type: 'object', properties: {
      include_platform: { type: 'boolean', description: 'Include contract addresses per chain' },
      status: { type: 'string', description: 'Filter by listing status' },
    } },
    categories: ['read'],
  },
  {
    name: 'crypto_search',
    description: 'Search coins, exchanges, categories and NFT collections by keyword',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'What to search for' },
    }, required: ['query'] },
    categories: ['read'],
  },
  {
    name: 'crypto_trending',
    description: 'What is trending in the last 24 hours: coins, NFT collections and categories',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'crypto_exchange_rates',
    description: 'Bitcoin exchange rates against every supported currency',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'crypto_global_market',
    description: 'The crypto market as a whole: total market capitalisation, total volume and Bitcoin dominance',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'crypto_global_defi_market',
    description: 'The decentralised-finance market as a whole: market capitalisation, volume and its share of crypto',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'crypto_price_history',
    description: 'Historical price, market cap and volume for one coin over a number of days',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string', description: 'Coin id, e.g. "bitcoin"' },
      vs_currency: { type: 'string', description: 'Currency to price in, e.g. "usd"' },
      days: { type: 'string', description: 'How many days back, or "max"' },
      interval: { type: 'string', description: 'Point spacing, e.g. "daily"' },
      precision: { type: 'string', description: 'Decimal places for the price' },
    }, required: ['id', 'vs_currency', 'days'] },
    categories: ['read'],
  },
  {
    name: 'crypto_price_on_date',
    description: 'A snapshot of one coin on a given calendar date',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string', description: 'Coin id, e.g. "bitcoin"' },
      date: { type: 'string', description: 'Date as dd-mm-yyyy' },
      localization: { type: 'boolean', description: 'Include all translated descriptions' },
    }, required: ['id', 'date'] },
    categories: ['read'],
  },
  {
    name: 'crypto_categories',
    description: 'Coin categories with their market capitalisation, volume and change',
    inputSchema: { type: 'object', properties: {
      order: { type: 'string', description: 'Sort order, e.g. "market_cap_desc"' },
    } },
    categories: ['read'],
  },
  {
    name: 'crypto_top_movers',
    description: 'The thirty largest price gains and losses over a chosen window',
    inputSchema: { type: 'object', properties: {
      vs_currency: { type: 'string', description: 'Currency to price in, e.g. "usd"' },
      duration: { type: 'string', description: 'Window, e.g. "24h"' },
      top_coins: { type: 'string', description: 'Rank cut-off to consider, e.g. "1000"' },
    }, required: ['vs_currency'] },
    categories: ['read'],
  },
  {
    name: 'crypto_exchanges',
    description: 'Cryptocurrency exchanges with trust score, trading volume and other metadata',
    inputSchema: { type: 'object', properties: {
      per_page: { type: 'number', description: 'Rows per page' },
      page: { type: 'number', description: 'Page number, from 1' },
    } },
    categories: ['read'],
  },
  // ── Search-engine and keyword data (DataForSEO behind it) ───────────────
  {
    name: 'search_ranking_results',
    description: 'Live Google results for a query with the rich features the page carries - featured snippets, people-also-ask, local packs - for a chosen location and language',
    inputSchema: { type: 'object', properties: {
      tasks: { type: 'array', items: { type: 'object' }, description: 'One or more task objects, each with keyword, location_name (or location_code), language_name (or language_code) and optional depth' },
    }, required: ['tasks'] },
    categories: ['read'],
  },
  {
    name: 'keyword_search_volume',
    description: 'Monthly search volume, competition and cost-per-click for up to a thousand keywords a task, from advertising data',
    inputSchema: { type: 'object', properties: {
      tasks: { type: 'array', items: { type: 'object' }, description: 'One or more task objects, each with keywords (an array), location_name (or location_code) and language_name (or language_code)' },
    }, required: ['tasks'] },
    categories: ['read'],
  },
  // ── Wallet and token intelligence (Nansen behind it) ────────────────────
  {
    name: 'wallet_token_balances',
    description: 'What a wallet holds now on one chain, with spam filtered out, sorted and paged',
    inputSchema: { type: 'object', properties: {
      address: { type: 'string', description: 'Wallet address' },
      chain: { type: 'string', description: 'Chain, e.g. "ethereum", "base", "solana"' },
      entity_name: { type: 'string', description: 'A named entity instead of an address' },
      filters: { type: 'object', description: 'Value and token filters' },
      hide_spam_token: { type: 'boolean', description: 'Leave out tokens flagged as spam' },
      order_by: { type: 'array', items: { type: 'object' }, description: 'Sort instructions' },
      pagination: { type: 'object', description: 'Page and page size' },
    }, required: ['chain'] },
    categories: ['read'],
  },
  {
    name: 'wallet_balance_history',
    description: 'What a wallet held over a date range on one chain',
    inputSchema: { type: 'object', properties: {
      address: { type: 'string', description: 'Wallet address' },
      chain: { type: 'string', description: 'Chain, e.g. "ethereum"' },
      date: { type: 'object', description: 'From and to dates' },
      entity_name: { type: 'string', description: 'A named entity instead of an address' },
      filters: { type: 'object', description: 'Value and token filters' },
      order_by: { type: 'array', items: { type: 'object' }, description: 'Sort instructions' },
      pagination: { type: 'object', description: 'Page and page size' },
    }, required: ['chain', 'date'] },
    categories: ['read'],
  },
  {
    name: 'wallet_token_pnl',
    description: 'Realised and unrealised profit and loss per token for a wallet on one chain',
    inputSchema: { type: 'object', properties: {
      address: { type: 'string', description: 'Wallet address' },
      entity_name: { type: 'string', description: 'A named entity instead of an address' },
      chain: { type: 'string', description: 'Chain, e.g. "ethereum"' },
      date: { type: 'object', description: 'From and to dates' },
      filters: { type: 'object', description: 'Value and token filters' },
      pagination: { type: 'object', description: 'Page and page size' },
      order_by: { type: 'array', items: { type: 'object' }, description: 'Sort instructions' },
    }, required: ['chain'] },
    categories: ['read'],
  },
  {
    name: 'wallet_pnl_summary',
    description: 'One wallet\'s overall profit and loss on a chain over a date range',
    inputSchema: { type: 'object', properties: {
      address: { type: 'string', description: 'Wallet address' },
      chain: { type: 'string', description: 'Chain, e.g. "ethereum"' },
      date: { type: 'object', description: 'From and to dates' },
      entity_name: { type: 'string', description: 'A named entity instead of an address' },
    }, required: ['chain', 'date'] },
    categories: ['read'],
  },
  {
    name: 'wallet_related_addresses',
    description: 'Wallets related to a given address on one chain',
    inputSchema: { type: 'object', properties: {
      address: { type: 'string', description: 'Wallet address' },
      chain: { type: 'string', description: 'Chain, e.g. "ethereum"' },
      order_by: { type: 'array', items: { type: 'object' }, description: 'Sort instructions' },
      pagination: { type: 'object', description: 'Page and page size' },
    }, required: ['address', 'chain'] },
    categories: ['read'],
  },
  {
    name: 'wallet_transactions',
    description: 'A wallet\'s on-chain transactions over a date range, with volume filters and spam removed',
    inputSchema: { type: 'object', properties: {
      address: { type: 'string', description: 'Wallet address' },
      chain: { type: 'string', description: 'Chain, e.g. "ethereum"' },
      date: { type: 'object', description: 'From and to dates' },
      filters: { type: 'object', description: 'Volume and token filters' },
      hide_spam_token: { type: 'boolean', description: 'Leave out tokens flagged as spam' },
      order_by: { type: 'array', items: { type: 'object' }, description: 'Sort instructions' },
      pagination: { type: 'object', description: 'Page and page size' },
    }, required: ['address', 'chain', 'date'] },
    categories: ['read'],
  },
  {
    name: 'token_flow_analysis',
    description: 'Inflows and outflows for one token over a date range, optionally narrowed to a labelled cohort such as the wallets a provider marks as informed money',
    inputSchema: { type: 'object', properties: {
      chain: { type: 'string', description: 'Chain, e.g. "ethereum"' },
      date: { type: 'object', description: 'From and to dates' },
      filters: { type: 'object', description: 'Volume filters' },
      label: { type: 'string', description: 'Cohort label to narrow to' },
      order_by: { type: 'array', items: { type: 'object' }, description: 'Sort instructions' },
      pagination: { type: 'object', description: 'Page and page size' },
      token_address: { type: 'string', description: 'Token contract address' },
    }, required: ['chain', 'date', 'token_address'] },
    categories: ['read'],
  },
  {
    name: 'token_buyers_and_sellers',
    description: 'Which wallets bought or sold a token over a date range, with trade-volume and cohort filters',
    inputSchema: { type: 'object', properties: {
      buy_or_sell: { type: 'string', description: 'Narrow to buyers or to sellers' },
      chain: { type: 'string', description: 'Chain, e.g. "ethereum"' },
      date: { type: 'object', description: 'From and to dates' },
      filters: { type: 'object', description: 'Trade-volume filters' },
      order_by: { type: 'array', items: { type: 'object' }, description: 'Sort instructions' },
      pagination: { type: 'object', description: 'Page and page size' },
      token_address: { type: 'string', description: 'Token contract address' },
    }, required: ['chain', 'date', 'token_address'] },
    categories: ['read'],
  },
  // ── Prediction and event markets, and market signals ────────────────────
  {
    name: 'event_contract_markets',
    description: 'Regulated event-contract markets with price, open interest and volume filters',
    inputSchema: { type: 'object', properties: {
      status: { type: 'string', description: 'Market status to include' },
      min_price: { type: 'number', description: 'Lowest contract price' },
      max_price: { type: 'number', description: 'Highest contract price' },
      min_open_interest: { type: 'number', description: 'Least open interest' },
      min_volume: { type: 'number', description: 'Least traded volume' },
      search: { type: 'string', description: 'Free-text match on the question' },
      ticker: { type: 'array', items: { type: 'string' }, description: 'Only these market tickers' },
      event_ticker: { type: 'array', items: { type: 'string' }, description: 'Only these event tickers' },
      series_ticker: { type: 'array', items: { type: 'string' }, description: 'Only these series tickers' },
      sort: { type: 'string', description: 'Sort order' },
      limit: { type: 'integer', description: 'Rows to return' },
      pagination_key: { type: 'string', description: 'Continue a previous page' },
    } },
    categories: ['read'],
  },
  {
    name: 'prediction_market_events',
    description: 'Prediction-market events with their markets, filtered by status, category, tag or volume',
    inputSchema: { type: 'object', properties: {
      status: { type: 'string', description: 'Event status to include' },
      category: { type: 'string', description: 'Only this category' },
      search: { type: 'string', description: 'Free-text match' },
      slug: { type: 'array', items: { type: 'string' }, description: 'Only these event slugs' },
      tag: { type: 'array', items: { type: 'string' }, description: 'Only these tags' },
      sort: { type: 'string', description: 'Sort order' },
      limit: { type: 'integer', description: 'Rows to return' },
      offset: { type: 'integer', description: 'Rows to skip' },
      include_markets: { type: 'boolean', description: 'Include each event\'s markets' },
      markets_per_event: { type: 'integer', description: 'How many markets an event may carry' },
      min_volume: { type: 'number', description: 'Least traded volume' },
      min_open_interest: { type: 'number', description: 'Least open interest' },
    } },
    categories: ['read'],
  },
  {
    name: 'prediction_market_traders',
    description: 'The leaderboard of the best-performing prediction-market wallets',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'prediction_market_quotes',
    description: 'Individual prediction-market contracts with price, open interest, volume and trade-count filters',
    inputSchema: { type: 'object', properties: {
      status: { type: 'string', description: 'Market status to include' },
      min_price: { type: 'number', description: 'Lowest contract price' },
      max_price: { type: 'number', description: 'Highest contract price' },
      min_open_interest: { type: 'number', description: 'Least open interest' },
      min_volume: { type: 'number', description: 'Least traded volume' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Only these tags' },
      event_slug: { type: 'array', items: { type: 'string' }, description: 'Only markets of these events' },
      search: { type: 'string', description: 'Free-text match on the question' },
      end_after: { type: 'integer', description: 'Only markets ending after this unix time' },
      end_before: { type: 'integer', description: 'Only markets ending before this unix time' },
      sort: { type: 'string', description: 'Sort order' },
      limit: { type: 'integer', description: 'Rows to return' },
      offset: { type: 'integer', description: 'Rows to skip' },
      min_volume_1d: { type: 'number', description: 'Least volume in a day' },
      min_volume_7d: { type: 'number', description: 'Least volume in a week' },
      min_volume_30d: { type: 'number', description: 'Least volume in a month' },
    } },
    categories: ['read'],
  },
  {
    name: 'us_stock_symbols',
    description: 'The list of covered United States stock symbols, and the route templates for their realtime and historical quotes',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'crypto_fear_greed_index',
    description: 'The crypto fear-and-greed score from 0 to 100, with funding sentiment and open-interest context alongside it',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'bitcoin_price_forecast',
    description: 'The current Bitcoin price and a model forecast for it: probability of a rise, expected close and a prediction band',
    inputSchema: { type: 'object', properties: {
      horizon: { type: 'string', description: 'How far ahead to forecast' },
    } },
    categories: ['read'],
  },
  // ── Exchange rates and commodity prices (Pyth feeds behind it, listed
  // FREE by the source, so these cost the platform and the customer nothing).
  // The two price reads are the source's latest DAILY CLOSE with its own
  // source and timestamp beside it: a delayed feed, never a realtime quote,
  // which is what the names and descriptions say. Symbols are hyphenated
  // ("EUR-USD", "XAU-USD" for gold) and each directory is how to find them.
  {
    name: 'currency_daily_exchange_rate',
    description: 'The daily closing exchange rate for one currency pair',
    inputSchema: { type: 'object', properties: {
      symbol: { type: 'string', description: 'The pair as BASE-USD. The free feed covers "EUR-USD", "GBP-USD" and "AUD-USD" only; anything else, including every cross pair, answers that it is not served' },
      session: { type: 'string', description: 'Which trading session to read: "regular" or "extended"' },
    }, required: ['symbol'] },
    categories: ['read'],
  },
  {
    name: 'commodity_daily_price',
    description: 'The daily closing price for one commodity',
    inputSchema: { type: 'object', properties: {
      symbol: { type: 'string', description: 'The commodity as BASE-USD. The free feed covers "XAU-USD" (gold) and "XAG-USD" (silver) only; platinum, palladium and the base metals answer that they are not served' },
      session: { type: 'string', description: 'Which trading session to read: "regular" or "extended"' },
    }, required: ['symbol'] },
    categories: ['read'],
  },
];

/** Locus catalog slug behind each function and Locus's listed base price in
 *  USD. Tiered endpoints list their floor. A pass-through entry (`mpp`) is a
 *  Locus proxy of a vendor's own API: the executor forwards the function's
 *  input as the vendor's query (or body) under the vendor's own path, and
 *  the price is the vendor's usual per-record charge, quoted at call time. */
export interface LocusDispatchEntry {
  slug: string;
  priceUsd: number;
  mpp?: { method: 'GET' | 'POST'; path: string };
}

export const LOCUS_DISPATCH: Record<string, LocusDispatchEntry> = {
  people_search: { slug: 'apollo/people-search', priceUsd: 0.005 },
  people_enrich: { slug: 'apollo/people-enrichment', priceUsd: 0.038 },
  company_search: { slug: 'apollo/org-search', priceUsd: 0.005 },
  company_enrich: { slug: 'apollo/org-enrichment', priceUsd: 0.038 },
  company_job_postings: { slug: 'apollo/job-postings', priceUsd: 0.005 },
  email_find: { slug: 'hunter/email-finder', priceUsd: 0.013 },
  email_verify: { slug: 'hunter/email-verifier', priceUsd: 0.008 },
  domain_emails: { slug: 'hunter/domain-search', priceUsd: 0.013 },
  person_profile_enrich: { slug: 'mpp-orth-peopledatalabs/call', priceUsd: 0.28, mpp: { method: 'GET', path: '/v5/person/enrich' } },
  company_profile_enrich: { slug: 'mpp-orth-peopledatalabs/call', priceUsd: 0.1, mpp: { method: 'GET', path: '/v5/company/enrich' } },
  linkedin_contact_details: { slug: 'mpp-orth-contactout/call', priceUsd: 0.1, mpp: { method: 'GET', path: '/v1/people/linkedin' } },
  startup_search: { slug: 'parse-crunchbase-com-api-08842cc1/search_organizations', priceUsd: 0.0505 },
  startup_profile: { slug: 'parse-crunchbase-com-api-08842cc1/get_organization_profile', priceUsd: 0.0505 },
  startup_funding_rounds: { slug: 'parse-crunchbase-com-api-08842cc1/get_company_funding_rounds', priceUsd: 0.0505 },
  startup_people: { slug: 'parse-crunchbase-com-api-08842cc1/get_company_people', priceUsd: 0.0505 },
  investor_search: { slug: 'parse-crunchbase-com-api-08842cc1/search_investors', priceUsd: 0.0505 },
  stock_key_statistics: { slug: 'parse-finance-yahoo-com-api-9d24fafd/get_stock_stats', priceUsd: 0.075752 },
  fund_top_holdings: { slug: 'parse-finance-yahoo-com-api-9d24fafd/get_holdings', priceUsd: 0.02525 },
  ticker_lookup: { slug: 'parse-finance-yahoo-com-api-9d24fafd/search_ticker', priceUsd: 0.02525 },
  web_page_scrape: { slug: 'firecrawl/scrape', priceUsd: 0.003 },
  web_search_results: { slug: 'firecrawl/search', priceUsd: 0.00466 },
  web_site_map: { slug: 'firecrawl/map', priceUsd: 0.00383 },
  // Exa's own x402 API through Locus: the listed prices are Exa's ($1 per
  // thousand pages, $5 per thousand auto searches); the charge Locus reports
  // on the response is what is booked.
  web_page_text: { slug: 'x402-api-exa-ai-contents/call', priceUsd: 0.001 },
  web_semantic_search: { slug: 'x402-api-exa-ai-search/call', priceUsd: 0.005 },
  // Crypto market data through Locus's own CoinGecko lane, at its listed price.
  crypto_price_now: { slug: 'coingecko/simple-price', priceUsd: 0.0505 },
  crypto_token_price_by_contract: { slug: 'coingecko/simple-token-price', priceUsd: 0.0505 },
  crypto_market_table: { slug: 'coingecko/coins-markets', priceUsd: 0.0505 },
  crypto_coin_profile: { slug: 'coingecko/coin-data', priceUsd: 0.0505 },
  crypto_coin_directory: { slug: 'coingecko/coins-list', priceUsd: 0.0505 },
  crypto_search: { slug: 'coingecko/search', priceUsd: 0.0505 },
  crypto_trending: { slug: 'coingecko/trending', priceUsd: 0.0505 },
  crypto_exchange_rates: { slug: 'coingecko/exchange-rates', priceUsd: 0.0505 },
  crypto_global_market: { slug: 'coingecko/global', priceUsd: 0.0505 },
  crypto_global_defi_market: { slug: 'coingecko/global-defi', priceUsd: 0.0505 },
  crypto_price_history: { slug: 'coingecko/market-chart', priceUsd: 0.0505 },
  crypto_price_on_date: { slug: 'coingecko/coin-history', priceUsd: 0.0505 },
  crypto_categories: { slug: 'coingecko/categories', priceUsd: 0.0505 },
  crypto_top_movers: { slug: 'coingecko/top-gainers-losers', priceUsd: 0.0505 },
  crypto_exchanges: { slug: 'coingecko/exchanges', priceUsd: 0.0505 },
  // Search-engine and keyword data. Both are priced per TASK by the vendor
  // ($0.005 for ten results, $0.093 for up to a thousand keywords), which is
  // what stands in if Locus ever reports no charge.
  search_ranking_results: { slug: 'dataforseo/serp-google-organic', priceUsd: 0.005 },
  keyword_search_volume: { slug: 'dataforseo/search-volume', priceUsd: 0.093 },
  // Wallet, token and market lanes Locus resells over x402. Locus prices these
  // live per call and reports the charge on the burn, so the figures below are
  // only the floor used when it reports none. They are deliberately a round
  // cent rather than a guess at a vendor list price none of these publish:
  // over-recording a rare unreported call is the safe direction, because the
  // alternative is booking a paid call as free.
  wallet_token_balances: { slug: 'x402-api-nansen-ai-api-v1-profiler-address-current-balance/call', priceUsd: 0.01 },
  wallet_balance_history: { slug: 'x402-api-nansen-ai-api-v1-profiler-address-historical-balances/call', priceUsd: 0.01 },
  wallet_token_pnl: { slug: 'x402-api-nansen-ai-api-v1-profiler-address-pnl/call', priceUsd: 0.01 },
  wallet_pnl_summary: { slug: 'x402-api-nansen-ai-api-v1-profiler-address-pnl-summary/call', priceUsd: 0.01 },
  wallet_related_addresses: { slug: 'x402-api-nansen-ai-api-v1-profiler-address-related-wallets/call', priceUsd: 0.01 },
  wallet_transactions: { slug: 'x402-api-nansen-ai-api-v1-profiler-address-transactions/call', priceUsd: 0.01 },
  token_flow_analysis: { slug: 'x402-api-nansen-ai-api-v1-tgm-flows/call', priceUsd: 0.01 },
  token_buyers_and_sellers: { slug: 'x402-api-nansen-ai-api-v1-tgm-who-bought-sold/call', priceUsd: 0.01 },
  event_contract_markets: { slug: 'x402-blockrun-ai-api-v1-pm-kalshi-markets/call', priceUsd: 0.01 },
  prediction_market_events: { slug: 'x402-blockrun-ai-api-v1-pm-polymarket-events/call', priceUsd: 0.01 },
  prediction_market_traders: { slug: 'x402-blockrun-ai-api-v1-pm-polymarket-leaderboard/call', priceUsd: 0.01 },
  prediction_market_quotes: { slug: 'x402-blockrun-ai-api-v1-pm-polymarket-markets/call', priceUsd: 0.01 },
  crypto_fear_greed_index: { slug: 'x402-kronossignals-com-api-v1-fear-greed/call', priceUsd: 0.01 },
  bitcoin_price_forecast: { slug: 'x402-kronossignals-com-api-v1-forecast-btc/call', priceUsd: 0.01 },
  // Listed free by the source; the charge Locus reports still wins if it ever
  // reports one.
  us_stock_symbols: { slug: 'x402-blockrun-public-usstock-list/call', priceUsd: 0 },
  currency_daily_exchange_rate: { slug: 'x402-blockrun-fx-price-symbol/call', priceUsd: 0 },
  commodity_daily_price: { slug: 'x402-blockrun-commodity-price-symbol/call', priceUsd: 0 },
};
