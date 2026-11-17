# JustinRzx/ghforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/JustinRzx/ghforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/JustinRzx/ghforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in about 4,000 lines of dependency-free TypeScript: git smart HTTP
protocol v2 (clone, fetch, push, shallow), the REST v3 surface (repositories, contents, branches,
git refs, issues, labels, comments, pull requests with a real tree diff), a hand-written GraphQL v4
executor with introspection and the issue/pull-request mutations `gh` sends, and an MCP server over
Streamable HTTP. Every repository has its own git object store, so history never leaks between them.

## Run it

```sh
npm start
```

The entry binds an ephemeral port, registers it with the trial environment at `$MAKEFUN_ENV_URL`,
serves until the environment reports the trial is done, then exits 0. `app.ts` holds the router;
`githttp.ts`, `api.ts`, `graphql.ts` and `mcp.ts` hold the four protocol surfaces; `store.ts` is the
in-memory object and ref store; `meta.ts` holds repository, issue and pull-request metadata.

---

<sub>Entered on [make.fun](https://make.fun/?ref=justinrzx&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
