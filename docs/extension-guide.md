# Use the Chrome extension

This guide takes you from a fresh checkout to a filled application form. It covers the one-time setup, what to prepare in Hanapbuhay so the panel has something to fill, the workflow for each job, and what to do when something goes wrong.

For permissions, stored data, the threat model, and the known limits, see [EXTENSION.md](EXTENSION.md).

## What the extension does

The extension adds a side panel to Chrome. On a job's application form, it fills the empty fields from your profile, your saved answers, and the answers you marked reviewed. It attaches your resume or cover letter to the upload field you pick.

It never submits a form. It never changes a field that already has a value. It never fills a pay question. You check the form and submit it yourself.

## Set it up once

You need:

- Chrome 116 or later.
- Hanapbuhay running on this computer, with Docker (`docker compose up -d`) or for development (`bun run dev`).

### 1. Build and load the extension

1. In the repository, build the extension:

   ```sh
   bun run build:extension
   ```

   The build writes the `dist-extension/` folder.

2. In Chrome, open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select `dist-extension/`.
4. Click the puzzle icon in the toolbar and pin **Hanapbuhay**.

Click the **Hanapbuhay** icon to open the side panel.

### 2. Pair the extension with Hanapbuhay

1. In Hanapbuhay, open **Settings** and find **Chrome extension**.
2. Click **Create pairing code**. The code expires after 10 minutes and works once.
3. In the side panel, enter the **Hanapbuhay address**:

   | You run Hanapbuhay with | Address |
   |---|---|
   | Docker | `http://localhost:3000`, or the port in `HB_PORT` |
   | `bun run dev` | `http://localhost:3000`, the API. Not `5173`, the Vite page. |

4. Enter the code and click **Pair**.
5. When Chrome asks for access to `localhost`, click **Allow**.

The panel shows "Paired with" and the address. In **Settings**, the pairing shows as **Active**.

## Prepare what the panel fills

The panel fills only what Hanapbuhay already knows. Before your first application, fill these in:

| Where | What to fill | What it fills on a form |
|---|---|---|
| **Profile** > **Contact** | Name, email, phone, location, links | Name fields, email, phone, location, LinkedIn, GitHub, and website (your first link that isn't LinkedIn or GitHub) |
| **Profile** > **Standard answers** | Work authorization, notice period, start date, references | The matching questions on every job |
| The job's workspace | Draft the resume and cover letter, fix every `[[...]]` blank, then click **Mark reviewed** | The files you can attach |
| The job's workspace | Draft the answers to the job's questions, then click **Mark reviewed** | The custom questions on that job's form |

Things to know:

- **Salary is never filled**, even when you saved a salary answer. Type it yourself.
- **Name fields split only a two-word name.** "Maria Santos" fills first name and last name. "Juan dela Cruz" fills a single full-name field but leaves first-name and last-name fields blank.
- **A file attaches only when it could be exported.** A resume with a `[[...]]` blank left in it is refused, the same as PDF export.
- **Facts are not filled directly.** They reach a form only through the files and answers drafted from them.
- **Some questions fill only from saved answers.** Sponsorship, how you heard about the job, portfolio, relocation, travel, work arrangement, and the voluntary questions (gender, race or ethnicity, veteran status, disability) have no place in your profile. Answer them on the first form, then click **Save as default**. After a fill, the panel offers **Save as default** or **Save for this job** for any field you typed yourself, and the next form gets that answer.

## Apply to a job

Do these steps for each application.

### 1. Open the form from Hanapbuhay

1. Open the job's workspace in Hanapbuhay.
2. Click **Apply**. Use a plain click: Cmd-click or Ctrl-click opens the page without telling the extension.

Hanapbuhay opens the job's apply page in a new tab and starts an application session. You have 15 minutes to link the tab. After you link it, the session lasts 4 hours.

### 2. Link the tab

1. On the new tab, click the **Hanapbuhay** icon to open the panel.
2. The panel shows the job and links the tab.

If the panel shows something else:

| Panel says | Do this |
|---|---|
| "The extension can't read this tab's address" | Click **Allow access to the job's site**, then **Allow** in Chrome's prompt. |
| "This tab isn't the job's apply page" | The site redirected you, for example from a job board to the company's own site. If this is the same job's form, click **Link this tab anyway**. |
| "This application session ended" | More than 15 minutes passed. Click **Apply** in Hanapbuhay again. |
| "Click Apply on a job in Hanapbuhay…" | There is no session. Go back to step 1. |

If the form is on a later page, for example after you click the site's own **Apply** button, go to that page first. The panel follows the tab.

### 3. Scan the form

1. Click **Scan form**.
2. The first time on a site, Chrome asks for access to that one site. Click **Allow**.

The panel lists every field it found, in groups:

- **Check these first.** Likely matches and drafted answers you have not reviewed. They fill only if you tick them. A drafted answer also has **Mark reviewed**.
- **Will fill.** Exact matches from your profile and saved answers. They fill on **Prefill**.
- **Turned off.** Fields you unticked. They stay as they are.
- **Left blank.** Each field says why: it already had a value, it's a pay question, nothing saved fits, or the control isn't supported.

When the form asks sensitive questions (work authorization, sponsorship, gender, race or ethnicity, veteran status, disability), the panel shows a checklist. Confirm it once for this application before any of those fill.

### 4. Draft missing answers (optional)

When the form has custom questions with no answer, the panel lists them. Click **Draft** to have Hanapbuhay write one. When it finishes, click **Scan form** again. The answer shows under **Check these first**. Read it, then click **Mark reviewed** or tick it so it fills.

### 5. Attach files (optional)

1. Under **Files**, pick the resume or cover letter for each upload field. The panel suggests one from the field's label.
2. Click **Attach**.
3. Check that the page now shows the file name.

When a page has no real file input, for example a drag-and-drop area, the panel offers to download the PDF instead. Upload it on the page yourself.

### 6. Prefill and submit

1. Click **Prefill**.
2. Check every field on the page. Fix anything wrong, and fill what the panel left blank.
3. For fields you typed yourself, click **Save as default** or **Save for this job** if you want the next form to get the same answer.
4. Submit the form on the site.

### 7. Mark it applied

When the page shows a confirmation, the panel asks "Did you submit this application?". Click **Yes, mark applied** only if you submitted. The job moves to Applied on your board.

If the panel doesn't ask, mark the job applied in Hanapbuhay yourself.

## Import a job from a page

You can save a job you find while browsing, without copying it into Hanapbuhay by hand.

1. Open the job posting in a tab.
2. In the panel, open the **Import** tab and click **Read this page**. Allow access to the site if Chrome asks.
3. If Hanapbuhay already has this job, the panel links to it. Otherwise, check the title, company, location, apply link, and description the panel read, and fix anything wrong.
4. Click **Import**. The job goes to your board.

Nothing is read until you click **Read this page**, and nothing is saved until you click **Import**.

On LinkedIn, Indeed, JobStreet, Kalibrr, OnlineJobs.ph, Upwork, Glassdoor, Wellfound, and Toptal, the extension refuses to read or fill pages, because those sites' terms forbid automated tools. Paste those jobs into Hanapbuhay instead. **Apply** still opens them, and **Copy as text** in the workspace gives you the answers to paste.

## Update the extension

After you pull new code:

1. Run `bun run build:extension`.
2. In `chrome://extensions`, click the reload icon on the **Hanapbuhay** card.

The pairing survives a reload. Load the folder from the same path each time: Chrome derives the extension's id from the path, and a new id needs a new pairing. Removing the extension also deletes its pairing.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Could not reach Hanapbuhay" or "Can't reach Hanapbuhay at …" | Start the server. Check that the address in the panel is the one in the setup table above. |
| "This browser was disconnected from Hanapbuhay. Pair it again." | The pairing was revoked in **Settings**. Create a new code and pair again. |
| "The extension's background worker did not answer" | Reload the extension in `chrome://extensions`. |
| "The form changed since the scan" or "The page changed, scan again" | The site redrew the form. Click **Scan form** again. |
| The scan finds no fields | The form is probably inside an iframe or a shadow root, which the extension can't read. Fill it yourself. |
| A dropdown or yes-or-no question stays blank | Greenhouse dropdowns and Ashby yes-or-no buttons aren't supported. Answer them on the page. |
| A field you expected stays blank | Read its reason under **Left blank**. Usually Hanapbuhay has no answer for it: add it to your profile, or fill it and click **Save as default**. |
| The resume won't attach | Check the resume in the workspace for `[[...]]` blanks and fix them. The PDF must also be 10 MB or less. |
| The panel shows a different job | Click **Apply** on the job you want. A new **Apply** ends the earlier session. |

To see what the extension did, open the **Diagnostics** tab. It lists the recent requests with their outcomes, and the sites you allowed.

## Stop using it

- **Disconnect this browser:** click **Disconnect** in the panel, then click **Revoke** on the pairing in Hanapbuhay's **Settings**.
- **Take back access to one site:** in **Diagnostics**, click **Revoke** next to the site.
- **Remove everything:** remove the extension in `chrome://extensions`, and revoke the pairing in **Settings**.
