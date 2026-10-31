# Lessons learned: Ritlog app

Updated after feedback and errors. Each entry: what happened, cause, rule for next time.

---

## Constraints set by Roel

| Date | Constraint |
|---|---|
| 2026-10-28 | Ask questions one topic at a time and wait for approval before building. |
| 2026-10-30 | No Microsoft Entra / Azure. No services that require a paid plan or a credit card. |
| 2026-10-30 | Nothing is committed to this file without Roel's approval. |

---

## Errors and wrong assumptions

### 1. Entra needs an Azure directory (2026-10-30)
- **What happened:** the setup required a Microsoft Entra app registration for OneDrive access. Roel refused it, so the OneDrive design is blocked after phase 1 was built.
- **Cause:** I marked the account requirement as "Check:" in the setup guide instead of verifying it during design. The cost and account prerequisites of each external service were never checked against Roel's limits.
- **Rule:** during design, list every external service with: account needed, card needed, cost, admin rights needed. Get approval on that list before writing code.

### 2. Cost estimate was off by a factor of about 10 (2026-10-28)
- **What happened:** I first said "a few euros per year" for the Claude API. The calculation later gave about $0.02 to $0.03 per ride, a few dollars per month.
- **Cause:** I gave a number before calculating it.
- **Rule:** no cost figure without a calculation (tokens per call × price × expected volume). Show the calculation.

### 3. Microsoft Graph Excel API unclear for personal OneDrive (2026-10-28)
- **What happened:** Microsoft's own documentation contradicts itself on whether the workbook API works on a personal OneDrive.
- **Cause:** the design relied on an API I had not verified for this account type.
- **Fix:** the backend edits the .xlsx file itself (download, add row, upload). This works on any file storage and can be tested locally.
- **Rule:** prefer approaches that can be tested here over platform APIs that can only be tested on the user's account.

### 4. Save button lost the form data (2026-10-28, caught in testing)
- **What happened:** in the end-ride screen the app switched to "Saving…" before reading the form fields, so the save failed.
- **Cause:** UI replaced before values were collected.
- **Fix:** collect all values first, then change the screen.
- **Rule:** keep the end-to-end browser test in the routine. It caught this before Roel saw it.

### 5. Retry could write the same ride twice (2026-10-28, caught in review)
- **What happened:** if Excel was written but saving the app data failed, a retry would add the row again.
- **Fix:** before writing, the backend checks column H for the ride ID.
- **Rule:** every write that can be retried must be safe to repeat.

### 6. OneDrive path differed from the Windows path (2026-10-29)
- **What happened:** Windows showed `OneDrive\Documenten\ritlog`. The file was in `Documenten/Git` on OneDrive.
- **Cause:** I asked for the folder from Windows Explorer, which shows local and translated names.
- **Rule:** ask for the web address of the file (copy from the browser). It shows the real path.

### 7. Unclear request for the Cloudflare subdomain (2026-10-29)
- **What happened:** I asked for "the subdomain" and got the dashboard address.
- **Rule:** when asking for a value from a web console, give the exact menu path and an example of what the value looks like.

### 8. GitHub push refused (2026-10-29)
- **What happened:** pushing to the new repository failed until the Claude GitHub App was installed.
- **Rule:** put "install the Claude GitHub App on the repository" in the setup steps, before the push.

### 9. Secrets pasted in the chat (2026-10-29)
- **What happened:** the Cloudflare token and Anthropic key were pasted in the chat, although the instructions said not to.
- **Cause:** the instruction came after the steps, and I gave no clear place to paste each value at the moment it was created.
- **Rule:** at the step where a secret is created, say right there where to paste it (for example the GitHub secrets page). Advise replacing any secret that ends up in the chat.

### 10. Anthropic key with an unexpected prefix (2026-10-29)
- **What happened:** the key started with `sk-ant-usr-`. Normal API keys start with `sk-ant-api`.
- **Rule:** tell what a valid value looks like (prefix, length) at the step where it is created.

### 11. Secrets entered in the wrong repository (2026-10-31)
- **What happened:** the GitHub secrets and variable were added to another repository instead of `ritlog`. Secrets cannot be moved or read back, so they had to be entered again.
- **Rule:** on a GitHub settings page, check the repository name in the page header (`rfonteyninfo / ritlog`) before adding secrets. Give direct links to the right settings page in every instruction.

---

## Technical notes

- The cloud container has no `rsync`. Use `tar` to copy folders.
- Node ES modules ignore `NODE_PATH`. Load a global package (Playwright) with `createRequire`.
- A chain of commands with `&&` stops at the first failure. Check the output before assuming later steps ran.
