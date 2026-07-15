# Workflow Engine V2 P13 Build Warning Cleanup Review

Date: 2026-07-08

## Scope

- Main app production build warning cleanup.
- Initial bundle size reduction.
- Shiki syntax highlighter bundle reduction.
- No business behavior changes were intended.

## Changes Reviewed

- `app/src/App.tsx`
  - Converted page and heavy dialog imports to `React.lazy`.
  - Wrapped authenticated and unauthenticated page rendering in `Suspense`.
  - Added a minimal full-area loading fallback.

- `app/src/hooks/useHighlight.ts`
  - Kept Shiki core-based initialization.
  - Removed the low-frequency Ruby language loader from eager highlighter initialization.
  - Mapped `rb` to plaintext fallback instead of loading the oversized Ruby grammar chunk.

- `app/vite.config.ts`
  - Keeps targeted manual chunks for React, KaTeX, icons, charts, and Markdown dependencies.

## Review Result

Passed.

The app no longer emits Vite large chunk warnings in production build. The initial app chunk dropped from about 1.07MB to about 149KB. Heavy pages are now isolated into route-level chunks, so users do not pay the admin/workflow/AutoCode cost on initial chat entry.

## Verification

- `npm.cmd run build` in `app`: passed.
- `mvn.cmd -DskipTests compile` in `backend`: passed.

## Residual Risk

- Ruby code blocks now render as escaped plaintext instead of syntax-highlighted Shiki output. This is intentional for bundle size. If Ruby highlighting becomes important, add it behind a user-triggered loader or accept the language chunk cost explicitly.
- The loading fallback is deliberately simple. A future UX pass can replace it with skeletons for individual pages.
