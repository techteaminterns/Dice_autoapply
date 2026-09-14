const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractSkillFromQuestion,
  classifyIntentRuleFallback,
  matchNumericOption,
  matchBestOption,
  parseRangeOption,
} = require('../lib/local-nlp');

test('extractSkillFromQuestion correctly extracts technical skills from question text', () => {
  assert.equal(
    extractSkillFromQuestion('How many years of work experience do you have with Python?'),
    'Python'
  );
  assert.equal(
    extractSkillFromQuestion('How many years of experience in React.js do you have?'),
    'React.js'
  );
  assert.equal(
    extractSkillFromQuestion('How many years of hands-on experience using AWS do you have?'),
    'AWS'
  );
  assert.equal(
    extractSkillFromQuestion('Docker - Years of Experience:'),
    'Docker'
  );
});

test('classifyIntentRuleFallback categorizes question intent', () => {
  assert.equal(
    classifyIntentRuleFallback('Are you legally authorized to work in the United States?'),
    'work_authorization'
  );
  assert.equal(
    classifyIntentRuleFallback('Will you now or in the future require visa sponsorship?'),
    'sponsorship_requirement'
  );
  assert.equal(
    classifyIntentRuleFallback('What is your highest level of completed education?'),
    'education_level'
  );
  assert.equal(
    classifyIntentRuleFallback('What is your expected hourly rate or salary?'),
    'salary_expectation'
  );
  assert.equal(
    classifyIntentRuleFallback('Are you willing to relocate or work hybrid in office?'),
    'commute_relocate'
  );
  assert.equal(
    classifyIntentRuleFallback('Are you at least 18 years of age?'),
    'age_over_18'
  );
});

test('matchNumericOption correctly aligns calculated number with option range', () => {
  const options = ['0-1 years', '2-4 years', '5-7 years', '8+ years'];

  assert.equal(matchNumericOption(options, 0), '0-1 years');
  assert.equal(matchNumericOption(options, 1), '0-1 years');
  assert.equal(matchNumericOption(options, 3), '2-4 years');
  assert.equal(matchNumericOption(options, 4), '2-4 years');
  assert.equal(matchNumericOption(options, 6), '5-7 years');
  assert.equal(matchNumericOption(options, 10), '8+ years');
});

test('matchBestOption accurately maps education levels and strings', () => {
  const options = ["High School", "Associate's Degree", "Bachelor's Degree", "Master's Degree", "Doctorate"];
  assert.equal(matchBestOption(options, "Master's"), "Master's Degree");
  assert.equal(matchBestOption(options, "Bachelor"), "Bachelor's Degree");
});
