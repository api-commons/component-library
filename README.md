# Model Library

A browser-first tool for a **versioned, reusable model / component library** — the API design-governance primitive Spectral leaves out. Author or import a library of named JSON Schemas with semantic versions, see which OpenAPI specs consume each model, and when a model version bumps, know instantly whether the change is **breaking** or **non-breaking** for every consumer — plus a drift detector that surfaces near-duplicate model variants. No backend, no accounts; runs entirely in your browser. Live at **[library.apicommons.org](https://library.apicommons.org)**.

Linters check one document at a time. They cannot tell you that forty APIs each define their own slightly-different `User`, or that bumping the shared `Money` model quietly breaks the three services that consume it. The missing capability is a place for the **models themselves** to live, version, and be reused — so specs `$ref` a canonical definition instead of copying it.

## The library

A model library is a small, machine-readable file — a version plus a list of reusable named
schemas, each with its own semantic version, owner, and description:

```yaml
version: "1.0"
models:
  - name: User
    version: "2.0.0"
    owner: team-identity
    description: A platform user account.
    schema:
      type: object
      required: [id, email, name]
      properties:
        id:     { type: string, format: uuid }
        email:  { type: string, format: email }
        name:   { type: string }
        status: { type: string, enum: [active, disabled] }
```

Specs consume a model by `$ref`-ing `#/components/schemas/<Name>` (or, as a drift signal, by
defining an inline schema of the same name).

## What it reports

Paste your library and the OpenAPI spec(s) that reference it, and it produces three views:

- **Models** — every named schema and version in the library, with its owner, property count,
  and how many specs consume it. Two rows for one name are versions to reconcile.
- **Change propagation** — a structural `diffSchema(old, new)` of each version bump, with every
  change classified **breaking** (a removed/renamed required property, a narrowed type, a
  removed enum value) or **non-breaking** (an added optional property, an added enum value, a
  description edit) — and the verdict propagated to each spec that `$ref`s the model.
- **Drift & dedup** — near-duplicate model variants (same-ish name, or property-set overlap by
  Jaccard ≥ 0.6) across the library and the inline schemas your specs define, so you can see
  "three variants of a user model" and collapse them onto one definition.

## Develop

```bash
npm install
npm run dev
npm run build     # → dist/
```

Pure client-side; no data build. The samples in `public/` demonstrate a breaking version bump,
non-breaking changes, and a multi-variant drift cluster.

## Privacy

Everything runs client-side. The library and specs you paste never leave the page — there is
no server.

---

This tool came out of the **State-of-Spectral** research and a conversation with a Spectral
maintainer about the capability API governance tooling still misses: not another linter, but a
**versioned model / design library** where reusable schemas live, version, and are reused.

A project of [API Evangelist](https://apievangelist.com), maintained openly under
[API Commons](https://apicommons.org). Free to fork; API Evangelist offers expert API design
and governance services — including standing up a real shared model library — when you want
help. Apache-2.0.

## Part of API Commons

An open, browser-first tool from **[API Commons](https://apicommons.org)** — free, no backend, your data stays in your browser. Browse the full set at **[apicommons.org/tools](https://apicommons.org/tools/)**.

**Related tools**
- [Spec Review](https://review.apicommons.org) — ref-resolving breaking-change diff for PRs
- [API Validator](https://validator.apicommons.org) — lint OpenAPI/AsyncAPI/Arazzo/JSON Schema in-browser
- [Code-First Governance](https://codefirst.apicommons.org) — govern generated specs; fix findings in code
- [API Governance Graph](https://graph.apicommons.org) — bind building blocks into one graph + Gaps view
- [Spectral Ruleset Studio](https://studio.apicommons.org) — turn a style guide into an owned ruleset
- [API Reusability](https://reusability.apicommons.org) — score API reuse across an org
