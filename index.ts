// Supabase Edge Function: Google Sheets Bidirectional Sync
// Syncs QC entries from Google Sheets to Supabase with status updates and visual feedback

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Environment variables
const SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL")!;
const PRIVATE_KEY = Deno.env.get("GOOGLE_PRIVATE_KEY")!.replace(/\\n/g, "\n");
const SPREADSHEET_ID = Deno.env.get("SPREADSHEET_ID")!;
const SHEET_NAME = Deno.env.get("SHEET_NAME") || "Sheet1";

// Get built-in Edge Function environment variables
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, serviceRoleKey);

// Column name mappings from Google Sheets to database columns
const COLUMN_MAPPING: Record<string, string> = {
  "ID": "id",
  "Date": "entry_date",
  "QC Reviewer": "qc_reviewer",
  "Project - Task": "project_task",
  "VA Reviewed": "va_reviewed",
  "Entries Checked": "entries_checked",
};

// Sync status constants
const STATUS_PENDING = "PENDING";
const STATUS_PROCESSING = "PROCESSING...";
const STATUS_SAVED = "SAVED";
const STATUS_ERROR = "ERROR";

// Color definitions for Google Sheets API (RGB color)
interface Color {
  red: number;
  green: number;
  blue: number;
}

const COLORS: Record<string, Color> = {
  [STATUS_PENDING]: { red: 1, green: 0, blue: 0 },      // Red
  [STATUS_PROCESSING]: { red: 1, green: 0.6, blue: 0 }, // Orange
  [STATUS_SAVED]: { red: 0, green: 0.8, blue: 0 },      // Green
  [STATUS_ERROR]: { red: 1, green: 0, blue: 0 },        // Red
};

// JWT generation for Google API
async function getGoogleAccessToken(): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: SERVICE_ACCOUNT_EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const base64UrlEncode = (str: string): string => {
    return btoa(str)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const text = `${encodedHeader}.${encodedPayload}`;

  const keyData = PRIVATE_KEY
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binaryKey = Uint8Array.from(atob(keyData), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(text)
  );

  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const jwt = `${text}.${encodedSignature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const data = await response.json();
  return data.access_token;
}

// Read data from Google Sheets
async function readGoogleSheetsData(accessToken: string): Promise<{ values: string[][]; headers: string[] }> {
  const range = `${SHEET_NAME}!A1:ZZ`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to read Google Sheets: ${error}`);
  }

  const data = await response.json();
  const values = data.values || [];
  const headers = values[0] || [];
  const rows = values.slice(1);

  return { values: rows, headers };
}

// Find column index by name
function findColumnIndex(headers: string[], columnName: string): number {
  return headers.findIndex(h => h.toLowerCase() === columnName.toLowerCase());
}

// Find sync_status column index
function findSyncStatusColumnIndex(headers: string[]): number {
  return headers.findIndex(h =>
    h.toLowerCase().includes('sync') && h.toLowerCase().includes('status')
  );
}

// Map Google Sheets row to database record
// Only processes columns BEFORE sync_status column
function mapRowToRecord(
  headers: string[],
  row: string[],
  rowIndex: number,
  syncStatusColIndex: number
): { id: string; rowIndex: number; record: Record<string, string | null>; isComplete: boolean; isEligible: boolean; currentStatus: string } {
  const rowData: Record<string, string | null> = {};

  // Get the ID column (should be first column "ID")
  const idColumnIndex = findColumnIndex(headers, "ID");
  const idValue = idColumnIndex >= 0 && idColumnIndex < row.length ? row[idColumnIndex] : "";
  const id = idValue ? String(idValue).trim() : `row_${rowIndex + 1}`;

  // Get current sync_status value
  let currentStatus = "";
  if (syncStatusColIndex >= 0 && syncStatusColIndex < row.length) {
    currentStatus = (row[syncStatusColIndex] || "").trim().toUpperCase();
  }

  // Only map columns that come BEFORE sync_status column
  // If sync_status doesn't exist, map all known columns
  const columnsToProcess = syncStatusColIndex >= 0
    ? headers.slice(0, syncStatusColIndex)
    : headers;

  columnsToProcess.forEach((header, index) => {
    const mappedColumn = COLUMN_MAPPING[header];
    if (mappedColumn && index < row.length) {
      rowData[mappedColumn] = row[index] || null;
    }
  });

  // Check if row is complete (all columns before sync_status are non-empty)
  let isComplete = true;
  for (let i = 0; i < columnsToProcess.length; i++) {
    const value = row[i];
    if (!value || value.toString().trim() === "") {
      isComplete = false;
      break;
    }
  }

  // Check if row is eligible for sync:
  // 1. Row must be complete
  // 2. sync_status is empty, PENDING, or PROCESSING...
  const normalizedStatus = currentStatus.replace(/\./g, ""); // Remove dots for comparison
  let isEligible = isComplete && (
    currentStatus === "" ||
    currentStatus === STATUS_PENDING ||
    currentStatus === STATUS_PROCESSING ||
    (currentStatus === STATUS_SAVED) // Re-sync SAVED rows to verify
  );

  return {
    id,
    rowIndex,
    record: rowData,
    isComplete,
    isEligible,
    currentStatus
  };
}

// Find or create sync_status column index
async function findOrCreateSyncStatusColumn(accessToken: string, headers: string[]): Promise<number> {
  let statusColIndex = findSyncStatusColumnIndex(headers);

  // If sync_status column doesn't exist, add it
  if (statusColIndex === -1) {
    statusColIndex = headers.length;

    // Get sheet ID first
    const spreadsheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`;
    const sheetResponse = await fetch(spreadsheetUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!sheetResponse.ok) {
      throw new Error(`Failed to get spreadsheet info: ${await sheetResponse.text()}`);
    }

    const sheetData = await sheetResponse.json();
    const sheetId = sheetData.sheets?.find((s: any) => s.properties.title === SHEET_NAME)?.properties.sheetId ?? 0;

    // Add column and header using batchUpdate
    const batchUpdateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`;

    const requestBody = {
      requests: [{
        appendDimension: {
          sheetId: sheetId,
          dimension: "COLUMNS",
          length: 1
        }
      }, {
        updateCells: {
          rows: [{
            values: [{
              userEnteredValue: { stringValue: "sync_status" }
            }]
          }],
          fields: "userEnteredValue",
          start: {
            sheetId: sheetId,
            rowIndex: 0,
            columnIndex: statusColIndex
          }
        }
      }]
    };

    const addHeaderResponse = await fetch(batchUpdateUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (!addHeaderResponse.ok) {
      const errorText = await addHeaderResponse.text();
      console.error("Failed to add sync_status column:", errorText);
    }
  }

  return statusColIndex;
}

// Update sync status in Google Sheets with background color
async function updateGoogleSheetsStatus(
  accessToken: string,
  updates: Array<{ rowIndex: number; status: string }>,
  statusColIndex: number
): Promise<void> {
  if (updates.length === 0) return;

  // Get sheet ID
  const spreadsheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`;
  const sheetResponse = await fetch(spreadsheetUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!sheetResponse.ok) {
    console.error("Failed to get spreadsheet info");
    return;
  }

  const sheetData = await sheetResponse.json();
  const sheetId = sheetData.sheets?.find((s: any) => s.properties.title === SHEET_NAME)?.properties.sheetId ?? 0;

  // Build update cells data with colors
  const batchUpdateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`;

  const requestBody = {
    requests: updates.map(u => {
      const color = COLORS[u.status];
      const hasColor = color !== undefined;

      return {
        updateCells: {
          rows: [{
            values: [{
              ...(u.status === "" ? {} : { userEnteredValue: { stringValue: u.status } }),
              ...(hasColor ? {
                userEnteredFormat: {
                  backgroundColor: color
                }
              } : {})
            }]
          }],
          fields: u.status === "" ? "userEnteredFormat" : "userEnteredValue,userEnteredFormat",
          start: {
            sheetId: sheetId,
            rowIndex: u.rowIndex + 1, // +1 to account for header row
            columnIndex: statusColIndex
          }
        }
      };
    })
  };

  const batchResponse = await fetch(batchUpdateUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  if (!batchResponse.ok) {
    const errorText = await batchResponse.text();
    console.error("Failed to update status:", errorText);
  }
}

// Parse integer value safely
function parseInteger(value: string | null): number | null {
  if (value === null || value === undefined || value.toString().trim() === "") {
    return null;
  }
  const parsed = parseInt(value.toString().trim(), 10);
  return isNaN(parsed) ? null : parsed;
}

// Parse date value safely (YYYY-MM-DD format)
function parseDate(value: string | null): string | null {
  if (value === null || value === undefined || value.toString().trim() === "") {
    return null;
  }
  const dateStr = value.toString().trim();
  // Try to parse as date and return in YYYY-MM-DD format
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    return null; // Invalid date
  }
  return date.toISOString().split('T')[0];
}

// Upsert eligible rows to Supabase qc_entries table
async function upsertEligibleRows(rows: Array<{
  id: string;
  rowIndex: number;
  record: Record<string, string | null>
}>): Promise<{ success: string[]; failed: Array<{ id: string; error: string }> }> {
  const success: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const row of rows) {
    try {
      const { error } = await supabase
        .from('qc_entries')
        .upsert({
          id: parseInteger(row.record.id) || null,
          entry_date: parseDate(row.record.entry_date),
          qc_reviewer: row.record.qc_reviewer,
          project_task: row.record.project_task,
          va_reviewed: row.record.va_reviewed,
          entries_checked: parseInteger(row.record.entries_checked),
          sync_status: STATUS_SAVED,
          synced_at: new Date().toISOString()
        }, {
          onConflict: 'id'
        });

      if (error) {
        throw new Error(error.message);
      }

      success.push(row.id);
    } catch (error) {
      failed.push({ id: row.id, error: error.message });
    }
  }

  return { success, failed };
}

// Main sync function
async function syncGoogleSheetsToSupabase(): Promise<{
  synced: number;
  skipped: number;
  errors: number;
  details: string
}> {
  const accessToken = await getGoogleAccessToken();

  // Read data from Google Sheets
  const { values, headers } = await readGoogleSheetsData(accessToken);

  // Find or create sync_status column
  const statusColIndex = await findOrCreateSyncStatusColumn(accessToken, headers);

  // Map rows and find eligible ones
  const mappedRows = values.map((row, index) =>
    mapRowToRecord(headers, row, index, statusColIndex)
  );

  // Separate rows by status
  const completeRows = mappedRows.filter(r => r.isComplete);
  const incompleteRows = mappedRows.filter(r => !r.isComplete);

  // Clear status for incomplete rows
  const incompleteUpdates = incompleteRows
    .filter(r => r.currentStatus !== "")
    .map(r => ({ rowIndex: r.rowIndex, status: "" }));

  if (incompleteUpdates.length > 0) {
    await updateGoogleSheetsStatus(accessToken, incompleteUpdates, statusColIndex);
  }

  // Find eligible rows (complete rows that need syncing)
  const eligibleRows = completeRows.filter(r => r.isEligible);

  if (eligibleRows.length === 0) {
    return {
      synced: 0,
      skipped: mappedRows.length,
      errors: 0,
      details: `No eligible rows to sync. Total: ${mappedRows.length}, Complete: ${completeRows.length}, Incomplete: ${incompleteRows.length}`
    };
  }

  // Update status to PROCESSING... for eligible rows
  const processingUpdates = eligibleRows
    .filter(r => r.currentStatus !== STATUS_PROCESSING)
    .map(r => ({ rowIndex: r.rowIndex, status: STATUS_PROCESSING }));

  if (processingUpdates.length > 0) {
    await updateGoogleSheetsStatus(accessToken, processingUpdates, statusColIndex);
  }

  // Upsert eligible rows to Supabase
  const result = await upsertEligibleRows(eligibleRows);

  // Update status to SAVED or ERROR
  const finalUpdates: Array<{ rowIndex: number; status: string }> = [];

  result.success.forEach(id => {
    const row = mappedRows.find(r => r.id === id);
    if (row) {
      finalUpdates.push({ rowIndex: row.rowIndex, status: STATUS_SAVED });
    }
  });

  result.failed.forEach(fail => {
    const row = mappedRows.find(r => r.id === fail.id);
    if (row) {
      finalUpdates.push({ rowIndex: row.rowIndex, status: STATUS_ERROR });
    }
  });

  if (finalUpdates.length > 0) {
    await updateGoogleSheetsStatus(accessToken, finalUpdates, statusColIndex);
  }

  return {
    synced: result.success.length,
    skipped: mappedRows.length - eligibleRows.length,
    errors: result.failed.length,
    details: `Synced: ${result.success.length}, Skipped: ${mappedRows.length - eligibleRows.length}, Errors: ${result.failed.length}`
  };
}

Deno.serve(async () => {
  try {
    const result = await syncGoogleSheetsToSupabase();

    return new Response(JSON.stringify({
      success: true,
      message: result.details,
      data: result
    }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Sync error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      stack: error.stack
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
