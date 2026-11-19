# 🚦 Safer Roads Desk: AI Agent Technical Challenge (Inference Group)

**Use crash data to decide which road repairs save lives first.**

> ⚠️ Demo project. **All data is synthetic** (crashes, cases, residents, inspectors), placed on real Cape Town street names.
> Not affiliated with the City of Cape Town, the Western Cape Government, or any client data.

| | What it does | Built with |
|---|---|---|
| **Part 1 – Road Safety Command Centre (RAG)** | Chat over 5 structured documents. Answers come with charts, map pins, citations and a verification badge. A second page shows a live map. | Python · Streamlit · BM25 + bge-small embeddings (hybrid search) · Claude via OpenRouter |
| **Part 2 – Road Hazard Agent (n8n)** | Reads resident emails (EN/AF/XH). Verifies addresses on OpenStreetMap, merges duplicates and scores risk using the Part 1 crash data. Books inspectors in Google Calendar, replies in the resident's language, and updates the live map. | n8n Cloud · Gmail · Google Calendar · Google Sheets · OpenStreetMap API · Claude |

```
part1_rag/
  app.py               navigation (2 pages)
  chat.py              Ask the Data: chat, auto charts and maps, "how this answer was produced" trace
  command_centre.py    live map: crash heatmap + hotspots + agent cases from the Google Sheet
  rag.py               ingestion, chunking, hybrid index, query planner, aggregation tool, verifier
  data/                crashes.csv · hotspots.csv · road_register.csv · hazard_response_rules.json · inspectors.csv · demo_cases.csv
part2_agent/
  road_hazard_agent_workflow.json   the agent (import into n8n)
  demo_setup_workflow.json          sends 14 test emails and creates calendar busy blocks
  sheet_template.csv                header row for the Command Centre Google Sheet
  code_nodes/                       readable copies of the JavaScript in each Code node
```

---

# Setup checklist (about 60 min, all free, all personal accounts)

Use a **personal Chrome profile** on your laptop (profile icon → Add → "Personal"). Don't use SMEC accounts for any of this.

### Step 1 · Personal browser profile + demo Google account (10 min)
1. In Chrome, click your profile picture → **Add** → **Continue without an account** → name it "Personal". Do everything in this window.
2. Go to accounts.google.com/signup and create a new Gmail just for the demo, e.g. `saferroads.demo@gmail.com`.
   This keeps your own inbox and calendar off screen during the interview. The demo uses this account's main calendar.
3. The agent only reads emails the account sent **to itself** (`from:me to:me`) in the last 7 days, which is how the test emails arrive.

### Step 2 · GitHub (10 min)
1. Sign up at github.com (personal email) → **New repository** → name it `safer-roads-desk` → **Public** → Create.
2. Click **uploading an existing file**. Drag in the *contents* of the unzipped folder (README.md, part1_rag, part2_agent) → **Commit changes**.
   - The `.streamlit` folder is hidden. That's fine; you don't need it.
3. Note your username. The raw data link is:
   `https://raw.githubusercontent.com/YOUR_USERNAME/safer-roads-desk/main/part1_rag/data`
   Open `.../data/hotspots.csv` in the browser to check it works.

### Step 3 · Google Sheet for the live map (5 min). Signed in as the demo account:
1. sheets.new → rename the file "Safer Roads Desk cases" → rename the tab at the bottom to **`cases`**.
2. **File → Import → Upload** `part2_agent/sheet_template.csv` → *Replace current sheet* → Import. Rename the tab to `cases` again if it changed. You should now have just a header row.
3. Copy the sheet's URL from the address bar (for n8n).
4. **File → Share → Publish to web** → choose the `cases` tab and **Comma-separated values (.csv)** → Publish. Copy that link (for Streamlit).

### Step 4 · Deploy Part 1 (10 min)
1. share.streamlit.io → sign in with GitHub → **Create app** → *Deploy a public app from GitHub*.
2. Repository `YOUR_USERNAME/safer-roads-desk`, branch `main`, main file `part1_rag/app.py`.
3. **Advanced settings** → Python **3.12** → paste into Secrets:
   ```toml
   OPENROUTER_API_KEY = "your OpenRouter key"
   PLANNER_MODEL = "anthropic/claude-haiku-4.5"
   ANSWER_MODEL = "anthropic/claude-sonnet-4.5"
   CASES_CSV_URL = "the Publish-to-web CSV link from step 3"
   ```
4. Deploy. The first start takes about 2 minutes (it downloads the embedding model). Check:
   - The sidebar says **Retrieval: hybrid (BM25 + dense)**.
   - Every example button gives an answer with ✅ Verified.
   - The **Live Command Centre** page shows the map. Until the agent has run, it's empty or shows "sample cases".
5. Copy the app URL (for n8n and the summary document).

### Step 5 · n8n (20 min)
1. n8n.io → **Start free trial** (14 days, no card) with your personal email.
2. **Overview → Create → Import from file**: import `demo_setup_workflow.json`. Then import `road_hazard_agent_workflow.json` the same way.
3. **Credentials:**
   - Every Gmail, Google Calendar and Google Sheets node: **Create new credential → Sign in with Google**, using the **demo** account.
   - Both "Claude" nodes: create an **OpenRouter** credential with your API key.
4. **Demo Setup workflow** → open **Setup Config** → set `demo_inbox` to the demo Gmail address → **Execute workflow**.
   You should see 14 emails in the demo inbox and grey "[INS-0x] Busy" events in its calendar.
5. **Agent workflow** → open **Config** and fill in:
   - `reference_base_url` = the raw data link from step 2
   - `report_to` = the demo Gmail address
   - `sheet_url` = the sheet URL from step 3
   - `command_centre_url` = your Streamlit app URL + `/command_centre`
6. **Execute workflow** (takes about 1 minute). Expected results:
   - **Calendar:** coloured inspection events (red = P1, orange = P2, blue = P3).
   - **Sheet:** 10 cases. The **map** updates within 30 s.
   - **Inbox:** a run report with a CSV attached, and 13 replies in English, Afrikaans and isiXhosa. These are marked "demo: would go to …".
7. **Run it again.** Nothing gets double-booked and no duplicate replies are sent. That's worth showing in the interview.

**If something goes wrong after import:**
- *Model missing on a Claude node:* drag each OpenRouter model onto its chain's **Model** input.
- *Calendar returns nothing:* open the node and check that Time Min/Max are set. Older n8n versions put them under Options.
- *Sheet error:* the tab must be called exactly `cases`, and the header row must be in row 1.
- *Model ID error:* pick a current Claude model in the OpenRouter node's dropdown.
- **To re-run the demo from scratch:** delete the sheet rows (keep the header), delete the inspection events, and delete the "[Safer Roads Desk]" emails.

### Step 6 · Screenshots for the submission
1. The n8n canvas of the agent, with the sticky notes visible.
2. The output of *Extract Hazard (Claude)* (raw JSON).
3. The *Verify, Dedupe & Score* output (the Bellville case with 3 merged reports and its score breakdown).
4. The Google Calendar week view with the inspections.
5. The run-report email, plus the isiXhosa and Afrikaans replies.
6. The Streamlit chat: the night-pedestrian question, with its chart and trace.
7. The Live Command Centre map.
