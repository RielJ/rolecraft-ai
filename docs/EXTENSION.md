# The Hanapbuhay Chrome extension

The extension is an unpacked Manifest V3 extension with a side panel. It pairs with your own Hanapbuhay server. When you click **Apply** in a job's workspace, the panel links the job's tab to that application. After you click **Prefill**, it fills empty fields from your profile, your saved answers, and the answers you marked reviewed. It attaches a PDF only to the upload field you pick. It never submits a form, never overwrites a field that has a value, and never fills a pay question. When the page looks like a confirmation page, it asks you before it marks the job applied.

To set it up and use it step by step, read [extension-guide.md](extension-guide.md). This page has three parts:

- How-to guides: install, pair, revoke, and run the tests.
- Reference: permissions, stored data, the threat model, and the limits.
- The manual checklist for live job sites.

## Install the extension

You need Chrome 116 or later, and a Hanapbuhay server running on this computer.

1. Build the extension:

   ```sh
   bun run build:extension
   ```

   The build writes `dist-extension/`.

2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `dist-extension/` folder.
4. Pin **Hanapbuhay** to the toolbar. Click the icon to open the side panel.

Chrome gives an unpacked extension an id that comes from the folder path. If you load the folder from another path, the id changes, and you must pair again.

After you rebuild, click the reload button on the extension's card in `chrome://extensions`. The pairing survives a reload. Removing the extension deletes its storage, so after you add it again you must pair again.

## Pair the extension with your server

1. In Hanapbuhay, open **Settings** and find **Chrome extension**.
2. Click **Create pairing code**. The code has eight characters and expires after 10 minutes.
3. In the side panel, enter the **Hanapbuhay address**, for example `http://localhost:3000`. Use the address you open the app at. The address must be `http://localhost`, `http://127.0.0.1`, or an `https` address.
4. Enter the **Pairing code** and click **Pair**.
5. When Chrome asks for access to the address, click **Allow**. The extension needs it to call the server.

The panel then shows "Paired with" and the address. In **Settings**, the pairing shows as **Active**. A code works one time only.

## Apply to a job with the panel

1. In the job's workspace, click **Apply**. Hanapbuhay opens the apply URL in a new tab and records an application session.
2. Open the side panel on that tab. The panel shows the job and links the tab to the session. If the panel says it can't read the tab's address, click **Allow access to the job's site**.
3. Click **Scan form**. The first time on a site, Chrome asks for access to that site. Click **Allow**.
4. Read the review. Fields under **Check these first** fill only if you tick them. Fields under **Left blank** say why.
5. Optional: under **Files**, pick the PDF and click **Attach** for an upload field. Check that the page lists the file name.
6. Click **Prefill**.
7. Check every field yourself, then submit the form on the site.
8. When the panel asks "Did you submit this application?", click **Yes, mark applied** only if you did.

If the session is older than 15 minutes when the panel tries to link the tab, click **Apply** again.

## Disconnect or revoke the extension

- To stop the extension from using the server, open **Settings** in Hanapbuhay, click **Revoke** on the pairing, and confirm. The next panel request gets a 401, and the panel goes back to the pairing screen with "This browser was disconnected from Hanapbuhay. Pair it again."
- To forget the token in this browser only, click **Disconnect** in the panel. The server still lists the pairing as **Active**. Revoke it in **Settings** too.
- To take back access to one job site, open **Diagnostics** in the panel and click **Revoke** next to the site under **Allowed sites**. You can also remove site access on the extension's details page in `chrome://extensions`.
- To remove everything the extension stored, remove the extension in `chrome://extensions`.

## Run the end-to-end test

The test is `e2e-extension/extension.e2e.ts`, run by `playwright.extension.config.ts`. It is not named `*.spec.ts`, because `bun test` would pick that up.

1. Start Postgres with `bun run db:up`.
2. Build the web app with `bun run build`.
3. Run the test:

   ```sh
   bun run e2e:extension
   ```

The script type-checks `e2e-extension/`, builds `dist-extension/`, and runs the specs. The config starts the server on port 3110 (set `HB_E2E_EXTENSION_PORT` to change it), with the same `hanapbuhay_e2e` database and the same fake AI and fixture sources as `bun run e2e`. The test that stops the server starts a second server on the next port. Both runs reset `hanapbuhay_e2e` before each test, so do not run `bun run e2e` and `bun run e2e:extension` at the same time.

The test loads the extension into a persistent Chromium context. It uses Playwright's full Chromium build (`channel: "chromium"`) in headless mode, because the default headless shell does not load extensions. To watch the run, set `HEADED=1`. If Chromium does not start the extension's service worker, each test is skipped with the reason, and you must run the manual checklist instead.

Two parts of a real session cannot be automated:

- **The side panel.** Chrome has no automation API to open or drive a side panel. The test opens `chrome-extension://<id>/panel.html` as a background tab in the job tab's window. In that tab, `chrome.tabs.query({ active: true, currentWindow: true })` returns the job tab, as it does from the side panel.
- **The permission prompt.** `chrome.permissions.request` shows a native prompt that Playwright cannot click. In headless mode the request never resolves. The test copies `dist-extension/` to a temporary folder and adds `http://localhost/*` and `https://jobs.hb-fixture.test/*` to the copy's manifest as `host_permissions`. The panel's request for those origins then resolves without a prompt. Every other origin stays optional and ungranted. The shipped manifest is not changed, and the test fails if it ever declares `host_permissions`.

The job site is `application.html` and `frame.html` in `e2e-extension/fixtures/`. A Playwright route serves them at `https://jobs.hb-fixture.test` (approved) and `https://other.hb-fixture.test` (never approved). No request goes to the network.

The specs cover these flows:

| Test | What it proves |
|---|---|
| Happy path | Pair with a code from **Settings**. **Apply** opens the apply URL and records a pending session. The panel claims it. Scan, then attach the reviewed resume. Prefill fills first name, last name, and email only, and leaves the pre-filled phone and the salary question untouched. The panel asks after the page shows "Thanks for applying", and only **Yes** marks the job applied on the board. Extension storage holds no profile values or file bytes. |
| Foreign messages | The page has no `chrome.runtime`. `postMessage` calls from the page and from its subframe get no answer and change nothing. A runtime message from a script in the subframe gets no reply and shows in **Diagnostics** as `refused scan_result` with `not_top_frame`. |
| Unapproved origin | The panel can't read the tab's address, so it shows **Allow access to the job's site** and no **Scan form**. A forged `session_claim` gets `unsupported_url`, a forged `scan` gets `not_bound`, and Chrome refuses to inject the content script. The session stays pending. |
| Revoked pairing | Revoking in **Settings** puts the panel back on the pairing screen at the next **Prefill** click. Nothing is filled. The token and the tab binding are deleted. The endpoint stays. |
| Server stopped | With the server stopped, **Prefill** fails closed with "Can't reach Hanapbuhay at ...", and **Retry** keeps it closed. The page is unchanged. |

## Permissions

The manifest is `extension/manifest.json`. `extension/test/manifest.test.ts` fails if a permission is added or removed.

| Permission | Why the extension has it |
|---|---|
| `sidePanel` | Shows the panel. Clicking the toolbar icon opens it. |
| `storage` | Keeps the endpoint, the pairing token, the approved sites, and the panel settings in `chrome.storage.local`, and the tab binding and the activity log in `chrome.storage.session`. |
| `activeTab` | Lets the extension read and inject into the current tab after you click the toolbar icon, without a site grant. |
| `scripting` | Injects `content.js` into the top frame of the current tab with `chrome.scripting.executeScript`, only after a panel click. No content script is declared in the manifest. |
| `downloads` | When a page does not accept a PDF, the extension downloads it so you can attach it yourself. |
| `http://localhost/*`, `http://127.0.0.1/*` (optional) | Requested when you pair, so the worker can call your server. |
| `https://*/*` (optional) | Requested one site at a time, as `https://<host>/*`, when you click **Scan form** or **Allow access to the job's site**. The extension never asks for all sites at once. |

The manifest has no `host_permissions`, no `content_scripts`, no `externally_connectable`, and no `web_accessible_resources`. A web page cannot send a message to the extension, and it cannot load a file from the extension.

## Where data is kept

| Place | Holds | Cleared when |
|---|---|---|
| `chrome.storage.local` | `endpoint`, `pairing` (pairing id and bearer token), `grantedOrigins`, `ui` (whether Diagnostics is shown) | The token goes on **Disconnect** or a 401. Everything goes when you remove the extension. |
| `chrome.storage.session` | `binding` (session id, opportunity id, tab id, claim time) and the Diagnostics activity log (metadata only: request kind, outcome, origin, time) | The browser closes. The binding also goes on a new pairing or a 401. |
| `extension_pairings` table | The SHA-256 digests of the pairing code and the token, the extension's `chrome-extension://` origin, and the created, claimed, last-used, and revoked times | Never deleted. Revoking sets `revoked_at`. |
| `application_sessions` table | One row for each **Apply**: opportunity, apply URL, status (`pending`, `claimed`, `completed`, or `expired`), expiry, and the pairing that claimed it | Deleted with the opportunity. A new **Apply** expires the live one. |
| `application_preferences` table | Answers you save with **Save as default** or **Save for this job** | You delete them, or the opportunity is deleted. |
| `outputs.reviewed_at` column | When you marked a generated answer or file reviewed | A redraft or a body edit sets it back to null. |

The extension stores no answers, no page text, and no file bytes. A PDF exists only in memory, for the duration of one Attach.

## Threat model

The extension can type into forms on sites you approve, with data from your profile. The server has no login. These are the risks, and what stops each one.

**A malicious or compromised job page.** The page runs in its own world, and the content script runs in an isolated world. The content script does not listen to `window` messages, reads no `chrome.storage`, and never receives the token. The worker acts only on messages from the extension's own pages. It drops a message from a subframe before it parses it and logs `not_top_frame`, and it answers a message from a top frame with nothing. Scan and fill results reach the worker only as the reply to its own request, and the worker checks that request's nonce. A fill request carries field ids from the last scan. Before it writes, the content script scans again and compares each field's signature. It skips a field that changed, is hidden, disabled, or read-only, or already has a value. It never clicks a button and never submits. A page can still show misleading labels. The review lists every value and its source before **Prefill**, so check it.

**Token leakage.** The token is 32 random bytes. The server stores only its SHA-256 digest and compares digests in constant time. Neither the code nor the token is logged. The worker sends the token in an `Authorization` header to the paired endpoint only. A token copied out of the extension is still refused when the request carries an `Origin` other than the paired `chrome-extension://` origin. A request with no `Origin`, for example from `curl` on this computer, is accepted. Anything that can read your Chrome profile can read the token. Revoke the pairing in **Settings** if you think it leaked.

**Localhost CSRF and DNS rebinding.** The server listens on `127.0.0.1` by default (`HB_HOST`). It answers only to the `Host` names `localhost`, `127.0.0.1`, and `[::1]`, plus `HB_ALLOWED_HOSTS`. Any other `Host` gets 403, so a rebinding domain gets 403. Under `/api`, a write (any method except GET, HEAD, and OPTIONS) is refused with `forbidden_origin` when its `Origin` is not the request's own host, or when it has `Sec-Fetch-Site: cross-site`. The `/api/extension/*` routes skip that rule. They need the bearer token instead, and CORS echoes back only a `chrome-extension://` origin, never `*`, and never with credentials. The pairing claim needs a `chrome-extension://` `Origin` and binds it to the pairing.

**Host permissions.** The extension starts with no site access. You grant each job site one at a time, from a click in the panel. The panel refuses http pages, wildcards, and the hosts in `src/shared/hosts.ts`. Remove a site in **Diagnostics** or in `chrome://extensions`. `activeTab` gives the extension the current tab after you click the toolbar icon, until you navigate away.

**Sensitive values.** Work authorization, sponsorship, gender, race or ethnicity, veteran status, and disability status need one confirmation checklist per application before any of them fills. A pay question is never filled. The salary answer never leaves the server in a prefill reply, and a field whose label mentions salary, compensation, pay, rate, wage, remuneration, CTC, income, stipend, or OTE is left blank. A generated answer fills only after you mark it reviewed and tick it in the panel.

**File injection.** The worker fetches the PDF from your server and checks three things: the media type is `application/pdf`, the body starts with `%PDF-`, and the body is 10 MB or less. It then puts the file on the one upload field you picked, and only while that field is still visible, enabled, empty, unchanged, and accepts PDF. The page sees an ordinary file pick. The extension never reads files from your disk.

**No rate limit on the pairing claim.** `POST /api/extension/pair/claim` has no attempt limit. A code has 8 characters from a 30-character alphabet, so there are about 6.6 × 10^11 codes. A code works one time and expires after 10 minutes. Only a caller that can reach the server and send a `chrome-extension://` `Origin` can try. On loopback that is a process on your own computer. If you expose the server with `HB_HOST` or `HB_ALLOWED_HOSTS`, a guessing attack becomes possible over the network.

## Limits

- **Greenhouse single-choice questions are not filled.** Country, work authorization, sponsorship, and the EEOC questions are react-select comboboxes whose options are not in the page. The scan reports a field as `combobox`, and the matcher leaves it blank with `unsupported_control`.
- **Ashby yes-or-no questions are not filled.** Each one is two buttons and a hidden checkbox, and the extension never clicks buttons.
- **Shadow DOM and iframes are not scanned.** The scan reads the top frame's light DOM only. An application form inside an iframe or a shadow root shows as no fields.
- **Lever's disability-form signature lines.** Lever labels them only "Name" and "Date". The Lever adapter renames them, so the label match does not take them for your name or a start date. They stay blank.
- **Blocked sites.** On the sites in `src/shared/hosts.ts` (LinkedIn, Indeed, JobStreet, Kalibrr, OnlineJobs.ph, Upwork, Glassdoor, Wellfound, and Toptal, with their subdomains), the extension never reads, scans, fills, attaches to, or checks a page for success. The panel refuses site access for them and says "This site's terms forbid automated tools, so the extension won't fill it." **Import** in the panel refuses too and says to paste the job instead. Jobs from these sites still get in through the web paste form and the server's import route. **Apply** still opens them, and the panel can still link the tab to the session when it can read the tab's address. The panel does not show your answers as text to copy. Use **Copy as text** in the workspace. Whether to allow prefill on these sites is open (decision 61).
- **Facts are not used for prefill.** Only contact details, standard answers except salary, saved answers, and reviewed generated answers fill fields. Confirmed facts are not passed to the matcher yet.
- **Names split only in two words.** "Maria Santos" fills first name "Maria" and last name "Santos". A one-word name or a name with three or more words, such as "Juan dela Cruz", leaves first-name and last-name fields blank. A single full-name field still fills.
- **Docker publishes the app on loopback only.** `compose.yaml` publishes the app's port on `127.0.0.1`. Pair with `http://localhost:<HB_PORT>`. Compose publishes the Postgres port on `127.0.0.1` too.
- **Custom upload widgets and drag-and-drop areas get no file.** Attach needs a real `<input type="file">`. When the page has none, the extension downloads the PDF instead.

## Manual checklist for live job sites

Run these before you rely on the extension. Use real postings and never submit.

- [ ] Load `dist-extension/` unpacked. Pair it. Restart the service worker from `chrome://extensions` and check that the panel still shows "Paired with".
- [ ] In **Settings**, check that the pairing code is readable and that its countdown runs.
- [ ] Pair, then check that Chrome showed its own prompt for the server address. The automated test skips the prompt.
- [ ] On a live **Greenhouse** posting: Apply, open the panel, Scan form, and check that Chrome asks for that one site. Allow it, Prefill, and check that only empty fields changed. Attach the resume and check that the page lists the file name.
- [ ] Repeat on a live **Lever** posting. Check that the disability-form signature lines stay blank.
- [ ] Repeat on a live **Ashby** posting. Check that the yes-or-no buttons are untouched.
- [ ] Stop the server in the middle of a session. Click **Prefill** and check that the panel shows the pairing screen with "Can't reach Hanapbuhay" and that the page is unchanged.
- [ ] Open the extension's service worker in `chrome://extensions`, run `await chrome.storage.local.get(null)` and `await chrome.storage.session.get(null)` in its console, and check that no answers, page text, or file data appear.
- [ ] Open a LinkedIn job in a tab. Check that **Scan form** and **Read this page** both refuse with the terms message.
