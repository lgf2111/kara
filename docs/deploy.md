# Deploying to Cloudflare Pages

The site is static and self-contained: weights, the ONNX runtime and the OCR assets are all served from its own origin, so the Content-Security-Policy needs no exceptions.

```sh
pnpm --filter ./apps/web build
node scripts/prepare-deploy.mjs
pnpm dlx wrangler pages deploy apps/web/dist --project-name kara
```

`prepare-deploy.mjs` copies into `apps/web/dist` the htdemucs weights (`/weights/htdemucs-web/`), the ONNX runtime (`/spike-ort/`) and the tesseract worker, core and English data (`/tesseract/`). It needs `models/htdemucs-web` and `models/tessdata/eng.traineddata` locally (both are gitignored).

Pages refuses any asset over 25 MiB. The runtime's wasm is 27 MiB, so it ships gzipped (`ort-wasm-simd-threaded.asyncify.wasm.gz`) and the separation worker unzips it before handing the bytes to the runtime. The script fails if any file is still over the limit.

Headers (cross-origin isolation, CSP) come from `apps/web/public/_headers`.
