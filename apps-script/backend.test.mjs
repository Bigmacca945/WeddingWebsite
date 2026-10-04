import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';

const source = readFileSync(new URL('./Code.gs', import.meta.url), 'utf8');
const headers = ['Guest ID', 'Group ID', 'First Name', 'Last Name', 'Display Name', 'Attendance', 'Dietary Requirements', 'Revision', 'Updated At'];
// Synthetic fixtures only. These are not real guests or spreadsheet IDs.
const guest = (id, group, first, last) => [id, group, first, last, `${first} ${last}`.trim(), '', '', 0, ''];
const fixtures = () => [
  headers.slice(),
  guest('guest-1', 'group-1', 'Example', 'Alpha'),
  guest('guest-2', 'group-1', 'Sample', 'Alpha'),
  guest('guest-3', 'group-2', 'Example', 'Beta'),
  guest('guest-4', 'group-3', 'Multi Word', 'Gamma')
];

function harness(options = {}) {
  const state = {
    rows: options.rows || fixtures(),
    properties: options.properties || {
      RSVP_SPREADSHEET_ID: 'synthetic-sheet',
      RSVP_TOKEN_SECRET: 'synthetic-test-signing-key-not-for-production'
    },
    reads: 0, writes: 0, opens: 0, releases: 0, lockAttempts: [],
    lockAvailable: true, locked: false, writeError: false, readError: false,
    flushError: false, releaseError: false, consumeApostrophe: false, coerceNumericIds: false,
    active: true, hasSheet: true, now: 1_800_000_000_000
  };
  const properties = {
    getProperty: key => state.properties[key] ?? null,
    setProperty: (key, value) => { state.properties[key] = value; },
    getProperties: () => ({ ...state.properties }),
    setProperties: updates => Object.assign(state.properties, updates),
    deleteProperty: key => { delete state.properties[key]; }
  };
  const sheet = {
    getLastRow: () => state.rows.length,
    getDataRange: () => ({
      getValues: () => {
        state.reads++;
        if (state.readError) throw new Error('synthetic read failure');
        return state.rows.map(row => row.slice());
      }
    }),
    getRange: (start, column, count, width) => ({
      setValues: values => {
        if (state.writeError) throw new Error('synthetic write failure');
        assert.equal(column, 1);
        assert.equal(width, 9);
        assert.equal(values.length, count);
        state.writes++;
        values.forEach((row, index) => {
          state.rows[start - 1 + index] = row.map((value, columnIndex) => {
            if (state.coerceNumericIds && columnIndex < 2 && typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
            return state.consumeApostrophe && typeof value === 'string' && value.startsWith("'")
              ? value.slice(1) : value;
          });
        });
      }
    })
  };
  const spreadsheet = {
    getId: () => 'synthetic-sheet',
    getSheetByName: name => {
      assert.equal(name, 'Guests');
      return state.hasSheet ? sheet : null;
    },
    insertSheet: name => {
      assert.equal(name, 'Guests');
      state.hasSheet = true;
      return sheet;
    }
  };
  const lock = {
    tryLock: timeout => {
      state.lockAttempts.push(timeout);
      if (!state.lockAvailable) return false;
      assert.equal(state.locked, false);
      state.locked = true;
      return true;
    },
    releaseLock: () => {
      state.releases++;
      state.locked = false;
      if (state.releaseError) throw new Error('synthetic release failure');
    }
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])); }
    static now() { return state.now; }
  }
  const context = vm.createContext({
    Date: Clock,
    PropertiesService: { getScriptProperties: () => properties },
    LockService: { getScriptLock: () => lock },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => state.active ? spreadsheet : null,
      openById: id => {
        assert.equal(id, state.properties.RSVP_SPREADSHEET_ID);
        state.opens++;
        return spreadsheet;
      },
      flush: () => { if (state.flushError) throw new Error('synthetic flush failure'); }
    },
    Utilities: {
      Charset: { UTF_8: 'utf8' },
      computeHmacSha256Signature: (value, secret) => [...createHmac('sha256', secret).update(value).digest()],
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url'),
      base64DecodeWebSafe: text => [...Buffer.from(text, 'base64url')],
      newBlob: value => ({
        getBytes: () => [...Buffer.from(value)],
        getDataAsString: () => Buffer.from(value).toString('utf8')
      }),
      getUuid: randomUUID
    },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createTemplateFromFile: file => ({
        file,
        evaluate() {
          return {
            file: this.file,
            embedChannel: this.embedChannel,
            parentOrigin: this.parentOrigin,
            setTitle(title) { this.title = title; return this; },
            setXFrameOptionsMode(mode) { this.mode = mode; return this; }
          };
        }
      })
    }
  });
  vm.runInContext(source, context, { filename: 'Code.gs' });
  const lookup = (firstName = 'Example', lastName = 'Alpha') =>
    context.lookupInvitation({ firstName, lastName });
  const answers = () => [
    { id: 'guest-1', attending: 'yes', dietaryRequirements: 'Synthetic note' },
    { id: 'guest-2', attending: 'no', dietaryRequirements: 'Clear this note' }
  ];
  const save = (token, responses = answers()) => context.saveInvitation({ token, responses });
  return { state, context, lookup, save, answers };
}

test('only three web-callable functions exist, with embeddable HTML', () => {
  const functions = [...source.matchAll(/^function (\w+)\(/gm)].map(match => match[1]);
  assert.deepEqual(functions.filter(name => !name.endsWith('_')), ['doGet', 'lookupInvitation', 'saveInvitation']);
  const { context } = harness();
  const html = context.doGet();
  assert.equal(html.file, 'Rsvp');
  assert.equal(html.title, 'Wedding RSVP');
  assert.equal(html.mode, 'ALLOWALL');
  assert.equal(html.embedChannel, '');
  assert.equal(html.parentOrigin, 'https://bigmacca945.github.io');
});

test('HTML template permits only a bounded channel and pins the parent origin', () => {
  const { context } = harness();
  const channel = '12345678-1234-1234-1234-123456789abc';
  assert.equal(context.doGet({ parameter: { channel } }).embedChannel, channel);
  assert.equal(context.doGet({ parameter: { channel: channel.toUpperCase() } }).embedChannel, channel.toUpperCase());
  for (const channel of [undefined, '', '<script>unsafe</script>', 'a'.repeat(37), 'g'.repeat(36), ['a'.repeat(36)]]) {
    assert.equal(context.doGet({ parameter: { channel, parentOrigin: 'https://invalid.example' } }).embedChannel, '');
    assert.equal(context.doGet({ parameter: { channel, parentOrigin: 'https://invalid.example' } }).parentOrigin, 'https://bigmacca945.github.io');
  }
});

test('lookup and legitimate signed save work without an invitation code', () => {
  const h = harness();
  assert.deepEqual(Object.keys(h.state.properties).sort(), ['RSVP_SPREADSHEET_ID', 'RSVP_TOKEN_SECRET']);
  const invitation = h.context.lookupInvitation({ firstName: 'Example', lastName: 'Alpha' });
  assert.equal(invitation.status, 'found');
  assert.equal(h.context.saveInvitation({ token: invitation.token, responses: h.answers() }).status, 'saved');
  assert.equal(h.state.writes, 1);
});

test('missing tokens and malformed save requests are rejected before sheet access', () => {
  const h = harness();
  for (const request of [undefined, null, false, 42, 'forged', [], {}, { responses: h.answers() },
    { token: 'forged', responses: h.answers() }]) {
    assert.equal(h.context.saveInvitation(request).status, 'invalid');
  }
  assert.equal(h.context.lookupInvitation(null).status, 'invalid');
  assert.equal(h.state.opens, 0);
  assert.equal(h.state.reads, 0);
  assert.equal(h.state.writes, 0);
});

test('missing or invalid configuration fails closed', () => {
  for (const key of ['RSVP_SPREADSHEET_ID', 'RSVP_TOKEN_SECRET']) {
    const h = harness();
    delete h.state.properties[key];
    assert.throws(() => h.lookup(), /not configured/);
    assert.throws(() => h.save('invalid'), /not configured/);
    assert.equal(h.state.opens, 0);
  }
  for (const value of ['', 'short', 42, {}]) {
    const h = harness();
    h.state.properties.RSVP_TOKEN_SECRET = value;
    assert.throws(() => h.lookup(), /not configured/);
    assert.throws(() => h.save('invalid'), /not configured/);
    assert.equal(h.state.opens, 0);
  }
});

test('private initialization uses the bound sheet and preserves the signing secret', () => {
  const h = harness({ rows: [], properties: {} });
  h.state.hasSheet = false;
  h.context.initializeRsvp_();
  assert.deepEqual(Array.from(h.state.rows[0]), headers);
  assert.equal(h.state.properties.RSVP_SPREADSHEET_ID, 'synthetic-sheet');
  assert.ok(h.state.properties.RSVP_TOKEN_SECRET.length >= 64);
  assert.deepEqual(Object.keys(h.state.properties).sort(), ['RSVP_SPREADSHEET_ID', 'RSVP_TOKEN_SECRET']);
  const secret = h.state.properties.RSVP_TOKEN_SECRET;
  h.context.initializeRsvp_();
  assert.equal(h.state.properties.RSVP_TOKEN_SECRET, secret);
  h.state.active = false;
  assert.throws(() => h.context.initializeRsvp_(), /bound spreadsheet/);
  h.state.active = true;
  h.state.rows[0][0] = 'Incorrect header';
  assert.throws(() => h.context.initializeRsvp_(), /layout/);
});

test('normalizes NFKC, case, and whitespace, including multiword first names', () => {
  const h = harness();
  const invitation = h.lookup('  ＥＸＡＭＰＬＥ  ', ' ALPHA ');
  assert.equal(invitation.status, 'found');
  assert.deepEqual(Array.from(invitation.guests, guest => guest.id), ['guest-1', 'guest-2']);
  assert.equal(invitation.hasResponse, false);
  assert.equal(invitation.guests[0].attending, null);
  assert.equal(h.lookup('  MULTI \t WORD\n', ' gamma ').guests[0].id, 'guest-4');
  h.state.active = false;
  assert.equal(h.lookup('Multi Word', '').status, 'found');
  assert.equal(h.state.opens, 3);
  const payload = JSON.parse(Buffer.from(invitation.token.split('.')[0], 'base64url'));
  assert.equal(payload.scope, 'synthetic-sheet');
  assert.equal(JSON.stringify(payload).includes(h.state.properties.RSVP_TOKEN_SECRET), false);
});

test('native numeric IDs and blank surnames round-trip as stable public string IDs', () => {
  const h = harness({ rows: [
    headers.slice(),
    guest(1, 11, 'Single', ''),
    guest(2, 11, 'Companion', ''),
    guest(3, 12, 'Distinct', '')
  ] });
  h.state.coerceNumericIds = true;
  const invitation = h.lookup('single', '');
  assert.equal(invitation.status, 'found');
  assert.deepEqual(Array.from(invitation.guests, guest => guest.id), ['1', '2']);
  assert.equal(JSON.parse(Buffer.from(invitation.token.split('.')[0], 'base64url')).group, '11');
  const responses = invitation.guests.map(guest => ({
    id: guest.id, attending: 'yes', dietaryRequirements: 'Synthetic note'
  }));
  assert.equal(h.save(invitation.token, responses).status, 'saved');
  assert.equal(h.state.rows[1][0], 1);
  assert.equal(h.state.rows[1][1], 11);
  assert.equal(h.state.rows[2][0], 2);
  assert.equal(h.state.rows[2][7], 1);
  const reopened = h.lookup('single', '');
  assert.equal(reopened.status, 'found');
  assert.equal(reopened.hasResponse, true);
  assert.deepEqual(Array.from(reopened.guests, guest => guest.id), ['1', '2']);
  assert.equal(h.save(reopened.token, responses).status, 'saved');
  assert.equal(h.lookup('Single', 'Incorrect').status, 'notFound');
});

test('trimmed text IDs normalize consistently and mixed native/text groups remain contiguous', () => {
  const h = harness({ rows: [
    headers.slice(),
    guest(' 1 ', ' 11 ', 'Single', ''),
    guest(' synthetic-2 ', 11, 'Companion', '')
  ] });
  const invitation = h.lookup('Single', '');
  assert.equal(invitation.status, 'found');
  assert.deepEqual(Array.from(invitation.guests, guest => guest.id), ['1', 'synthetic-2']);
  assert.equal(h.save(invitation.token, invitation.guests.map(guest => ({
    id: guest.id, attending: 'no', dietaryRequirements: ''
  }))).status, 'saved');
  assert.equal(h.lookup('Single', '').guests[0].id, '1');
  h.state.rows.push(guest(1, 12, 'Other', 'Synthetic'));
  assert.throws(() => h.lookup('Single', ''), /administrator attention/);
});

test('invalid numeric IDs, normalized duplicates, and non-string surnames fail closed', () => {
  for (const value of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, null, {}, '', '  ', '0']) {
    for (const column of [0, 1]) {
      const rows = [headers.slice(), guest(1, 11, 'Single', '')];
      rows[1][column] = value;
      const h = harness({ rows });
      assert.throws(() => h.lookup('Single', ''), /administrator attention/);
      assert.equal(h.state.writes, 0);
    }
  }
  const duplicate = harness({ rows: [
    headers.slice(), guest(1, 11, 'Single', ''), guest('1', 12, 'Other', '')
  ] });
  assert.throws(() => duplicate.lookup('Single', ''), /administrator attention/);
  const surname = harness();
  surname.state.rows[1][3] = null;
  assert.throws(() => surname.lookup(), /administrator attention/);
});

test('ambiguous names request a surname without exposing candidate names', () => {
  const h = harness();
  const result = h.lookup('Example', '');
  assert.equal(result.status, 'needsSurname');
  assert.equal(result.guests, undefined);
  assert.equal(JSON.stringify(result).includes('Alpha'), false);
  assert.equal(JSON.stringify(result).includes('Beta'), false);
  assert.equal(h.lookup('Example', 'Beta').guests.length, 1);
  assert.equal(h.lookup('Example', 'Unknown').status, 'notFound');
  assert.equal(h.lookup('Unknown', '').status, 'notFound');
  h.state.rows.push(guest('guest-5', 'group-4', 'Example', 'Alpha'));
  assert.equal(h.lookup('Example', 'Alpha').status, 'notFound');
});

test('invalid names do not read the guest sheet', () => {
  const h = harness();
  for (const firstName of ['', '   ', 42, 'x'.repeat(129)]) {
    assert.equal(h.context.lookupInvitation({ firstName }).status, 'invalid');
  }
  assert.equal(h.context.lookupInvitation({ firstName: 'Example', lastName: {} }).status, 'invalid');
  assert.equal(h.state.opens, 0);
});

test('save updates the full contiguous group once and lookup reopens saved primitives', () => {
  const h = harness();
  const invitation = h.lookup();
  assert.equal(h.save(invitation.token).status, 'saved');
  assert.equal(h.state.writes, 1);
  assert.equal(h.state.rows[1][7], 1);
  assert.equal(h.state.rows[2][7], 1);
  assert.ok(h.state.rows[1][8] instanceof Date);
  assert.equal(h.state.rows[1][8].getTime(), h.state.rows[2][8].getTime());
  assert.equal(h.state.rows[2][6], '');
  assert.equal(h.state.rows[3][7], 0);
  const reopened = h.lookup();
  assert.equal(reopened.hasResponse, true);
  assert.equal(reopened.guests[0].attending, 'yes');
  assert.equal(reopened.guests[0].dietaryRequirements, 'Synthetic note');
  assert.equal(reopened.guests[1].attending, 'no');
  assert.ok(JSON.stringify(reopened));
  assert.equal(h.save(invitation.token).status, 'conflict');
  assert.equal(h.save(reopened.token).status, 'saved');
  assert.equal(h.state.rows[1][7], 2);
});

test('requires all and only invited IDs, with no duplicates or invalid responses', () => {
  const h = harness();
  const token = h.lookup().token;
  const good = h.answers();
  for (const responses of [
    [], null, [good[0]], [good[0], good[0]],
    [...good, { ...good[0], id: 'guest-3' }],
    [good[0], { ...good[1], id: 'unknown' }],
    [good[0], { ...good[1], id: 'guest-3' }],
    [good[0], { ...good[1], attending: 'maybe' }],
    [good[0], { ...good[1], dietaryRequirements: null }],
    [good[0], { ...good[1], dietaryRequirements: 'x'.repeat(501) }],
    [good[0], null]
  ]) assert.equal(h.save(token, responses).status, 'invalid');
  assert.equal(h.state.writes, 0);
  assert.equal(h.state.locked, false);
  assert.equal(h.save(token, [{ ...good[0], dietaryRequirements: 'x'.repeat(500) }, good[1]]).status, 'saved');
});

test('formula-like notes round-trip safely, preserving genuine leading apostrophes', () => {
  for (const consumeApostrophe of [false, true]) {
    for (const note of ['=1+1', '+synthetic', '-synthetic', '@synthetic', ' \t=1+1', "'=literal", '\u200Bmarker', "'\u200Bmarker"]) {
      const h = harness();
      h.state.consumeApostrophe = consumeApostrophe;
      const token = h.lookup().token;
      const responses = h.answers();
      responses[0].dietaryRequirements = note;
      assert.equal(h.save(token, responses).status, 'saved');
      assert.equal(h.lookup().guests[0].dietaryRequirements, note);
      assert.equal(/^\s*[=+\-@]/.test(h.state.rows[1][6]), false);
    }
  }
});

test('expired, forged, malformed, and cross-sheet tokens cannot read or write', () => {
  const h = harness();
  const token = h.lookup().token;
  const reads = h.state.reads;
  const opens = h.state.opens;
  for (const bad of [undefined, null, '', 'not-a-token', token + 'x', token.replace(/.$/, token.endsWith('A') ? 'B' : 'A'), 'x'.repeat(2049)]) {
    assert.equal(h.save(bad).status, 'invalid');
  }
  const pieces = token.split('.');
  const payload = JSON.parse(Buffer.from(pieces[0], 'base64url'));
  payload.group = 'group-2';
  assert.equal(h.save(Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + pieces[1]).status, 'invalid');
  h.state.properties.RSVP_SPREADSHEET_ID = 'other-synthetic-sheet';
  assert.equal(h.save(token).status, 'invalid');
  h.state.properties.RSVP_SPREADSHEET_ID = 'synthetic-sheet';
  h.state.now += 60 * 60 * 1000;
  assert.equal(h.save(token).status, 'expired');
  assert.equal(h.state.reads, reads);
  assert.equal(h.state.opens, opens);
  assert.equal(h.state.writes, 0);
});

test('rate limits are private atomic counters, with expiry cleanup preserving configuration', () => {
  const h = harness();
  for (let index = 0; index < 30; index++) assert.equal(h.lookup().status, 'found');
  const reads = h.state.reads;
  assert.equal(h.lookup().status, 'rateLimited');
  assert.equal(h.state.reads, reads);
  assert.equal(h.lookup('Multi Word', '').status, 'found');
  const rateKeys = Object.keys(h.state.properties).filter(key => key.startsWith('RSVP_RATE_'));
  assert.equal(rateKeys.length, 3);
  assert.ok(rateKeys.every(key => !key.includes('example')));
  const secret = h.state.properties.RSVP_TOKEN_SECRET;
  h.state.properties.RSVP_RATE_BROKEN = 'invalid-json';
  h.state.now += 15 * 60 * 1000;
  assert.equal(h.lookup().status, 'found');
  assert.equal(h.state.properties.RSVP_RATE_BROKEN, undefined);
  assert.equal(h.state.properties.RSVP_TOKEN_SECRET, secret);
  assert.equal(h.state.releases, h.state.lockAttempts.length);
  assert.ok(h.state.lockAttempts.every(value => value === 10000));
});

test('global enumeration cap and bounded property storage reject further lookups', () => {
  const h = harness();
  for (let index = 0; index < 240; index++) {
    assert.equal(h.lookup(`Synthetic ${index}`, '').status, 'notFound');
  }
  assert.equal(h.lookup('Synthetic extra', '').status, 'rateLimited');
  assert.equal(Object.keys(h.state.properties).filter(key => key.startsWith('RSVP_RATE_')).length, 241);
  const bounded = harness();
  for (let index = 0; index < 250; index++) {
    bounded.state.properties[`RSVP_RATE_TEST_${index}`] = JSON.stringify({ until: bounded.state.now + 10000, count: 1 });
  }
  assert.equal(bounded.lookup().status, 'rateLimited');
});

test('global lookup limiter counts incomplete name requests before sheet reads', () => {
  const h = harness();
  for (let index = 0; index < 240; index++) {
    assert.equal(h.context.lookupInvitation({
      firstName: `Synthetic ${index}`, lastName: null
    }).status, 'invalid');
  }
  assert.equal(h.lookup().status, 'rateLimited');
  assert.equal(h.state.opens, 0);
  assert.equal(h.state.reads, 0);
  assert.equal(h.state.locked, false);
  h.state.now += 15 * 60 * 1000;
  assert.equal(h.lookup().status, 'found');
});

test('nameless attempts count toward the global limit even with missing configuration', () => {
  const h = harness();
  delete h.state.properties.RSVP_TOKEN_SECRET;
  for (let index = 0; index < 240; index++) {
    assert.throws(() => h.context.lookupInvitation({}), /not configured/);
  }
  assert.equal(h.context.lookupInvitation({}).status, 'rateLimited');
  assert.equal(h.state.opens, 0);
  assert.equal(Object.keys(h.state.properties).filter(key => key.startsWith('RSVP_RATE_')).length, 1);
});

test('busy locks do not read or write; lock exceptions are not masked', () => {
  const h = harness();
  const token = h.lookup().token;
  h.state.lockAvailable = false;
  const reads = h.state.reads;
  assert.equal(h.lookup().status, 'busy');
  assert.equal(h.save(token).status, 'busy');
  assert.equal(h.state.reads, reads);
  assert.equal(h.state.writes, 0);
  assert.equal(h.state.releases, 1);
  h.context.LockService.getScriptLock = () => ({
    tryLock() { throw new Error('synthetic lock failure'); }
  });
  assert.throws(() => h.lookup(), /lock failure/);
  assert.throws(() => h.save(token), /lock failure/);
});

test('write, read, flush, and release failures never report saved and release locks', () => {
  for (const failure of ['writeError', 'readError', 'flushError', 'releaseError']) {
    const h = harness();
    const token = h.lookup().token;
    h.state[failure] = true;
    assert.throws(() => h.save(token), /synthetic .* failure/);
    assert.equal(h.state.locked, false);
    assert.equal(h.state.releases, 2);
  }
});

test('schema and malformed data fail closed without leaking private row details', () => {
  const mutations = [
    rows => { rows[0][0] = 'Bad header'; },
    rows => { rows[0].push('Extra column'); },
    rows => { rows[2][0] = rows[1][0]; },
    rows => { rows[1][1] = ''; },
    rows => { rows[1][2] = 42; },
    rows => { rows[1][5] = 'maybe'; },
    rows => { rows[1][6] = 42; },
    rows => { rows[1][7] = '0'; },
    rows => { rows[1][7] = -1; },
    rows => { rows[1][7] = Number.MAX_SAFE_INTEGER + 1; },
    rows => { rows[2][7] = 1; },
    rows => { rows[1][8] = 'not-a-date'; },
    rows => { rows.push(guest('guest-5', 'group-1', 'Synthetic', 'Alpha')); }
  ];
  for (const mutate of mutations) {
    const h = harness();
    const token = h.lookup().token;
    mutate(h.state.rows);
    for (const operation of [() => h.lookup(), () => h.save(token)]) {
      assert.throws(operation, error => {
        assert.match(error.message, /administrator attention/);
        assert.equal(error.message.includes('Example'), false);
        return true;
      });
    }
    assert.equal(h.state.writes, 0);
    assert.equal(h.state.locked, false);
  }
});
