const { createPool } = require('./azure');

function createApplyQueue(azure) {
  async function enqueueApplyJob({ clientId, telegramChatId, url, jobId = null, availableAt = new Date().toISOString() }) {
    let pool = null;
    try {
      pool = createPool();
    } catch {
      // Pool might not be initialized or available in test environments
    }

    if (pool && typeof pool.query === 'function') {
      try {
        const result = await pool.query(
          `INSERT INTO dice_apply_queue (
             client_id, telegram_chat_id, job_id, url, status, available_at
           )
           VALUES ($1, $2, $3, $4, 'queued', $5)
           ON CONFLICT (client_id, url) DO UPDATE SET
             status = CASE
               WHEN dice_apply_queue.status IN ('failed', 'cancelled') THEN 'queued'
               ELSE dice_apply_queue.status
             END,
             telegram_chat_id = CASE
               WHEN dice_apply_queue.status IN ('failed', 'cancelled') THEN EXCLUDED.telegram_chat_id
               ELSE dice_apply_queue.telegram_chat_id
             END,
             job_id = CASE
               WHEN dice_apply_queue.status IN ('failed', 'cancelled') THEN EXCLUDED.job_id
               ELSE dice_apply_queue.job_id
             END,
             available_at = CASE
               WHEN dice_apply_queue.status IN ('failed', 'cancelled') THEN EXCLUDED.available_at
               ELSE dice_apply_queue.available_at
             END,
             last_error = CASE
               WHEN dice_apply_queue.status IN ('failed', 'cancelled') THEN NULL
               ELSE dice_apply_queue.last_error
             END,
             worker_id = CASE
               WHEN dice_apply_queue.status IN ('failed', 'cancelled') THEN NULL
               ELSE dice_apply_queue.worker_id
             END,
             locked_at = CASE
               WHEN dice_apply_queue.status IN ('failed', 'cancelled') THEN NULL
               ELSE dice_apply_queue.locked_at
             END,
             started_at = CASE
               WHEN dice_apply_queue.status IN ('failed', 'cancelled') THEN NULL
               ELSE dice_apply_queue.started_at
             END,
             finished_at = CASE
               WHEN dice_apply_queue.status IN ('failed', 'cancelled') THEN NULL
               ELSE dice_apply_queue.finished_at
             END,
             attempts = CASE
               WHEN dice_apply_queue.status IN ('failed', 'cancelled') THEN 0
               ELSE dice_apply_queue.attempts
             END
           RETURNING id, status, created_at, (xmax = 0) AS inserted`,
          [clientId, telegramChatId, jobId, url, availableAt]
        );

        if (result.rows && result.rows.length > 0) {
          const row = result.rows[0];
          const wasInserted = Boolean(row.inserted);

          if (wasInserted) {
            return { row, created: true };
          }
          if (row.status === 'completed') {
            return { row, created: false, alreadyDone: true };
          }
          if (row.status === 'queued' && !wasInserted) {
            // Was failed/cancelled and re-queued by ON CONFLICT, OR was already queued
            return { row, created: true };
          }
          // Already running
          return { row, created: false };
        }
      } catch (err) {
        // If unique constraint is not yet present on DB, warn and fall back to query builder
        console.warn('[apply-queue] Atomic upsert fallback:', err.message);
      }
    }

    const { data: existing, error: existingError } = await azure
      .from('dice_apply_queue')
      .select('id, status')
      .eq('client_id', clientId)
      .eq('url', url)
      .maybeSingle();

    if (existingError) throw new Error(`Queue lookup failed: ${existingError.message}`);

    if (existing) {
      if (existing.status === 'queued' || existing.status === 'running') {
        return { row: existing, created: false };
      }
      if (existing.status === 'completed') {
        return { row: existing, created: false, alreadyDone: true };
      }
      // failed / cancelled → re-queue
      const { data, error } = await azure
        .from('dice_apply_queue')
        .update({
          status: 'queued',
          telegram_chat_id: telegramChatId,
          job_id: jobId,
          last_error: null,
          worker_id: null,
          locked_at: null,
          started_at: null,
          finished_at: null,
          available_at: availableAt,
          attempts: 0,
        })
        .eq('id', existing.id)
        .select('id, status, created_at')
        .single();
      if (error) throw new Error(`Could not re-queue job: ${error.message}`);
      return { row: data, created: true };
    }

    const { data, error } = await azure
      .from('dice_apply_queue')
      .insert({
        client_id: clientId,
        telegram_chat_id: telegramChatId,
        job_id: jobId,
        url,
        status: 'queued',
        available_at: availableAt,
      })
      .select('id, status, created_at')
      .single();

    if (error) throw new Error(`Could not enqueue job: ${error.message}`);
    return { row: data, created: true };
  }

  async function getQueuePosition(queueId) {
    const { data, error } = await azure.rpc('apply_queue_position', {
      p_job_id: queueId,
    });
    if (error) {
      console.error('apply_queue_position failed:', error.message);
      return null;
    }
    return data;
  }

  async function countQueuedAhead() {
    const { count, error } = await azure
      .from('dice_apply_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'queued');
    if (error) return null;
    return count;
  }

  async function claimNextJob(workerId) {
    const { data, error } = await azure.rpc('claim_apply_queue_job_ready', {
      p_worker_id: workerId,
      p_stale_minutes: 20,
    });
    if (error) throw new Error(`claim_apply_queue_job failed: ${error.message}`);
    if (!data || (Array.isArray(data) && data.length === 0)) return null;
    return Array.isArray(data) ? data[0] : data;
  }

  async function markCompleted(queueId) {
    const { error } = await azure
      .from('dice_apply_queue')
      .update({
        status: 'completed',
        finished_at: new Date().toISOString(),
        last_error: null,
        worker_id: null,
        locked_at: null,
      })
      .eq('id', queueId);
    if (error) console.error(`Failed to mark queue ${queueId} completed:`, error.message);
  }

  async function markFailedOrRetry(queueId, errorMessage, attempts, maxAttempts) {
    if (attempts < maxAttempts) {
      const { error } = await azure
        .from('dice_apply_queue')
        .update({
          status: 'queued',
          last_error: errorMessage,
          worker_id: null,
          locked_at: null,
          available_at: new Date().toISOString(),
        })
        .eq('id', queueId);
      if (error) console.error(`Failed to re-queue ${queueId}:`, error.message);
      return { retried: true };
    }

    const { error } = await azure
      .from('dice_apply_queue')
      .update({
        status: 'failed',
        last_error: errorMessage,
        finished_at: new Date().toISOString(),
        worker_id: null,
        locked_at: null,
      })
      .eq('id', queueId);
    if (error) console.error(`Failed to mark queue ${queueId} failed:`, error.message);
    return { retried: false };
  }

  async function markFailed(queueId, errorMessage) {
    const { error } = await azure
      .from('dice_apply_queue')
      .update({
        status: 'failed',
        last_error: errorMessage,
        finished_at: new Date().toISOString(),
        worker_id: null,
        locked_at: null,
      })
      .eq('id', queueId);
    if (error) console.error(`Failed to mark queue ${queueId} failed:`, error.message);
    return { retried: false };
  }

  async function hasActiveOrFinishedQueueItem(clientId, url) {
    const query = azure
      .from('dice_apply_queue')
      .select('id, status')
      .eq('client_id', clientId)
      .eq('url', url);

    let result;
    if (typeof query.limit === 'function') {
      result = await query.limit(1);
    } else if (typeof query.maybeSingle === 'function') {
      result = await query.maybeSingle();
    } else {
      result = await query;
    }

    const { data, error } = result || {};
    if (error) {
      console.error('Queue presence check failed:', error.message);
      return false;
    }
    const item = Array.isArray(data) ? data[0] : data;
    if (!item) return false;
    return ['queued', 'running', 'completed', 'failed'].includes(item.status);
  }

  async function hasActiveClientJob(clientId) {
    const query = azure
      .from('dice_apply_queue')
      .select('id, status')
      .eq('client_id', clientId)
      .in('status', ['queued', 'running']);

    let result;
    if (typeof query.limit === 'function') {
      result = await query.limit(1);
    } else if (typeof query.maybeSingle === 'function') {
      result = await query.maybeSingle();
    } else {
      result = await query;
    }

    const { data, error } = result || {};
    if (error) {
      console.error('Client active job check failed:', error.message);
      return false;
    }

    if (Array.isArray(data)) {
      return data.length > 0;
    }
    return Boolean(data);
  }

  async function clearStaleClientJobs(clientId) {
    return { retained: true, clientId };
  }

  return {
    enqueueApplyJob,
    getQueuePosition,
    countQueuedAhead,
    claimNextJob,
    markCompleted,
    markFailedOrRetry,
    markFailed,
    hasActiveOrFinishedQueueItem,
    hasActiveClientJob,
    clearStaleClientJobs,
  };
}

module.exports = {
  createApplyQueue,
};
