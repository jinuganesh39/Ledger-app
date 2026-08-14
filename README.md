# Ledger — finance, invoicing & cash-flow tracker

A single-page app that stores everything — business profile, product catalog,
transactions, invoices — in one spreadsheet inside **your own Google Drive**.
No backend, no database, no third-party server ever touches your data.

Two files: `index.html` (structure/styles) and `app.js` (all logic). Open
`index.html` in a browser to run it once it's configured — no build step.

---

## Why you must do a Google Cloud setup step first

Google's OAuth screen only signs a user into an app whose identity Google
Cloud recognizes — that means an OAuth **Client ID** tied to the exact web
address the app is running on. That can't be pre-filled for you here because
it doesn't exist yet until you create it, and it has to point at wherever
you end up hosting these two files. This is a one-time, ~10 minute setup.

### 1. Create a Google Cloud project
1. Go to [console.cloud.google.com](https://console.cloud.google.com/) → create a new project (or pick an existing one).

### 2. Enable the two APIs the app calls
In **APIs & Services → Library**, enable:
- **Google Sheets API**
- **Google Drive API**

### 3. Configure the OAuth consent screen
**APIs & Services → OAuth consent screen**
- User type: **External** (unless you have a Google Workspace org — then Internal is simpler).
- Fill in app name, support email, developer email.
- Scopes: add `.../auth/drive.file` and `.../auth/spreadsheets`.
- Test users: while the app is in "Testing" mode, add your own Google account's email here — otherwise sign-in will be blocked.

### 4. Create the OAuth Client ID
**APIs & Services → Credentials → Create Credentials → OAuth client ID**
- Application type: **Web application**.
- **Authorized JavaScript origins**: add the exact origin you'll serve the app from, e.g.:
  - `http://localhost:8080` for local testing
  - `https://your-username.github.io` if hosting on GitHub Pages
  - Whatever HTTPS domain you deploy to
- You do **not** need a redirect URI — this app uses the token (implicit) flow, not the authorization-code flow.
- Copy the generated **Client ID** (ends in `.apps.googleusercontent.com`).

### 5. Paste the Client ID into the app
Open `app.js` and set:
```js
const CONFIG = {
  CLIENT_ID: "123456789-abc...apps.googleusercontent.com",
  ...
};
```

### 6. Run it
Google's sign-in flow will not work on a `file://` page — it must be served over `http(s)`.
Locally, any static server works, e.g.:
```bash
python3 -m http.server 8080
```
then visit `http://localhost:8080` — matching whatever origin you authorized in step 4.

For real use, deploy the two files to any static host (GitHub Pages, Netlify,
Vercel, Cloudflare Pages, S3) and add that HTTPS origin in step 4.

### 7. Move out of "Testing" mode (optional)
While the OAuth consent screen is in Testing, only the test users you listed
can sign in, and tokens expire after 7 days. If this is just for yourself,
that's fine forever. If others need access, submit the consent screen for
verification (only required if you request sensitive scopes broadly — for
personal/internal use, Testing mode is usually sufficient).

---

## How data is stored

On first sign-in, the app searches your Drive (using the narrow `drive.file`
scope, which only ever sees files this app itself creates — it cannot browse
the rest of your Drive) for a spreadsheet named **"Ledger Data (do not
rename)"**. If none exists, it creates one with four tabs:

| Tab | Holds |
|---|---|
| `Settings` | Your business profile, key/value rows |
| `Products` | Your product & service catalog |
| `Transactions` | Every cash-in / cash-out entry, including ones auto-logged from invoices |
| `Invoices` | Every saved invoice / bill of supply, with line items stored as JSON |

You can open that spreadsheet directly in Google Sheets at any time — it's a
normal file in your Drive.

## What's implemented

- Google Sign-In (OAuth 2.0, implicit token flow via Google Identity Services)
- First-run business profile setup, auto-populated onto every invoice
- Product/service catalog (add, edit, delete)
- Tax Invoice / Bill of Supply toggle, dynamic line items, live subtotal /
  CGST+SGST (same state) or IGST (different state) / total / amount-in-words
- Print-to-PDF via the browser's native print dialog (a print stylesheet
  hides the app chrome and prints only the invoice)
- Saving an invoice auto-logs a matching inflow transaction
- Manual cash-in / cash-out logging with method, party, notes
- Dashboard with total in / total out / net balance and recent activity
- Searchable, filterable transaction history (type, date range, free text)
- CSV and JSON export of the filtered transaction set

## Known simplifications worth knowing about

- **Deletes are "soft"**: removing a product clears its row's values rather
  than physically removing the spreadsheet row (avoids row-shifting bugs
  with concurrent edits). Empty rows are simply filtered out on load — you
  won't see them, but they're harmless leftover blank rows in the sheet.
- **Excel export** is delivered as CSV, which Excel opens natively — a true
  `.xlsx` would need a charting library; CSV keeps the app dependency-free.
- **State matching for CGST/SGST vs IGST** is a plain case-insensitive string
  match between your home state and the client's state field — there's no
  official state-code list wired in.
- No offline queue: if a save fails (e.g. connection drop mid-write), you'll
  get a toast and should retry: nothing is silently lost, but nothing is
  cached for automatic replay either.
