# Phase 1b Research Findings
## Pre-Electron Architecture Research — Concurrent Instances & Headless Refresh

> **Status:** Template — fill in after running `test-concurrent.js` and `test-headless-refresh.js`
>
> Run commands:
> ```powershell
> node test-concurrent.js 2>concurrent-raw.txt
> node test-headless-refresh.js 2>headless-raw.txt
> ```

---

## Question A — Concurrent Instances

### Test Setup

| Field | Value |
|---|---|
| Script | `test-concurrent.js` |
| Instances tested | <!-- e.g. 2 and 3 --> |
| Profile dirs | AntigravityTest0, AntigravityTest1 (pre-authenticated copies) |
| Test date | <!-- YYYY-MM-DD --> |

### A1 — Electron Single-Instance Lock

> Does a second instance with a **different** `--user-data-dir` succeed, or does Electron's
> `requestSingleInstanceLock()` prevent it?

| Instance | `--user-data-dir` | SingletonLock created? | LSP appeared? | Exited early? |
|---|---|---|---|---|
| 0 | `AntigravityTest0` | <!-- yes/no --> | <!-- yes/no --> | <!-- yes/no --> |
| 1 | `AntigravityTest1` | <!-- yes/no --> | <!-- yes/no --> | <!-- yes/no --> |
| 2 (if tested) | `AntigravityTest2` | | | |

**Verdict:**
- [ ] Each `--user-data-dir` gets its own lock → **multi-profile safe**
- [ ] Single global lock → only **one instance** possible at a time

Notes: <!-- e.g. "Instance 1 immediately exited (code 0) — lock is global" -->

---

### A2 — Port Isolation

> Do all instances bind to different ports, or do they collide?

| Instance | Port detected | Source (netstat/cmdline/log) | Collision? |
|---|---|---|---|
| 0 | <!-- e.g. 55320 --> | <!-- netstat --> | — |
| 1 | <!-- e.g. 55321 --> | | <!-- yes/no --> |

**Port collision detected:** <!-- YES / NO -->

If collision detected: <!-- describe which strategy the refresh engine should use to disambiguate -->

---

### A3 — Session Isolation

> When two instances boot, does each LSP return data from its **own** profile, or do they share session state?

| Instance | GetUserStatus HTTP | Body snippet (first 100 chars) | Same as Instance 0? |
|---|---|---|---|
| 0 | <!-- 200 / 401 / error --> | <!-- ... --> | — |
| 1 | | | <!-- yes (BAD) / no (GOOD) --> |

**Isolation verdict:** <!-- ISOLATED (good) / CROSS-CONTAMINATED (bad) / UNTESTABLE -->

---

### A4 — RAM & CPU per Instance

> WorkingSetSize (RSS equivalent) for the full process tree per profile.

| Instance | RAM (MB) | Process count | Notes |
|---|---|---|---|
| 0 | <!-- e.g. 350 --> | <!-- e.g. 8 --> | |
| 1 | | | |
| 2 (if tested) | | | |
| **Total** | | | |

**Peak combined RAM (2 instances):** <!-- MB -->
**Peak combined RAM (3 instances):** <!-- MB or "not tested" -->

System RAM available: <!-- GB -->
Acceptable for 4-5 hour refresh cycle: <!-- YES / NO / MARGINAL -->

---

### A5 — Boot Time Under Concurrency

> Does instance 1 take longer to boot an LSP than instance 0 (resource contention)?

| Instance | Time to LSP (ms) | Spread vs Instance 0 (ms) |
|---|---|---|
| 0 | <!-- baseline --> | — |
| 1 | | |
| 2 | | |

**Contention observed:** <!-- YES / NO / MARGINAL -->

---

### A6 — Clean Kill

> Can each instance tree be killed independently without orphans?

| Instance | Kill OK? | Orphan count | Notes |
|---|---|---|---|
| 0 | <!-- yes/no --> | <!-- 0 --> | |
| 1 | | | |

---

### A — Architecture Recommendation

Based on the results above:

- **Max safe concurrent instances:** <!-- 0 / 1 / 2 / 3+ -->
- **Strategy:** <!-- sequential-only / parallel up to N / parallel with stagger -->
- **Notes:** <!-- any Electron single-instance lock constraint -->

---

## Question B — Headless / UI Suppression

### Test Setup

| Field | Value |
|---|---|
| Script | `test-headless-refresh.js` |
| Test profile | `AntigravityHeadlessTest` |
| Auth state of test profile | <!-- authenticated / not authenticated --> |
| Test date | <!-- YYYY-MM-DD --> |

---

### B1 — Auth State Detection

> Can we detect whether a profile is already authenticated **without** spawning the IDE?

| Profile | api_key file found? | state.vscdb found? | Token-like file found? | isAuthenticated |
|---|---|---|---|---|
| Real (Roaming) | <!-- yes/no --> | | | <!-- yes/no --> |
| Test copy | | | | |

**Reliable auth detection possible:** <!-- YES / NO / PARTIAL -->

Auth detection method to use in refresh engine:
```
<!-- e.g. "Check existence and non-zero size of:
     %APPDATA%\Antigravity IDE\User\globalStorage\Antigravity.antigravity\api_key" -->
```

---

### B2 — Window Suppression Strategies

| # | Strategy | Window state (auto) | LSP booted? | GetUserStatus OK? | Window appeared? (manual) |
|---|---|---|---|---|---|
| 0 | Baseline (no flags) | <!-- visible/minimized/hidden --> | <!-- yes/no --> | <!-- yes/no --> | <!-- VISIBLE / minimized / nothing --> |
| 1 | --start-minimized | | | | |
| 2 | --start-minimized --no-sandbox | | | | |
| 3 | PS Start-Process -WindowStyle Hidden | | | | |

> **MANUAL column** — what you actually saw on screen during each strategy.

---

### B3 — Best Strategy

| Criterion | Winning strategy # | Value |
|---|---|---|
| Lowest window visibility | | |
| LSP boot success | | |
| GetUserStatus success | | |
| Clean kill | | |
| **Overall winner** | | |

Recommended spawn invocation for the Electron refresh engine:

```javascript
// Recommended headless spawn (fill in after test)
spawn(ANTIGRAVITY_EXE, [
  `--user-data-dir=${profileDir}`,
  // add flags determined by test
], { shell: true, detached: false, windowsHide: true, stdio: 'ignore' });
```

---

### B4 — Unauthenticated Profile Handling

> What happens if a profile has no valid auth token?

| Scenario | Observed behaviour | Recovery strategy |
|---|---|---|
| No api_key file | <!-- OAuth window opens / crash / silent --> | <!-- Skip profile / flag for user action --> |
| Stale / expired token | | |

**Decision for refresh engine:**
- If `isAuthenticated = false` → <!-- skip silently / notify user / open interactive window -->

---

## Summary — Architecture Decisions for Lune Refresh Engine

| Decision | Conclusion |
|---|---|
| Sequential vs. parallel refreshes | <!-- e.g. "Sequential — Electron lock is global" --> |
| Window suppression method | <!-- e.g. "Strategy 2: --start-minimized --no-sandbox" --> |
| Auth pre-check before spawn | <!-- YES (skip unauthenticated profiles) / NO --> |
| Max concurrent instances | <!-- 1 / 2 / N --> |
| RAM budget per refresh run | <!-- MB --> |
| Total refresh cycle time estimate (N profiles) | <!-- seconds --> |
| Stagger delay between sequential spawns | <!-- ms (from A5 contention data) --> |

---

## Blockers / Open Issues

<!-- List anything that needs further investigation before Electron scaffold -->

- [ ] <!-- e.g. "SingletonLock is global - must use --user-data-dir per instance" -->
- [ ] <!-- e.g. "LSP port not present in cmdline - must use netstat to discover port" -->
- [ ] <!-- e.g. "No reliable windowless mode found - need virtual desktop approach" -->

---

## Raw Output Files

- `concurrent-raw.txt` — raw LSP cmdlines from `test-concurrent.js` (stderr)
- `headless-raw.txt`   — raw LSP cmdlines from `test-headless-refresh.js` (stderr)

---

*Last updated: <!-- date --> by `test-concurrent.js` + `test-headless-refresh.js` Phase 1b run*
