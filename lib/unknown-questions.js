const memoryKnownQuestionsCache = new Map();

const LANG_REPLACEMENTS = [
  [/c\+\+/gi, 'cplusplus'],
  [/c#/gi, 'csharp'],
  [/f#/gi, 'fsharp'],
  [/\.net/gi, 'dotnet'],
  [/node\.js/gi, 'nodejs'],
  [/react\.js/gi, 'reactjs'],
  [/vue\.js/gi, 'vuejs'],
  [/next\.js/gi, 'nextjs'],
  [/nest\.js/gi, 'nestjs'],
  [/express\.js/gi, 'expressjs'],
  [/angular\.js/gi, 'angularjs'],
  [/three\.js/gi, 'threejs'],
  [/d3\.js/gi, 'd3js'],
];

function normalizeQuestionText(text) {
  if (!text) return '';
  let s = String(text).toLowerCase();
  for (const [pattern, replacement] of LANG_REPLACEMENTS) {
    s = s.replace(pattern, replacement);
  }
  return s
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findKnownAnswer(pool, { clientId = null, questionText, options = [] }) {
  if (!questionText) return null;
  const normalized = normalizeQuestionText(questionText);
  if (!normalized) return null;

  const cacheKey = clientId ? `${clientId}::${normalized}` : normalized;

  // 1. Check in-memory cache
  if (memoryKnownQuestionsCache.has(cacheKey)) {
    return memoryKnownQuestionsCache.get(cacheKey);
  }

  // 2. Query PostgreSQL if pool is available
  if (pool && typeof pool.query === 'function') {
    try {
      const query = clientId
        ? `SELECT answer FROM public.dice_unknown_questions
           WHERE normalized_question = $1 AND client_id = $2
           ORDER BY updated_at DESC LIMIT 1`
        : `SELECT answer FROM public.dice_unknown_questions
           WHERE normalized_question = $1 AND client_id IS NULL
           ORDER BY updated_at DESC LIMIT 1`;
      const params = clientId ? [normalized, clientId] : [normalized];

      const res = await pool.query(query, params);
      if (res.rows && res.rows.length > 0) {
        const ans = res.rows[0].answer;
        memoryKnownQuestionsCache.set(cacheKey, ans);
        return ans;
      }
    } catch (err) {
      // Table might not be migrated yet or DB unreachable
      console.warn('[unknown-questions] Lookup skipped:', err.message);
    }
  }

  return null;
}

async function saveKnownAnswer(pool, {
  clientId = null,
  questionText,
  questionType = 'text',
  options = [],
  answer,
  source = 'nlp_resolved',
}) {
  if (!questionText || answer == null) return null;
  const normalized = normalizeQuestionText(questionText);
  if (!normalized) return null;

  const cacheKey = clientId ? `${clientId}::${normalized}` : normalized;

  // Cache in memory
  memoryKnownQuestionsCache.set(cacheKey, String(answer));

  if (pool && typeof pool.query === 'function') {
    try {
      await pool.query(
        `INSERT INTO public.dice_unknown_questions 
         (client_id, question_text, normalized_question, question_type, options, answer, source, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          clientId,
          questionText,
          normalized,
          questionType,
          JSON.stringify(options || []),
          String(answer),
          source,
        ]
      );
      console.log(`[unknown-questions] Saved learned Q&A: "${questionText.slice(0, 50)}..." -> "${answer}"`);
    } catch (err) {
      console.error('[unknown-questions] Failed to save answer to DB:', err.message);
    }
  }

  return answer;
}

async function listRecentUnknownQuestions(pool, limit = 50) {
  if (!pool || typeof pool.query !== 'function') return [];
  try {
    const res = await pool.query(
      `SELECT id, client_id, question_text, question_type, options, answer, source, created_at, updated_at
       FROM public.dice_unknown_questions
       ORDER BY updated_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows || [];
  } catch (err) {
    return [];
  }
}

function clearKnownQuestionsCache() {
  memoryKnownQuestionsCache.clear();
}

module.exports = {
  normalizeQuestionText,
  findKnownAnswer,
  saveKnownAnswer,
  listRecentUnknownQuestions,
  clearKnownQuestionsCache,
};
