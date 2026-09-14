const memoryKnownQuestionsCache = new Map();

function normalizeQuestionText(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findKnownAnswer(pool, { questionText, options = [] }) {
  if (!questionText) return null;
  const normalized = normalizeQuestionText(questionText);
  if (!normalized) return null;

  // 1. Check in-memory cache
  if (memoryKnownQuestionsCache.has(normalized)) {
    return memoryKnownQuestionsCache.get(normalized);
  }

  // 2. Query PostgreSQL if pool is available
  if (pool && typeof pool.query === 'function') {
    try {
      const res = await pool.query(
        `SELECT answer FROM public.dice_unknown_questions
         WHERE normalized_question = $1
         ORDER BY updated_at DESC LIMIT 1`,
        [normalized]
      );
      if (res.rows && res.rows.length > 0) {
        const ans = res.rows[0].answer;
        memoryKnownQuestionsCache.set(normalized, ans);
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

  // Cache in memory
  memoryKnownQuestionsCache.set(normalized, String(answer));

  if (pool && typeof pool.query === 'function') {
    try {
      // Auto-ensure table exists on first insert if needed
      await pool.query(`
        CREATE TABLE IF NOT EXISTS public.dice_unknown_questions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          client_id UUID,
          question_text TEXT NOT NULL,
          normalized_question TEXT NOT NULL,
          question_type TEXT NOT NULL,
          options JSONB DEFAULT '[]'::jsonb,
          answer TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_unknown_questions_normalized 
          ON public.dice_unknown_questions(normalized_question);
      `).catch(() => {});

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
