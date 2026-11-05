/**
 * ASNs DB → GoodTech staff portal: feeds the Dashboard's Testing and "not POed" cards.
 *
 * Every 10 minutes this sends:
 *   - ASNs rows whose PO (column AG) is blank: order number (A), shipment (B), serial (F),
 *     grade (AA), status (AD) and location (AF);
 *   - Shipment Check: SO (A), warehouse (B) and Delivered (AL).
 * The portal works out Received · not tested and Graded / Repairs / Locked · not POed from these.
 * It only reads the sheet; nothing in the sheet is changed.
 *
 * Setup (once), in ASNs DB → Extensions → Apps Script:
 *   1. Add a script file, delete the empty myFunction it starts with, paste this in and save.
 *   2. Project Settings → Script properties → add PORTAL_SYNC_TOKEN with the token you were given.
 *   3. Run installAsnOpsTrigger once and approve the permissions. It sends the first snapshot and
 *      schedules the rest.
 */

var ASN_OPS_PORTAL_URL = 'https://mniqcdqajhhsrvfagmra.supabase.co/functions/v1/staff-portal';

function asnOpsSync() {
  var token = PropertiesService.getScriptProperties().getProperty('PORTAL_SYNC_TOKEN');
  if (!token) throw new Error('Set the PORTAL_SYNC_TOKEN script property first.');
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var asns = ss.getSheetByName('ASNs');
  var lastRow = asns.getLastRow();
  var values = asns.getRange(2, 1, Math.max(lastRow - 1, 0), 33).getDisplayValues(); // A:AG
  var rows = [], total = 0;
  for (var i = 0; i < values.length; i++) {
    var r = values[i], serial = String(r[5]).trim();
    if (!serial) continue;
    total++;
    if (String(r[32]).trim() !== '') continue; // AG: has a PO
    rows.push({ row: i + 2, order: r[0], shipment: r[1], serial: serial, grade: r[26], status: r[29], location: r[31] });
  }

  var check = ss.getSheetByName('Shipment Check');
  var cLast = check.getLastRow();
  var cValues = check.getRange(3, 1, Math.max(cLast - 2, 0), 38).getDisplayValues(); // A:AL
  var shipments = [];
  for (var j = 0; j < cValues.length; j++) {
    var c = cValues[j], order = String(c[0]).trim();
    if (order) shipments.push({ order: order, warehouse: c[1], delivered: c[37] });
  }

  var res = UrlFetchApp.fetch(ASN_OPS_PORTAL_URL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-sync-token': token },
    payload: JSON.stringify({ action: 'sync.asn', rowsTotal: total, rows: rows, shipments: shipments }),
  });
  if (res.getResponseCode() !== 200) throw new Error('Portal sync failed (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 300));
  Logger.log('Synced ' + rows.length + ' ASN rows without a PO and ' + shipments.length + ' Shipment Check rows.');
}

function installAsnOpsTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'asnOpsSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('asnOpsSync').timeBased().everyMinutes(10).create();
  asnOpsSync();
}
