# ee-crs-daily

This runs every day on your Mac with no Claude involved. It:

1. reads your profile, Sohana's profile and your future plans (CSV files);
2. opens IRCC's **official CRS calculator** in a hidden Chrome window (Playwright), fills every question and clicks **Calculate your score**, once for your current profile and once for every combination of plans;
3. reads the site's own total, the latest draw cutoffs from IRCC's rounds data, and the category rules from IRCC's category page;
4. emails three tables to you and Sohana: **Input (current profile)**, **Points**, and **Documents to collect** (from the `*_EE_evidence_documents.csv` checklists next to each profile).

Every total comes from the site. The script never adds up points itself. If anything fails, you both get a one-line email saying why, with no numbers.

## What you need

- macOS with Node.js 18 or newer (`node -v`). If you don't have it: `brew install node`.
- A **Gmail app password** for the sending account (below).
- Access to the CSVs, either as files on the Mac (option A) or through a Google service account (option B).

## Setup (about 10 minutes)

```bash
cd ~/ee-crs-daily        # wherever you unzipped it
./install.sh             # installs dependencies and the browser, creates config.json
```

Then edit `config.json`.

### 1. Where the CSVs come from

**Option A, local files (simplest).** Install Google Drive for Desktop and sign in to the account that can see the "Canada PR – Express Entry" folder. If you use pervez.cse@gmail.com, Sohana shares the folder with you first; then right-click the folder → Organize → Add shortcut → My Drive. Set `principal`, `partner` and `plans` to the three CSV paths, for example:

```
~/Library/CloudStorage/GoogleDrive-pervez.cse@gmail.com/My Drive/Canada PR – Express Entry/Pervez/Pervez_EE_profile.csv
```

You can check a path with `ls "<path>"`. In Drive for Desktop, right-click the folder and choose "Available offline" so the files are on disk at 6 pm.

**Option B, straight from Google Drive (no Drive app).**
1. In Google Cloud Console, create a project, enable the **Google Drive API**, create a **service account** and download its JSON key as `service-account.json` into this folder.
2. In Drive, share the **Pervez** and **Sohana** folders with the service account's email (it ends in `iam.gserviceaccount.com`) as **Viewer**.
3. In `config.json`, replace `source` with the `_source_drive_example` block and rename it to `source`. The folder IDs are already filled in.

The script finds files by name, so it keeps working when a CSV is replaced.

### 2. Gmail app password

Using sohanamahmud@gmail.com (the same account that owns the Drive folder):

1. Turn on 2-Step Verification: Google Account → Security.
2. Go to <https://myaccount.google.com/apppasswords>, create one named "ee-crs-daily", and copy the 16 characters.
3. Put them in `mail.appPassword`. Set `mail.user` and `mail.from` to that account.

`config.json` is set to be readable only by you (`chmod 600`). Don't share it.

### 3. Test, then schedule

```bash
node crs-daily.js --dry-run   # runs the real calculator and prints the two tables; no email
node crs-daily.js --show      # same, with the browser visible so you can watch it fill the form
node crs-daily.js             # real run: sends the email
./install.sh                  # run again: schedules it daily at 18:00
```

To use a different time, run for example `./install.sh 18 30`. The log is in `logs/run.log`.

To start the scheduled job right away: `launchctl kickstart gui/$(id -u)/ca.ee-crs-daily`.
To remove the schedule: `./uninstall.sh`.

**If the Mac is asleep at 18:00**, macOS runs the job as soon as it wakes. If it's shut down, that day is skipped.

## Run it in the cloud instead (GitHub Actions, no laptop)

The same script runs on GitHub's servers at 18:00 Montréal time every day. Your Mac can be off. It's free: a private repo gets 2,000 minutes a month and each run takes about 3.

1. **Google service account** (the cloud can't see your Drive app's files). Follow option B above: enable the Drive API, create a service account, download its JSON key, and share the **Pervez** and **Sohana** folders with its email as **Viewer**.
2. **Gmail app password**, as in step 2 above.
3. **Create a private repo** on GitHub, for example `ee-crs-daily`, and push this folder:
   ```bash
   cd ~/ee-crs-daily
   git init && git add . && git commit -m "ee-crs-daily"
   git branch -M main
   git remote add origin git@github.com:YOUR_USER/ee-crs-daily.git
   git push -u origin main
   ```
   `.gitignore` keeps `config.json` and the key out of the repo.
4. **Add two secrets** under the repo's Settings → Secrets and variables → Actions → New repository secret:
   - `CRS_CONFIG_JSON`: the whole of `config.cloud.example.json`, with your app password filled in.
   - `GDRIVE_SA_JSON`: the whole service account key file.
5. **Test it:** go to the Actions tab → **Express Entry daily CRS** → **Run workflow**. Leave "Only print the tables" ticked; the two tables appear in the run log. Then run it once with the box unticked to send the email.

From then on it runs by itself. GitHub sometimes starts scheduled runs late, so the email can arrive a few minutes to about half an hour after 18:00. Two schedules (22:00 and 23:00 UTC) cover summer and winter time, and only the one that is 18:00 in Montréal that day runs.

**One unknown:** canada.ca may treat GitHub's servers differently from a home connection. If the test run fails with a page that won't load or a missing field, use the Mac setup instead.

## Plans

Each row in `Pervez_EE_future_plan.csv` with a value in **Calculator change (override)** becomes a plan, for example:

| # | Calculator change (override) | Target date |
|---|---|---|
| 1 | `lang1_writing = 10` | |
| 2 | `canadian_work_years = 1; canadian_high_wage = 1.5x` | 2027-01-19 |

The script runs the current profile, then each plan alone and every combination. For a combination it uses your age on its latest target date; for a plan with no target date it uses today's age. Add a row and it shows up in the next email.

## Files

| File | What it does |
|---|---|
| `crs-daily.js` | Main program |
| `lib/page-script.js` | Runs inside the calculator page: fills the form, clicks Calculate, reads the site's result, checks draw and category eligibility |
| `lib/inputs.js` | Reads the CSVs (local or Drive) and builds the plan combinations |
| `lib/report.js` | Builds the two tables (text and HTML) |
| `test/mock-routes.js` | For testing only: a stand-in calculator page, never used in normal runs |

## If it breaks

IRCC sometimes changes the form. In that case the failure email names the field, for example `Field q6ii not found` or `No option "…" in q3`. Run `node crs-daily.js --show` to see the page, then update the mapping in `lib/page-script.js` (the `runCalculator` function).
