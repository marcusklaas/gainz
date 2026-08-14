# gainz

A single-user weight and nutrition tracker. Live at
[marcusklaas.nl/gainz](https://marcusklaas.nl/gainz).

No backend. The app runs entirely in the browser and stores its data as JSON in
a separate private GitHub repo, reached with a personal access token that lives
in `localStorage` and is never sent anywhere else. Food descriptions are turned
into calorie and protein estimates by calling Anthropic or OpenAI directly from
the browser, with the API key kept the same way.

Settings has an **Export for AI** section that builds the recent log — days,
weeks, sessions, food, and the derived numbers with the notes needed to read
them — as one Markdown document carrying fenced CSV, to copy, share or download
into a general chatbot and ask questions about. Nothing is uploaded; where it
goes is wherever it gets pasted.

TypeScript, no framework, no bundler. The only dependency is
[uPlot](https://github.com/leeoniya/uPlot), vendored in `vendor/`.

```
npm install
npm run build     # tsc: src/ -> js/
npm run test      # node:test over the estimators
npm run serve     # http://localhost:8080
```

Tests cover the pure half of the app — `dates`, `estimate`, `lifts` and
`export`, which is where all the arithmetic lives. They compile through `tsconfig.test.json` into
`test-build/` and run on Node's built-in runner, so there is no test framework
to install.

`.github/workflows/checks.yml` runs the build and the tests on every pull
request, and pushing to `main` runs the same job before publishing via
`.github/workflows/pages.yml`.
