# Teams app package assets

`buildAppPackageZip()` (src/agent-chat/teams-adapter/teams-app-service.ts) assembles the
Microsoft Teams app package from this directory:

- `manifest.template.json` — filled with `{{BOT_APP_ID}}` and `{{VALID_DOMAIN}}` at publish
  time, then zipped.
- `color.png` — **required**, 192×192 full-color icon (the Liftoff rocket on brand orange).
- `outline.png` — **required**, 32×32 transparent icon (the rocket as a white silhouette;
  Teams tints it in the app rail).

Both PNGs are the Liftoff brand mark and are committed here; `buildAppPackageZip()` zips them
alongside the filled manifest for org-catalog publish and Store submission.
