# Slack Integration — FlashStack

**Status:** Stage 1 specified here; **not yet active — requires admin action in Slack (see §5).**
**Owner:** Matt (Slack workspace admin + repo admin). Specified by the Security & Contract Lead.
**Scope rule:** Slack is **notification / observability only**. It is never part of the
security gate, and a Slack outage must never turn a CI check red. See §6.

---

## 1. Why the official integration, not a custom bot

We use the **official GitHub app for Slack** (`github.com/integrations/slack`) rather than a
webhook bot, because:

- **No credentials in the repo.** It authenticates by OAuth between GitHub and Slack. There is
  **no webhook URL, no bot token, and no GitHub secret to store** — so there is nothing for us
  to leak, rotate, or accidentally commit. A custom bot would require an incoming-webhook URL in
  repository secrets, which is a credential we would then own.
- **It cannot affect CI.** Subscriptions are read-only consumers of GitHub events. There is no
  workflow step to fail, so the security gate is structurally unable to depend on Slack.
- **Nothing deployment-related is exposed.** No deployer mnemonic, no contract admin key, and no
  mainnet credential is involved at any point. Slack sees only what is already public — this is a
  public repository.

## 2. Channels

| Channel | Purpose |
|---|---|
| `#flashstack-ci` | Build/test health: PR activity, review + merge activity, `FlashStack CI` outcomes on `main`. |
| `#flashstack-security` | Security signal only: `Security Scan` workflow outcomes, audit blockers, findings needing attention. |

Keeping these separate is deliberate. A security channel that also carries routine build chatter
stops being read, and an unread security channel is worse than none.

## 3. Commands — `#flashstack-ci`

Run these **in `#flashstack-ci`**, after `/github signin`:

```
/github subscribe mattglory/Flashstack
/github unsubscribe mattglory/Flashstack commits issues public branches discussions
/github subscribe mattglory/Flashstack reviews
/github subscribe mattglory/Flashstack workflows:{name:"FlashStack CI" branch:"main"}
```

- The first line subscribes with GitHub's defaults (issues, pulls, statuses, commits, releases,
  deployments); the second line **removes the noisy half** of that default immediately.
- `commits` is dropped: every merge to `main` is already visible as PR merge activity.
- `branches` and `public` are dropped: branch create/delete is pure noise for a two-person team.
- `releases` / `deployments` are **left subscribed but are currently dormant** — FlashStack has no
  release or GitHub-deployment flow today. They cost nothing now and are the right default if one
  is added.
- `workflows:{…}` is scoped to the CI workflow **on `main`**, so PR-run chatter does not land here;
  PR-level pass/fail is already visible on the PR itself.
- `statuses` is **deliberately kept**, and is the one default we retain knowingly. Vercel reports
  through the commit-status API rather than as a GitHub Actions workflow, so `workflows:{…}` does
  not see it; `statuses` is the only route by which a failed preview/production deploy reaches
  Slack. The cost is per-commit status chatter on PRs. If that proves too noisy in practice, add
  `statuses` to the `unsubscribe` line above and accept that Vercel outcomes are then PR-only.

## 4. Commands — `#flashstack-security`

Run these **in `#flashstack-security`**:

```
/github subscribe mattglory/Flashstack workflows:{name:"Security Scan" branch:"main"}
/github unsubscribe mattglory/Flashstack commits issues pulls releases deployments statuses branches public discussions
/github subscribe mattglory/Flashstack issues:{label:"security"}
```

The `unsubscribe` line is important: `/github subscribe` on a repo applies defaults, so the
security channel must have them stripped or it becomes a second CI channel.

`issues:{label:"security"}` gives us a deliberate escalation path — labelling an issue `security`
routes it to the channel. Matt has created the `security` label, so this line resolves as written.

### 4.1 Known gap — security *alerts* do not reach Slack

**The official GitHub Slack app has no subscription for Dependabot alerts or CodeQL / code-scanning
alerts.** Those are restricted to users with repository security access and are not exposed as a
Slack subscription feature. So `#flashstack-security` will carry:

- ✅ `Security Scan` **workflow** outcomes (dependency audit + CodeQL job results)
- ❌ **not** the Dependabot alert feed, and **not** individual CodeQL findings

This is a real limitation, not an oversight in the commands above. Until it is closed, the alert
feed remains email + the GitHub Security tab. Closing it properly needs either a GitHub Actions
step that reads the alerts API and posts a digest, or GitHub Enterprise-level tooling — that is
Stage 2 territory, and see §7 for why Stage 2 is blocked.

## 5. Admin action required — cannot be done from this repository

Everything in §3 and §4 is a **Slack slash command**, not a repository file. None of it can be
committed, and none of it is active as a result of this document being merged. Matt needs to:

1. Install the GitHub app into the Slack workspace (**Slack workspace admin**) —
   https://slack.github.com or the Slack App Directory.
2. Create `#flashstack-ci` and `#flashstack-security` if they do not exist.
3. Run `/github signin` once, to link the GitHub account.
4. Run the §3 commands in `#flashstack-ci` and the §4 commands in `#flashstack-security`.
5. Confirm back what was actually applied — `/github subscribe list features` in each channel
   prints the live subscription set. **Please paste that output**, so the state in this document
   can be replaced with verified reality rather than intent.

**Secrets required: none.** If any step asks for a webhook URL or a token, stop — that means a
custom-bot path was taken instead of the official app, and that path needs a separate decision
about where the credential lives (repository/org secret, never a committed file).

### 5.1 Verify, do not assume

GitHub has changed the `workflows:{…}` filter syntax before. If a command in §3/§4 is rejected,
run `/github help` for the syntax that channel's app version accepts, and correct this document —
do not silently leave a subscription broader than specified. A subscription that fails open is
the noise problem; a filter believed to be applied but rejected is worse, because it looks solved.

## 6. Constraints — non-negotiable

- Slack is **never** a required status check, and no workflow gains a Slack step in Stage 1.
- A Slack failure **must not** fail the security gate. Stage 1 satisfies this structurally: there
  is no workflow step to fail. Stage 2 must satisfy it explicitly (`continue-on-error: true` on
  the notify step *only*, never on an audit step).
- No deployment or contract credential is ever sent to Slack.
- No webhook URL or token is ever committed. Org/repository secrets only, if ever needed.
- `.github/workflows/` is CODEOWNERS-protected; any Stage 2 workflow change goes through review.

## 7. Stage 2 — what unblocked it, and what still gates it

Stage 2 is a custom CI summary posting the **security gate result** to `#flashstack-security`.

**Blocker cleared.** Until PR #69 merged, both `npm audit` steps in `security.yml` carried
`continue-on-error: true`, so the Dependency Audit job concluded **success** even when the audit
printed high/critical findings — PR #61's run did exactly that. A Stage 2 summary built then would
have posted a green "Security CI passed" at precisely that moment: automated false assurance,
which is strictly worse than no notification.

```
  BEFORE #69                              NOW (#69 on main, 25130a4)
  ----------                              --------------------------
  npm audit finds high/critical           npm audit finds high/critical
            |                                       |
     continue-on-error: true                 step fails (flag removed)
            |                                       |
     step "fails" but is swallowed          job conclusion = failure
            |                                       |
  job conclusion = SUCCESS                  workflow conclusion = failure
            |                                       |
  Slack would report "all clear"           Slack reports the real result
            |
     FALSE ASSURANCE
```

The gate can now go red, so a summary of it can be trusted. For the record, `Security Scan` is
currently green because the tree is genuinely clean (root audit: 0 vulnerabilities; web audit:
0 high, 0 critical), not because the check is incapable of failing.

**What still gates Stage 2 is operational, not technical:** §5 has not been carried out yet, so
no one is subscribed. A summary posted into channels with no subscribers is not an observable
integration. The remaining sequence is:

```
§5 commands run  ->  /github subscribe list features pasted back  ->  verified channel state
                 ->  ONLY THEN Stage 2
```

Tracked in Beads as `Flashstack-ajv.2.9`. Do not start Stage 2 until the subscription state above
is verified rather than assumed.
