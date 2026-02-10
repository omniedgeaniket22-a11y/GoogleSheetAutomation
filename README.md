# Google Sheets ↔ Supabase Near Real-Time Sync

## 1. Project Overview

### What was built
This project implements a near real-time, bidirectional integration between Google Sheets and Supabase using Supabase Edge Functions. Google Sheets is used as the data entry interface, while Supabase acts as the backend database. A scheduled Edge Function validates sheet data, syncs completed rows into Supabase, and updates the sheet with clear status indicators and visual feedback.

### Problem it solves
Non-technical teams often rely on Google Sheets for data entry, but Sheets alone are not suitable as a reliable backend. This solution bridges that gap by allowing structured, validated, and trackable data ingestion into a real database without requiring a custom UI or manual exports.

### Target users
- Operations and QA teams  
- Non-technical or semi-technical users  
- Engineering teams needing lightweight ingestion workflows  
- Internal tools and fast-moving teams  

---

## 2. Technical Details

### Google Sheets integration
- Google Sheets is used as the primary data input layer.
- The system dynamically reads headers, making it resilient to column reordering or schema changes.

### Google Sheets API operations used
- `values.get` – Read headers and row data  
- `values.update` – Update `sync_status` values  
- `spreadsheets.batchUpdate` – Apply background colors and formatting  

### Authentication
- Google Service Account  
- JWT-based OAuth 2.0 flow  
- Tokens generated programmatically inside the Edge Function  
- No user login or API keys exposed  

### Data flow
- **Sheet → Supabase**: Business data is synced from completed rows  
- **Supabase → Sheet**: Sync status and visual feedback are written back  
- Overall flow is bidirectional  

### Supabase features used
- Supabase Database (PostgreSQL)  
- Supabase Edge Functions (Deno runtime)  
- Scheduled Edge Functions (cron jobs)  
- Environment variables for secure secret management  

### Scheduling
- Cron job runs every **30 seconds**
- Enables near real-time syncing since Google Sheets does not support push-based webhooks  

---

## 3. Implementation

### Architecture overview
- Google Sheets acts as the UI  
- Supabase is the source of truth  
- Edge Functions orchestrate validation, syncing, and feedback  

### Row validation logic
- Only columns **before `sync_status`** are considered required
- If any required column is empty:
  - The row is ignored
  - No status or formatting is applied
- Prevents premature processing while users are typing

### `sync_status` lifecycle
| State        | Meaning |
|-------------|--------|
| *(empty)*   | Row incomplete |
| PENDING     | Row complete, waiting to sync |
| PROCESSING… | Sync in progress |
| SAVED       | Successfully stored in Supabase |
| ERROR       | Sync failed |

### Visual feedback
- **PENDING / ERROR** → Red background  
- **PROCESSING…** → Orange background  
- **SAVED** → Green background  
- Formatting is applied using Google Sheets `batchUpdate` API  

---

## Database Schema

### Table: `qc_entries`

This table mirrors the Google Sheet structure and stores validated business data.

```sql
CREATE TABLE qc_entries (
  id              INTEGER PRIMARY KEY,
  entry_date      DATE,
  qc_reviewer     TEXT,
  project_task    TEXT,
  va_reviewed     TEXT,
  entries_checked INTEGER,
  sync_status     TEXT,
  synced_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
