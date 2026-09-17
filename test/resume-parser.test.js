const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseResumeText,
  normalizeSkillName,
  getExperienceForSkill,
  calculateDurationYears,
} = require('../lib/resume-parser');

test('normalizeSkillName recognizes skill aliases and variations', () => {
  assert.equal(normalizeSkillName('React.js'), 'react');
  assert.equal(normalizeSkillName('reactjs'), 'react');
  assert.equal(normalizeSkillName('PostgreSQL'), 'sql');
  assert.equal(normalizeSkillName('Amazon Web Services'), 'aws');
  assert.equal(normalizeSkillName('NodeJS'), 'node');
  assert.equal(normalizeSkillName('Kubernetes'), 'kubernetes');
  assert.equal(normalizeSkillName('k8s'), 'kubernetes');
  assert.equal(normalizeSkillName('Golang'), 'go');
});

test('calculateDurationYears calculates accurate year intervals', () => {
  const start = { year: 2021, month: 0 }; // Jan 2021
  const end = { year: 2023, month: 0 }; // Jan 2023
  assert.equal(calculateDurationYears(start, end), 2.0);

  const start2 = { year: 2022, month: 5 }; // Jun 2022
  const end2 = { year: 2023, month: 11 }; // Dec 2023
  assert.equal(calculateDurationYears(start2, end2), 1.5);
});

test('parseResumeText extracts work blocks, dates, and accumulates skill years across employers', () => {
  const mockResume = `
John Doe
Software Engineer
Email: john@example.com | Phone: 123-456-7890
Education: Master of Science in Computer Science, 2020

Work Experience:

Tech Lead at Acme Corp
Jan 2022 - Jan 2024
- Built scalable web applications using React and Node.js.
- Architected cloud solutions on AWS and managed PostgreSQL databases.
- Deployed microservices using Docker and Kubernetes.

Software Developer at Beta Inc
Jan 2020 - Dec 2021
- Developed frontend components using React.js and Redux.
- Wrote automated tests and maintained Python data pipelines.
- Integrated REST APIs with SQL backends.
  `;

  const parsed = parseResumeText(mockResume);
  assert.ok(parsed.workBlocks.length >= 2, 'Should identify at least 2 work blocks');
  assert.equal(parsed.highestEducation, "Master's Degree");

  // React mentioned in both jobs (2 yrs at Acme + 2 yrs at Beta = 4 yrs)
  const reactYrs = getExperienceForSkill(parsed, 'React');
  assert.ok(reactYrs >= 4, `React experience should be at least 4 years, got ${reactYrs}`);

  // Python mentioned in Beta Inc (2 yrs)
  const pythonYrs = getExperienceForSkill(parsed, 'Python');
  assert.ok(pythonYrs >= 2, `Python experience should be at least 2 years, got ${pythonYrs}`);

  // AWS mentioned in Acme Corp (2 yrs)
  const awsYrs = getExperienceForSkill(parsed, 'AWS');
  assert.ok(awsYrs >= 2, `AWS experience should be at least 2 years, got ${awsYrs}`);

  // Related skill fallback: Kotlin -> Java (if candidate has no Kotlin or Java -> 0)
  const unknownSkill = getExperienceForSkill(parsed, 'Fortran');
  assert.equal(unknownSkill, 0, 'Completely unmentioned skill should return 0');
});

test('parseResumeText isolates professional experience and excludes education dates from work blocks', () => {
  const resumeWithEduDates = `
Jane Smith
Full Stack Developer

Professional Experience:
Senior Developer at Gamma Tech
Jan 2022 - Jan 2024
- Led frontend architecture with TypeScript and React.js.

Developer at Delta LLC
Jan 2020 - Jan 2022
- Backend services using Go and PostgreSQL.

Education:
State University of Technology
Sep 2014 - Jun 2018
- Bachelor of Science in Computer Science.
- Coursework: Algorithms, Operating Systems, C++.
  `;

  const parsed = parseResumeText(resumeWithEduDates);

  // Exactly 2 work blocks from Gamma Tech and Delta LLC (total 4 years)
  assert.equal(parsed.workBlocks.length, 2, 'Should only extract work blocks from experience section');
  assert.equal(parsed.highestEducation, "Bachelor's Degree");
  assert.equal(parsed.totalExperienceYears, 4, 'Total experience should be 4 years, NOT 8 years (education excluded)');

  // Ensure no work block contains the education date range
  const hasEduBlock = parsed.workBlocks.some((b) => b.text.includes('State University') || b.dateRange.includes('2014'));
  assert.equal(hasEduBlock, false, 'Education must not be parsed as a work block');
});
