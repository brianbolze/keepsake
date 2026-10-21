# Keepsake identity

The identity pairs an editorial lowercase wordmark with a bird-shaped `k` logomark. The opening `k` carries the bird's head; both `k` letters share wing and tail curves. Use the wordmark in product headers and the logomark for square icons.

- `public/brand/wordmark.webp`: transparent, lossless WebP, 800 × 191. The library displays it at up to 180 px wide; the extension uses the same asset at 146 px wide.
- `public/brand/logomark.webp`: transparent, lossless WebP, 512 × 512.
- `public/favicon.ico`: 16, 32, and 48 px PNG frames.
- `public/brand/icon-32.png` and `public/apple-touch-icon.png`: browser and home-screen icons.
- `extension/icons/icon-{16,32,48,128}.png`: Chrome toolbar and extension management icons. Chrome requires PNG icons; the header uses `extension/icons/wordmark.webp`.

Square icons use an ivory tile with 10% padding to keep the forest-green mark legible against both light and dark browser chrome. The popup wordmark becomes light in dark mode through CSS.

After changing production assets, run `npm run build` and reload the unpacked extension in `chrome://extensions`.
