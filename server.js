const express = require('express');
const cors = require('cors');
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use((req, res, next) => {
  if (req.originalUrl === '/api/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});
app.use(express.static(__dirname));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const puppeteer = require('puppeteer');
const RENTCAST_API_KEY = process.env.RENTCAST_API_KEY;
const NON_DISCLOSURE_STATES = ['AK','ID','KS','LA','MS','MO','MT','NM','ND','SD','TX','UT','WY'];

function checkNonDisclosure(address) {
  const match = address.match(/\b([A-Z]{2})\b\s*\d{0,5}\s*$/i);
  if (!match) return null;
  const state = match[1].toUpperCase();
  return NON_DISCLOSURE_STATES.includes(state) ? state : null;
}
const REQUIRE_PAYMENT = process.env.REQUIRE_PAYMENT === 'true';
const REQUIRE_TOS_ACCEPTANCE = process.env.REQUIRE_TOS_ACCEPTANCE === 'true';


function analyzeDeal(inputs) {
  const price = inputs.price || 0;
  const downPct = inputs.downPct || 20;
  const rate = inputs.rate || 7;
  const termYears = inputs.termYears || 30;
  const closing = inputs.closing || 0;
  const rehab = inputs.rehab || 0;
  const rent = inputs.rent || 0;
  const vacancyPct = inputs.vacancyPct || 5;
  const annualTaxes = inputs.annualTaxes || 0;
  const annualInsurance = inputs.annualInsurance || 0;
  const hoaMonthly = inputs.hoaMonthly || 0;
  const mgmtPct = inputs.mgmtPct || 0;
  const maintPct = inputs.maintPct || 8;
  const sqft = inputs.sqft || 0;
  const comps = inputs.comps || [];

  const downPayment = price * (downPct / 100);
  const loanAmount = price - downPayment;
  const monthlyRate = (rate / 100) / 12;
  const n = termYears * 12;

  let monthlyPI = 0;
  if (loanAmount > 0 && n > 0) {
    if (monthlyRate === 0) {
      monthlyPI = loanAmount / n;
    } else {
      monthlyPI = loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, n)) /
                  (Math.pow(1 + monthlyRate, n) - 1);
    }
  }

  const vacancyLoss = rent * (vacancyPct / 100);
  const effectiveGrossIncomeMonthly = rent - vacancyLoss;

  const taxesMonthly = annualTaxes / 12;
  const insuranceMonthly = annualInsurance / 12;
  const mgmtFeeMonthly = rent * (mgmtPct / 100);
  const maintReserveMonthly = rent * (maintPct / 100);

  const operatingExpensesMonthly = taxesMonthly + insuranceMonthly + hoaMonthly +
                                    mgmtFeeMonthly + maintReserveMonthly;

  const noiMonthly = effectiveGrossIncomeMonthly - operatingExpensesMonthly;
  const noiAnnual = noiMonthly * 12;
  const capRate = price > 0 ? (noiAnnual / price) * 100 : 0;

  const cashFlowMonthly = noiMonthly - monthlyPI;
  const cashFlowAnnual = cashFlowMonthly * 12;

  const totalCashInvested = downPayment + closing + rehab;
  const cashOnCash = totalCashInvested > 0 ? (cashFlowAnnual / totalCashInvested) * 100 : 0;

  const annualDebtService = monthlyPI * 12;
  const dscr = annualDebtService > 0 ? noiAnnual / annualDebtService : null;

  const grossPotentialAnnual = rent * 12;
  const breakEvenOccupancy = grossPotentialAnnual > 0
    ? ((operatingExpensesMonthly * 12 + annualDebtService) / grossPotentialAnnual) * 100
    : 0;

  const validComps = comps.filter(c => c.price > 0 && c.sqft > 0);
  let estimatedValue = null, valueDeltaPct = null, avgCompPsf = null;
  if (validComps.length > 0 && sqft > 0) {
    const psfs = validComps.map(c => c.price / c.sqft);
    avgCompPsf = psfs.reduce((a, b) => a + b, 0) / psfs.length;
    estimatedValue = avgCompPsf * sqft;
    valueDeltaPct = ((price - estimatedValue) / estimatedValue) * 100;
  }

  const result = {
    downPayment, loanAmount, monthlyPI,
    effectiveGrossIncomeMonthly, operatingExpensesMonthly,
    noiMonthly, noiAnnual, capRate,
    cashFlowMonthly, cashFlowAnnual,
    totalCashInvested, cashOnCash,
    dscr, breakEvenOccupancy,
    estimatedValue, valueDeltaPct, avgCompPsf
  };

  // Safety net: convert any Infinity/-Infinity/NaN into null so the
  // frontend can display "—" instead of crashing
  Object.keys(result).forEach(key => {
    if (typeof result[key] === 'number' && !isFinite(result[key])) {
      result[key] = null;
    }
  });

  return result;
}
async function checkAnalysisAllowance(user_id) {
  if (!user_id) return { allowed: false, reason: 'Sign in required to run an analysis.' };

  let isSubscriber = false;
  if (REQUIRE_PAYMENT) {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('user_id', user_id)
      .eq('status', 'active')
      .maybeSingle();
    isSubscriber = !!sub;
  }

  if (isSubscriber) return { allowed: true, isSubscriber: true };

  const { data: usage } = await supabase
    .from('usage_tracking')
    .select('analysis_count')
    .eq('user_id', user_id)
    .maybeSingle();

  const used = usage?.analysis_count || 0;

  if (used >= ANALYSIS_FREE_LIMIT) {
    return { allowed: false, reason: `You've used your ${ANALYSIS_FREE_LIMIT} free analyses. Upgrade to Pro for unlimited.` };
  }

  return { allowed: true, isSubscriber: false, used };
}

async function incrementAnalysisCount(user_id, currentUsed) {
  await supabase
    .from('usage_tracking')
    .upsert([{ user_id, analysis_count: currentUsed + 1 }], { onConflict: 'user_id' });
}
function verdictFromMetrics(m) {
  let score = 0;
  if (m.cashFlowMonthly !== null && m.cashFlowMonthly > 0) score++; else score--;
  if (m.capRate !== null && m.capRate >= 6) score++; else if (m.capRate !== null && m.capRate < 4) score--;
  if (m.cashOnCash !== null && m.cashOnCash >= 8) score++; else if (m.cashOnCash !== null && m.cashOnCash < 4) score--;
  if (m.dscr !== null) {
    if (m.dscr >= 1.2) score++; else if (m.dscr < 1.0) score -= 2;
  }
  if (score >= 3) return { label: 'Clear to Proceed', cls: 'green' };
  if (score >= 0) return { label: 'Proceed with Caution', cls: 'amber' };
  return { label: 'Do Not Proceed', cls: 'red' };
}

app.post('/api/analyze', async (req, res) => {
  try {
    const inputs = req.body;
    const allowance = await checkAnalysisAllowance(inputs.user_id);
    if (!allowance.allowed) {
      return res.status(429).json({ error: allowance.reason });
    }

    const m = analyzeDeal(inputs);
    const verdict = verdictFromMetrics(m);

   const payload = {
      price: inputs.price,
      monthlyRent: inputs.rent,
      capRate: m.capRate !== null ? m.capRate.toFixed(2) + '%' : 'n/a',
      cashOnCashReturn: m.cashOnCash !== null ? m.cashOnCash.toFixed(2) + '%' : 'n/a',
      monthlyCashFlow: m.cashFlowMonthly !== null ? m.cashFlowMonthly.toFixed(0) : 'n/a',
      dscr: m.dscr !== null ? m.dscr.toFixed(2) : 'n/a (all cash or missing loan info)',
      vacancyAssumption: (inputs.vacancyPct || 5) + '%',
      valueVsComps: m.valueDeltaPct !== null ? m.valueDeltaPct.toFixed(1) + '%' : 'no comps provided',
      breakEvenOccupancy: m.breakEvenOccupancy !== null ? m.breakEvenOccupancy.toFixed(1) + '%' : 'n/a',
      ruleBasedVerdict: verdict.label,
      calculatedMaxOffer: inputs.maxOffer ? `$${inputs.maxOffer.toLocaleString()} (based on your target return)` : 'not calculated'
    };
    

    const systemPrompt = `You are a real estate investment analyst assistant. You will be given structured financial data for a rental property deal, already calculated. Write a clear, professional 120-170 word summary for an investor deciding whether to pursue this deal.

Your summary must:
1. Open with the headline verdict already provided (do not contradict or recalculate it) and briefly say why the numbers support it.
2. Reference the cap rate and cash-on-cash return specifically.
3. Flag any red flags explicitly: DSCR below 1.1, negative cash flow, purchase price notably above comps, high break-even occupancy.
4. If a calculated max offer is provided (not "not calculated"), explicitly compare the purchase price to that max offer and note whether the investor has room to negotiate or is already at/above their ceiling.
5. Note one or two sensitivities worth double-checking.
6. Do NOT recalculate or override any numbers provided.
7. Do NOT give legal, tax, or investment advice.
8. Keep tone direct and analytical. Output only the summary text, no preamble, no markdown formatting.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Deal data:\n${JSON.stringify(payload, null, 2)}` }]
    });

    const narrative = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    if (!allowance.isSubscriber) {
      await incrementAnalysisCount(inputs.user_id, allowance.used);
    }

    res.json({ metrics: m, verdict, narrative, remainingAnalyses: allowance.isSubscriber ? null : ANALYSIS_FREE_LIMIT - (allowance.used + 1) });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong analyzing this deal.' });
  }
});
// Save a deal
app.post('/api/deals', async (req, res) => {
  try {
    const { user_id, address, inputs, results, narrative } = req.body;

    const { data, error } = await supabase
      .from('deals')
      .insert([{ user_id, address, inputs, results, narrative }])
      .select();

    if (error) throw error;

    // Enforce a cap of 25 saved deals per user — delete oldest beyond that
    const { data: allDeals } = await supabase
      .from('deals')
      .select('id, created_at')
      .eq('user_id', user_id)
      .order('created_at', { ascending: false });

    if (allDeals && allDeals.length > 25) {
      const idsToDelete = allDeals.slice(25).map(d => d.id);
      await supabase.from('deals').delete().in('id', idsToDelete);
    }

    res.json({ success: true, deal: data[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save deal.' });
  }
});

// Load all saved deals (for now, all of them — we'll filter by user in Week 5)
app.get('/api/deals', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { user_id } = req.query;

    let query = supabase
      .from('deals')
      .select('*')
      .order('created_at', { ascending: false });

    if (user_id) {
      query = query.eq('user_id', user_id);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({ deals: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load deals.', details: err.message || err });
  }
});
// Create a Stripe Checkout session
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { user_id, user_email } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: user_email,
      client_reference_id: user_id,
      success_url: `${req.headers.origin}/?checkout=success`,
      cancel_url: `${req.headers.origin}/?checkout=cancelled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start checkout.' });
  }
});

// Let the frontend know whether payment is currently required
app.get('/api/payment-status', (req, res) => {
  res.json({ requirePayment: REQUIRE_PAYMENT });
});

app.get('/api/tos-status', async (req, res) => {
  const { user_id } = req.query;
  let alreadyAccepted = false;

  if (user_id) {
    const { data } = await supabase
      .from('usage_tracking')
      .select('tos_accepted')
      .eq('user_id', user_id)
      .maybeSingle();
    alreadyAccepted = data?.tos_accepted || false;
  }

  res.json({ requireTos: REQUIRE_TOS_ACCEPTANCE, alreadyAccepted });
});

app.post('/api/accept-tos', async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'Sign in required.' });

    const { data: existing } = await supabase
      .from('usage_tracking')
      .select('*')
      .eq('user_id', user_id)
      .maybeSingle();

    await supabase
      .from('usage_tracking')
      .upsert([{ ...(existing || { user_id }), tos_accepted: true }], { onConflict: 'user_id' });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save acceptance.' });
  }
});
// Check if a specific user has an active subscription
app.get('/api/subscription-status', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.json({ active: false });

    const { data, error } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('user_id', user_id)
      .eq('status', 'active')
      .maybeSingle();

    if (error) throw error;

    res.json({ active: !!data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ active: false });
  }
});
// Stripe webhook — listens for payment confirmations
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const user_id = session.client_reference_id;
    const customer_id = session.customer;

    try {
      const { data, error } = await supabase
        .from('subscriptions')
        .upsert([{ user_id, stripe_customer_id: customer_id, status: 'active' }], { onConflict: 'user_id' })
        .select();

      if (error) {
        console.error('Supabase upsert error:', error);
      } else {
        console.log('Supabase upsert result:', data);
      }
    } catch (err) {
      console.error('Failed to update subscription:', err);
    }
  }
 

  res.json({ received: true });
});
// Generate a branded PDF report for a deal
app.post('/api/generate-pdf', async (req, res) => {
  try {
    const { address, inputs, results, verdict, narrative, user_id } = req.body;

    if (!user_id) {
      return res.status(401).json({ error: 'Sign in required to download a PDF report.' });
    }

    if (REQUIRE_PAYMENT) {
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('status')
        .eq('user_id', user_id)
        .eq('status', 'active')
        .maybeSingle();

      if (!sub) {
        return res.status(402).json({ error: 'PDF export is a Pro feature. Upgrade to download reports.' });
      }
    }

    const html = `
      <html>
      <head>
        <style>
          body { font-family: Georgia, serif; color: #101B29; padding: 40px; }
          h1 { font-size: 22px; border-bottom: 3px solid #B8862B; padding-bottom: 10px; }
          .stamp { display:inline-block; border: 3px solid #4C8567; color:#4C8567; padding: 8px 18px; font-weight:bold; font-family: monospace; margin: 16px 0; }
          table { width: 100%; border-collapse: collapse; margin: 20px 0; }
          td { padding: 10px; border: 1px solid #ddd; font-family: monospace; }
          .narrative { background: #F5F0E6; border-left: 4px solid #B8862B; padding: 16px; margin-top: 20px; line-height:1.6; }
          .footer { margin-top: 40px; font-size: 11px; color: #888; }
        </style>
      </head>
      <body>
        <h1>Deal Analysis Report — ${address || 'Property'}</h1>
        <div class="stamp">${verdict?.label || ''}</div>
        <table>
          <tr><td>Monthly Cash Flow</td><td>$${results.cashFlowMonthly?.toFixed(0) ?? '—'}</td></tr>
          <tr><td>Cap Rate</td><td>${results.capRate?.toFixed(1) ?? '—'}%</td></tr>
          <tr><td>Cash-on-Cash Return</td><td>${results.cashOnCash?.toFixed(1) ?? '—'}%</td></tr>
          <tr><td>DSCR</td><td>${results.dscr?.toFixed(2) ?? '—'}</td></tr>
          <tr><td>Total Cash Invested</td><td>$${results.totalCashInvested?.toFixed(0) ?? '—'}</td></tr>
        </table>
        <div class="narrative">${narrative || ''}</div>
        <div class="footer">Generated by Deal Analyzer — for planning purposes only, not financial advice.</div>
      </body>
      </html>
    `;

    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html);
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename=deal-report.pdf'
    });
    res.send(pdfBuffer);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not generate PDF.' });
  }
});

// Look up comps and estimated value for an address using RentCast
const COMPS_FREE_LIMIT = 3;
const COMPS_SUBSCRIBER_MONTHLY_LIMIT = 50;
const ANALYSIS_FREE_LIMIT = 10;

app.get('/api/comps', async (req, res) => {
  try {
    const { address, user_id } = req.query;
    if (!address) return res.status(400).json({ error: 'Address is required.' });
    if (!user_id) return res.status(400).json({ error: 'Sign in required for comps lookup.' });

    const currentMonth = new Date().toISOString().slice(0, 7);

    const { data: usage } = await supabase
      .from('usage_tracking')
      .select('free_lookups_used, month, comps_count')
      .eq('user_id', user_id)
      .maybeSingle();

    const freeUsed = usage?.free_lookups_used || 0;
    const monthlyCount = (usage?.month === currentMonth) ? (usage?.comps_count || 0) : 0;

    let isSubscriber = false;
    if (REQUIRE_PAYMENT) {
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('status')
        .eq('user_id', user_id)
        .eq('status', 'active')
        .maybeSingle();
      isSubscriber = !!sub;
    }

    if (!isSubscriber && freeUsed >= COMPS_FREE_LIMIT) {
      return res.status(429).json({ error: `You've used your ${COMPS_FREE_LIMIT} free comps lookups. Upgrade to Pro for more.` });
    }
    if (isSubscriber && monthlyCount >= COMPS_SUBSCRIBER_MONTHLY_LIMIT) {
      return res.status(429).json({ error: `Monthly comps limit (${COMPS_SUBSCRIBER_MONTHLY_LIMIT}) reached. Resets next month.` });
    }

    const response = await fetch(
      `https://api.rentcast.io/v1/avm/value?address=${encodeURIComponent(address)}&compCount=3`,
      { headers: { 'X-Api-Key': RENTCAST_API_KEY } }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('RentCast error:', errText);
      return res.status(response.status).json({ error: 'Could not fetch comps for this address.' });
    }

    const data = await response.json();

    const comps = (data.comparables || []).slice(0, 3).map(c => ({
      price: c.price || 0,
      sqft: c.squareFootage || 0
    }));

    const nonDisclosureState = checkNonDisclosure(address);

    await supabase
      .from('usage_tracking')
      .upsert([{
        user_id,
        free_lookups_used: isSubscriber ? freeUsed : freeUsed + 1,
        month: currentMonth,
        comps_count: isSubscriber ? monthlyCount + 1 : monthlyCount
      }], { onConflict: 'user_id' });

    res.json({
      estimatedValue: data.price || null,
      sqft: data.subjectProperty?.squareFootage || null,
      comps,
      remainingLookups: isSubscriber
        ? COMPS_SUBSCRIBER_MONTHLY_LIMIT - (monthlyCount + 1)
        : COMPS_FREE_LIMIT - (freeUsed + 1),
      isSubscriber,
      nonDisclosureState
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Comps lookup failed.' });
  }
});
 function metricsAtPrice(price, base) {
  return analyzeDeal({ ...base, price });
}
app.post('/api/mao', (req, res) => {
  try {
   const { targetCashOnCash, targetDSCR, ...base } = req.body;

    if (!targetCashOnCash && !targetDSCR) {
      return res.status(400).json({ error: 'Provide at least a target cash-on-cash return or DSCR.' });
    }
    if (!base.rent || base.rent <= 0) {
      return res.status(400).json({ error: 'Enter monthly rent before calculating a max offer.' });
    }
    

    let low = 10000, high = 5000000;
    for (let i = 0; i < 40; i++) {
      const mid = (low + high) / 2;
      const m = metricsAtPrice(mid, base);

      const cocOk = !targetCashOnCash || (m.cashOnCash !== null && m.cashOnCash >= targetCashOnCash);
      const dscrOk = !targetDSCR || (m.dscr !== null && m.dscr >= targetDSCR);

      if (cocOk && dscrOk) {
        low = mid;
      } else {
        high = mid;
      }
    }

    const returnBasedMax = Math.round(low);
    const finalMetrics = metricsAtPrice(returnBasedMax, base);
    const marketValueEstimate = req.body.rentcastEstimatedValue || null;

    let trueMaxOffer = returnBasedMax;
    let bindingConstraint = 'return target';

    if (marketValueEstimate && marketValueEstimate < returnBasedMax) {
      trueMaxOffer = marketValueEstimate;
      bindingConstraint = 'comps / market value';
    }

    res.json({
      maxOffer: trueMaxOffer,
      returnBasedMax,
      marketValueEstimate,
      bindingConstraint,
      metricsAtMaxOffer: finalMetrics
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not calculate maximum offer.' });
  }
});
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});