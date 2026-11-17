import { useEffect } from 'react'
import { Helmet } from 'react-helmet-async'
import { useLocation } from 'react-router'

interface PageHeadProps {
  /** Page title — will be rendered as `Liftoff — {title}`. Omit on the homepage. */
  title?: string
  /** Meta description for this page. Falls back to the site default if omitted. */
  description?: string
  /** OG/Twitter image URL. Absolute or root-relative. Falls back to /og-image.png. */
  image?: string
  /** Optional JSON-LD structured data block to inject for this page. */
  jsonLd?: Record<string, unknown> | Record<string, unknown>[]
  /** Set to true to add a per-page noindex (e.g. for thin pages we don't want crawled). */
  noindex?: boolean
  /**
   * Use `title` verbatim instead of prefixing it with the site name. For pages whose
   * title already opens with the brand ("Liftoff vs Codex Comparison"), the default
   * prefix would duplicate it. Defaults to false, so every existing page is unchanged.
   */
  exactTitle?: boolean
}

const BASE_URL = 'https://example.com'
const SITE_NAME = 'Liftoff'
const DEFAULT_TITLE = 'Liftoff | One Sentence to a Working Agent'
// Runs past the ~160 chars a search snippet shows, so the third sentence is
// there for the OG/Twitter unfurl and for crawlers that read the whole tag
// rather than for Google results.
const DEFAULT_DESCRIPTION =
  'Describe a job, and an agent is built to own it, with its own tools, access, and your context. Hand off work, loop in people, keep going while you sleep. Accessible from Slack, Microsoft Teams, or your AI tools.'
// WebP saves ~75% over PNG. Major OG/Twitter scrapers (Facebook, LinkedIn,
// Twitter, Slack) all support WebP. og-image.png is kept on disk as a fallback.
const DEFAULT_IMAGE = '/og-image.webp'

/**
 * PageHead — sets <title>, meta description, canonical URL, OG/Twitter tags, and
 * optional JSON-LD for a page.
 *
 * Canonical URLs always use the production domain (https://example.com), regardless
 * of where the site is currently being served from, so a page reached through the
 * Cloud Run URL or a preview host still names the canonical one.
 *
 * Usage:
 *   <PageHead />                                                  // uses defaults
 *   <PageHead title="Pricing" description="..." noindex />        // any other page
 *   <PageHead title="Help Centre" jsonLd={breadcrumbSchema} />    // with structured data
 */
export function PageHead({ title, description, image, jsonLd, noindex, exactTitle }: PageHeadProps) {
  const location = useLocation()

  // Signal to @prerenderer/rollup-plugin (puppeteer) that this route has finished
  // mounting and is ready to be snapshotted to static HTML. This MUST live here
  // (not in App.tsx) so it fires AFTER any lazy-loaded route component has resolved
  // — otherwise puppeteer would snapshot an empty Suspense fallback. Real browsers
  // just dispatch the event with no listeners and ignore it.
  useEffect(() => {
    document.dispatchEvent(new Event('render-event'))
  }, [location.pathname])

  const fullTitle = title ? (exactTitle ? title : `${SITE_NAME} — ${title}`) : DEFAULT_TITLE
  const metaDescription = description ?? DEFAULT_DESCRIPTION
  const ogImagePath = image ?? DEFAULT_IMAGE

  // Canonical URL: strip trailing slash except for root.
  const path = location.pathname === '/' ? '/' : location.pathname.replace(/\/$/, '')
  const canonicalUrl = path === '/' ? `${BASE_URL}/` : `${BASE_URL}${path}`

  const imageUrl = ogImagePath.startsWith('http') ? ogImagePath : `${BASE_URL}${ogImagePath}`

  const jsonLdArray = jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : []

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={metaDescription} />
      <link rel="canonical" href={canonicalUrl} />
      {noindex && <meta name="robots" content="noindex, nofollow" />}

      {/* Open Graph */}
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:url" content={canonicalUrl} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={metaDescription} />
      <meta property="og:image" content={imageUrl} />

      {/* Twitter Card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:url" content={canonicalUrl} />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={metaDescription} />
      <meta name="twitter:image" content={imageUrl} />

      {jsonLdArray.map((schema, i) => (
        <script key={i} type="application/ld+json">
          {JSON.stringify(schema)}
        </script>
      ))}
    </Helmet>
  )
}
