let pipelineInstance = null;
let pipelinePromise = null;
let transformersAvailable = true;

const INTENTS = [
  'skill_experience_years',
  'work_authorization',
  'sponsorship_requirement',
  'education_level',
  'salary_expectation',
  'start_date',
  'commute_relocate',
  'background_drug_check',
  'age_over_18',
];

async function getClassifierPipeline() {
  if (pipelineInstance) return pipelineInstance;
  if (!transformersAvailable) return null;
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    try {
      const { pipeline, env } = require('@xenova/transformers');
      // Set cache directory to local folder if needed
      env.allowLocalModels = true;
      env.useBrowserCache = false;
      const classifier = await pipeline('zero-shot-classification', 'Xenova/all-MiniLM-L6-v2');
      pipelineInstance = classifier;
      return classifier;
    } catch (err) {
      console.warn('[local-nlp] Transformers ONNX model unavailable; using semantic token fallback:', err.message);
      transformersAvailable = false;
      return null;
    } finally {
      pipelinePromise = null;
    }
  })();

  return pipelinePromise;
}

const { SKILL_ALIASES } = require('./resume-parser');

function extractSkillFromQuestion(questionText) {
  if (!questionText) return null;
  const q = String(questionText).trim();

  // Pattern 1: "experience ... (do you have)? with/in/using [skill]"
  const m1 = q.match(/(?:years\s+of(?:\s+hands-on|\s+work)?\s+experience(?:\s+do\s+you\s+have)?\s+(?:with|in|using|for))\s+([a-zA-Z0-9#+.\s/-]+?)(?:\s+do\s+you|\s*\?|\s*\(|\s*:|$)/i);
  if (m1 && m1[1]) {
    const raw = m1[1].trim().replace(/\b(do you have|have you|required)\b/gi, '').trim();
    if (raw.length >= 2 && raw.length <= 40) return raw;
  }

  // Pattern 2: "experience (with/in/using) [skill]"
  const m2 = q.match(/(?:experience\s+(?:with|in|using|for))\s+([a-zA-Z0-9#+.\s/-]+?)(?:\s+do\s+you|\s*\?|\s*\(|\s*:|$)/i);
  if (m2 && m2[1]) {
    const raw = m2[1].trim().replace(/\b(do you have|have you|required)\b/gi, '').trim();
    if (raw.length >= 2 && raw.length <= 40) return raw;
  }

  // Pattern 3: "years (do you have/have you had) with/in/using [skill]"
  const m3 = q.match(/years\s+(?:do\s+you\s+have|have\s+you\s+had)\s+(?:with|in|using)\s+([a-zA-Z0-9#+.\s/-]+?)(?:\s*\?|\s*\(|\s*:|$)/i);
  if (m3 && m3[1]) {
    return m3[1].trim();
  }

  // Pattern 4: "[Skill] - Years of Experience" or "[Skill] experience (years)"
  const m4 = q.match(/^([a-zA-Z0-9#+.\s/-]{2,30})\s*(?:[-–:]|\()\s*(?:years\s+of\s+experience|experience)/i);
  if (m4 && m4[1]) {
    return m4[1].trim();
  }

  // Pattern 5: Direct dictionary scan across known skills
  const lowerQ = q.toLowerCase();
  for (const [canonical, aliases] of Object.entries(SKILL_ALIASES)) {
    for (const alias of aliases) {
      if (alias.length <= 2 && !['js', 'ts', 'c#', 'c', 'go', 'py', 'ml', 'ai'].includes(alias)) {
        continue; // skip short aliases that might be common words
      }
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(^|[^a-zA-Z0-9_])${escaped}([^a-zA-Z0-9_]|$)`, 'i');
      if (pattern.test(lowerQ)) {
        return alias;
      }
    }
  }

  return null;
}

function classifyIntentRuleFallback(questionText) {
  const q = String(questionText || '').toLowerCase();

  if (/years\s+of\s+experience|how\s+many\s+years/i.test(q)) {
    return 'skill_experience_years';
  }
  if (/authorized\s+to\s+work|eligible\s+to\s+work|legal\s+right\s+to\s+work|citizenship/i.test(q)) {
    return 'work_authorization';
  }
  if (/sponsor|visa\s+sponsorship|require.*sponsorship|immigration/i.test(q)) {
    return 'sponsorship_requirement';
  }
  if (/highest.*education|degree|level\s+of\s+education|graduation/i.test(q)) {
    return 'education_level';
  }
  if (/desired\s+salary|hourly\s+rate|compensation|pay\s+rate|expected\s+salary/i.test(q)) {
    return 'salary_expectation';
  }
  if (/start\s+date|when\s+can\s+you\s+start|earliest.*start|available.*start/i.test(q)) {
    return 'start_date';
  }
  if (/relocat|commute|office|on-site|onsite|hybrid|work\s+in\s+the\s+office/i.test(q)) {
    return 'commute_relocate';
  }
  if (/background\s+check|drug\s+(screen|test)/i.test(q)) {
    return 'background_drug_check';
  }
  if (/18\s+years|over\s+18|legal\s+age/i.test(q)) {
    return 'age_over_18';
  }

  return null;
}

async function classifyQuestionIntent(questionText) {
  if (!questionText) return { intent: null, confidence: 0 };

  // Fast check: deterministic pattern
  const ruleIntent = classifyIntentRuleFallback(questionText);
  if (ruleIntent) {
    return { intent: ruleIntent, confidence: 0.95 };
  }

  // Try Transformer ONNX Zero-Shot Classifier
  const classifier = await getClassifierPipeline();
  if (classifier) {
    try {
      const candidateLabels = [
        'years of experience with a specific programming language or skill',
        'authorization to work in the United States',
        'visa or immigration sponsorship requirement',
        'highest level of completed education or degree',
        'desired salary or hourly pay compensation',
        'available start date for work',
        'willingness to relocate or commute to the office',
        'willingness to undergo background check or drug test',
        'age 18 or older',
      ];
      const result = await classifier(questionText, candidateLabels);
      const topScore = result.scores[0];
      const topLabel = result.labels[0];

      if (topScore >= 0.45) {
        const labelIndex = candidateLabels.indexOf(topLabel);
        return {
          intent: INTENTS[labelIndex],
          confidence: topScore,
        };
      }
    } catch (err) {
      console.warn('[local-nlp] Classification error:', err.message);
    }
  }

  return { intent: null, confidence: 0 };
}

function parseRangeOption(optionText) {
  const text = String(optionText || '').trim().toLowerCase();

  // "5+ years" or "5 or more" or "more than 5"
  const plusMatch = text.match(/(\d+)\s*(?:\+|or more|years\s+or\s+more|more\s+than)/i);
  if (plusMatch) {
    return { min: parseInt(plusMatch[1], 10), max: Infinity };
  }

  // "None" or "0" or "No experience"
  if (/none|no\s+experience|^0\b/i.test(text)) {
    return { min: 0, max: 0.5 };
  }

  // "1 - 3 years" or "1 to 3"
  const rangeMatch = text.match(/(\d+)\s*(?:-|–|—|to)\s*(\d+)/i);
  if (rangeMatch) {
    return { min: parseInt(rangeMatch[1], 10), max: parseInt(rangeMatch[2], 10) };
  }

  // Exact number: "3 years"
  const singleMatch = text.match(/\b(\d+)\b/);
  if (singleMatch) {
    const val = parseInt(singleMatch[1], 10);
    return { min: val, max: val };
  }

  return null;
}

function matchNumericOption(options, numericValue) {
  if (!Array.isArray(options) || !options.length) return null;
  const num = Number(numericValue);
  if (Number.isNaN(num)) return null;

  for (const opt of options) {
    const range = parseRangeOption(opt);
    if (range && num >= range.min && num <= range.max) {
      return opt;
    }
  }

  // If no range explicitly bounded, pick closest option
  let closest = null;
  let minDiff = Infinity;
  for (const opt of options) {
    const range = parseRangeOption(opt);
    if (range) {
      const mid = range.max === Infinity ? range.min + 2 : (range.min + range.max) / 2;
      const diff = Math.abs(num - mid);
      if (diff < minDiff) {
        minDiff = diff;
        closest = opt;
      }
    }
  }

  return closest || options[0];
}

function matchBestOption(options, targetValue) {
  if (!Array.isArray(options) || !options.length || !targetValue) return null;
  const targetLower = String(targetValue).trim().toLowerCase();

  // 1. Exact match
  const exact = options.find((opt) => opt.trim().toLowerCase() === targetLower);
  if (exact) return exact;

  // 2. Substring match
  const sub = options.find((opt) => opt.toLowerCase().includes(targetLower) || targetLower.includes(opt.toLowerCase()));
  if (sub) return sub;

  // 3. Word token overlap
  const targetWords = targetLower.split(/\W+/).filter(Boolean);
  let bestOpt = null;
  let maxOverlap = 0;

  for (const opt of options) {
    const optWords = opt.toLowerCase().split(/\W+/).filter(Boolean);
    const overlap = optWords.filter((w) => targetWords.includes(w)).length;
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      bestOpt = opt;
    }
  }

  return maxOverlap > 0 ? bestOpt : null;
}

module.exports = {
  classifyQuestionIntent,
  classifyIntentRuleFallback,
  extractSkillFromQuestion,
  matchNumericOption,
  matchBestOption,
  parseRangeOption,
  INTENTS,
};
