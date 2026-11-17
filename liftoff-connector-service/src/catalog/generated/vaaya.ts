// FALLBACK-AUTHORED registry functions — Vaaya, an aggregator that resells
// enrichment, signal and public-records vendors per call on one prepaid
// balance (vaaya.ai/api/catalog, read live 2026-09-20: 1,607 priced rows).
// CURATED to the needs the platform cannot serve on a vendor of its own:
// an email from a LinkedIn profile and reverse enrichment from an email
// (Tomba; its email find, verify and domain listing are left out — the
// locus card serves the same reads at a third of the price), funding / M&A / hiring / executive-move signals (Signalbase), SEC
// EDGAR, USPTO and CourtListener records. Function names are the CAPABILITY, never the
// vendor behind it: the model must not learn which supplier answers. Each
// name below is a case in src/clients/vaaya.ts (VAAYA_DISPATCH) and the
// listed price is Vaaya's whole-cent price, which seeds the per-call
// ceiling (×2) and is what the customer's Operating Units are drawn from.
// All read-only. Add a function by extending BOTH lists here and seeding
// its classification in platform-backend.

import type { ConnectorFunction } from '../../types.js';

/** The filters the four signal functions share. */
const SIGNAL_FILTERS = {
  limit: { type: 'integer', description: 'Most results to return (1–100)' },
  date_preset: { type: 'string', description: "A relative window, e.g. 'last_7_days', 'last_30_days'" },
  dateFrom: { type: 'string', description: 'Start date YYYY-MM-DD' },
  dateTo: { type: 'string', description: 'End date YYYY-MM-DD' },
  countries: { type: 'string', description: 'Comma-separated ISO country codes to include' },
  exclude_countries: { type: 'string', description: 'Comma-separated ISO country codes to exclude' },
  page: { type: 'integer', description: 'Page number, from 1' },
};

export const VAAYA_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'linkedin_email',
    description: "Reveal the professional email behind a person's LinkedIn profile URL",
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'LinkedIn profile URL' } },
      required: ['url'],
    },
    categories: ['read'],
  },
  {
    name: 'person_from_email',
    description: 'Enrich an email address into the person and company behind it: name, title, company, social profiles',
    inputSchema: {
      type: 'object',
      properties: { email: { type: 'string', description: 'The email address to enrich' } },
      required: ['email'],
    },
    categories: ['read'],
  },
  {
    name: 'funding_rounds',
    description: 'Recent funding rounds: who raised, how much, which round and from which investors, with sources',
    inputSchema: { type: 'object', properties: SIGNAL_FILTERS },
    categories: ['read'],
  },
  {
    name: 'acquisitions',
    description: 'Recent acquisitions: acquirer, target, terms where disclosed, with sources',
    inputSchema: { type: 'object', properties: SIGNAL_FILTERS },
    categories: ['read'],
  },
  {
    name: 'hiring_signals',
    description: 'Companies hiring now: open positions with counts, by country and date',
    inputSchema: { type: 'object', properties: SIGNAL_FILTERS },
    categories: ['read'],
  },
  {
    name: 'executive_moves',
    description: 'Executive job changes and role transitions, with sources',
    inputSchema: { type: 'object', properties: SIGNAL_FILTERS },
    categories: ['read'],
  },
  {
    name: 'sec_filings_search',
    description: 'Full-text search across SEC EDGAR filings (2001 onward), optionally by form type and date range',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search phrase' },
        forms: { type: 'string', description: 'Comma-separated form types, e.g. 10-K,8-K' },
        startdt: { type: 'string', description: 'Start date YYYY-MM-DD' },
        enddt: { type: 'string', description: 'End date YYYY-MM-DD' },
      },
      required: ['q'],
    },
    categories: ['read'],
  },
  {
    name: 'sec_company_filings',
    description: "One company's SEC filing history by CIK",
    inputSchema: {
      type: 'object',
      properties: { cik: { type: 'string', description: 'SEC Central Index Key' } },
      required: ['cik'],
    },
    categories: ['read'],
  },
  {
    name: 'patent_search',
    description: 'Search US patent applications and grants by text and date',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search phrase' },
        date_gte: { type: 'string', description: 'Earliest date YYYY-MM-DD' },
        date_lte: { type: 'string', description: 'Latest date YYYY-MM-DD' },
        limit: { type: 'integer', description: 'Most results to return' },
      },
      required: ['q'],
    },
    categories: ['read'],
  },
  {
    name: 'court_opinions_search',
    description: 'Search US court opinions by text, court, judge, party or docket number',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search phrase' },
        court: { type: 'string', description: 'Court identifier' },
        party_name: { type: 'string', description: 'A party to the case' },
        docket_number: { type: 'string', description: 'Docket number' },
        filed_after: { type: 'string', description: 'Filed on or after YYYY-MM-DD' },
        filed_before: { type: 'string', description: 'Filed on or before YYYY-MM-DD' },
      },
      required: ['q'],
    },
    categories: ['read'],
  },
  // ── Prediction and event markets ────────────────────────────────────────
  // One upstream rung serving several venues; each function pins its own path
  // (see VAAYA_DISPATCH `fixed`). Every one is a public read at a cent a call,
  // and the rung is reached on the aggregator's prepaid balance -- it settles
  // with the venue over x402 on ITS wallet, not the platform's.
  {
    name: 'event_contract_listings',
    description: 'Regulated event contracts open for trading, with their question, series and current pricing',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'prediction_market_listings',
    description: 'Open prediction markets on a chain-settled venue, with their questions and current odds',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'opinion_market_listings',
    description: 'Open opinion markets, where the contract is a view rather than a measurable outcome',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'prediction_contest_listings',
    description: 'Open contest-style prediction markets, with their questions and current pricing',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'prediction_market_board',
    description: 'The full board of open prediction markets on the largest chain-settled venue, with prices, volume and open interest',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'prediction_market_page',
    description: 'One page of the prediction-market board, for walking the whole board without re-reading it',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'prediction_event_board',
    description: 'Prediction-market events -- the real-world happenings the individual markets hang off',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'prediction_event_page',
    description: 'One page of the prediction-market event list, for walking it without re-reading it',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'prediction_market_leaders',
    description: 'The best-performing wallets on the prediction-market venue, by profit and by volume',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'prediction_market_positions',
    description: 'Open positions held across the prediction-market venue',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'prediction_market_trades',
    description: 'Recent trades on the prediction-market venue',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'prediction_trader_cohorts',
    description: 'How groups of prediction-market traders behave and perform, grouped by the venue',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'crypto_updown_markets',
    description: 'Short-dated markets on whether a crypto asset finishes a period up or down',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  // ── Private-company intelligence ────────────────────────────────────────
  // One upstream rung over a private-company database: the firmographic
  // profile and, beside it, the observable signals a person uses to read a
  // company from outside -- who reviews it, how many people work there, how
  // its site is visited, what it is hiring for, what it posts. The two
  // resolvers are free and exist because every other call here takes a domain
  // or the database's own id. Each was called once before being written down,
  // and all ten answered.
  {
    name: 'private_company_resolve',
    description: "Resolve a company name, domain or identifier to a private-company record, for the calls that need one",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Company name, domain or identifier' } },
      required: ['query'],
    },
    categories: ['read'],
  },
  {
    name: 'industry_taxonomy_resolve',
    description: "Resolve a free-text industry or topic to the exact industry terms a company search accepts",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: "An industry or topic in plain words, e.g. 'warehouse automation'" } },
      required: ['query'],
    },
    categories: ['read'],
  },
  {
    name: 'private_company_profile',
    description: 'A private company profile by domain or identifier, in the sections asked for: firmographics, business model, product, technology, management, strategy, customers, industry, hierarchy, digital presence, financial estimates, location, funding and acquisitions',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company domain or identifier' },
        sections: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['firmographic', 'business_model', 'company_assessment', 'product_offering', 'technology', 'management_profile', 'strategic_signal', 'customer_profile', 'industry', 'trust_signal', 'company_hierarchy', 'digital_presence', 'financial_estimate', 'location', 'funding_detail', 'mna_and_investment'],
          },
          description: 'The sections to return. Ask only for what the task needs; each one costs.',
        },
      },
      required: ['company', 'sections'],
    },
    categories: ['read'],
  },
  {
    name: 'company_news',
    description: 'Company and industry news, de-duplicated and resolved to the company it is about, with sentiment and a summary',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company domain or identifier' },
        industry: { type: 'string', description: 'An industry term, as an alternative to a company' },
        query: { type: 'string', description: 'Free-text search over the headlines' },
        sentiment_list: { type: 'array', items: { type: 'string', enum: ['positive', 'negative', 'neutral'] }, description: 'Keep only these sentiments' },
        start_date: { type: 'string', description: 'Published on or after YYYY-MM-DD' },
        limit: { type: 'integer', description: 'Most results to return (1-100)' },
        offset: { type: 'integer', description: 'How many to skip, for paging' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'employer_reviews',
    description: 'What people who worked at a company say about it: overall rating, the rated sub-scores, and the pros and cons they wrote',
    inputSchema: {
      type: 'object',
      properties: { company: { type: 'string', description: 'Company domain or identifier' } },
      required: ['company'],
    },
    categories: ['read'],
  },
  {
    name: 'product_reviews',
    description: "Reviews of a company's own products: rating, star distribution and the review text, by product",
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company domain or identifier' },
        products: { type: 'array', items: { type: 'string' }, description: 'Limit to these product names' },
      },
      required: ['company'],
    },
    categories: ['read'],
  },
  {
    name: 'company_headcount_trends',
    description: 'How a company\'s workforce has moved: total headcount now and the percentage change over the trailing periods',
    inputSchema: {
      type: 'object',
      properties: { company: { type: 'string', description: 'Company domain or identifier' } },
      required: ['company'],
    },
    categories: ['read'],
  },
  {
    name: 'company_website_traffic',
    description: "Estimated traffic to a company's website: monthly visits, bounce rate, pages per visit and time on site",
    inputSchema: {
      type: 'object',
      properties: { company: { type: 'string', description: 'Company domain or identifier' } },
      required: ['company'],
    },
    categories: ['read'],
  },
  {
    name: 'company_job_posts',
    description: 'A company\'s live job posts: title, location, date posted and the link to apply',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company domain or identifier' },
        limit: { type: 'integer', description: 'Most results to return (1-100)' },
        offset: { type: 'integer', description: 'How many to skip, for paging' },
      },
      required: ['company'],
    },
    categories: ['read'],
  },
  {
    name: 'company_social_posts',
    description: 'What a company has posted on social platforms lately, with the engagement each post drew',
    inputSchema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company domain or identifier' },
        limit: { type: 'integer', description: 'Most results to return (1-100)' },
        offset: { type: 'integer', description: 'How many to skip, for paging' },
      },
      required: ['company'],
    },
    categories: ['read'],
  },
  // ── Venture funding records ─────────────────────────────────────────────
  // A second upstream rung, over a venture funding database. The round is the
  // unit: who raised, how much, from whom, and every round a company, a firm
  // or a person has been part of. The five resolvers cost a cent each and
  // exist because the detail calls take this database's own identifiers and
  // permalinks, not names. All eleven answered a live call.
  {
    name: 'venture_rounds_search',
    description: 'Search venture funding rounds: the company, round type, amount raised, date and a written summary of the round',
    inputSchema: {
      type: 'object',
      properties: {
        page_size: { type: 'integer', description: 'Rounds per page (1-25)' },
        page: { type: 'integer', description: 'Page number, from 0' },
      },
      required: ['page_size'],
    },
    categories: ['read'],
  },
  {
    name: 'venture_company_profile',
    description: 'One venture-backed company profile with its latest funding round and the investors who took part',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: "The company's identifier from a company resolve" },
        domain: { type: 'string', description: 'Company domain' },
        linkedin: { type: 'string', description: 'Company LinkedIn URL' },
        crunchbase: { type: 'string', description: 'Company Crunchbase URL' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'company_funding_history',
    description: 'Every funding round one company has raised, oldest to newest, with amounts and round types',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: "The company's identifier from a company resolve" },
        domain: { type: 'string', description: 'Company domain' },
        linkedin: { type: 'string', description: 'Company LinkedIn URL' },
        crunchbase: { type: 'string', description: 'Company Crunchbase URL' },
        page_size: { type: 'integer', description: 'Rounds per page (1-25)' },
        page: { type: 'integer', description: 'Page number, from 0' },
      },
      required: ['page_size'],
    },
    categories: ['read'],
  },
  {
    name: 'funding_round_investors',
    description: 'The full investor lineup for one funding round, saying which firm led it',
    inputSchema: {
      type: 'object',
      properties: { deal_id: { type: 'string', description: "The round's identifier, from a rounds search" } },
      required: ['deal_id'],
    },
    categories: ['read'],
  },
  {
    name: 'investor_deal_history',
    description: 'Every funding round one investment firm has taken part in, with the company, amount and date',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: "The firm's identifier from an investor resolve" },
        permalink: { type: 'string', description: "The firm's permalink" },
        domain: { type: 'string', description: 'Firm domain' },
        linkedin: { type: 'string', description: 'Firm LinkedIn URL' },
        crunchbase: { type: 'string', description: 'Firm Crunchbase URL' },
        page_size: { type: 'integer', description: 'Rounds per page (1-25)' },
        page: { type: 'integer', description: 'Page number, from 0' },
      },
      required: ['page_size'],
    },
    categories: ['read'],
  },
  {
    name: 'person_investment_history',
    description: 'Every funding round one person has invested in, with the company, amount and date',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: "The person's identifier from a person resolve" },
        linkedin: { type: 'string', description: 'Person LinkedIn URL' },
        crunchbase: { type: 'string', description: 'Person Crunchbase URL' },
        twitter: { type: 'string', description: 'Person X or Twitter URL' },
        page_size: { type: 'integer', description: 'Rounds per page (1-25)' },
        page: { type: 'integer', description: 'Page number, from 0' },
      },
      required: ['page_size'],
    },
    categories: ['read'],
  },
  {
    name: 'venture_company_resolve',
    description: 'Resolve a company name to the identifier the funding-record calls take',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Company name' },
        domain: { type: 'string', description: 'Company domain, if known' },
      },
    },
    categories: ['read'],
  },
  {
    name: 'investor_resolve',
    description: 'Resolve an investment firm or fund name to the identifier the funding-record calls take',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Firm or fund name' } },
    },
    categories: ['read'],
  },
  {
    name: 'investor_person_resolve',
    description: 'Resolve a person to the identifier the investing-history call takes',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: "The person's name" } },
    },
    categories: ['read'],
  },
  {
    name: 'venture_industry_resolve',
    description: 'Resolve an industry or super-category name to the exact term a funding-round search accepts',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Industry or category name' } },
      required: ['name'],
    },
    categories: ['read'],
  },
  {
    name: 'venture_location_resolve',
    description: 'Resolve a place name to the exact term a funding-round search accepts',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'City, region or country name' } },
      required: ['name'],
    },
    categories: ['read'],
  },
  // ── Prediction markets: the board, the book, and who is trading ─────────
  // The second half of the same upstream rung. The thirteen above list what
  // is open; these nineteen say what a market is doing and who is doing it --
  // the order book, open interest, the price and volume of one contract, and
  // the wallet-level reads (a trader's positions, profit and loss, the
  // markets they touch, the wallets that behave like theirs). The supplier
  // retired its broken routes and republished 34 working ones;
  // every one of these was called before it was written down, and all 34 of
  // them answer. The two that looked broken were not: one wants the market's
  // condition identifier rather than its question identifier and only has a
  // record while the market is unsettled, and the other refuses any filter
  // below thresholds its error states but its schema does not.
  {
    name: 'prediction_market_search',
    description: 'Search open markets across every prediction venue at once, by question text, with each result saying which venue it is on',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: 'Words to look for in the question' } },
      required: ['q'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_market_orderbook',
    description: 'The order book for one prediction contract over a window: resting bids and asks and how they moved',
    inputSchema: {
      type: 'object',
      properties: {
        token_id: { type: 'string', description: "The contract's token identifier, from a market listing's outcomes" },
        start_time: { type: 'integer', description: 'Window start, Unix seconds' },
        end_time: { type: 'integer', description: 'Window end, Unix seconds' },
      },
      required: ['token_id', 'start_time', 'end_time'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_contract_price',
    description: 'The current price of one prediction contract',
    inputSchema: {
      type: 'object',
      properties: { token_id: { type: 'string', description: "The contract's token identifier" } },
      required: ['token_id'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_contract_volume',
    description: 'How much has traded on one prediction contract',
    inputSchema: {
      type: 'object',
      properties: { token_id: { type: 'string', description: "The contract's token identifier" } },
      required: ['token_id'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_market_open_interest',
    description: 'Open interest on one prediction market: how much money is still riding on the outcome',
    inputSchema: {
      type: 'object',
      properties: { hash: { type: 'string', description: "The market's condition identifier, from a market listing" } },
      required: ['hash'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_market_volume_history',
    description: 'Traded volume on one prediction market over a window, as a series',
    inputSchema: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: "The market's condition identifier" },
        start_time: { type: 'integer', description: 'Window start, Unix seconds' },
        end_time: { type: 'integer', description: 'Window end, Unix seconds' },
      },
      required: ['hash', 'start_time', 'end_time'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_market_top_traders',
    description: 'The traders with the largest positions or profit on one prediction market',
    inputSchema: {
      type: 'object',
      properties: { hash: { type: 'string', description: "The market's condition identifier" } },
      required: ['hash'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_trader_activity',
    description: 'What one trader has done lately: the trades they placed and the markets they placed them on',
    inputSchema: {
      type: 'object',
      properties: { wallet: { type: 'string', description: "The trader's wallet address" } },
      required: ['wallet'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_trader_pnl',
    description: "One trader's profit and loss over time, at the granularity asked for",
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "The trader's wallet address" },
        granularity: { type: 'string', description: "Bucket size, e.g. 'day' or 'hour'" },
      },
      required: ['address', 'granularity'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_trader_volume_history',
    description: 'How much one trader has traded over a window, as a series',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "The trader's wallet address" },
        start_time: { type: 'integer', description: 'Window start, Unix seconds' },
        end_time: { type: 'integer', description: 'Window end, Unix seconds' },
      },
      required: ['address', 'start_time', 'end_time'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_trader_markets',
    description: 'The prediction markets one trader has taken a position on',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: "The trader's wallet address" } },
      required: ['address'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_trader_identity',
    description: 'What is publicly known about one trading wallet: its handle, and how it is labelled',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: "The trader's wallet address" } },
      required: ['address'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_trader_identities',
    description: 'What is publicly known about many trading wallets at once, for reading a leaderboard without a call per row',
    inputSchema: {
      type: 'object',
      properties: {
        addresses: { type: 'array', items: { type: 'string' }, description: 'The wallet addresses to look up' },
      },
      required: ['addresses'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_trader_cluster',
    description: 'The cluster one trading wallet belongs to, for telling one person running several wallets from several people',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: "The trader's wallet address" } },
      required: ['address'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_similar_traders',
    description: 'Wallets that trade like this one, by the markets they pick and how they size positions',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string', description: "The trader's wallet address" } },
      required: ['address'],
    },
    categories: ['read'],
  },
  {
    name: 'event_contract_orderbook',
    description: 'The order book for one regulated event contract over a window',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: "The contract's ticker" },
        start_time: { type: 'integer', description: 'Window start, Unix seconds' },
        end_time: { type: 'integer', description: 'Window end, Unix seconds' },
      },
      required: ['ticker', 'start_time', 'end_time'],
    },
    categories: ['read'],
  },
  {
    name: 'event_contract_trades',
    description: 'Executed trades on regulated event contracts, for one contract or one event',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: "One contract's ticker" },
        event_ticker: { type: 'string', description: "One event's ticker, for every contract under it" },
      },
    },
    categories: ['read'],
  },
  {
    name: 'crypto_price_candles',
    description: 'Open, high, low and close candles for one crypto trading pair at the interval asked for',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: "The trading pair, e.g. 'BTCUSDT'" },
        interval: { type: 'string', description: "Candle size, e.g. '1m', '1h', '1d'" },
      },
      required: ['symbol', 'interval'],
    },
    categories: ['read'],
  },
  {
    name: 'crypto_price_ticks',
    description: 'Individual trades on one crypto trading pair over a window',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: "The trading pair, e.g. 'BTCUSDT'" },
        start_time: { type: 'integer', description: 'Window start, Unix seconds' },
        end_time: { type: 'integer', description: 'Window end, Unix seconds' },
      },
      required: ['symbol', 'start_time', 'end_time'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_market_resolution',
    description: 'The resolution record behind one prediction market: what state it is in, whether it is paused or disputed, the bond posted, and the settled price once it has one',
    inputSchema: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: "The market's condition identifier, from a market listing. A market that has not been settled yet is the one to ask about; a long-closed market has no record to return." },
      },
      required: ['hash'],
    },
    categories: ['read'],
  },
  {
    name: 'prediction_smart_money_markets',
    description: 'The prediction markets that experienced traders are active in, where experience is defined by the threshold given',
    inputSchema: {
      type: 'object',
      properties: {
        min_volume: { type: 'number', description: 'Only traders who have traded at least this much, in dollars. The source refuses anything under 10000.' },
        min_trades: { type: 'integer', description: 'Only traders with at least this many trades. The source refuses anything under 100.' },
        min_roi: { type: 'number', description: 'Only traders at or above this return on investment, as a fraction. The source refuses anything under 0.15.' },
        min_realized_pnl: { type: 'number', description: 'Only traders with at least this much realised profit, in dollars. The source refuses anything under 5000.' },
        min_total_pnl: { type: 'number', description: 'Only traders with at least this much total profit, in dollars. The source refuses anything under 5000.' },
      },
    },
    categories: ['read'],
  },
];

/** Vaaya action behind each function and the price Vaaya lists for it in
 *  USD (whole cents). The price is the declared cost for the per-call
 *  ceiling and the customer's charge is the amount Vaaya reports back. */
/** `fixed` carries parameters the PLATFORM supplies, never the model: the
 *  market-data rung is one `fetch` action taking an upstream path, so each
 *  function here pins its own path. The client spreads these after the
 *  model's input so an argument cannot redirect the call. */
export const VAAYA_DISPATCH: Record<string, { action: string; priceUsd: number; fixed?: Record<string, unknown> }> = {
  linkedin_email: { action: 'tomba/linkedin-finder', priceUsd: 0.05 },
  person_from_email: { action: 'tomba/enrich', priceUsd: 0.04 },
  funding_rounds: { action: 'signalbase/funding', priceUsd: 0.25 },
  acquisitions: { action: 'signalbase/acquisitions', priceUsd: 0.25 },
  hiring_signals: { action: 'signalbase/hiring', priceUsd: 0.25 },
  executive_moves: { action: 'signalbase/job-changes', priceUsd: 0.25 },
  sec_filings_search: { action: 'edgar/fulltext', priceUsd: 0.01 },
  sec_company_filings: { action: 'edgar/filings', priceUsd: 0.01 },
  patent_search: { action: 'uspto/patents', priceUsd: 0.01 },
  court_opinions_search: { action: 'courtlistener/cases', priceUsd: 0.01 },
  // The prediction and event market rung. One action, `fetch`, with the
  // upstream path pinned per function so a model cannot point it elsewhere.
  // A cent a call, which is what the vendor lists and what it charged on every
  // one of these when each was called once to confirm it answers
  // -- the rung advertises 103 paths and 13 of them return data.
  event_contract_listings: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/kalshi/markets' } },
  prediction_market_listings: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/limitless/markets' } },
  opinion_market_listings: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/opinion/markets' } },
  prediction_contest_listings: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/predictfun/markets' } },
  prediction_market_board: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/markets' } },
  prediction_market_page: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/markets/keyset' } },
  prediction_event_board: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/events' } },
  prediction_event_page: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/events/keyset' } },
  prediction_market_leaders: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/leaderboard' } },
  prediction_market_positions: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/positions' } },
  prediction_market_trades: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/trades' } },
  prediction_trader_cohorts: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/cohorts/stats' } },
  crypto_updown_markets: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/crypto-updown' } },
  // ── Private-company intelligence and venture funding records ────────────
  // Two upstream rungs reached by their own named actions, so no path is
  // pinned here. The two free resolvers are free at the vendor too; the
  // prices below are what each call ACTUALLY charged when it was called once,
  // which for five of them is the first real figure -- the
  // catalog quotes those per call and lists no price.
  private_company_resolve: { action: 'akta/company-search', priceUsd: 0 },
  industry_taxonomy_resolve: { action: 'akta/industry-search', priceUsd: 0 },
  private_company_profile: { action: 'akta/company-enrich', priceUsd: 0.14 },
  company_news: { action: 'akta/news', priceUsd: 0.01 },
  employer_reviews: { action: 'akta/employee-reviews', priceUsd: 0.11 },
  product_reviews: { action: 'akta/product-reviews', priceUsd: 0.11 },
  company_headcount_trends: { action: 'akta/headcount-trends', priceUsd: 0.18 },
  company_website_traffic: { action: 'akta/website-traffic', priceUsd: 0.11 },
  company_job_posts: { action: 'akta/job-posts', priceUsd: 0.21 },
  company_social_posts: { action: 'akta/social-posts', priceUsd: 0.11 },
  venture_rounds_search: { action: 'fundable/deals', priceUsd: 0.10 },
  venture_company_profile: { action: 'fundable/company', priceUsd: 0.10 },
  company_funding_history: { action: 'fundable/company-deals', priceUsd: 0.10 },
  funding_round_investors: { action: 'fundable/deal-investors', priceUsd: 0.10 },
  investor_deal_history: { action: 'fundable/investor-deals', priceUsd: 0.10 },
  person_investment_history: { action: 'fundable/person-deals', priceUsd: 0.10 },
  venture_company_resolve: { action: 'fundable/company-search', priceUsd: 0.01 },
  investor_resolve: { action: 'fundable/investor-search', priceUsd: 0.01 },
  investor_person_resolve: { action: 'fundable/person-search', priceUsd: 0.01 },
  venture_industry_resolve: { action: 'fundable/industry-search', priceUsd: 0.01 },
  venture_location_resolve: { action: 'fundable/location-search', priceUsd: 0.01 },
  // The rest of the same rung, republished with its path
  // parameters actually substituted. The endpoint TEMPLATE is pinned here and
  // the identifier travels as an ordinary argument, so a model supplies the
  // wallet or the market but can never choose the route.
  prediction_market_search: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/markets/search' } },
  prediction_market_orderbook: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/orderbooks' } },
  prediction_contract_price: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/market-price/{token_id}' } },
  prediction_contract_volume: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/markets/{token_id}/volume' } },
  prediction_market_open_interest: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/markets/{hash}/open_interest' } },
  prediction_market_volume_history: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/volume-chart/{hash}' } },
  prediction_market_top_traders: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/leaderboard/market/{hash}' } },
  prediction_trader_activity: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/activity' } },
  prediction_trader_pnl: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/wallet/pnl/{address}' } },
  prediction_trader_volume_history: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/wallet/volume-chart/{address}' } },
  prediction_trader_markets: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/wallet/{address}/markets' } },
  prediction_trader_identity: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/wallet/identity/{address}' } },
  prediction_trader_identities: { action: 'blockrun/submit', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/wallet/identities' } },
  prediction_trader_cluster: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/wallet/{address}/cluster' } },
  prediction_similar_traders: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/wallet/{address}/similar' } },
  event_contract_orderbook: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/kalshi/orderbooks' } },
  event_contract_trades: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/kalshi/trades' } },
  crypto_price_candles: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/binance/candles/{symbol}' } },
  crypto_price_ticks: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/binance/ticks/{symbol}' } },
  // The last two of the 34. Both looked broken and were not: the resolution
  // record takes the CONDITION identifier and only an unsettled market has
  // one, and the smart-money read is refused below the source's own
  // thresholds (10000 traded, 100 trades, 0.15 return, 5000 profit), which
  // its error states and its schema does not. Each is in the argument
  // descriptions so a model does not have to learn it from a refusal.
  prediction_market_resolution: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/uma/market/{hash}' } },
  prediction_smart_money_markets: { action: 'blockrun/fetch', priceUsd: 0.01, fixed: { endpoint: '/api/v1/pm/polymarket/markets/smart-activity' } },
};
