# Contributing to NVX Ancile

Thank you for helping. Please read this page before you open a pull request: the licence section decides whether we can merge your work at all.

## Licensing, and why we ask for a CLA

NVX Ancile's free edition is licensed under the GNU General Public License, version 3 or later (GPL-3.0-or-later). NVX Ancile Pro is a paid edition built from the same code plus proprietary Pro features.

Shipping both is only possible because one copyright holder owns all of the GPL code and can license it under other terms as well. A contribution under the GPL alone would end that: its author would own it, and Pro could no longer include it.

So before we merge your first pull request, you sign the [Contributor Licence Agreement](CLA.md) (CLA). In short, you keep the copyright in your work and you grant the NVX Ancile maintainers a licence to use it, including in NVX Ancile Pro and under licences other than the GPL. Your contribution stays available to everyone under the GPL in the free edition.

How to sign: comment on your pull request with

> I have read the CLA document and I hereby sign the CLA.

One signature covers all your later contributions. If you contribute on behalf of an employer, they must agree too (CLA section 4).

We cannot merge a pull request without a signed CLA, however small.

### Code from other projects

- Do not copy code from GPL, LGPL, AGPL, SSPL or source-available projects into this repository, even with credit.
- **Odysseus is clean-room:** do not copy, adapt or translate its code, from any version, and do not keep it open while writing the equivalent here.
- Code under a permissive licence (MIT, BSD, Apache-2.0, ISC) may be adapted only with its notice kept and the licence recorded beside it. Say so in the pull request.
- Dependencies must have a licence the desktop build accepts: `apps/desktop/scripts/third-party-licenses.mjs` fails the build on AGPL, SSPL, BUSL, proprietary or unknown licences.
- Proprietary components such as Anthropic's Claude Agent SDK are never added to the repository or bundled. They are downloaded at runtime, checked against a pinned hash and used only from separate programs (see `services/claude-bridge`).

### Sign off your commits

Also sign off each commit (`git commit -s`), certifying the [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change, or otherwise have the right to submit it.

## Working on the code

- Read `README.md` for the layout, and run `pnpm doctor` to check your environment.
- Before you push: `pnpm typecheck`, `pnpm lint` and `pnpm test`. Python: `uv run --project services/knowledge pytest`.
- Every user-facing error has a title, a hint and a code documented in `docs/errors.md`.
- Copy is plain, concrete and in sentence case, with British spelling and no em dashes in the UI. Buttons say what happens.
- Keep user-facing docs in `docs/` current in the same pull request.

## Reporting security problems

Do not open a public issue for a security problem. Email the maintainers through the contact on https://nvx.sh, with steps to reproduce.
