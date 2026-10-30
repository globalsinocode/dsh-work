# Brand assets

Square `brand-mark.svg` matches `AppLogo` mark (blue field, no outer rounded corners). Browsers and PWA shells apply their own masks.

Committed rasters under `public/` are built from the SVG. To refresh after editing the SVG:

```bash
pnpm add -D sharp --filter @dsh-work/brand-assets
node packages/brand-assets/scripts/generate-icons.mjs
```

Then commit updated files under `public/`.
