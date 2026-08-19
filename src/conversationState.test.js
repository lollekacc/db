const assert = require('node:assert/strict');

const { normalizeQualification } = require('../qualification-service');
const {
  applyConversationAnswer,
  buildQualificationStep,
  mergeQualificationState,
} = require('./conversation-state');
const { normalizeQuickReplies } = require('./chat-ui-response');

const initialAnalysis = {
  peopleCount: 4,
  operators: ['Telenor'],
  bindingEnds: [],
  mobileUsage: 'high',
  priceRange: null,
  familyPriceRange: null,
  operatorAppliesToAll: true,
  bindingAppliesToAll: false,
  priceAppliesToAll: false,
};

let qualification = normalizeQualification(initialAnalysis);
assert.equal(qualification.peopleCount, 4);
assert.deepEqual(qualification.operators, ['Telenor', 'Telenor', 'Telenor', 'Telenor']);
assert.equal(qualification.mobileUsage, 'high');
assert.deepEqual(qualification.missingFields, ['bindingEnds', 'priceRange']);

const explicitInitialStatement = normalizeQualification(applyConversationAnswer({
  message: 'jag vill ha 4 abonnemang obegränsade. vi alla har telenor idag',
  qualification: {},
}));
assert.equal(explicitInitialStatement.peopleCount, 4);
assert.deepEqual(explicitInitialStatement.operators, Array(4).fill('Telenor'));
assert.equal(explicitInitialStatement.mobileUsage, 'high');

const bindingStep = buildQualificationStep({ qualification, language: 'sv' });
assert.equal(bindingStep.reply, 'Har någon av er bindningstid kvar?');
assert.deepEqual(bindingStep.quickReplies.map((reply) => reply.label), [
  'Nej, ingen av oss',
  'Ja, en eller flera',
  'Vi vet inte',
]);
assert.deepEqual(bindingStep.quickReplies[0].qualificationPatch.bindingEnds, Array(4).fill('Ingen bindningstid'));

qualification = normalizeQualification({
  ...qualification,
  ...bindingStep.quickReplies[0].qualificationPatch,
});
assert.equal(qualification.bindingEnds.length, 4);
assert.deepEqual(qualification.missingFields, ['priceRange']);

const priceStep = buildQualificationStep({ qualification, language: 'sv' });
assert.equal(priceStep.reply, 'Ungefär vad betalar ni totalt för alla abonnemang idag?');
assert.equal(priceStep.quickReplies[1].label, '1 000–1 500 kr');

const normalizedReplies = normalizeQuickReplies(priceStep.quickReplies);
assert.equal(normalizedReplies[1].qualificationPatch.familyPriceRange, '1000-1500');

qualification = normalizeQualification({
  ...qualification,
  ...priceStep.quickReplies[1].qualificationPatch,
});
assert.equal(qualification.familyPriceRange, '1000-1500');
assert.deepEqual(qualification.missingFields, []);
assert.equal(buildQualificationStep({ qualification, language: 'sv' }), null);

const stateAfterEmptyAiTurn = mergeQualificationState(qualification, {
  peopleCount: null,
  operators: [],
  bindingEnds: [],
  mobileUsage: null,
  priceRange: null,
  familyPriceRange: null,
});
assert.equal(stateAfterEmptyAiTurn.peopleCount, 4);
assert.equal(stateAfterEmptyAiTurn.bindingEnds.length, 4);
assert.equal(stateAfterEmptyAiTurn.familyPriceRange, '1000-1500');

const beforeTypedNo = normalizeQualification(initialAnalysis);
const afterTypedNo = normalizeQualification(applyConversationAnswer({
  message: 'nej',
  messages: [{ role: 'assistant', content: 'Har någon av er bindningstid kvar?' }],
  qualification: beforeTypedNo,
}));
assert.deepEqual(afterTypedNo.bindingEnds, Array(4).fill('Ingen bindningstid'));
assert.equal(afterTypedNo.bindingAppliesToAll, true);

const afterTypedNone = normalizeQualification(applyConversationAnswer({
  message: 'ingen',
  messages: [{ role: 'assistant', content: 'Har någon av er bindningstid kvar?' }],
  qualification: beforeTypedNo,
}));
assert.deepEqual(afterTypedNone.bindingEnds, Array(4).fill('Ingen bindningstid'));

const afterConfirmation = normalizeQualification(applyConversationAnswer({
  message: 'ja',
  messages: [{ role: 'assistant', content: 'Har alla fyra ingen bindningstid kvar?' }],
  qualification: beforeTypedNo,
}));
assert.deepEqual(afterConfirmation.bindingEnds, Array(4).fill('Ingen bindningstid'));

const exactFamilyTotal = normalizeQualification(applyConversationAnswer({
  message: '1250 kr',
  messages: [{ role: 'assistant', content: 'Ungefär vad betalar ni totalt för alla abonnemang idag?' }],
  qualification: afterTypedNo,
}));
assert.equal(exactFamilyTotal.familyTotalPrice, 1250);
assert.ok(!exactFamilyTotal.missingFields.includes('priceRange'));

console.log('conversation state tests passed');
