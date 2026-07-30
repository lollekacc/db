const assert = require('node:assert/strict');

const { BRAND_NAMES, languageNames, translateTexts } = require('./translation-service');

const originalFetch = global.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
let providerCalls = 0;
const seenProviderTexts = [];

global.fetch = async (_url, options) => {
  providerCalls += 1;
  const request = JSON.parse(options.body);
  const match = String(request.input).match(/Strings: (\[[\s\S]*\])$/);
  const texts = JSON.parse(match[1]);
  seenProviderTexts.push(...texts);
  return {
    ok: true,
    async json() {
      return {
        output_text: JSON.stringify({
          translations: texts.map((text) => `Translated: ${text}`),
        }),
      };
    },
  };
};
process.env.OPENAI_API_KEY = 'translation-test-key';

const run = async () => {
  assert(languageNames.de && languageNames.ar && languageNames.so && languageNames.fa);

  const first = await translateTexts({
    language: 'de',
    texts: ['Välj abonnemang', 'Tillbaka', 'Välj abonnemang'],
  });
  assert.deepEqual(
    first.translations.map(({ translated }) => translated),
    ['Translated: Välj abonnemang', 'Translated: Tillbaka', 'Translated: Välj abonnemang']
  );
  assert.equal(providerCalls, 1);

  const branded = await translateTexts({
    language: 'de',
    texts: ['Jämför Dealett, Telia och Tele2'],
  });
  assert.equal(
    branded.translations[0].translated,
    'Translated: Jämför Dealett, Telia och Tele2'
  );
  assert(BRAND_NAMES.includes('Dealett') && BRAND_NAMES.includes('Telia'));
  assert(!seenProviderTexts.some((text) => text.includes('Dealett') || text.includes('Telia')));
  assert(seenProviderTexts.some((text) => text.includes('__DEALETT_BRAND_')));

  await translateTexts({ language: 'de', texts: ['Tillbaka'] });
  assert.equal(providerCalls, 2, 'Cached translations should not call the provider again.');

  const swedish = await translateTexts({ language: 'sv', texts: ['Tillbaka'] });
  assert.equal(swedish.translations[0].translated, 'Tillbaka');
  assert.equal(providerCalls, 2);

  for (const language of Object.keys(languageNames).filter((code) => !['sv', 'de'].includes(code))) {
    const result = await translateTexts({ language, texts: [`Språktest ${language}`] });
    assert.equal(result.language, language);
    assert.equal(result.translations[0].translated, `Translated: Språktest ${language}`);
  }

  await assert.rejects(
    translateTexts({ language: 'xx', texts: ['Tillbaka'] }),
    /Unsupported translation language/
  );

  console.log('Translation service tests passed.');
};

run()
  .finally(() => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  })
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
