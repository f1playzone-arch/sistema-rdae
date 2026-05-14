import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();

const PORT = process.env.PORT || 4000;
const RDAE_API_KEY = process.env.RDAE_API_KEY || '';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const REMOTE_DASHBOARD_PASSWORD = process.env.REMOTE_DASHBOARD_PASSWORD || '';
const REMOTE_DASHBOARD_TOKEN_SECRET =
  process.env.REMOTE_DASHBOARD_TOKEN_SECRET || '';

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function base64UrlEncode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function base64UrlDecode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function createRemoteToken(payload) {
  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const body = {
    ...payload,
    exp: Date.now() + 1000 * 60 * 60 * 12,
  };

  const encodedHeader = base64UrlEncode(header);
  const encodedBody = base64UrlEncode(body);

  const signature = crypto
    .createHmac('sha256', REMOTE_DASHBOARD_TOKEN_SECRET)
    .update(`${encodedHeader}.${encodedBody}`)
    .digest('base64url');

  return `${encodedHeader}.${encodedBody}.${signature}`;
}

function verifyRemoteToken(token) {
  if (!REMOTE_DASHBOARD_TOKEN_SECRET) {
    return null;
  }

  const parts = String(token || '').split('.');

  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedBody, signature] = parts;

  const expectedSignature = crypto
    .createHmac('sha256', REMOTE_DASHBOARD_TOKEN_SECRET)
    .update(`${encodedHeader}.${encodedBody}`)
    .digest('base64url');

  if (signature !== expectedSignature) {
    return null;
  }

  try {
    const payload = base64UrlDecode(encodedBody);

    if (!payload.exp || Date.now() > payload.exp) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function requireApiKey(req, res, next) {
  if (!RDAE_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'RDAE_API_KEY não configurada na API remota.',
    });
  }

  const authorization = req.headers.authorization || '';
  const token = authorization.replace('Bearer ', '').trim();

  if (token !== RDAE_API_KEY) {
    return res.status(401).json({
      ok: false,
      error: 'Acesso não autorizado.',
    });
  }

  next();
}

function requireRemoteDashboardAuth(req, res, next) {
  const authorization = req.headers.authorization || '';
  const token = authorization.replace('Bearer ', '').trim();

  const payload = verifyRemoteToken(token);

  if (!payload) {
    return res.status(401).json({
      ok: false,
      error: 'Sessão remota inválida ou expirada.',
    });
  }

  req.remoteUser = payload;
  next();
}

function requireDatabase(req, res, next) {
  if (!supabase) {
    return res.status(500).json({
      ok: false,
      error:
        'Supabase não configurado. Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.',
    });
  }

  next();
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'API remota Sabores da Ilha online',
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'API remota Sabores da Ilha funcionando',
    now: new Date().toISOString(),
    databaseConfigured: Boolean(supabase),
  });
});

app.post('/api/remote-login', (req, res) => {
  const { password } = req.body || {};

  if (!REMOTE_DASHBOARD_PASSWORD || !REMOTE_DASHBOARD_TOKEN_SECRET) {
    return res.status(500).json({
      ok: false,
      error:
        'Login remoto não configurado. Configure REMOTE_DASHBOARD_PASSWORD e REMOTE_DASHBOARD_TOKEN_SECRET.',
    });
  }

  if (password !== REMOTE_DASHBOARD_PASSWORD) {
    return res.status(401).json({
      ok: false,
      error: 'Senha inválida.',
    });
  }

  const token = createRemoteToken({
    role: 'remote-dashboard',
    restaurantId: 'restaurante-da-edilma',
  });

  return res.json({
    ok: true,
    token,
    expiresInHours: 12,
  });
});

app.post('/api/closed-reports', requireApiKey, requireDatabase, async (req, res) => {
  try {
    const report = req.body;

    if (!report.restaurantId) {
      return res.status(400).json({
        ok: false,
        error: 'restaurantId é obrigatório.',
      });
    }

    if (!report.reportId) {
      return res.status(400).json({
        ok: false,
        error: 'reportId é obrigatório.',
      });
    }

    if (!report.date) {
      return res.status(400).json({
        ok: false,
        error: 'date é obrigatório.',
      });
    }

    const payload = {
      restaurant_id: report.restaurantId,
      local_report_id: String(report.reportId),
      report_date: report.date,
      report_month: Number(report.month || 0),
      report_year: Number(report.year || 0),

      revenue_total: Number(report.revenueTotal || 0),
      expenses_total: Number(report.expensesTotal || 0),
      estimated_profit: Number(report.estimatedProfit || 0),

      table_revenue: Number(report.tableRevenue || 0),
      quick_revenue: Number(report.quickRevenue || 0),
      total_sales_count: Number(report.totalSalesCount || 0),

      payment_summary: report.paymentSummary || {},
      sales: report.sales || [],
      expenses: report.expenses || [],

      notes: report.notes || '',
      closed_by: report.closedBy || 'Sistema',
      closed_at: report.closedAt || new Date().toISOString(),

      source: report.source || 'rdae-local',
      local_created_at:
        report.localCreatedAt || report.closedAt || new Date().toISOString(),
      local_updated_at: report.localUpdatedAt || new Date().toISOString(),

      synced_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('closed_reports')
      .upsert(payload, {
        onConflict: 'restaurant_id,local_report_id',
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }

    return res.json({
      ok: true,
      message: 'Relatório salvo na API remota.',
      id: data.id,
      remoteId: data.id,
      syncedAt: data.synced_at,
      data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'Erro desconhecido ao salvar relatório.',
    });
  }
});

app.get('/api/closed-reports', requireApiKey, requireDatabase, async (req, res) => {
  try {
    const restaurantId = String(req.query.restaurantId || '');

    if (!restaurantId) {
      return res.status(400).json({
        ok: false,
        error: 'restaurantId é obrigatório.',
      });
    }

    const { data, error } = await supabase
      .from('closed_reports')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('report_date', { ascending: false });

    if (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
      });
    }

    return res.json({
      ok: true,
      reports: data || [],
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'Erro desconhecido ao buscar relatórios.',
    });
  }
});

app.get(
  '/api/remote/closed-reports',
  requireRemoteDashboardAuth,
  requireDatabase,
  async (req, res) => {
    try {
      const restaurantId = String(
        req.query.restaurantId ||
          req.remoteUser?.restaurantId ||
          'restaurante-da-edilma'
      );

      const { data, error } = await supabase
        .from('closed_reports')
        .select('*')
        .eq('restaurant_id', restaurantId)
        .order('report_date', { ascending: false });

      if (error) {
        return res.status(500).json({
          ok: false,
          error: error.message,
        });
      }

      return res.json({
        ok: true,
        reports: data || [],
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Erro desconhecido ao buscar relatórios remotos.',
      });
    }
  }
);

app.listen(PORT, () => {
  console.log('');
  console.log('==========================================');
  console.log(' API remota Sabores da Ilha iniciada');
  console.log('==========================================');
  console.log(` Porta: ${PORT}`);
  console.log(` Health: http://localhost:${PORT}/api/health`);
  console.log('==========================================');
  console.log('');
});