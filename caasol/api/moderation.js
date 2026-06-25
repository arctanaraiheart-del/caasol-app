const { createHash } = require('node:crypto');

const allowedEntityTypes = new Set([
  'post',
  'post_comment',
  'board',
  'board_message'
]);

const APP_PAUSED = false;

function getConfig() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').trim();
  const secretKey = (process.env.SUPABASE_SECRET_KEY || '').trim();
  const adminKey = (process.env.ADMIN_MOD_KEY || '').trim();
  const reportAlertEmailTo = (process.env.REPORT_ALERT_EMAIL_TO || '').trim();
  const reportAlertEmailFrom = (process.env.REPORT_ALERT_EMAIL_FROM || '').trim();
  const resendApiKey = (process.env.RESEND_API_KEY || '').trim();
  const reportAlertThreshold = Math.max(1, Number(process.env.REPORT_ALERT_THRESHOLD || 3) || 3);

  if (!url || !secretKey) {
    throw new Error('Supabase is not configured in Vercel.');
  }

  return {
    url,
    secretKey,
    adminKey,
    reportAlertEmailTo,
    reportAlertEmailFrom,
    resendApiKey,
    reportAlertThreshold
  };
}

function sendError(res, status, message) {
  res.status(status).json({ error: { message } });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  return { response, data };
}

function getHeaders(secretKey) {
  return {
    apikey: secretKey,
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/json'
  };
}

function requireAdmin(req, res, adminKey) {
  const provided = String(req.headers['x-admin-key'] || '').trim();
  if (!adminKey || !provided || provided !== adminKey) {
    sendError(res, 403, 'Admin authentication failed.');
    return false;
  }
  return true;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function inferReporterKey(req, rawViewerId) {
  const viewerId = String(rawViewerId || '').trim();
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const source = viewerId || forwardedFor;

  if (!source) return '';

  return createHash('sha256').update(source).digest('hex').slice(0, 48);
}

function targetLabel(entityType) {
  switch (entityType) {
    case 'post':
      return 'Timeline post';
    case 'post_comment':
      return 'Comment';
    case 'board':
      return 'Board';
    case 'board_message':
      return 'Board message';
    default:
      return 'Post';
  }
}

function reportAlertsEnabled(config) {
  return Boolean(
    config.resendApiKey &&
    config.reportAlertEmailTo &&
    config.reportAlertEmailFrom
  );
}

async function sendReportAlertEmail(config, payload) {
  if (!reportAlertsEnabled(config)) {
    return { skipped: true };
  }

  const subject = `[CAASOL] ${payload.reporterCount} unique reports received`;
  const previewText = payload.preview ? payload.preview : 'No preview';
  const html = `
    <div style="font-family:Arial,'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif;line-height:1.7;color:#111827">
      <h2 style="margin:0 0 12px">CAASOL report alert</h2>
      <p style="margin:0 0 12px">This target has reached ${payload.reporterCount} unique reports.</p>
      <table style="border-collapse:collapse;margin:0 0 16px">
        <tr><td style="padding:4px 12px 4px 0"><strong>Target</strong></td><td style="padding:4px 0">${escapeHtml(targetLabel(payload.entityType))}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><strong>ID</strong></td><td style="padding:4px 0">${escapeHtml(payload.entityId)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><strong>Reports</strong></td><td style="padding:4px 0">${escapeHtml(String(payload.reporterCount))}</td></tr>
        <tr><td style="padding:4px 12px 4px 0"><strong>Time</strong></td><td style="padding:4px 0">${escapeHtml(payload.occurredAt)}</td></tr>
      </table>
      <div style="padding:12px 14px;border-radius:12px;background:#f3f4f6">
        <div style="font-size:12px;color:#6b7280;margin-bottom:6px">Preview</div>
        <div>${escapeHtml(previewText)}</div>
      </div>
    </div>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: config.reportAlertEmailFrom,
      to: [config.reportAlertEmailTo],
      subject,
      html
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error((data && data.message) || 'Failed to send email.');
  }

  return { emailId: data && data.id ? String(data.id) : '' };
}

async function fetchReportAlert(headers, config, entityType, entityId) {
  const { response, data } = await fetchJson(
    `${config.url}/rest/v1/report_alerts?select=id,notified_at,reporter_count,threshold_count,email_id&entity_type=eq.${encodeURIComponent(entityType)}&entity_id=eq.${encodeURIComponent(entityId)}&limit=1`,
    { headers }
  );

  if (!response.ok) {
    throw new Error(data.message || 'Failed to read report alerts.');
  }

  return Array.isArray(data) && data.length ? data[0] : null;
}

async function saveReportAlert(headers, config, payload) {
  const existing = await fetchReportAlert(headers, config, payload.entityType, payload.entityId);
  const body = {
    entity_type: payload.entityType,
    entity_id: payload.entityId,
    reporter_count: payload.reporterCount,
    threshold_count: payload.thresholdCount,
    last_report_at: payload.occurredAt
  };

  if (payload.notifiedAt) {
    body.notified_at = payload.notifiedAt;
    body.email_id = typeof payload.emailId === 'string'
      ? payload.emailId
      : (existing && existing.email_id) || '';
  }

  if (!existing) {
    const { response, data } = await fetchJson(`${config.url}/rest/v1/report_alerts`, {
      method: 'POST',
      headers: {
        ...headers,
        Prefer: 'return=representation'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(data.message || 'Failed to save report alert.');
    }

    return Array.isArray(data) ? data[0] : data;
  }

  const { response, data } = await fetchJson(
    `${config.url}/rest/v1/report_alerts?id=eq.${encodeURIComponent(existing.id)}`,
    {
      method: 'PATCH',
      headers: {
        ...headers,
        Prefer: 'return=representation'
      },
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    throw new Error(data.message || 'Failed to update report alert.');
  }

  return Array.isArray(data) ? data[0] : data;
}

async function maybeNotifyOnReport(req, headers, config, payload) {
  const reporterKey = inferReporterKey(req, payload.viewerId);
  if (!reporterKey) {
    return { reporterCount: 0, notified: false, alertsEnabled: reportAlertsEnabled(config) };
  }

  const { response, data } = await fetchJson(
    `${config.url}/rest/v1/reports?select=reporter_key&entity_type=eq.${encodeURIComponent(payload.entityType)}&entity_id=eq.${encodeURIComponent(payload.entityId)}&order=created_at.desc&limit=500`,
    { headers }
  );

  if (!response.ok) {
    throw new Error(data.message || 'Failed to count reports.');
  }

  const reporterCount = new Set(
    (Array.isArray(data) ? data : [])
      .map(item => String(item.reporter_key || '').trim())
      .filter(Boolean)
  ).size;

  if (!reportAlertsEnabled(config)) {
    return { reporterCount, notified: false, alertsEnabled: false };
  }

  const occurredAt = new Date().toISOString();
  const existingAlert = await fetchReportAlert(headers, config, payload.entityType, payload.entityId);

  if (
    reporterCount >= config.reportAlertThreshold &&
    !existingAlert?.notified_at &&
    reportAlertsEnabled(config)
  ) {
    const email = await sendReportAlertEmail(config, {
      entityType: payload.entityType,
      entityId: payload.entityId,
      preview: payload.preview,
      reporterCount,
      occurredAt
    });

    await saveReportAlert(headers, config, {
      entityType: payload.entityType,
      entityId: payload.entityId,
      reporterCount,
      thresholdCount: config.reportAlertThreshold,
      notifiedAt: occurredAt,
      emailId: email.emailId || '',
      occurredAt
    });

    return { reporterCount, notified: true, alertsEnabled: true };
  }

  await saveReportAlert(headers, config, {
    entityType: payload.entityType,
    entityId: payload.entityId,
    reporterCount,
    thresholdCount: config.reportAlertThreshold,
    notifiedAt: existingAlert && existingAlert.notified_at ? existingAlert.notified_at : null,
    emailId: existingAlert && existingAlert.email_id ? String(existingAlert.email_id) : undefined,
    occurredAt
  });

  return { reporterCount, notified: false, alertsEnabled: true };
}

function targetConfig(entityType) {
  switch (entityType) {
    case 'post':
      return { table: 'posts', column: 'hidden' };
    case 'post_comment':
      return { table: 'post_comments', column: 'hidden' };
    case 'board':
      return { table: 'boards', column: 'closed' };
    case 'board_message':
      return { table: 'board_messages', column: 'hidden' };
    default:
      return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (APP_PAUSED) {
    sendError(res, 503, 'The app is temporarily paused.');
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  let config;

  try {
    config = getConfig();
  } catch (error) {
    sendError(res, 500, error.message);
    return;
  }

  const headers = getHeaders(config.secretKey);
  const body = req.body || {};
  const action = typeof body.action === 'string' ? body.action : '';

  try {
    if (action === 'admin-check') {
      if (!requireAdmin(req, res, config.adminKey)) return;
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'report') {
      const entityType = typeof body.entityType === 'string' ? body.entityType : '';
      const entityId = String(body.entityId || '').trim();
      const preview = typeof body.preview === 'string' ? body.preview.trim().slice(0, 280) : '';
      const viewerId = String(body.viewerId || '').trim();
      const reason = typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim().slice(0, 200)
        : 'user-report';
      const reporterKey = inferReporterKey(req, viewerId);

      if (!allowedEntityTypes.has(entityType) || !entityId) {
        sendError(res, 400, 'Invalid report target.');
        return;
      }

      const { response, data } = await fetchJson(`${config.url}/rest/v1/reports`, {
        method: 'POST',
        headers: {
          ...headers,
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          entity_type: entityType,
          entity_id: entityId,
          reporter_key: reporterKey,
          reason,
          preview
        })
      });

      if (!response.ok) {
        sendError(res, response.status, data.message || 'Failed to save report.');
        return;
      }

      const notification = await maybeNotifyOnReport(req, headers, config, {
        entityType,
        entityId,
        preview,
        viewerId
      });

      res.status(201).json({
        ok: true,
        reporterCount: notification.reporterCount,
        notified: notification.notified,
        alertsEnabled: notification.alertsEnabled
      });
      return;
    }

    if (action === 'moderate') {
      if (!requireAdmin(req, res, config.adminKey)) return;

      const entityType = typeof body.entityType === 'string' ? body.entityType : '';
      const entityId = String(body.entityId || '').trim();
      const configForTarget = targetConfig(entityType);

      if (!configForTarget || !entityId) {
        sendError(res, 400, 'Invalid moderation target.');
        return;
      }

      const { response, data } = await fetchJson(
        `${config.url}/rest/v1/${configForTarget.table}?id=eq.${encodeURIComponent(entityId)}`,
        {
          method: 'PATCH',
          headers: {
            ...headers,
            Prefer: 'return=representation'
          },
          body: JSON.stringify({
            [configForTarget.column]: true
          })
        }
      );

      if (!response.ok) {
        sendError(res, response.status, data.message || 'Failed to moderate target.');
        return;
      }

      res.status(200).json({ ok: true, item: Array.isArray(data) ? data[0] : null });
      return;
    }

    sendError(res, 400, 'Invalid action.');
  } catch (error) {
    sendError(res, 500, 'Server error while handling moderation.');
  }
};
