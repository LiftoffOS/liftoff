import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deriveRoutePaths, renderConf, toPattern } from '../../scripts/generate-spa-routes.mjs'

/**
 * Serving contracts for the application.
 *
 * These are the kind of thing that rots silently: the nginx SPA allowlist is
 * DERIVED from src/App.tsx and committed,
 * so a route added without rebuilding answers 404 in production while every
 * test passes.
 */

const root = process.cwd()
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

const nginxConf = read('nginx.conf.template')
const robotsTxt = read('public/robots.txt')


describe('non-production hosts are never indexed', () => {
  // dev.example.com serves the same artifact as example.com. Canonicals
  // there already point at production, but a canonical is a hint rather than a
  // directive, so the noindex header is what actually keeps a dev URL out of
  // the index. Verified end to end against the real nginx image; these assert
  // the config keeps saying so.
  it('maps a non-production host to noindex', () => {
    // The rule that matters to any deployment: a container's own *.run.app URL
    // serves the same markup as the canonical domain and must not be indexed
    // beside it.
    expect(nginxConf).toMatch(/map \$host \$nonprod_robots_tag \{/)
    expect(nginxConf).toMatch(/~\*\\\.run\\\.app\$\s+"noindex, nofollow";/)
  })

  it('emits the combined tag, not the path-only one', () => {
    // add_header $robots_tag would silently drop the host rule: the path map
    // returns "" for every path it does not list, which on a non-production
    // host is exactly the set of pages the host rule exists for.
    expect(nginxConf).toMatch(/add_header X-Robots-Tag \$effective_robots_tag always;/)
    expect(nginxConf).not.toMatch(/add_header X-Robots-Tag \$robots_tag always;/)
  })

  it('disallows the whole tree, and leaves /share to the header', () => {
    // Every route needs a session, so there is nothing to index and a blanket
    // Disallow is the correct state.
    //
    // One caveat holds for the one path it affects: a crawler that cannot
    // FETCH a page never reads its noindex. /share/* is
    // handled by X-Robots-Tag in nginx, which applies whether or not robots.txt
    // permits the fetch, so the header is asserted here rather than an
    // exception in robots.txt.
    expect(robotsTxt).toMatch(/^Disallow: \/$/m)
    expect(nginxConf).toMatch(/X-Robots-Tag/)
  })
})

describe('SPA route allowlist is derived, not hand-maintained', () => {
  const appSource = read('src/App.tsx')
  const paths = deriveRoutePaths(appSource)

  it('covers every absolute route declared in App.tsx', () => {
    // The regression that matters: a real route answering 404 in production.
    const declared = [...appSource.matchAll(/\bpath="(\/[^"]*)"/g)]
      .map((m) => m[1])
      .filter((p) => p !== '*')
    expect(declared.length).toBeGreaterThan(20)
    for (const path of declared) {
      expect(paths, `route ${path} would 404`).toContain(path)
    }
  })

  it('resolves nested routes to their full path', () => {
    // These live in App.tsx as relative children (`:tab` inside `settings`
    // inside `/dashboard`). Anything that flattens them would either 404 the
    // real page or whitelist a path that does not exist.
    expect(paths).toContain('/dashboard/settings/:tab')
    expect(paths).toContain('/dashboard/agents/update/webhook')
    // ...and must NOT invent the un-nested sibling.
    expect(paths).not.toContain('/dashboard/:tab')
  })

  it('keeps :params as their own segment', () => {
    expect(paths).toContain('/connections/capture/:token')
    expect(paths).toContain('/dashboard/settings/:tab')
  })

  it('treats an index route as its parent path', () => {
    expect(paths).toContain('/dashboard')
  })

  it('includes the homepage', () => {
    expect(paths).toContain('/')
  })

  it('never emits the catch-all as a route', () => {
    expect(paths).not.toContain('*')
  })

  it('refuses to emit a config that would 404 the homepage', () => {
    expect(() => deriveRoutePaths('<Route path="/pricing" />')).toThrow(/no "\/" route/)
  })

  it('refuses to emit a suspiciously small allowlist', () => {
    // If the parser ever stops matching, the failure mode is 404ing most of the
    // app. Fail the build instead of shipping that.
    expect(() => deriveRoutePaths('<Route path="/" />')).toThrow(/expected 40\+/)
  })

  it('prefixes every pattern with ~ so nginx reads it as a regex', () => {
    // Without the ~, nginx compares the key as a LITERAL string. It does not
    // error, it just never matches — and any path with a static index.html
    // hides it completely, because try_files finds that file before the
    // allowlist is consulted. Those keep working while /login and /dashboard 404.
    for (const p of ['/', '/about-us', '/support/:category']) {
      expect(toPattern(p).startsWith('~'), `${p} lost its ~`).toBe(true)
    }
    for (const line of read('nginx/spa-routes.conf').split('\n')) {
      if (line.trim().startsWith('"')) expect(line.trim().startsWith('"~')).toBe(true)
    }
  })

  it('anchors patterns end-to-end so subpaths do not slip through', () => {
    // The whole reason for full paths over first segments: /about-us/nope used
    // to answer 200 with the app shell.
    const p = toPattern('/about-us')
    expect(new RegExp(p.slice(1)).test('/about-us')).toBe(true)
    expect(new RegExp(p.slice(1)).test('/about-us?utm=x')).toBe(true)
    expect(new RegExp(p.slice(1)).test('/about-us/nope')).toBe(false)
    expect(new RegExp(p.slice(1)).test('/about-us-fake')).toBe(false)
  })

  it('matches a :param across exactly one segment', () => {
    const re = new RegExp(toPattern('/support/:category').slice(1))
    expect(re.test('/support/getting-started')).toBe(true)
    expect(re.test('/support/getting-started/an-article')).toBe(false)
  })

  it('does not let the root pattern match a doubled slash', () => {
    const re = new RegExp(toPattern('/').slice(1))
    expect(re.test('/')).toBe(true)
    expect(re.test('//')).toBe(false)
  })

  it('keys the map on $request_uri, not $uri', () => {
    // try_files rewrites $uri to /index.html before the fallback runs, so a
    // $uri map matches nothing on exactly the paths it exists to classify.
    expect(renderConf(['/'])).toContain('map $request_uri $is_spa_route')
  })

  it('is checked in and current with App.tsx', () => {
    // Regenerated on every build, but committed so the allowlist is reviewable.
    // This fails if someone adds a route and commits without building.
    expect(read('nginx/spa-routes.conf')).toBe(renderConf(paths))
  })
})

describe('markdown content negotiation (acceptmarkdown.com)', () => {
  it('serves markdown by trying the .md variant first', () => {
    expect(nginxConf).toMatch(/try_files \$uri\$md_ext \$uri\/index\$md_ext \$uri \$uri\/index\.html @spa;/)
  })

  it('only sets $md_ext when markdown was actually asked for', () => {
    expect(nginxConf).toMatch(/map \$http_accept \$md_ext \{[\s\S]*?default\s+"";/)
    expect(nginxConf).toMatch(/"~\*text\/markdown"\s+"\.md";/)
  })

  it('honours an explicit q=0 refusal, and tests it before the general case', () => {
    const block = nginxConf.slice(nginxConf.indexOf('map $http_accept $md_ext'))
    const refusal = block.indexOf('q=0')
    const general = block.indexOf('"~*text/markdown"')
    expect(refusal).toBeGreaterThan(-1)
    // nginx takes the first matching regex, so the refusal must come first or a
    // client saying "definitely not markdown" would be handed markdown.
    expect(refusal).toBeLessThan(general)
  })

  it('teaches nginx the .md mime type', () => {
    // Without this a markdown file is application/octet-stream, which agents
    // treat as a download rather than text.
    expect(nginxConf).toMatch(/types \{\s*text\/markdown\s+md;\s*\}/)
  })

  it('adds the charset without touching the HTML Content-Type', () => {
    expect(nginxConf).toMatch(/charset_types text\/markdown;/)
  })

  it('sends exactly one Vary carrying Accept on negotiated responses', () => {
    expect(nginxConf).toMatch(/add_header Vary "Accept, Accept-Encoding" always;/)
    // gzip_vary would append a SECOND Vary: Accept-Encoding.
    expect(nginxConf).toMatch(/gzip_vary off;/)
  })

  it('keeps Vary: Accept-Encoding on responses that drop the inherited header', () => {
    // add_header in a location discards every inherited header, so the asset and
    // robots/sitemap blocks must restate it or a cache could hand a brotli body
    // to a client that cannot decode it.
    for (const marker of ['location ~* \\.(js|css|png', 'location ~* ^/(robots\\.txt']) {
      const start = nginxConf.indexOf(marker)
      expect(start, `${marker} not found`).toBeGreaterThan(-1)
      const block = nginxConf.slice(start, nginxConf.indexOf('}', start) + 1)
      expect(block, marker).toMatch(/add_header Vary "Accept-Encoding" always;/)
    }
  })

  it('406s only what it genuinely cannot serve', () => {
    expect(nginxConf).toMatch(/if \(\$acceptable = 0\) \{\s*return 406;/)
    // Absent Accept, */*, text/* and html must all stay acceptable, or the site
    // starts 406ing browsers.
    const block = nginxConf.slice(nginxConf.indexOf('map $http_accept $acceptable'))
    expect(block).toMatch(/""\s+1;/)
    expect(block).toMatch(/\\\*\/\\\*/)
    expect(block).toContain('text/html')
  })
})

describe('the build runs only what the app needs', () => {
  it('runs no sitemap, prerender or page-markdown step', () => {
    // Each of these would serve a crawler. The app has no public route to
    // crawl, and a step that reads a file nobody generates is a build that
    // breaks for the next person rather than a safeguard.
    const build = JSON.parse(read('package.json')).scripts.build
    for (const step of ['generate-sitemap', 'verify-prerender', 'generate-page-markdown']) {
      expect(build, `${step} has no public route to serve`).not.toContain(step)
    }
    // The allowlist generator is NOT one of them: nginx still needs the route
    // list, and it is derived from App.tsx.
    expect(build).toContain('generate-spa-routes.mjs')
  })
})

describe('nginx returns real 404s', () => {
  it('falls back to @spa, never straight to the shell', () => {
    // `try_files ... /index.html` as the LAST entry is what made every unknown
    // path answer 200 with the app.
    expect(nginxConf).toMatch(/try_files .*@spa;/)
    expect(nginxConf).not.toMatch(/try_files \$uri \$uri\/index\.html \/index\.html;/)
  })

  it('404s anything not on the allowlist', () => {
    expect(nginxConf).toMatch(/if \(\$is_spa_route = 0\) \{\s*return 404;/)
  })

  it('includes the generated allowlist from outside conf.d', () => {
    // conf.d/*.conf is auto-included by the base image; a second copy there
    // would load the map twice and nginx would refuse to start.
    expect(nginxConf).toContain('include /etc/nginx/spa-routes.conf;')
    expect(nginxConf).not.toContain('include /etc/nginx/conf.d/spa-routes.conf;')
  })

  it('serves the app shell as the default 404 body so the styled screen survives', () => {
    expect(nginxConf).toMatch(/map \$http_accept \$notfound_body \{[\s\S]*?default\s+\/index\.html;/)
  })

  it('serves markdown to agents that ask for it', () => {
    expect(nginxConf).toMatch(/"~\*text\/markdown"\s+\/404\.md;/)
    expect(nginxConf).toContain('error_page 404 $notfound_body;')
  })

  it('does not rewrite the status code on the error page', () => {
    // `error_page 404 = /404.md` would answer 200. The `=` form must not appear.
    expect(nginxConf).not.toMatch(/error_page\s+404\s+=/)
  })

  it('sends a single Vary carrying Accept on the negotiated body', () => {
    // Anchor on the opening brace: the bare path is also mentioned in the
    // comment above the $notfound_body map.
    const start = nginxConf.indexOf('location = /404.md {')
    const block = nginxConf.slice(start, nginxConf.indexOf('}', start) + 1)
    // gzip_vary is off server-wide now, so this block only has to restate the
    // headers its own add_header would otherwise discard.
    expect(block).toMatch(/add_header Vary "Accept, Accept-Encoding" always;/)
    expect(block).toContain('internal;')
    expect(block).toContain('default_type text/markdown;')
  })
})

describe('the markdown 404 body exists', () => {
  // nginx maps a markdown-accepting 404 to /404.md and serves it `internal`,
  // so if this file goes missing that branch answers with nothing. It names no
  // llms.txt, sitemap or help centre: none of them exists any more.
  const body = read('public/404.md')

  it('is markdown with a heading that says what happened', () => {
    expect(body.startsWith('# 404 Not Found')).toBe(true)
  })

  it('points at no route the app does not serve', () => {
    for (const dead of ['llms.txt', 'sitemap.xml', '/support', 'agent-setup.md']) {
      expect(body, `${dead} is not served any more`).not.toContain(dead)
    }
  })

  it('uses no em dashes (INV-UI-004)', () => {
    expect(body).not.toContain('\u2014')
  })
})

describe('the generated allowlist reaches the image', () => {
  const dockerfile = read('Dockerfile')

  it('is copied from the builder to /etc/nginx', () => {
    expect(dockerfile).toMatch(
      /COPY --from=builder \/app\/nginx\/spa-routes\.conf \/etc\/nginx\/spa-routes\.conf/,
    )
  })

  it('is generated during the build', () => {
    expect(JSON.parse(read('package.json')).scripts.build).toContain('generate-spa-routes.mjs')
  })
})
