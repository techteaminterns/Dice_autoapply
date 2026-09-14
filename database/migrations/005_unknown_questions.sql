CREATE TABLE IF NOT EXISTS public.dice_unknown_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES public.clients_additional_info(id) ON DELETE SET NULL,
  question_text TEXT NOT NULL,
  normalized_question TEXT NOT NULL,
  question_type TEXT NOT NULL, -- 'radio', 'checkbox', 'dropdown', 'text'
  options JSONB DEFAULT '[]'::jsonb,
  answer TEXT NOT NULL,
  source TEXT NOT NULL, -- 'telegram_prompt', 'nlp_resolved', 'manual_operator'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unknown_questions_normalized 
  ON public.dice_unknown_questions(normalized_question);

CREATE INDEX IF NOT EXISTS idx_unknown_questions_client 
  ON public.dice_unknown_questions(client_id);
