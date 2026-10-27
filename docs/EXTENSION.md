# The Rolecraft Chrome extension

The extension is an unpacked Manifest V3 extension with a side panel, and it pairs with your own Rolecraft server. When you click **Apply** on a job, the panel links the new tab to that job. After you click **Prefill**, it fills the empty fields of the application form from your profile, your saved answers, and the answers drafted for the job. It attaches a resume or cover letter PDF to the upload field you pick. It never submits a form, never changes a field that already has a value, and never fills a pay question. When the page looks like a confirmation page, it asks you before it marks the job applied. It can also import a job posting from the page you are reading.

This page has three parts: how-to guides, reference, and notes for developers. For the design behind the extension, read [ARCHITECTURE.md](ARCHITECTURE.md) and decisions 56 to 61 in [DECISIONS.md](DECISIONS.md).

## Set it up once

You need Chrome 116 or later. You also need Rolecraft running on this computer, with Docker (`docker compose up -d`) or for development (`bun run dev`).

### Build and load the extension

1. In the repository, build the extension:

   ```sh
   bun run build:extension
   ```

   The build writes the `dist-extension/` folder.

2. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select `dist-extension/`.
4. Click the puzzle icon in the toolbar and pin **Rolecraft**.

To open the side panel, click the **Rolecraft** icon.

### Pair the extension with Rolecraft

1. In Rolecraft, open **Settings** and find **Chrome extension**.
2. Click **Create pairing code**. The code has eight characters, works once, and expires after 10 minutes.
3. In the side panel, enter the **Rolecraft address**. Use `http://localhost:3000`, or the port in `HB_PORT` for Docker or `PORT` for `bun run dev`. With `bun run dev`, use the API port, not the Vite page on `5173`. The panel also accepts `http://127.0.0.1` and `https` addresses.
4. Enter the **Pairing code** and click **Pair**.
5. When Chrome asks for access to the address, click **Allow**. The extension needs it to call the server.

The panel shows "Paired with" and the address. In **Settings**, the pairing shows as **Active**.

## Prepare what the panel fills

The panel fills only what Rolecraft already knows. Before your first application, fill in these places:

| Where | What to fill | What it fills on a form |
|---|---|---|
| **Profile** > **Contact** | Name, email, phone, location, and links | Name, email, phone, location, LinkedIn, GitHub, and website. Website takes your first link that is not LinkedIn or GitHub. Links to your private GitHub repos never fill. |
| **Profile** > **Standard answers** | Work authorization, notice period, start date, and references | The matching questions on every job |
| The job's workspace | Draft the resume and cover letter, and fix everything under **Needs your input** | The files you can attach |
| The job's workspace | Draft the answers to the job's questions, then click **Mark reviewed** | The custom questions on that job's form |

Some questions have no place in your profile: sponsorship, how you heard about the job, portfolio, relocation, travel, work arrangement, and the voluntary questions (gender, race or ethnicity, veteran status, and disability). Answer them on the first form. After a fill, the panel offers **Save as default** or **Save for this job** for each field you typed yourself, and the next form gets that answer.

A file attaches only when Rolecraft can export it. A resume with a `[[...]]` blank left in it is refused, the same as PDF export. For what never fills, read [Limits](#limits).

## Apply to a job

Do these steps for each application.

### 1. Open the form from Rolecraft

1. Open the job's workspace in Rolecraft.
2. Click **Apply** with a plain click. A Cmd-click or Ctrl-click opens the page without telling the extension.

Rolecraft opens the job's apply page in a new tab and starts an application session. You have 15 minutes to link the tab. After you link it, the session lasts 4 hours.

### 2. Link the tab

On the new tab, click the **Rolecraft** icon to open the panel. The panel shows the job and links the tab. If the panel shows something else, use this table:

| Panel says | Do this |
|---|---|
| "The extension can't read this tab's address" | Click **Allow access to the job's site**, then **Allow** in Chrome's prompt. |
| "This tab isn't the job's apply page." | The site sent you to another address, for example from a job board to the company's own site. If this is the same job's form, click **Link this tab anyway**. |
| "This application session ended" | More than 15 minutes passed. Click **Apply** in Rolecraft again. |
| "Click Apply on a job in Rolecraft, then open its application form in this tab." | There is no session. Go back to step 1. |

If the form is on a later page, for example after the site's own **Apply** button, go to that page first. The panel follows the tab.

### 3. Scan the form

1. Click **Scan form**.
2. The first time on a site, Chrome asks for access to that one site. Click **Allow**.

The panel lists every field it found, in groups:

- **Check these first.** Likely matches and drafted answers you have not reviewed. They fill only if you tick them. A drafted answer also has **Mark reviewed**.
- **Will fill.** Exact matches from your profile and saved answers.
- **Turned off.** Fields you unticked. They stay as they are.
- **Left blank.** Each field says why. For example, it already had a value, it is a pay question, nothing saved fits, or the control is not supported.

When the form asks about work authorization, sponsorship, gender, race or ethnicity, veteran status, or disability, the panel shows a checklist. Confirm it once for this application before any of those fields fill.

### 4. Draft or save custom answers

Under **Custom answers**, the panel offers controls for free-text questions it found on the form. It does not read existing field values during a scan.

To save an answer you typed on the site:

1. Click **Read from form** beside that question. The panel reads only that field.
2. Review or edit the text in the panel.
3. Click **Save reference**. The server saves the question, answer, and source job.

When the same question appears on another application, the panel shows up to three saved references with their original companies. Matching ignores case and whitespace, but preserves wording and company names. Click **Use as starting point**, edit the answer for this job, then click **Fill this answer**. Selecting a reference alone never fills the page.

To draft a new answer, click **Generate draft**. Rolecraft adds the question to this job's workspace and uses the existing AI drafting flow. Read and edit the result, replace any `[[placeholders]]`, then click **Fill this answer**. Drafting uses your AI budget and does not approve spending over your cap. A regeneration button explicitly says it replaces the answer in the panel. Neither drafting nor filling saves a reusable reference automatically.

Personal details such as your current company, websites, and availability must be written by you. Pay, authorization, and sensitive questions have no custom drafting controls. Filling always leaves a nonempty field untouched.

Questions already in the workspace also appear under **Questions without an answer**. Click **Draft**, then scan again to see the result under **Check these first**. Read it, then click **Mark reviewed** or tick it.

### 5. Attach files

This step is optional.

1. Under **Files**, pick the resume or cover letter for each upload field. The panel suggests one from the field's label.
2. Click **Attach**.
3. Check that the page now shows the file name.

When the page refuses the file, the panel offers **Download instead**. Upload the downloaded PDF on the page yourself.

### 6. Prefill and submit

1. Click **Prefill**. The button shows how many fields will fill.
2. Check every field on the page. Fix anything wrong, and fill what the panel left blank.
3. To give the next form the same answer for a field you typed, click **Save as default** or **Save for this job**.
4. Submit the form on the site.

### 7. Mark the job applied

When the page shows a confirmation, the panel asks "Did you submit this application?". Click **Yes, mark applied** only if you submitted. The job moves to Applied on your board. If the panel does not ask, mark the job applied in Rolecraft yourself.

## Import a job from a page

1. Open the job posting in a tab.
2. In the panel, open the **Import** tab and click **Read this page**. If Chrome asks for access to the site, click **Allow**.
3. If Rolecraft already has this job, the panel links to it. If not, check the title, company, location, apply link, and description, and fix anything wrong.
4. Click **Import**. The job goes to your board.

The extension reads nothing until you click **Read this page** and saves nothing until you click **Import**.

## Update the extension

1. Pull the new code and run `bun run build:extension`.
2. In `chrome://extensions`, click the reload icon on the **Rolecraft** card.

The pairing survives a reload. Chrome derives the extension's id from the folder path, so load the folder from the same path each time. A new id needs a new pairing. Removing the extension deletes its storage, and after you add it again you must pair again.

## Stop using the extension

- To cut off the extension at the server, click **Revoke** on the pairing in **Settings** and confirm. At its next request the panel shows the pairing screen with "This browser was disconnected from Rolecraft. Pair it again."
- To forget the token in this browser, click **Disconnect** in the panel. The server still lists the pairing as **Active**, so revoke it in **Settings** too.
- To take back access to one site, click **Revoke** next to it under **Allowed sites** in **Diagnostics**, or remove it on the extension's details page in `chrome://extensions`.
- To remove everything the extension stored, remove it in `chrome://extensions`, then revoke the pairing in **Settings**.

## Troubleshooting

To see what the extension did, open the **Diagnostics** tab. It lists the recent requests with their outcomes, and the sites you allowed.

| Problem | Fix |
|---|---|
| "Could not reach Rolecraft" or "Can't reach Rolecraft at ..." | Start the server, then click **Retry**. Check that the address in the panel matches the table in [Pair the extension with Rolecraft](#pair-the-extension-with-rolecraft). |
| "This browser was disconnected from Rolecraft. Pair it again." | The pairing was revoked in **Settings**. Pair again with a new code. |
| "The extension's background worker did not answer" | Reload the extension in `chrome://extensions`. |
| "The form changed since the scan" or "The page changed, scan again" | The site redrew the form. Click **Scan form** again. |
| The scan finds no fields, or a dropdown or yes-or-no question stays blank | The extension cannot fill that form or control. Read [Limits](#limits) and fill it yourself. |
| A field you expected stays blank | Read its reason under **Left blank**. Usually Rolecraft has no answer for it. Add the answer to your profile, or fill the field and click **Save as default**. |
| The resume won't attach | Fix everything under **Needs your input** in the workspace. The PDF must also be 10 MB or less. |
| The panel shows a different job | Click **Apply** on the job you want. In its form tab, click **Refresh application** in the panel. This checks the current session without reloading the page or clearing its fields. |

## Reference

### Permissions

The manifest is `extension/manifest.json`. `extension/test/manifest.test.ts` fails if a permission is added or removed.

| Permission | Why the extension has it |
|---|---|
| `sidePanel` | Shows the panel when you click the toolbar icon. |
| `storage` | Keeps the data in [Where data is kept](#where-data-is-kept). |
| `activeTab` | Gives the extension the current tab after you click the toolbar icon, until you navigate away, without a site grant. |
| `scripting` | Injects `content.js` into the top frame of the current tab with `chrome.scripting.executeScript`, only after a panel click. |
| `downloads` | Saves the PDF when you click **Download instead** after **Attach** fails. |
| `http://localhost/*`, `http://127.0.0.1/*` (optional) | Requested when you pair, so the worker can call your server. |
| `https://*/*` (optional) | Requested one site at a time, as `https://<host>/*`, when you click **Scan form**, **Allow access to the job's site**, or **Read this page**. |

The manifest has no `host_permissions`, no `content_scripts`, no `externally_connectable`, and no `web_accessible_resources`. A web page cannot send a message to the extension, and it cannot load a file from the extension.

### Where data is kept

| Place | Holds | Cleared when |
|---|---|---|
| `chrome.storage.local` | `endpoint`, `pairing` (pairing id and bearer token), and `grantedOrigins` | The token goes on **Disconnect** or a 401. Everything goes when you remove the extension. |
| `chrome.storage.session` | `binding` (session id, opportunity id, tab id, and claim time) and `diagnostics`, the last 50 log entries. An entry holds request kind, outcome, origin, adapter, field counts, and time. | The browser closes. The binding also goes on **Disconnect**, a new pairing, a 401, a confirmed submission, or discovery that its session ended or changed. |
| `extension_pairings` table | SHA-256 digests of the code and the token, the `chrome-extension://` origin, and the created, claimed, last-used, and revoked times | An unclaimed expired code goes at the next **Create pairing code**. A claimed pairing stays. Revoking sets `revoked_at`. |
| `application_sessions` table | One row for each **Apply**: opportunity, apply URL, status (`pending`, `claimed`, `completed`, or `expired`), expiry, and the claiming pairing | Deleted with the opportunity. A new **Apply** expires the live one. |
| `application_preferences` table | Answers saved with **Save as default** or **Save for this job** | A new save for the same question and scope replaces one. A job's answers go with the job. No screen deletes them, only `DELETE /api/extension/preferences/:id`. |
| `answer_references` table | Custom question text, the explicitly saved answer, source opportunity, and update time | A save for the same question and source job replaces it. Deleting the source opportunity deletes its references. No library deletion screen exists yet. |
| `outputs.reviewed_at` column | When you marked a drafted answer or file reviewed | A redraft or a body edit sets it back to null. |

The Chrome storage keys carry no product name, so the rename from Hanapbuhay to Rolecraft needs no migration. An extension you paired before the rename keeps its endpoint and token. Some developer identifiers still use the old name on purpose: the `HB_*` environment variables (such as `HB_PORT`, `HB_HOST`, and `HB_E2E_EXTENSION_PORT`) and the `hanapbuhay_e2e` test database.

The content script also keeps the old install marker. It marks a page as having its message listener by setting `rolecraftContentInstalled` and the legacy `hanapbuhayContentInstalled` in the extension's isolated world. Before it installs, it checks both. A page that got the script before the rename keeps that marker while it stays open, so this check stops a second listener when the script is injected again.

Chrome storage contains no answers, page text, or file bytes. Custom answers remain in panel memory while you review them, and reach server storage only through an explicit save or draft. A PDF exists only in memory, for the duration of one **Attach**.

### Threat model

The extension can type into forms on sites you approve, with data from your profile, and the server has no login. These are the risks and what stops each one.

**A malicious or compromised job page.** The content script runs in an isolated world. It does not listen to `window` messages, reads no `chrome.storage`, and never receives the token. The worker acts only on messages from the extension's own pages. It drops a message from a subframe unparsed and logs `not_top_frame`, and it answers a top-frame message with nothing. Scan and fill results reach the worker only as the reply to its own request, checked by nonce. Before a fill writes, the content script scans again and compares each field's signature. It skips a field that changed, is hidden, disabled, or read-only, or has a value. It never clicks a button. A page can still show misleading labels, so check the values and sources the review lists before **Prefill**.

**Token leakage.** The token is 32 random bytes. The server stores only its SHA-256 digest, compares digests in constant time, and never logs the code or the token. The worker sends the token in an `Authorization` header to the paired endpoint only. The server refuses the token with any `Origin` other than the paired `chrome-extension://` origin, but accepts it with no `Origin`, for example from `curl`. Anything that can read your Chrome profile can read the token. If you think it leaked, revoke the pairing.

**Localhost CSRF and DNS rebinding.** The server listens on `127.0.0.1` by default (`HB_HOST`). Under `/api`, it answers only to the `Host` names `localhost`, `127.0.0.1`, and `[::1]`, plus `HB_ALLOWED_HOSTS`, so a rebinding domain gets 403. It also refuses a write (any method except GET, HEAD, and OPTIONS) with `forbidden_origin` when the `Origin` is not the request's own host or `Sec-Fetch-Site` is `cross-site`. The `/api/extension/*` routes skip that rule and need the bearer token instead. Their CORS answer echoes back only a `chrome-extension://` origin, never `*`, and never with credentials. The pairing claim needs a `chrome-extension://` `Origin` and binds the pairing to it.

**Host permissions.** The extension starts with no site access, and you grant each job site from a click in the panel. The panel refuses http pages, wildcards, and the hosts in `src/shared/hosts.ts`.

**Sensitive values.** Work authorization, sponsorship, and the voluntary questions fill only after you confirm the checklist for this application. The salary answer never leaves the server in a prefill reply. A field whose label mentions salary, compensation, pay, rate, wage, remuneration, CTC, income, stipend, or OTE is left blank. A drafted answer that you have not marked reviewed fills only if you tick it.

**File injection.** The worker fetches the PDF from your server and checks that the media type is `application/pdf`, the body starts with `%PDF-`, and the body is 10 MB or less. It puts the file on the one upload field you picked, only while that field is still visible, enabled, empty, unchanged, and accepts PDF. The extension never reads files from your disk.

**No rate limit on the pairing claim.** `POST /api/extension/pair/claim` has no attempt limit. A code has 8 characters from a 30-character alphabet, about 6.6 × 10^11 codes, and lives 10 minutes. Only a caller that can reach the server and send a `chrome-extension://` `Origin` can guess. On loopback, that is a process on your own computer. If you expose the server with `HB_HOST` or `HB_ALLOWED_HOSTS`, guessing over the network becomes possible.

### Limits

- **Pay questions are never filled**, even when you saved a salary answer. Type the answer yourself.
- **Greenhouse single-choice questions are not filled.** Country, work authorization, sponsorship, and the EEOC questions are react-select comboboxes whose options are not in the page. They stay blank as `unsupported_control`.
- **Ashby yes-or-no questions are not filled.** Each one is two buttons and a hidden checkbox, and the extension never clicks buttons.
- **Shadow DOM and iframes are not scanned.** The scan reads the light DOM of the top frame only. A form inside an iframe or a shadow root shows as no fields.
- **Lever's disability-form signature lines stay blank.** Lever labels them only "Name" and "Date", so the Lever adapter renames them to keep your name and start date out.
- **Custom upload widgets get no file.** **Attach** needs a real `<input type="file">`. A page with only a drag-and-drop area shows no **Files** list. Click **Download PDF** on the file in the workspace and upload it yourself.
- **Names split only in two words.** "Maria Santos" fills first name "Maria" and last name "Santos". A one-word name, or a name with three or more words such as "Juan dela Cruz", leaves first-name and last-name fields blank. A single full-name field still fills.
- **Facts are not used for prefill.** They reach a form only through the files and answers drafted from them.
- **Blocked sites.** The terms of the sites in `src/shared/hosts.ts` forbid automated tools: LinkedIn, Indeed, JobStreet, Kalibrr, OnlineJobs.ph, Upwork, Glassdoor, Wellfound, and Toptal, with their subdomains. There the extension never reads, scans, fills, attaches to, or checks a page for success, and **Read this page** tells you to paste the job into Rolecraft. **Apply** still opens these jobs. To paste your answers, use **Copy text** on each file and answer in the workspace. Whether to allow prefill there is open (decision 61).
- **Docker publishes the app on loopback only.** `compose.yaml` publishes the app's port and the Postgres port on `127.0.0.1`.

## For developers

### Run the end-to-end test

The test is `e2e-extension/extension.e2e.ts`, run by `playwright.extension.config.ts`. Its name does not end in `.spec.ts`, because `bun test` would pick that up.

1. Start Postgres with `bun run db:up`.
2. Run the test:

   ```sh
   bun run e2e:extension
   ```

The script type-checks `e2e-extension/`, builds `dist/` and `dist-extension/`, and runs the specs. The server runs on port 3110 (set `HB_E2E_EXTENSION_PORT` to change it) with the `hanapbuhay_e2e` database and the fake AI and fixture sources of `bun run e2e`. The test that stops the server starts a second server on the next port. Both runs reset `hanapbuhay_e2e` before each test, so do not run `bun run e2e` and `bun run e2e:extension` at the same time.

The test loads the extension into a persistent context of Playwright's full Chromium build (`channel: "chromium"`), headless. The default headless shell does not load extensions. To watch the run, set `HEADED=1`. If Chromium does not start the extension's service worker, each test is skipped with the reason. Run the manual checklist instead.

Two parts of a real session cannot be automated:

- **The side panel.** Chrome has no API to open or drive a side panel. The test opens `chrome-extension://<id>/panel.html` as a background tab in the window of the job tab, where `chrome.tabs.query({ active: true, currentWindow: true })` returns the job tab.
- **The permission prompt.** Playwright cannot click the prompt of `chrome.permissions.request`, and headless, the request never resolves. The test copies `dist-extension/` to a temporary folder and adds `http://localhost/*` and `https://jobs.rolecraft-fixture.test/*` to the manifest of the copy as `host_permissions`. Every other origin stays optional and ungranted. The test fails if the shipped manifest ever declares `host_permissions`.

The job site is `application.html` and `frame.html` in `e2e-extension/fixtures/`. A Playwright route serves them at `https://jobs.rolecraft-fixture.test` (approved) and `https://other.rolecraft-fixture.test` (never approved). No request goes to the network.

The tests cover pairing through "mark applied", messages from the page and its subframe, an unapproved origin, a revoked pairing, and a stopped server. They also verify explicit custom-answer capture and saving, review-only reuse on another job, and drafting a newly scanned question without automatic filling. The happy path checks that **Prefill** leaves the pre-filled phone and salary untouched, and that Chrome storage holds no profile values or file bytes.

### Manual checklist for live job sites

Run these checks before you rely on the extension. Use real postings and never submit.

- [ ] Load `dist-extension/` unpacked and pair it. Restart the service worker from `chrome://extensions` and check that the panel still shows "Paired with".
- [ ] In **Settings**, check that the pairing code is readable and that its countdown runs.
- [ ] When you pair, check that Chrome shows its own prompt for the server address. The automated test skips the prompt.
- [ ] On a live **Greenhouse** posting, click **Apply**, open the panel, and click **Scan form**. Check that Chrome asks for that one site. Allow it, click **Prefill**, and check that only empty fields changed. Attach the resume and check that the page lists the file name.
- [ ] Repeat on a live **Lever** posting. Check that the disability-form signature lines stay blank.
- [ ] Repeat on a live **Ashby** posting. Check that the yes-or-no buttons are untouched.
- [ ] On a custom text question, type an answer on the site, click **Read from form**, and save a reference. On another job with the same question, check that its source company appears and that selecting it does not fill the page. Generate a draft for an eligible question and review it before filling.
- [ ] Stop the server in the middle of a session. Click **Prefill** and check that the panel shows the pairing screen with "Can't reach Rolecraft" and that the page is unchanged.
- [ ] Open the extension's service worker in `chrome://extensions`. In its console, run `await chrome.storage.local.get(null)` and `await chrome.storage.session.get(null)`. Check that no answers, page text, or file data appear.
- [ ] Open a LinkedIn job in a tab. Check that **Scan form** and **Read this page** both refuse with the terms message.
