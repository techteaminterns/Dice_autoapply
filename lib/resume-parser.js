const fs = require('fs');
const pdfParse = require('pdf-parse');

const parsedResumeCache = new Map();

const SKILL_ALIASES = {
  react: ['react', 'reactjs', 'react.js', 'react native'],
  node: ['node', 'nodejs', 'node.js', 'express', 'express.js', 'nest', 'nestjs'],
  python: ['python', 'py', 'django', 'flask', 'fastapi'],
  javascript: ['javascript', 'js', 'es6', 'ecmascript'],
  typescript: ['typescript', 'ts'],
  java: ['java', 'core java', 'j2ee'],
  'c++': ['c++', 'cpp'],
  'c#': ['c#', 'csharp', '.net', 'dotnet', 'asp.net'],
  go: ['go', 'golang'],
  ruby: ['ruby', 'ruby on rails', 'rails'],
  php: ['php', 'laravel'],
  sql: ['sql', 'mysql', 'postgresql', 'postgres', 't-sql', 'pl/sql', 'oracle', 'sqlite'],
  nosql: ['nosql', 'mongodb', 'mongo', 'dynamodb', 'cassandra', 'redis'],
  aws: ['aws', 'amazon web services', 'ec2', 's3', 'lambda', 'cloudformation'],
  azure: ['azure', 'microsoft azure'],
  gcp: ['gcp', 'google cloud', 'google cloud platform'],
  docker: ['docker', 'containerization', 'containers'],
  kubernetes: ['kubernetes', 'k8s'],
  'ci/cd': ['ci/cd', 'cicd', 'jenkins', 'gitlab ci', 'github actions', 'circleci'],
  terraform: ['terraform', 'iac', 'infrastructure as code'],
  linux: ['linux', 'unix', 'bash', 'shell scripting'],
  'html/css': ['html', 'html5', 'css', 'css3', 'sass', 'tailwind', 'bootstrap'],
  angular: ['angular', 'angularjs'],
  vue: ['vue', 'vuejs', 'vue.js'],
  spring: ['spring', 'spring boot', 'hibernate'],
  'rest api': ['rest', 'restful', 'api', 'graphql', 'grpc'],
  git: ['git', 'github', 'gitlab', 'bitbucket'],
  jira: ['jira', 'agile', 'scrum', 'confluence'],
  'machine learning': ['machine learning', 'ml', 'ai', 'deep learning', 'pytorch', 'tensorflow', 'scikit-learn'],
};

// Skill relationships for intelligent related-skill experience fallback
const RELATED_SKILLS = {
  kotlin: ['java', 'android'],
  swift: ['ios', 'objective-c'],
  rust: ['c++', 'c', 'systems programming'],
  nextjs: ['react', 'node', 'javascript'],
  vue: ['react', 'angular', 'javascript'],
  angular: ['react', 'typescript', 'javascript'],
  fastapi: ['python'],
  django: ['python'],
  flask: ['python'],
  graphql: ['rest api', 'node', 'sql'],
  gcp: ['aws', 'azure'],
  azure: ['aws', 'gcp'],
  kubernetes: ['docker', 'devops'],
};

const MONTH_NAMES = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

function normalizeSkillName(rawSkill) {
  if (!rawSkill) return null;
  const cleaned = String(rawSkill).trim().toLowerCase().replace(/[^\w.+/#-]/g, ' ');
  for (const [canonical, aliases] of Object.entries(SKILL_ALIASES)) {
    if (canonical === cleaned) return canonical;
    if (aliases.some((a) => a === cleaned || cleaned.includes(a))) {
      return canonical;
    }
  }
  return cleaned;
}

function parseMonthYear(text) {
  if (!text) return null;
  const clean = text.trim().toLowerCase();
  if (/present|current|now|ongoing/i.test(clean)) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  }

  // Format: "Jan 2021" or "January 2021" or "01/2021"
  const slashMatch = clean.match(/^(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    return { year: parseInt(slashMatch[2], 10), month: Math.max(0, parseInt(slashMatch[1], 10) - 1) };
  }

  const nameMatch = clean.match(/([a-z]+)[.\s,]+(\d{4})/i);
  if (nameMatch) {
    const mStr = nameMatch[1].slice(0, 3).toLowerCase();
    const month = MONTH_NAMES[mStr] ?? 0;
    const year = parseInt(nameMatch[2], 10);
    return { year, month };
  }

  // Format: "2021"
  const yearMatch = clean.match(/\b(19\d\d|20\d\d)\b/);
  if (yearMatch) {
    return { year: parseInt(yearMatch[1], 10), month: 0 };
  }

  return null;
}

function calculateDurationYears(startDate, endDate) {
  if (!startDate || !endDate) return 1.0;
  const diffMonths = (endDate.year - startDate.year) * 12 + (endDate.month - startDate.month);
  const years = Math.max(0.2, diffMonths / 12);
  return Number(years.toFixed(2));
}

const SECTION_DEFINITIONS = [
  {
    type: 'experience',
    pattern: /(?:^|\n)[ \t]*(?:professional\s+experience|work\s+experience|work\s+history|employment\s+history|experience|employment)[ \t]*:?[ \t]*(?=\n|$)/i,
  },
  {
    type: 'education',
    pattern: /(?:^|\n)[ \t]*(?:education|academic\s+background|academic\s+history|academics|degrees?)[ \t]*:?[ \t]*(?=\n|$)/i,
  },
  {
    type: 'skills',
    pattern: /(?:^|\n)[ \t]*(?:technical\s+skills|core\s+competencies|skills\s+and\s+abilities|technical\s+proficiencies|skills|proficiencies)[ \t]*:?[ \t]*(?=\n|$)/i,
  },
  {
    type: 'projects',
    pattern: /(?:^|\n)[ \t]*(?:key\s+projects|personal\s+projects|academic\s+projects|projects)[ \t]*:?[ \t]*(?=\n|$)/i,
  },
  {
    type: 'certifications',
    pattern: /(?:^|\n)[ \t]*(?:licenses\s+and\s+certifications|certifications\s+and\s+licenses|certifications?|licenses?)[ \t]*:?[ \t]*(?=\n|$)/i,
  },
  {
    type: 'summary',
    pattern: /(?:^|\n)[ \t]*(?:professional\s+summary|executive\s+summary|career\s+objective|summary|objective|profile|about\s+me)[ \t]*:?[ \t]*(?=\n|$)/i,
  },
];

function splitResumeSections(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { experience: '', education: '', skills: '', projects: '', certifications: '', summary: '', other: '' };
  }

  const matches = [];
  for (const def of SECTION_DEFINITIONS) {
    const regex = new RegExp(def.pattern.source, 'gi');
    let m;
    while ((m = regex.exec(rawText)) !== null) {
      matches.push({
        type: def.type,
        headerText: m[0].trim(),
        startIndex: m.index,
        contentStartIndex: m.index + m[0].length,
      });
    }
  }

  if (matches.length === 0) {
    return {
      experience: rawText,
      education: '',
      skills: '',
      projects: '',
      certifications: '',
      summary: '',
      other: '',
    };
  }

  matches.sort((a, b) => a.startIndex - b.startIndex);

  const sections = {
    experience: '',
    education: '',
    skills: '',
    projects: '',
    certifications: '',
    summary: '',
    other: '',
  };

  if (matches[0].startIndex > 0) {
    sections.summary = rawText.slice(0, matches[0].startIndex).trim();
  }

  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].startIndex : rawText.length;
    const content = rawText.slice(current.contentStartIndex, nextStart).trim();
    if (sections[current.type]) {
      sections[current.type] += `\n\n${content}`;
    } else {
      sections[current.type] = content;
    }
  }

  return sections;
}

function extractWorkBlocks(rawText) {
  if (!rawText) return [];

  // Match date ranges like "Jan 2020 - Present", "03/2019 – 12/2021", "2018 - 2020"
  const dateRangeRegex = /(?:([a-zA-Z]{3,9}\.?\s+\d{4}|\d{1,2}\/\d{4}|\b(?:19|20)\d{2}\b))\s*(?:[-–—to]+)\s*(?:([a-zA-Z]{3,9}\.?\s+\d{4}|\d{1,2}\/\d{4}|\b(?:19|20)\d{2}\b|present|current|now))/gi;

  const matches = [];
  let match;
  while ((match = dateRangeRegex.exec(rawText)) !== null) {
    matches.push({
      startStr: match[1],
      endStr: match[2],
      index: match.index,
      rawRange: match[0],
    });
  }

  if (!matches.length) {
    // Fallback: entire resume as one block if no explicit ranges detected
    return [{ durationYears: 3.0, text: rawText }];
  }

  const blocks = [];
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const startIndex = current.index;
    const endIndex = i + 1 < matches.length ? matches[i + 1].index : rawText.length;
    const blockText = rawText.slice(startIndex, endIndex);

    const start = parseMonthYear(current.startStr);
    const end = parseMonthYear(current.endStr);
    const durationYears = calculateDurationYears(start, end);

    blocks.push({
      dateRange: current.rawRange,
      start,
      end,
      durationYears,
      text: blockText,
    });
  }

  return blocks;
}

function parseResumeText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return {
      workBlocks: [],
      skills: {},
      totalExperienceYears: 0,
      highestEducation: null,
      sections: {},
      rawText: '',
    };
  }

  const sections = splitResumeSections(rawText);
  // Ensure work history time is strictly taken from professional experience section,
  // excluding dates from education sections
  const textForWorkBlocks = sections.experience && sections.experience.trim().length > 0
    ? sections.experience
    : (sections.education ? rawText.replace(sections.education, '') : rawText);

  const workBlocks = extractWorkBlocks(textForWorkBlocks);
  const skillDurations = {};

  // Accumulate total unique experience across blocks
  let totalExperienceYears = 0;
  for (const block of workBlocks) {
    totalExperienceYears += block.durationYears;
    const lowerBlockText = block.text.toLowerCase();

    for (const [canonical, aliases] of Object.entries(SKILL_ALIASES)) {
      const mentionsSkill = aliases.some((alias) => {
        // Word boundary check to avoid false positives (e.g. 'c' in 'company')
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(^|[^a-zA-Z0-9_])${escaped}([^a-zA-Z0-9_]|$)`, 'i');
        return pattern.test(lowerBlockText);
      });

      if (mentionsSkill) {
        skillDurations[canonical] = (skillDurations[canonical] || 0) + block.durationYears;
      }
    }
  }

  // Also scan full resume for skills that might be in a "Skills" section
  const lowerFull = rawText.toLowerCase();
  for (const [canonical, aliases] of Object.entries(SKILL_ALIASES)) {
    if (!skillDurations[canonical]) {
      const mentionsInFull = aliases.some((alias) => {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(^|[^a-zA-Z0-9_])${escaped}([^a-zA-Z0-9_]|$)`, 'i');
        return pattern.test(lowerFull);
      });
      if (mentionsInFull) {
        // Default to a baseline 1.5 years if mentioned in skills list without explicit timeline
        skillDurations[canonical] = Math.min(2.0, Math.max(1.0, totalExperienceYears * 0.5));
      }
    }
  }

  // Format skills map with rounded years
  const skillsMap = {};
  for (const [skill, yrs] of Object.entries(skillDurations)) {
    skillsMap[skill] = {
      years: Math.round(yrs * 10) / 10,
      roundedYears: Math.max(1, Math.round(yrs)),
    };
  }

  // Detect education (check education section first, then fall back to full resume)
  let highestEducation = null;
  const eduSearchText = (sections.education && sections.education.trim().length > 0) ? sections.education : rawText;
  if (/ph\.?d|doctorate|doctor of/i.test(eduSearchText)) {
    highestEducation = "Doctorate";
  } else if (/master(?:'s)?|ms |m\.s\.|mba|m\.sc/i.test(eduSearchText)) {
    highestEducation = "Master's Degree";
  } else if (/bachelor(?:'s)?|bs |b\.s\.|btech|b\.tech|b\.e\.|ba /i.test(eduSearchText)) {
    highestEducation = "Bachelor's Degree";
  } else if (/associate(?:'s)?/i.test(eduSearchText)) {
    highestEducation = "Associate's Degree";
  }

  return {
    workBlocks,
    skills: skillsMap,
    totalExperienceYears: Math.round(totalExperienceYears * 10) / 10,
    highestEducation,
    sections,
    rawText,
  };
}

async function extractTextFromBuffer(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch (err) {
    // If not a PDF or corrupted, try reading as UTF-8 text
    return buffer.toString('utf8');
  }
}

async function fetchResumeBuffer(url, customFetch = fetch) {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const res = await customFetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      throw new Error(`Failed to fetch resume HTTP ${res.status}: ${url}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // Local file path
  if (fs.existsSync(url)) {
    return fs.promises.readFile(url);
  }

  return null;
}

async function getCandidateResumeData(clientId, resumeUrl, customFetch = fetch) {
  if (!clientId) return null;
  if (parsedResumeCache.has(clientId)) {
    return parsedResumeCache.get(clientId);
  }

  if (!resumeUrl) {
    return null;
  }

  try {
    const buffer = await fetchResumeBuffer(resumeUrl, customFetch);
    if (!buffer) return null;

    const rawText = await extractTextFromBuffer(buffer);
    const parsed = parseResumeText(rawText);
    parsedResumeCache.set(clientId, parsed);
    return parsed;
  } catch (error) {
    console.error(`[resume-parser] Failed to parse resume for ${clientId}:`, error.message);
    return null;
  }
}

function getExperienceForSkill(parsedResume, skillQuery, totalCandidateExperience = 0) {
  if (!parsedResume || !skillQuery) return 0;
  const canonical = normalizeSkillName(skillQuery);

  if (parsedResume.skills && parsedResume.skills[canonical]) {
    return parsedResume.skills[canonical].roundedYears;
  }

  // Check related skills
  const relatedList = RELATED_SKILLS[canonical];
  if (relatedList && Array.isArray(relatedList)) {
    for (const related of relatedList) {
      const relatedCanonical = normalizeSkillName(related);
      if (parsedResume.skills && parsedResume.skills[relatedCanonical]) {
        return parsedResume.skills[relatedCanonical].roundedYears;
      }
    }
  }

  // If skill not found, return 0 (safe & accurate)
  return 0;
}

function searchResumeForAnswer(parsedResume, question, options = []) {
  if (!parsedResume || !parsedResume.rawText || !question) return null;
  const raw = parsedResume.rawText;
  const q = String(question).toLowerCase();

  // 1. LinkedIn URL
  if (/linkedin/i.test(q)) {
    const match = raw.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+/i);
    if (match) return match[0];
  }

  // 2. GitHub URL
  if (/github/i.test(q)) {
    const match = raw.match(/https?:\/\/(?:www\.)?github\.com\/[a-zA-Z0-9_-]+/i);
    if (match) return match[0];
  }

  // 3. Certifications
  if (/certif/i.test(q)) {
    const hasCert = /certified|certification|certificate/i.test(raw);
    if (options.length) {
      const yesOpt = options.find((opt) => /^yes/i.test(opt));
      const noOpt = options.find((opt) => /^no/i.test(opt));
      if (hasCert && yesOpt) return yesOpt;
      if (!hasCert && noOpt) return noOpt;
    }
  }

  // 4. Security Clearance
  if (/clearance/i.test(q)) {
    const hasClearance = /security clearance|secret clearance|top secret|ts\/sci|public trust/i.test(raw);
    if (options.length) {
      if (!hasClearance) {
        const noneOpt = options.find((opt) => /none|no clearance|not applicable|n\/a/i.test(opt));
        if (noneOpt) return noneOpt;
      } else {
        if (/top secret|ts\/sci/i.test(raw)) {
          const tsOpt = options.find((opt) => /top secret/i.test(opt));
          if (tsOpt) return tsOpt;
        }
        if (/secret/i.test(raw)) {
          const secOpt = options.find((opt) => /\bsecret\b/i.test(opt));
          if (secOpt) return secOpt;
        }
      }
    }
  }

  return null;
}

function clearResumeCache(clientId) {
  if (clientId) {
    parsedResumeCache.delete(clientId);
  } else {
    parsedResumeCache.clear();
  }
}

module.exports = {
  getCandidateResumeData,
  parseResumeText,
  splitResumeSections,
  normalizeSkillName,
  getExperienceForSkill,
  searchResumeForAnswer,
  extractWorkBlocks,
  parseMonthYear,
  calculateDurationYears,
  clearResumeCache,
  SKILL_ALIASES,
  RELATED_SKILLS,
};
