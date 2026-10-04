// Bound to the private spreadsheet; deploy as owner, accessible to Anyone.
// Tokens last one hour. Lookup limits: 30/name and 240 total per 15 minutes.
var RSVP_HEADERS_ = ['Guest ID', 'Group ID', 'First Name', 'Last Name', 'Display Name', 'Attendance', 'Dietary Requirements', 'Revision', 'Updated At'];
var RSVP_WINDOW_MS_ = 15 * 60 * 1000;
var RSVP_TOKEN_MS_ = 60 * 60 * 1000;
var RSVP_RATE_PREFIX_ = 'RSVP_RATE_';

function doGet(e) {
  var channel = e && e.parameter && e.parameter.channel;
  var template = HtmlService.createTemplateFromFile('Rsvp');
  template.embedChannel = typeof channel === 'string' && /^[a-f0-9-]{36}$/i.test(channel) ? channel : '';
  template.parentOrigin = 'https://bigmacca945.github.io';
  return template.evaluate()
    .setTitle('Wedding RSVP')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Run in the bound spreadsheet editor once. Configure RSVP_ACCESS_CODE privately
// in project settings; this function never generates or prints an access code.
function initializeRsvp_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Open the bound spreadsheet to initialize RSVP.');
  var sheet = spreadsheet.getSheetByName('Guests');
  if (!sheet) sheet = spreadsheet.insertSheet('Guests');
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, RSVP_HEADERS_.length).setValues([RSVP_HEADERS_]);
  } else {
    validateHeaders_(sheet.getDataRange().getValues()[0]);
  }
  var properties = PropertiesService.getScriptProperties();
  properties.setProperty('RSVP_SPREADSHEET_ID', spreadsheet.getId());
  if (!properties.getProperty('RSVP_TOKEN_SECRET')) {
    properties.setProperty('RSVP_TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
}

function lookupInvitation(request) {
  var firstCandidate = request && typeof request.firstName === 'string' && request.firstName.length <= 128 ?
    normalize_(request.firstName) : '';
  // Count all attempts before access-code verification, including incorrect codes.
  var limited = limitLookup_(firstCandidate);
  if (limited) return limited;
  var config = authenticate_(request);
  if (!config) return result_('unauthorized', 'Please check your invitation access code.');
  if (!request || typeof request.firstName !== 'string' ||
      request.firstName.length > 128 ||
      (request.lastName !== undefined && (typeof request.lastName !== 'string' || request.lastName.length > 128))) {
    return result_('invalid', 'Enter the first name printed on your invitation.');
  }
  var first = firstCandidate;
  var last = normalize_(request.lastName || '');
  if (!first) return result_('invalid', 'Enter the first name printed on your invitation.');
  var data = readGuests_(config.spreadsheetId);
  var matches = data.rows.filter(function (row) { return normalize_(row[2]) === first; });
  var groups = new Set(matches.map(function (row) { return row[1]; }));
  if (!last && groups.size > 1) return result_('needsSurname', 'Please also enter your last name.');
  if (last) matches = matches.filter(function (row) { return normalize_(row[3]) === last; });
  groups = new Set(matches.map(function (row) { return row[1]; }));
  if (groups.size !== 1) return result_('notFound', 'No invitation was found. Please check the name on your invitation.');
  var groupId = matches[0][1];
  var rows = data.rows.filter(function (row) { return row[1] === groupId; });
  return {
    status: 'found',
    token: createToken_(groupId, rows[0][7], config),
    guests: rows.map(function (row) {
      return { id: row[0], name: row[4], attending: row[5] || null, dietaryRequirements: decodeNote_(row[6]) };
    }),
    hasResponse: rows.some(function (row) { return row[5] !== ''; })
  };
}

function saveInvitation(request) {
  var config = authenticate_(request);
  if (!config) return result_('unauthorized', 'Please check your invitation access code.');
  var verified = verifyToken_(request.token, config);
  if (verified.error) return verified.error;
  if (!Array.isArray(request.responses) || request.responses.length === 0 || request.responses.length > 100) {
    return result_('invalid', 'Please answer for every person on your invitation.');
  }
  var responses = new Map();
  for (var i = 0; i < request.responses.length; i++) {
    var response = request.responses[i];
    if (!response || typeof response.id !== 'string' || responses.has(response.id) ||
        (response.attending !== 'yes' && response.attending !== 'no') ||
        typeof response.dietaryRequirements !== 'string' || response.dietaryRequirements.length > 500) {
      return result_('invalid', 'Check each attendance response and keep notes to 500 characters.');
    }
    responses.set(response.id, response);
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return result_('busy', 'RSVP is busy. Please try again shortly.');
  try {
    if (verified.payload.expires <= Date.now()) return result_('expired', 'Your session expired. Please look up your invitation again.');
    var data = readGuests_(config.spreadsheetId);
    var rows = data.rows.filter(function (row) { return row[1] === verified.payload.group; });
    if (!rows.length) return result_('invalid', 'Please look up your invitation again.');
    if (rows[0][7] !== verified.payload.revision) {
      return result_('conflict', 'This invitation has changed. Please look it up again before saving.');
    }
    if (responses.size !== rows.length || rows.some(function (row) { return !responses.has(row[0]); })) {
      return result_('invalid', 'Please answer for all and only the people on your invitation.');
    }
    if (!Number.isSafeInteger(rows[0][7] + 1)) throw new Error('RSVP data needs administrator attention.');
    var updatedAt = new Date();
    var firstIndex = data.rows.findIndex(function (row) { return row[1] === verified.payload.group; });
    var revised = rows.map(function (row, index) {
      var next = row.slice();
      // Keep native Sheet ID cell types while exposing canonical strings to UI.
      next[0] = data.rawRows[firstIndex + index][0];
      next[1] = data.rawRows[firstIndex + index][1];
      var answer = responses.get(row[0]);
      next[5] = answer.attending;
      next[6] = answer.attending === 'yes' ? encodeNote_(answer.dietaryRequirements) : '';
      next[7] = row[7] + 1;
      next[8] = updatedAt;
      return next;
    });
    var firstRow = firstIndex + 2;
    // One contiguous write keeps all invitation members on the same revision.
    data.sheet.getRange(firstRow, 1, revised.length, RSVP_HEADERS_.length).setValues(revised);
    SpreadsheetApp.flush();
    return { status: 'saved' };
  } finally {
    lock.releaseLock();
  }
}

function result_(status, message) {
  return { status: status, message: message };
}

function normalize_(value) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function authenticate_(request) {
  var properties = PropertiesService.getScriptProperties();
  var access = properties.getProperty('RSVP_ACCESS_CODE');
  if (typeof access !== 'string' || access.length < 8 || access.length > 256) {
    throw new Error('RSVP is not configured. Please contact the hosts.');
  }
  if (!request || typeof request.accessCode !== 'string' || request.accessCode.length > 256 ||
      !equalBytes_(digest_(request.accessCode), digest_(access))) return null;
  var spreadsheetId = properties.getProperty('RSVP_SPREADSHEET_ID');
  var secret = properties.getProperty('RSVP_TOKEN_SECRET');
  if (!spreadsheetId || !secret || secret.length < 32) {
    throw new Error('RSVP is not configured. Please contact the hosts.');
  }
  return { spreadsheetId: spreadsheetId, secret: secret };
}

function digest_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
}

function equalBytes_(left, right) {
  if (left.length !== right.length) return false;
  var difference = 0;
  for (var i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function base64_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function sign_(text, secret) {
  return Utilities.computeHmacSha256Signature(text, secret, Utilities.Charset.UTF_8);
}

function createToken_(group, revision, config) {
  var payload = JSON.stringify({ group: group, revision: revision, expires: Date.now() + RSVP_TOKEN_MS_, scope: config.spreadsheetId });
  var encoded = base64_(Utilities.newBlob(payload).getBytes());
  return encoded + '.' + base64_(sign_(encoded, config.secret));
}

function verifyToken_(token, config) {
  var invalid = { error: result_('invalid', 'Please look up your invitation again.') };
  if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return invalid;
  var parts = token.split('.');
  if (!equalBytes_(sign_(parts[0], config.secret), Utilities.base64DecodeWebSafe(parts[1]))) return invalid;
  var payload;
  // Only signed, bounded input is decoded; parsing errors are application errors.
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (error) {
    return invalid;
  }
  if (!payload || typeof payload.group !== 'string' || !payload.group || payload.group.length > 128 ||
      !Number.isSafeInteger(payload.revision) || payload.revision < 0 ||
      !Number.isSafeInteger(payload.expires) || payload.scope !== config.spreadsheetId) return invalid;
  if (payload.expires <= Date.now()) return { error: result_('expired', 'Your session expired. Please look up your invitation again.') };
  return { payload: payload };
}

function limitLookup_(firstName) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return result_('busy', 'RSVP is busy. Please try again shortly.');
  try {
    var properties = PropertiesService.getScriptProperties();
    var secret = properties.getProperty('RSVP_TOKEN_SECRET');
    var all = properties.getProperties();
    var now = Date.now();
    var current = {};
    Object.keys(all).forEach(function (key) {
      if (key.indexOf(RSVP_RATE_PREFIX_) !== 0) return;
      var counter;
      try { counter = JSON.parse(all[key]); } catch (error) { counter = null; }
      if (!counter || !Number.isSafeInteger(counter.until) || counter.until <= now ||
          !Number.isSafeInteger(counter.count) || counter.count < 0) {
        properties.deleteProperty(key);
      } else {
        current[key] = counter;
      }
    });
    var globalKey = RSVP_RATE_PREFIX_ + 'GLOBAL';
    var nameKey = firstName && secret && secret.length >= 32 ?
      RSVP_RATE_PREFIX_ + base64_(sign_(firstName, secret)) : null;
    var global = current[globalKey] || { until: now + RSVP_WINDOW_MS_, count: 0 };
    var name = nameKey ? (current[nameKey] || { until: now + RSVP_WINDOW_MS_, count: 0 }) : null;
    var newKeys = (current[globalKey] ? 0 : 1) + (nameKey && !current[nameKey] ? 1 : 0);
    if (global.count >= 240 || (name && name.count >= 30) ||
        Object.keys(current).length + newKeys > 250) {
      return result_('rateLimited', 'Too many lookups. Please wait 15 minutes before trying again.');
    }
    global.count++;
    var updates = {};
    updates[globalKey] = JSON.stringify(global);
    if (name) {
      name.count++;
      updates[nameKey] = JSON.stringify(name);
    }
    properties.setProperties(updates);
    return null;
  } finally {
    lock.releaseLock();
  }
}

function validateHeaders_(headers) {
  if (!Array.isArray(headers) || headers.length !== RSVP_HEADERS_.length ||
      headers.some(function (header, i) { return header !== RSVP_HEADERS_[i]; })) {
    throw new Error('RSVP sheet layout needs administrator attention.');
  }
}

function normalizeId_(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  var id = value.trim();
  if (!id || id.length > 128) return null;
  if (/^\d+$/.test(id) && (!Number.isSafeInteger(Number(id)) || Number(id) <= 0)) return null;
  return id;
}

function readGuests_(spreadsheetId) {
  var sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName('Guests');
  if (!sheet) throw new Error('RSVP sheet is missing. Please contact the hosts.');
  var values = sheet.getDataRange().getValues();
  validateHeaders_(values[0]);
  var rawRows = values.slice(1);
  var rows = rawRows.map(function (row) { return row.slice(); });
  var ids = new Set();
  var groups = new Map();
  var previousGroup;
  rows.forEach(function (row) {
    row[0] = normalizeId_(row[0]);
    row[1] = normalizeId_(row[1]);
    var timestamp = row[8] === '' ? '' : (row[8] instanceof Date && Number.isFinite(row[8].getTime()) ? row[8].getTime() : null);
    if (row.length !== RSVP_HEADERS_.length || row[0] === null || row[1] === null || ids.has(row[0]) ||
        [2, 4].some(function (i) { return typeof row[i] !== 'string' || !normalize_(row[i]); }) ||
        typeof row[3] !== 'string' ||
        !['', 'yes', 'no'].includes(row[5]) || typeof row[6] !== 'string' ||
        decodeNote_(row[6]).length > 500 || !Number.isSafeInteger(row[7]) || row[7] < 0 || timestamp === null ||
        (row[7] > 0 && timestamp === '')) throw new Error('RSVP data needs administrator attention.');
    ids.add(row[0]);
    if (groups.has(row[1])) {
      var group = groups.get(row[1]);
      if (previousGroup !== row[1] || group.revision !== row[7] || group.timestamp !== timestamp) {
        throw new Error('RSVP data needs administrator attention.');
      }
    } else {
      groups.set(row[1], { revision: row[7], timestamp: timestamp });
    }
    previousGroup = row[1];
  });
  return { sheet: sheet, rows: rows, rawRows: rawRows };
}

// An invisible marker distinguishes escaped notes from genuine apostrophes.
// Sheets may retain or consume the literal-text apostrophe; both round-trip.
function encodeNote_(note) {
  return /^\s*[=+\-@]/.test(note) || /^['\u200B]/.test(note) ? "'\u200B" + note : note;
}

function decodeNote_(note) {
  return typeof note === 'string' && /^'?\u200B/.test(note) ? note.replace(/^'?\u200B/, '') : note;
}
