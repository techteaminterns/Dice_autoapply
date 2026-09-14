function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function yesNoFromBoolean(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return null;
}

function pickAllOptions(options, wantedList) {
  const chosen = [];
  for (const wanted of wantedList) {
    const match = pickOption(options, wanted);
    if (match && !chosen.includes(match)) chosen.push(match);
  }
  return chosen;
}

function answersToList(answer) {
  if (answer == null || answer === '') return [];
  if (Array.isArray(answer)) return answer.map((item) => String(item).trim()).filter(Boolean);
  return String(answer).split(',').map((item) => item.trim()).filter(Boolean);
}

function ruleAnswerMulti(question, options, profile) {
  const single = ruleAnswer(question, options, profile);
  if (single) return answersToList(single);

  const roleHints = [
    ...(Array.isArray(profile.job_role_preferences) ? profile.job_role_preferences : []),
    ...answersToList(profile.alternate_job_roles),
    ...(Array.isArray(profile.add_ons_info) ? profile.add_ons_info : []),
  ];
  const fromProfile = pickAllOptions(options, roleHints);
  return fromProfile.length ? fromProfile : null;
}

function pickOption(options, wanted) {
  if (!wanted) return null;
  const wantedLower = String(wanted).trim().toLowerCase();
  return options.find((option) => option.toLowerCase() === wantedLower)
    || options.find((option) => option.toLowerCase().includes(wantedLower))
    || null;
}

const { getCandidateResumeData, getExperienceForSkill, searchResumeForAnswer } = require('./resume-parser');
const { classifyQuestionIntent, extractSkillFromQuestion, matchNumericOption, matchBestOption } = require('./local-nlp');
const { findKnownAnswer, saveKnownAnswer } = require('./unknown-questions');

const IGNORED_COLUMN_KEYS = new Set([
  'id', 'client_id', 'created_at', 'updated_at', 'telegram_chat_id',
  'resume_url', 'raw_data', 'metadata', 'password', 'applywizz_id',
  'exclude_companies', 'career_associate_id',
]);

function matchDynamicProfileColumn(question, profile, options = []) {
  if (!question || !profile || typeof profile !== 'object') return null;
  const cleanQ = String(question).toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const qTokens = cleanQ.split(/\s+/).filter((w) => w.length > 2);
  if (!qTokens.length) return null;

  let bestMatch = null;
  let highestScore = 0;

  for (const [key, value] of Object.entries(profile)) {
    if (value == null || value === '' || IGNORED_COLUMN_KEYS.has(key)) continue;

    const keyWords = key
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[_\s]+/)
      .filter((w) => w.length > 2);

    if (!keyWords.length) continue;

    const matchedWords = keyWords.filter((kw) => qTokens.some((qt) => qt === kw || qt.includes(kw) || kw.includes(qt)));
    const overlapRatio = matchedWords.length / keyWords.length;

    if (overlapRatio >= 0.5 && overlapRatio > highestScore) {
      highestScore = overlapRatio;
      bestMatch = { key, value };
    }
  }

  if (!bestMatch || highestScore < 0.5) return null;

  const val = bestMatch.value;
  if (typeof val === 'boolean') {
    return pickOption(options, yesNoFromBoolean(val));
  }

  const valStr = String(val).trim();
  if (options && options.length) {
    return matchBestOption(options, valStr) || pickOption(options, valStr);
  }

  return valStr;
}

async function resolveQuestionAnswer({
  question,
  options = [],
  type = 'text',
  profile = {},
  dbPool = null,
  onPromptFallback = null,
}) {
  // Tier 1A: Fast Rule Check
  if (type === 'checkbox') {
    const ruleMulti = ruleAnswerMulti(question, options, profile);
    if (ruleMulti && ruleMulti.length) {
      return { answer: ruleMulti, source: 'rule' };
    }
  } else {
    const ruleSingle = ruleAnswer(question, options, profile);
    if (ruleSingle != null && ruleSingle !== '') {
      return { answer: ruleSingle, source: 'rule' };
    }
  }

  // Tier 1B: Dynamic Profile Column Matcher (e.g. veteran_status, clearance, disability, etc.)
  const dynamicColAnswer = matchDynamicProfileColumn(question, profile, options);
  if (dynamicColAnswer != null && dynamicColAnswer !== '') {
    return { answer: dynamicColAnswer, source: 'dynamic_column' };
  }

  // Tier 2: Check unknown_questions database table
  const known = await findKnownAnswer(dbPool, { questionText: question, options });
  if (known != null && known !== '') {
    if (type === 'checkbox') {
      const list = answersToList(known);
      if (list.length) return { answer: list, source: 'knowledge_base' };
    } else if (type === 'radio' && options.length) {
      const picked = pickOption(options, known);
      if (picked) return { answer: picked, source: 'knowledge_base' };
    } else {
      return { answer: known, source: 'knowledge_base' };
    }
  }

  // Tier 3: Local NLP & Resume Intelligence
  const parsedResume = profile.id
    ? await getCandidateResumeData(profile.id, profile.resume_url).catch(() => null)
    : null;

  // 3A: Search full resume text for certifications, clearances, and URLs
  const resumeTextMatch = searchResumeForAnswer(parsedResume, question, options);
  if (resumeTextMatch != null && resumeTextMatch !== '') {
    return { answer: resumeTextMatch, source: 'resume_text' };
  }

  const { intent } = await classifyQuestionIntent(question);

  if (intent === 'skill_experience_years') {
    const skill = extractSkillFromQuestion(question);
    const yrs = skill
      ? getExperienceForSkill(parsedResume, skill, profile.experience || 0)
      : (parsedResume?.totalExperienceYears || profile.experience || 1);

    if (type === 'radio' && options.length) {
      const opt = matchNumericOption(options, yrs);
      if (opt) {
        saveKnownAnswer(dbPool, {
          clientId: profile.id,
          questionText: question,
          questionType: type,
          options,
          answer: opt,
          source: 'nlp_resolved',
        }).catch(() => {});
        return { answer: opt, source: 'local_nlp_resume' };
      }
    } else {
      const ansStr = String(Math.round(yrs));
      saveKnownAnswer(dbPool, {
        clientId: profile.id,
        questionText: question,
        questionType: type,
        options,
        answer: ansStr,
        source: 'nlp_resolved',
      }).catch(() => {});
      return { answer: ansStr, source: 'local_nlp_resume' };
    }
  } else if (intent === 'work_authorization') {
    const bool = profile.eligible_to_work_in_us ?? true;
    const ans = pickOption(options, yesNoFromBoolean(bool));
    if (ans) return { answer: ans, source: 'local_nlp_profile' };
  } else if (intent === 'sponsorship_requirement') {
    const bool = profile.require_future_sponsorship ?? profile.sponsorship ?? false;
    const ans = pickOption(options, yesNoFromBoolean(bool));
    if (ans) return { answer: ans, source: 'local_nlp_profile' };
  } else if (intent === 'education_level') {
    const edu = profile.highest_education || parsedResume?.highestEducation;
    if (edu) {
      const ans = options.length ? matchBestOption(options, edu) : edu;
      if (ans) return { answer: ans, source: 'local_nlp_profile' };
    }
  } else if (intent === 'salary_expectation') {
    const salary = profile.desired_salary || (profile.experience && profile.experience > 5 ? '100000' : '80000');
    if (!options.length) return { answer: String(salary), source: 'local_nlp_profile' };
    const opt = matchNumericOption(options, salary) || matchBestOption(options, String(salary));
    if (opt) return { answer: opt, source: 'local_nlp_profile' };
  } else if (intent === 'start_date') {
    const start = profile.desired_start_date || 'Immediately';
    if (!options.length) return { answer: start, source: 'local_nlp_profile' };
    const opt = matchBestOption(options, start);
    if (opt) return { answer: opt, source: 'local_nlp_profile' };
  } else if (intent === 'commute_relocate') {
    const bool = /relocat/i.test(question)
      ? profile.willing_to_relocate
      : profile.can_work_3_days_in_office;
    if (bool != null) {
      const ans = pickOption(options, yesNoFromBoolean(bool));
      if (ans) return { answer: ans, source: 'local_nlp_profile' };
    }
  } else if (intent === 'background_drug_check') {
    const bool = /drug/i.test(question) ? profile.willing_drug_screen : profile.willing_background_check;
    const ans = pickOption(options, yesNoFromBoolean(bool ?? true));
    if (ans) return { answer: ans, source: 'local_nlp_profile' };
  } else if (intent === 'age_over_18') {
    const ans = pickOption(options, yesNoFromBoolean(profile.is_over_18 ?? true));
    if (ans) return { answer: ans, source: 'local_nlp_profile' };
  }

  // Tier 4: Interactive Telegram Prompt Fallback
  if (onPromptFallback && typeof onPromptFallback === 'function') {
    console.log(`[apply-questions] Unresolved question. Triggering Telegram prompt fallback: "${question}"`);
    try {
      const userReply = await onPromptFallback({ question, options, type });
      if (userReply) {
        await saveKnownAnswer(dbPool, {
          clientId: profile.id,
          questionText: question,
          questionType: type,
          options,
          answer: String(userReply),
          source: 'telegram_prompt',
        }).catch(() => {});
        return { answer: userReply, source: 'telegram_prompt' };
      }
    } catch (err) {
      return { answer: null, error: err };
    }
  }

  return { answer: null };
}

function ruleAnswer(question, options, profile) {
  const q = question.toLowerCase();
  const pickYesNo = (bool) => pickOption(options, yesNoFromBoolean(bool));

  if (/office|on-site|onsite|come into the office|in the office|on site/.test(q)) {
    return pickYesNo(profile.can_work_3_days_in_office);
  }
  if (/relocat/.test(q)) {
    return pickYesNo(profile.willing_to_relocate);
  }
  if (/sponsor/.test(q)) {
    return pickYesNo(profile.require_future_sponsorship ?? profile.sponsorship);
  }
  if (/over 18|18 years/.test(q)) {
    return pickYesNo(profile.is_over_18);
  }
  if (/eligible to work in the (united states|u\.?s\.?)/.test(q) || /authorized to work in the (united states|u\.?s\.?)/.test(q)) {
    return pickYesNo(profile.eligible_to_work_in_us);
  }
  if (/authorized without (a )?visa|without visa sponsorship/.test(q)) {
    return pickYesNo(profile.authorized_without_visa);
  }
  if (/background check/.test(q)) {
    return pickYesNo(profile.willing_background_check);
  }
  if (/drug (screen|test)/.test(q)) {
    return pickYesNo(profile.willing_drug_screen);
  }
  if (/felony|convicted/.test(q)) {
    return pickYesNo(profile.convicted_of_felony);
  }
  if (/perform essential functions|essential (job )?functions/.test(q)) {
    return pickYesNo(profile.can_perform_essential_functions);
  }
  if (/years of experience|how many years/.test(q) && options.length === 0) {
    return profile.experience ? String(profile.experience) : null;
  }
  if (/highest (level of )?education|education level/.test(q)) {
    return pickOption(options, profile.highest_education) || (options.length ? null : profile.highest_education);
  }
  if (/when can you start|start date/.test(q) && options.length === 0) {
    return profile.desired_start_date ? String(profile.desired_start_date) : null;
  }

  return null;
}

async function loadApplyProfile(azure, clientId) {
  if (!clientId) return {};

  const { data: client, error: clientError } = await azure
    .from('clients_additional_info')
    .select('*')
    .eq('id', clientId)
    .maybeSingle();
  if (clientError) console.error('Failed to load client for apply questions:', clientError.message);

  const { data: profile, error: profileError } = await azure
    .from('client_profiles')
    .select('*')
    .eq('id', clientId)
    .maybeSingle();
  if (profileError) console.error('Failed to load profile for apply questions:', profileError.message);

  return {
    id: clientId,
    ...(client || {}),
    ...(profile || {}),
    sponsorship: client?.sponsorship,
  };
}

async function isResumeCoverStep(page) {
  const heading = page.getByText(/resume\s*&\s*cover letter/i);
  return (await heading.count()) > 0;
}

async function radioGroupAlreadyAnswered(group) {
  const radios = group.locator('input[type="radio"]');
  const count = await radios.count();
  for (let i = 0; i < count; i += 1) {
    if (await radios.nth(i).isChecked().catch(() => false)) return true;
  }
  return false;
}

async function readRadioQuestion(group) {
  const slotLabel = normalizeText(await group.locator('[slot="label"]').first().innerText().catch(() => ''));
  if (slotLabel) return slotLabel;

  const labelledBy = await group.getAttribute('aria-labelledby');
  if (labelledBy) {
    const id = labelledBy.trim().split(/\s+/)[0];
    const fromId = normalizeText(await group.page().locator(`[id="${id}"]`).innerText().catch(() => ''));
    if (fromId) return fromId;
  }

  return normalizeText(await group.getAttribute('aria-label') || '');
}

async function optionLabelsFromGroup(group) {
  const labels = group.locator('label');
  const count = await labels.count();
  const options = [];
  for (let i = 0; i < count; i += 1) {
    const text = normalizeText(await labels.nth(i).innerText().catch(() => ''));
    if (text) options.push(text);
  }
  return options;
}

async function clickLabeledControl(group, optionText) {
  const exact = new RegExp(`^${escapeRegExp(optionText)}$`, 'i');
  const pressableExact = group.locator('label[data-react-aria-pressable="true"]').filter({ hasText: exact });
  const pressableLoose = group.locator('label[data-react-aria-pressable="true"]').filter({ hasText: optionText });
  const labelExact = group.locator('label').filter({ hasText: exact });
  const byText = group.getByText(optionText, { exact: true });

  let target = pressableExact;
  if (await target.count() === 0) target = pressableLoose;
  if (await target.count() === 0) target = labelExact;
  if (await target.count() === 0) target = byText;

  await target.first().scrollIntoViewIfNeeded();
  await target.first().click();
}

function applyQuestionForm(page) {
  const withStepButton = page.locator('form').filter({
    has: page.getByRole('button', { name: /^(next|submit)$/i }),
  });
  return withStepButton.last();
}

async function fillRadioGroups(page, profile) {
  const form = applyQuestionForm(page);
  await form.getByRole('radiogroup').first().waitFor({ state: 'attached', timeout: 4000 }).catch(() => { });

  let groups = form.getByRole('radiogroup');
  let count = await groups.count();
  if (count === 0) {
    groups = form.locator('[role="radiogroup"]');
    count = await groups.count();
  }

  const rawRadios = await form.locator('input[type="radio"]').count();
  console.log('[apply-questions] radio scan', {
    inForm: (await form.count()) > 0,
    radiogroups: count,
    rawRadioInputs: rawRadios,
    officeDb: profile.can_work_3_days_in_office ?? null,
    relocateDb: profile.willing_to_relocate ?? null,
    sponsorshipDb: profile.require_future_sponsorship ?? profile.sponsorship ?? null,
  });

  for (let i = 0; i < count; i += 1) {
    const group = groups.nth(i);
    const already = await radioGroupAlreadyAnswered(group);
    const question = await readRadioQuestion(group);
    const options = await optionLabelsFromGroup(group);

    console.log('[apply-questions] radio group', {
      index: i,
      question: question || '(empty)',
      options,
      alreadyAnswered: already,
    });

    if (already) continue;
    if (!question || options.length === 0) {
      return { ok: false, reason: `Found a radio group but could not read question/options (question="${question}")` };
    }

    const resolved = await resolveQuestionAnswer({
      question,
      options,
      type: 'radio',
      profile,
      dbPool,
      onPromptFallback,
    });

    if (resolved.error) {
      return { ok: false, reason: resolved.error.message };
    }

    const chosen = resolved.answer;
    if (!chosen) {
      return { ok: false, reason: `Unanswered radio: ${question}` };
    }

    const option = pickOption(options, chosen);
    if (!option) {
      return { ok: false, reason: `No matching radio option for: ${question}` };
    }
    console.log('[apply-questions] clicking radio', option);
    await clickLabeledControl(group, option);
  }

  return { ok: true };
}

async function optionIsSelected(group, optionText) {
  const exact = new RegExp(`^${escapeRegExp(optionText)}$`, 'i');
  const label = group.locator('label').filter({ hasText: exact }).first();
  if (await label.getAttribute('data-selected').catch(() => null) === 'true') return true;
  return label.locator('input[type="checkbox"]').isChecked().catch(() => false);
}

async function collectCheckboxGroups(form) {
  const byRole = form.locator('[role="group"]').filter({ has: form.locator('input[type="checkbox"]') });
  const roleCount = await byRole.count();
  if (roleCount > 0) {
    const groups = [];
    for (let i = 0; i < roleCount; i += 1) groups.push(byRole.nth(i));
    return groups;
  }

  const boxes = form.locator('input[type="checkbox"]');
  const boxCount = await boxes.count();
  const seen = new Set();
  const groups = [];
  for (let i = 0; i < boxCount; i += 1) {
    const name = (await boxes.nth(i).getAttribute('name')) || `__idx_${i}`;
    if (seen.has(name)) continue;
    seen.add(name);
    const first = boxes.nth(i);
    const ancestor = first.locator('xpath=ancestor::*[.//*[@slot="label"]][1]');
    groups.push((await ancestor.count()) ? ancestor : first.locator('xpath=ancestor::div[1]'));
  }
  return groups;
}

async function fillCheckboxGroups(page, profile, { dbPool = null, onPromptFallback = null } = {}) {
  const form = applyQuestionForm(page);
  await form.locator('input[type="checkbox"]').first().waitFor({ state: 'attached', timeout: 2000 }).catch(() => { });

  const groups = await collectCheckboxGroups(form);
  const rawBoxes = await form.locator('input[type="checkbox"]').count();
  console.log('[apply-questions] checkbox scan', {
    inForm: (await form.count()) > 0,
    checkboxGroups: groups.length,
    rawCheckboxInputs: rawBoxes,
    rolesDb: profile.job_role_preferences ?? null,
    alternateRolesDb: profile.alternate_job_roles ?? null,
  });

  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const question = await readRadioQuestion(group);
    const options = await optionLabelsFromGroup(group);

    console.log('[apply-questions] checkbox group', {
      index: i,
      question: question || '(empty)',
      options,
    });

    if (!question || options.length === 0) {
      return { ok: false, reason: `Found a checkbox group but could not read question/options (question="${question}")` };
    }

    const resolved = await resolveQuestionAnswer({
      question,
      options,
      type: 'checkbox',
      profile,
      dbPool,
      onPromptFallback,
    });

    if (resolved.error) {
      return { ok: false, reason: resolved.error.message };
    }

    let chosenList = Array.isArray(resolved.answer) ? resolved.answer : answersToList(resolved.answer);
    if (!chosenList || !chosenList.length) {
      return { ok: false, reason: `Unanswered checkbox: ${question}` };
    }

    const toClick = pickAllOptions(options, chosenList);
    if (!toClick.length) {
      return { ok: false, reason: `No matching checkbox options for: ${question}` };
    }

    for (const option of toClick) {
      if (await optionIsSelected(group, option)) {
        console.log('[apply-questions] checkbox already selected', option);
        continue;
      }
      console.log('[apply-questions] clicking checkbox', option);
      await clickLabeledControl(group, option);
    }
  }

  return { ok: true };
}

function looksLikeCoverLetter(text) {
  return /cover letter/i.test(text);
}

async function readTextQuestion(field) {
  const container = field.locator('xpath=ancestor::*[.//*[@slot="label"]][1]');
  const slotLabel = normalizeText(await container.locator('[slot="label"]').first().innerText().catch(() => ''));
  if (slotLabel) return slotLabel;

  const labelledBy = await field.getAttribute('aria-labelledby');
  if (labelledBy) {
    const id = labelledBy.trim().split(/\s+/)[0];
    const fromId = normalizeText(await field.page().locator(`[id="${id}"]`).innerText().catch(() => ''));
    if (fromId) return fromId;
  }

  return normalizeText(await field.getAttribute('aria-label') || await field.getAttribute('placeholder') || '');
}

async function fillTextFields(page, profile, { dbPool = null, onPromptFallback = null } = {}) {
  const form = applyQuestionForm(page);
  await form.locator('textarea, input[type="text"]').first().waitFor({ state: 'attached', timeout: 2000 }).catch(() => { });

  const fields = form.locator('textarea, input[type="text"]');
  const count = await fields.count();
  console.log('[apply-questions] text scan', {
    inForm: (await form.count()) > 0,
    textFields: count,
    experienceDb: profile.experience ?? null,
    startDateDb: profile.desired_start_date ?? null,
  });

  for (let i = 0; i < count; i += 1) {
    const field = fields.nth(i);
    if (!await field.isVisible().catch(() => false)) continue;
    const current = normalizeText(await field.inputValue().catch(() => ''));
    const question = await readTextQuestion(field);

    console.log('[apply-questions] text field', {
      index: i,
      question: question || '(empty)',
      alreadyFilled: Boolean(current),
    });

    if (current) continue;
    if (looksLikeCoverLetter(question)) continue;
    if (!question) {
      return { ok: false, reason: 'Found a text field but could not read its question' };
    }

    const resolved = await resolveQuestionAnswer({
      question,
      options: [],
      type: 'text',
      profile,
      dbPool,
      onPromptFallback,
    });

    if (resolved.error) {
      return { ok: false, reason: resolved.error.message };
    }

    let chosen = resolved.answer;
    if (!chosen) {
      const required = /required|\*/i.test(question);
      if (required) return { ok: false, reason: `Unanswered text: ${question}` };
      continue;
    }

    console.log('[apply-questions] writing text', chosen);
    await field.click();
    await field.fill(String(chosen));
  }

  return { ok: true };
}

async function fillCurrentStep(page, profile, { dbPool = null, onPromptFallback = null } = {}) {
  const resumeHeadingPresent = await isResumeCoverStep(page);
  console.log('[apply-questions] fillCurrentStep', { resumeHeadingPresent });

  const radioResult = await fillRadioGroups(page, profile, { dbPool, onPromptFallback });
  if (!radioResult.ok) return radioResult;

  const checkboxResult = await fillCheckboxGroups(page, profile, { dbPool, onPromptFallback });
  if (!checkboxResult.ok) return checkboxResult;

  if (resumeHeadingPresent) {
    console.log('[apply-questions] skipping text/cover fields on resume step');
    return { ok: true };
  }

  const textResult = await fillTextFields(page, profile, { dbPool, onPromptFallback });
  if (!textResult.ok) return textResult;

  return { ok: true };
}

async function isVisibleEnabled(locator) {
  if (await locator.count() === 0) return false;
  const button = locator.first();
  if (!await button.isVisible().catch(() => false)) return false;
  return button.isEnabled();
}

module.exports = {
  resolveQuestionAnswer,
  matchDynamicProfileColumn,
  fillCurrentStep,
  isVisibleEnabled,
  loadApplyProfile,
  ruleAnswer,
};
