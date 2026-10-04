# WeddingWebsite

The wedding website stays on GitHub Pages at
https://bigmacca945.github.io/WeddingWebsite/. A Google Apps Script form embedded
in `rsvp.html` privately looks up invitations and saves responses to an
owner-only Google Sheet. No Cloudflare deployment or QR-code redirect is used.

## What guests do

1. Open the existing RSVP page and enter the code printed on their invitation.
2. Enter their first name. Names are case-insensitive and extra spaces are
   ignored. Enter the full first name, including spaces in multi-word names.
3. If that first name matches more than one invitation, enter a surname.
4. Confirm the invitation group, then choose attending/not attending for each
   person and optionally enter dietary requirements.
5. Return to the same page to review or update the saved responses.

Only the matching group is returned. There is no directory/autocomplete endpoint
and no guest list in the public website, repository, or Pages deployment.
The RSVP form uses Google's supported `google.script.run` transport, rather than
unreliable cross-origin fetch requests or write-only `no-cors` submissions.
An "open in a new tab" link is provided if a browser blocks the embedded form.

## Privacy and limits

- Keep the Sheet's sharing setting **Restricted**. Do not publish it to the web,
  share it with all guests, or give the Apps Script project public editor access.
- Deploy the web app **executing as you**, with access **Anyone**. This allows
  guests without Google accounts to use the form; it does not share the Sheet.
- The existing invitation code is checked on the server. Store it only in
  Apps Script properties, never in `rsvp-config.js`, Git, or the guest Sheet.
- This remains trust-based. A person with the code who knows another guest's
  name can read that group's RSVP and dietary notes and update its responses.
  Only collect notes that guests are comfortable sharing in this arrangement.
- The previously browser-visible invitation code is not a high-security secret.
  Server-side code checks and lookup limits reduce casual access but do not
  provide individual guest identity verification.
- GitHub Pages wedding HTML itself is publicly downloadable. This setup protects
  the guest list and RSVP records, not all wedding details. A browser-only code
  screen is not real protection for static HTML.
- Google Apps Script and Sheets have quotas. If unavailable, the form reports a
  failure instead of displaying a fake successful RSVP.
- The deadline is displayed, not automatically enforced.

## Google Sheet and Apps Script setup

1. Create a private Google Sheet for the wedding RSVPs. Copy the contents of the
   gitignored local `private\guests.tsv` into cell A1 of its first tab, and rename
   that tab **Guests**. The file contains the corrected 48 guests/27 groups.
   Never upload this private file to GitHub or a public Pages folder.
2. Select **Extensions > Apps Script**. Replace the default code with
   `apps-script\Code.gs`. Add an HTML file named **Rsvp** and paste
   `apps-script\Rsvp.html` into it.
3. For initial setup only, append
   `function setupWeddingRsvp() { initializeRsvp_(); }` to Code.gs. Save and run
   **setupWeddingRsvp**, approving the required Google permissions. This
   registers the bound Sheet and creates a signing secret. Remove this temporary
   wrapper and save again **before deploying**; the private initializer ends in
   `_` so it is not exposed to website visitors or the editor's function picker.
4. In **Project Settings > Script properties**, set **RSVP_ACCESS_CODE** to the
   existing code printed on the invitations. Enter it directly there, not in
   chat or source code. Retain the generated **RSVP_SPREADSHEET_ID** and
   **RSVP_TOKEN_SECRET** properties.
5. Select **Deploy > New deployment > Web app**. Execute as **Me**, allow
   **Anyone**, and authorize when prompted. Copy the deployed URL ending in
   `/exec`, not the editor-only `/dev` test URL.
6. Set `appUrl` in `rsvp-config.js` to that URL. This URL is public configuration,
   not a credential.
7. Confirm the Sheet is **Restricted**, and check the web app in a signed-out
   browser. Verify the code and unique/ambiguous name flows, saving, reopening,
   and updating a group. Do not test using another guest's personal dietary data.

If you update Apps Script code later, edit the existing deployment to use a
**new version**. Simply saving the script does not update the deployed `/exec`
version. Retain the deployment URL so existing website links continue working.

### Guest Sheet columns

The **Guests** tab must have these exact columns in order:

`Guest ID | Group ID | First Name | Last Name | Display Name | Attendance |
Dietary Requirements | Revision | Updated At`

Leave Attendance blank until a guest replies; saved values are `yes` or `no`.
Initial Revision is 0. Keep rows for each group contiguous. IDs, group IDs and
revisions are internal values; do not edit them casually. Do not reorder headers.

Responses replace the relevant group's existing rows rather than adding
duplicates. Declining a guest clears their dietary note. Server-side locking and
revision tokens prevent an old form overwriting newer group responses. Forms
expire after an hour; guests then look up the invitation again.

You can privately filter Attendance and dietary notes in Sheets. Do not publish
the results or export them to a public repository. No guest-facing admin/export
endpoint is provided.

## Publishing to the existing GitHub Pages address

Node.js 24 or later is required; there are no npm dependencies.

```powershell
npm test
npm run build
```

The build creates **pages-deploy** containing only six public website files.
It refuses to build until a valid Apps Script deployment URL is configured.
Never publish the repository root: that would risk exposing private/supporting
files if they were accidentally tracked.

In the GitHub repository's **Settings > Pages**, choose **GitHub Actions** as
the source. The workflow in `.github\workflows\pages.yml` runs tests, builds the
allow-listed files, and publishes them after a push to `main`, or a manual run.
This preserves `/WeddingWebsite/`; relative local asset links work under that
project path. Commit/push only after reviewing the diff and privacy settings.

The older `security` directory is retained as existing repository history/code,
but its Worker and D1 configuration are not used by the Google Sheets approach.
