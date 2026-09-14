const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveQuestionAnswer } = require('../lib/dice-apply-questions');
const { clearResumeCache } = require('../lib/resume-parser');
const { clearKnownQuestionsCache } = require('../lib/unknown-questions');

test.beforeEach(() => {
  clearResumeCache();
  clearKnownQuestionsCache();
});

test('resolveQuestionAnswer uses fast-path ruleAnswer for standard questions', async () => {
  const profile = {
    willing_to_relocate: true,
    is_over_18: true,
    eligible_to_work_in_us: true,
  };

  const res1 = await resolveQuestionAnswer({
    question: 'Are you willing to relocate?',
    options: ['Yes', 'No'],
    type: 'radio',
    profile,
  });
  assert.equal(res1.answer, 'Yes');
  assert.equal(res1.source, 'rule');

  const res2 = await resolveQuestionAnswer({
    question: 'Are you over 18 years of age?',
    options: ['Yes', 'No'],
    type: 'radio',
    profile,
  });
  assert.equal(res2.answer, 'Yes');
  assert.equal(res2.source, 'rule');
});

test('resolveQuestionAnswer uses unknown_questions knowledge base if previously answered', async () => {
  const mockPool = {
    query: async () => ({
      rows: [{ answer: 'Secret' }],
    }),
  };

  const res = await resolveQuestionAnswer({
    question: 'What is your security clearance level?',
    options: ['None', 'Secret', 'Top Secret'],
    type: 'radio',
    profile: {},
    dbPool: mockPool,
  });

  assert.equal(res.answer, 'Secret');
  assert.equal(res.source, 'knowledge_base');
});

test('resolveQuestionAnswer triggers onPromptFallback and saves answer if unknown', async () => {
  let savedData = null;
  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('INSERT INTO')) {
        savedData = params;
      }
      return { rows: [] };
    },
  };

  let promptCalled = false;
  const onPromptFallback = async ({ question, options }) => {
    promptCalled = true;
    return 'Option B';
  };

  const res = await resolveQuestionAnswer({
    question: 'Which shift are you applying for?',
    options: ['Option A', 'Option B', 'Option C'],
    type: 'radio',
    profile: { id: 'client-uuid-1' },
    dbPool: mockPool,
    onPromptFallback,
  });

  assert.ok(promptCalled, 'Should invoke onPromptFallback');
  assert.equal(res.answer, 'Option B');
  assert.equal(res.source, 'telegram_prompt');
  assert.ok(savedData, 'Should save answer to database');
  assert.equal(savedData[5], 'Option B'); // answer
});

test('resolveQuestionAnswer propagates skip or timeout errors from onPromptFallback', async () => {
  const onPromptFallback = async () => {
    throw new Error('SKIPPED_BY_USER');
  };

  const res = await resolveQuestionAnswer({
    question: 'Provide a 500 word description of your career goals.',
    options: [],
    type: 'text',
    profile: { id: 'client-uuid-1' },
    onPromptFallback,
  });

  assert.equal(res.answer, null);
  assert.equal(res.error?.message, 'SKIPPED_BY_USER');
});

test('matchDynamicProfileColumn automatically matches arbitrary database columns like veteran_status', async () => {
  const profile = {
    veteran_status: 'I am not a protected veteran',
    security_clearance: true,
    notice_period_days: 14,
  };

  const res1 = await resolveQuestionAnswer({
    question: 'What is your military veteran status?',
    options: [
      'I identify as a protected veteran',
      'I am not a protected veteran',
      'I do not wish to answer',
    ],
    type: 'radio',
    profile,
  });

  assert.equal(res1.answer, 'I am not a protected veteran');
  assert.equal(res1.source, 'dynamic_column');

  const res2 = await resolveQuestionAnswer({
    question: 'Do you currently hold an active security clearance?',
    options: ['Yes', 'No'],
    type: 'radio',
    profile,
  });

  assert.equal(res2.answer, 'Yes');
  assert.equal(res2.source, 'dynamic_column');
});

test('searchResumeForAnswer extracts URLs and certifications from resume text', () => {
  const { searchResumeForAnswer } = require('../lib/resume-parser');
  const mockResume = {
    rawText: `
      Jane Doe
      LinkedIn: https://www.linkedin.com/in/janedoe
      GitHub: https://github.com/janedoe
      Certifications: AWS Certified Solutions Architect Associate (2022)
    `,
  };

  const link = searchResumeForAnswer(mockResume, 'Please provide your LinkedIn profile URL');
  assert.equal(link, 'https://www.linkedin.com/in/janedoe');

  const cert = searchResumeForAnswer(
    mockResume,
    'Do you hold an active cloud certification?',
    ['Yes', 'No']
  );
  assert.equal(cert, 'Yes');
});
