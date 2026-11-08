# DEPLOY-CHECKLIST — owner-only actions of the CI/CD wave

Every item below is an **owner** action (GitHub Settings, VPS as root, or a
manual merge). None of them is marked as done: this file is a walk-through,
not a status report. Agent contributions end at "merge the PR and hand over".

## 1. Merge the wave PR (unlocks preview-deploy.yml fixes)

`preview-deploy.yml` is a **workflow_run** pipeline: GitHub always executes it
from the **default branch (main)**, whatever the PR says. The rewritten status
step (`node scripts/preview-comment.mjs`) therefore activates only **after the
merge** lands on main:

- [ ] Merge the CI/CD wave PR into `main` (self-merge allowed once CI is green — publishing policy §2).
- [ ] Expect the PR's own preview deploy to STILL run the old main version
      (with the stray-paren bug) until the merge happens — a red
      "Deployment и один комментарий" step on the *preview* run does **not**
      mean the rollout failed: cross-check the `PREVIEW-RESULT overall=…`
      lines of the "Выкладка или снос на VPS" step instead.
- [ ] After the merge, push any new commit to an open PR (or re-run its
      preview build): the stale failure marker left by the incident must be
      REPLACED by an up-to-date marker comment; if it is not, the new
      reporting path is broken — file it as a bug.
- [ ] Optional cross-check: the `bash -n` CI gate
      ("Синтаксис bash в workflow-скриптах") must be green on the merge
      commit.

## 2. Settings → Environments → `production`

`deploy-frontend.yml` now references `environment: production` on the vps job:

- [ ] On first deploy GitHub auto-creates the environment **unprotected**;
      verify it appears under Settings → Environments.
- [ ] If a manual approval gate for production deploys is wanted, add
      protection rules (required reviewers) to `production` there. This is a
      **Settings-zone action**: agents cannot and must not configure it.
- [ ] If protection rules stay OFF, deploy-frontend.yml keeps its own gates:
      push-to-main only, `workflow_dispatch` main-only (dispatch-guard job)
      and the transactional switch with rollback.

## 3. Settings → Branches → required status checks

Recommended additions so regressions cannot sneak past the wave:

- [ ] `Синтаксис bash в workflow-скриптах` (bash -n over every workflow
      run-block; would have failed the broken main revision of the incident).
- [ ] `Preview комментарий (маркер/бейджи/шапка)` — marker-comment contract.
- [ ] `Прод-переключатель www (транзакция)` — production switch contract.

## 4. VPS one-time prerequisites (root, once)

The production flow needs **no new** rights beyond what
deploy-frontend.yml already required, but the new promotion uses one extra
directory and two extra contracts:

- [ ] `deploy` must keep write access to `/opt/coop-field` itself (the
      staging steps check it and fail safe with instructions).
- [ ] `/opt/coop-field/.deploy-tools/` is created by the workflow itself on
      each deploy; if a manual `rm -rf` ever removes it, the next deploy
      recreates it — no root action needed.
- [ ] NEVER let anything prune `/opt/coop-field/.node/` — the switcher runs
      via `/opt/coop-field/.node/bin/node` (the same binary the systemd unit
      `coop-field` uses).
- [ ] Never run the switcher concurrently by hand: it takes a lock dir
      (`/opt/coop-field/.www-switch.lock`); a stale lock (>30 min) is taken
      over automatically with a warning.

## 5. How to operate after the merge (do not fight the scripts from the shell)

- The switcher keeps exactly ONE previous release snapshot per root:
  `/opt/coop-field/www.prev` and `/opt/coop-field/www-elyria.prev`. Retired
  (two-releases-old) snapshots live in `.retired-<stamp>` pens and are
  removed automatically **after** both roots switched.
- [ ] Manual rollback (last resort, with the deploy user):
  ```bash
  ssh deploy@89.232.184.77
  cd /opt/coop-field
  test -d www.prev && test -d www-elyria.prev || \
    echo "WARN: one of the .prev snapshots is missing — check before continuing"
  # swap current and previous for BOTH roots (the swap itself is reversible):
  mv www www.old-new && mv www.prev www && mv www.old-new www.prev
  mv www-elyria www.old-new-elyria && mv www-elyria.prev www-elyria && mv www.old-new-elyria www-elyria.prev
  ```
- If a switch ever reports `INCONSISTENT` (rollBACK failed): do NOT improvise;
  the run log prints the rename journal — restore by replaying it backwards
  from the `*.prev` snapshots and then investigate the disk condition
  (`df`, permissions) that made the rename fail.
- A refused deployment ("REFUSED: staging …") means the build artifact never
  reached production — no cleanup is needed, staging is left in place for
  inspection.
