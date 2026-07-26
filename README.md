# gainz

A single-user weight and nutrition tracker. Live at
[marcusklaas.nl/gainz](https://marcusklaas.nl/gainz).

No backend. The app runs entirely in the browser and stores its data as JSON in
a separate private GitHub repo, reached with a personal access token that lives
in `localStorage` and is never sent anywhere else. Food descriptions are turned
into calorie and protein estimates by calling Anthropic or OpenAI directly from
the browser, with the API key kept the same way.

TypeScript, no framework, no bundler. The only dependency is
[uPlot](https://github.com/leeoniya/uPlot), vendored in `vendor/`.

```
npm install
npm run build     # tsc: src/ -> js/
npm run serve     # http://localhost:8080
```

Pushing to `main` builds and publishes via `.github/workflows/pages.yml`.
