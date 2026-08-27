const assert = require('node:assert/strict');

const {
  addCalendarMonths,
  applyBindingTimeInput,
  calculateBindingEndDate,
  isStreamingOnlyBindingMessage,
  parseMonthsRemaining,
} = require('./binding-time');

const now = new Date('2026-08-27T10:00:00Z');
const qualification = {
  peopleCount: 1,
  bindingEnds: ['2026-12-01'],
  people: [{ id: 'person-1', bindingEnd: '2026-12-01' }],
  bindingAppliesToAll: false,
};

assert.equal(calculateBindingEndDate(6, now), '2027-02-27');
assert.equal(addCalendarMonths('2024-01-31', 1), '2024-02-29');
assert.equal(addCalendarMonths('2025-01-31', 1), '2025-02-28');
assert.equal(parseMonthsRemaining('Jag har 6 månader kvar'), 6);
assert.equal(parseMonthsRemaining('ett halvår kvar'), 6);
assert.equal(parseMonthsRemaining('6'), null);
assert.equal(parseMonthsRemaining('6', { allowBareNumber: true }), 6);
assert.equal(parseMonthsRemaining('999 månader kvar'), null);
assert.equal(isStreamingOnlyBindingMessage('Netflix har ingen bindningstid'), true);
assert.equal(isStreamingOnlyBindingMessage('Mitt mobilabonnemang hos Tele2 har bindningstid'), false);

const proposed = applyBindingTimeInput({
  qualification,
  flowState: { activeQuestionField: 'bindingEnds', attempts: { bindingEnds: 2 } },
  message: '6',
  now,
});
assert.deepEqual(proposed.qualification.bindingEnds, ['2026-12-01']);
assert.deepEqual(proposed.flowState.pendingBindingEnd, {
  date: '2027-02-27',
  monthsRemaining: 6,
  targetIndex: 0,
  appliesToAll: false,
});
assert.equal(proposed.flowState.attempts.bindingEnds, undefined);

const confirmed = applyBindingTimeInput({
  qualification: proposed.qualification,
  flowState: proposed.flowState,
  message: 'Ja, det stämmer',
  now,
});
assert.deepEqual(confirmed.qualification.bindingEnds, ['2027-02-27']);
assert.equal(confirmed.qualification.people[0].bindingEnd, '2027-02-27');
assert.equal(confirmed.flowState.pendingBindingEnd, null);

const correction = applyBindingTimeInput({
  qualification,
  flowState: {},
  message: 'Jag har egentligen 3 månader kvar',
  now,
});
assert.equal(correction.flowState.pendingBindingEnd.date, '2026-11-27');
const rejected = applyBindingTimeInput({
  qualification: correction.qualification,
  flowState: correction.flowState,
  message: 'Nej, annat datum',
});
assert.deepEqual(rejected.qualification.bindingEnds, []);
assert.equal(rejected.qualification.people[0].bindingEnd, null);

const exactCorrection = applyBindingTimeInput({
  qualification,
  flowState: {},
  message: 'Bindningstiden ska vara 2027-09-01 istället',
});
assert.deepEqual(exactCorrection.qualification.bindingEnds, ['2027-09-01']);

const bareDateCorrection = applyBindingTimeInput({
  qualification,
  flowState: {},
  message: '2027-10-15',
});
assert.deepEqual(bareDateCorrection.qualification.bindingEnds, ['2027-10-15']);

const noBindingCorrection = applyBindingTimeInput({
  qualification,
  flowState: {},
  message: 'Jag har ingen bindningstid på mobilabonnemanget',
});
assert.deepEqual(noBindingCorrection.qualification.bindingEnds, ['Ingen bindningstid']);

const ignoredStreaming = applyBindingTimeInput({
  qualification,
  flowState: { activeQuestionField: 'bindingEnds' },
  message: 'Streamingtjänster har ingen bindningstid',
});
assert.deepEqual(ignoredStreaming.qualification.bindingEnds, ['2026-12-01']);
assert.equal(ignoredStreaming.flowState.pendingBindingEnd, undefined);

console.log('binding time tests passed');
