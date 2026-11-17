# Liftoff Web App

Everything runs in your own cloud project, on your own credentials, and every
hostname is something you configure. The code throws rather than falling back
to a default, because a default here would point at infrastructure that is not
yours.

Licensed under [Apache-2.0](LICENSE). The licence grants no trademark rights:
the Liftoff name and logo are not licensed for use as the name of what you ship.

The browser client: sign-in, the dashboard, agent chat, and the settings and
oversight surfaces. React, TypeScript and Vite.

This is the **application only**. Every route is behind authentication apart
from sign-in and the OAuth and invitation callbacks.

## Running it

Install once at the root of the repository, not here — it is one npm workspace:

```sh
npm ci            # at the repository root
```

Then, from this directory:

```sh
npm run dev       # Vite dev server
npm run dev:mock  # dev server against mocked API handlers, no backend needed
npm run build     # production build
npm run preview   # serve the build
```

`npm run dev:mock` is the quickest way to see the app without standing up the
backend first.

## Tests and checks

```sh
npm test
npm run lint
npm run typecheck
```

`npm run storybook` runs the component explorer.

## Configuration

Copy `.env.example`. Everything is a `VITE_` variable, which means **it is
compiled into the bundle and is public** — put nothing secret in it.

| Variable | What it is |
|---|---|
| `VITE_FIREBASE_*` | Your own Firebase project, which provides authentication |
| `VITE_API_URL` | Your control-plane URL. Ships as a placeholder that resolves nowhere |
| `VITE_DEVELOPER_PROXY_URL` | Your developer-proxy URL, for the coding-tool integration |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Only needed if you run with a payment provider |

## Serving it

The build is static files. `Dockerfile` and `nginx.conf` build a container that
serves them and nothing else — no API proxy and no analytics — so it can sit
behind whatever ingress you already have. `nginx/spa-routes.conf` is generated
from the route tree during `npm run build`, so client-side routes return the app
rather than a 404; it is generated, not hand-maintained.
