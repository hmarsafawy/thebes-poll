# Thebes Poll

Create a poll, vote once, watch the results come in. The whole app is one
Motoko smart contract plus one React page, both on the **Thebes** chain:
no server, no database.

**Live:** https://memphis.mercaturaforum.com/_/raw/270806450139109/index.html

Backend cid `151992746813754` · frontend cid `270806450139109`

---

## What it shows

| Thebes feature | Where you see it |
|---|---|
| **Identity (`msg.caller`)** | `vote` refuses a second vote from the same identity. The page shows your ID on the chain. |
| **Consensus for writes** | `createPoll`, `vote` and `closePoll` are update calls, so every validator runs them and agrees on the result. |
| **Instant queries** | Results, options and your own votes are `query` calls that one node answers right away. |
| **Rules live in the contract** | Only the creator can close a poll, there are 2–4 options, and voting on a closed poll is refused. The page can't skip any of these checks. |
| **A tally that checks itself** | Every poll shows "✓ tally verified": the contract recomputes on every read that votes counted equal ballots on record. |
| **Persistence** | Polls and votes survive `thebes-deploy upgrade`. |
| **On-chain frontend** | The page itself is served by a frontend canister. |

## What's in it

```
backend/Backend.mo      the smart contract
frontend/src/App.tsx    the page: form, polls, result bars
thebes.toml             the deploy manifest
```

| Function | Kind | Takes | Gives back |
|---|---|---|---|
| `createPoll` | update | `question`, `options` (2–4) | `"Created poll #n"` or why not |
| `vote` | update | `pollId`, option `index` | `"Vote counted…"` or why not |
| `closePoll` | update | `pollId` | `"Closed poll #n"` or why not (creator only) |
| `listPolls` | **query** | — | every poll, with totals and `verified` |
| `listOptions` | **query** | — | every option of every poll, with vote counts |
| `myVotes` | **query** | — | which option you picked in each poll |
| `myId` | **query** | — | your identity on the chain |
| `seal` | **query** | — | tally check across all polls: `OK` or `BROKEN` |

Each poll stores its vote **counts** and its list of **voters** separately, and
`vote` updates both. The two must always agree:
`sum(counts) == number of voters`. That's the check behind "✓ tally verified".

Identity: every browser gets its own ID on the chain (the SDK keeps it in
`localStorage`), so a second browser counts as a second voter.

---

## Deploy

```bash
cd thebes-poll
thebes-deploy fresh-cid backend
thebes-deploy fresh-cid frontend
# put the backend cid in frontend/src/App.tsx  (const BACKEND = ...)
# and both cids in thebes.toml
thebes-deploy deploy
```

Local dev (talks to the live chain; there is no local chain):

```bash
cd frontend && npm install && npm run dev      # http://localhost:5173
```

## Call it from the terminal

```bash
thebes-deploy call  backend createPoll --arg '("Best language?", vec { "Motoko"; "Rust"; "Go" })'
thebes-deploy call  backend vote       --arg '(0 : nat, 1 : nat)'
thebes-deploy query backend listPolls
thebes-deploy query backend listOptions
thebes-deploy query backend seal
thebes-deploy call  backend closePoll  --arg '(0 : nat)'
```

## Demo script

1. **Create a poll** in Chrome and vote.
2. **Try to cheat:** the page locks the buttons, so go around it. Run
   `thebes-deploy call backend vote --arg '(0 : nat, 1 : nat)'` twice. The
   first call counts (the terminal is its own identity). The second gets
   `"You already voted in this poll"` from the contract itself.
3. **Open Firefox** (a different identity) and vote. Chrome's counts update
   within a few seconds.
4. **Read it without the website:** `thebes-deploy query backend listPolls`.
5. **Upgrade:** `thebes-deploy upgrade backend`, reload, and the votes are still there.
6. **Validators:** `thebes-deploy status` shows the set that agreed on every vote.
7. **Footer:** `seal` reads `OK`, so votes counted equal ballots on record.

## Two things not to change

- **`--legacy-persistence` in `thebes.toml`**: without it an upgrade comes
  back with no polls.
- **`base: "./"` in `vite.config.ts`**: the app is served from `/_/raw/<cid>/`,
  so asset paths must be relative.
