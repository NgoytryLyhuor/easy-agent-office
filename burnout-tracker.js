// Modulo Burnout Tracker & Predictive Quota Engine (Innovazione #3)
// Calcolo matematico predittivo del burn-rate orario, Time-To-Exhaustion (TTE) e prevenzione burnout.
const fs = require('fs');
const path = require('path');

const MAX_SAMPLES = 60; // Ring buffer circolare: max 60 campioni (~8 minuti a 8s di intervallo)
const CONFIDENCE_MIN_TIME_MS = 3 * 60 * 1000; // 3 minuti per considerare la stima affidabile
const CONFIDENCE_MIN_SAMPLES = 8; // Almeno 8 campioni per affidabilità

let sampleHistory = [];

/**
 * Normalizza una percentuale o frazione in un numero float compreso tra 0.0 e 1.0
 */
function parseQuotaFraction(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') {
    if (Number.isNaN(val) || !Number.isFinite(val)) return 0;
    if (val > 1) return Math.min(1, Math.max(0, val / 100));
    return Math.min(1, Math.max(0, val));
  }
  const str = String(val).replace('%', '').trim();
  const num = parseFloat(str);
  if (Number.isNaN(num) || !Number.isFinite(num)) return 0;
  if (num > 1) return Math.min(1, Math.max(0, num / 100));
  return Math.min(1, Math.max(0, num));
}

/**
 * Registra un nuovo campione di quota nel ring buffer
 */
function recordQuotaSample(quotaData = {}, customTimestamp = null) {
  const now = typeof customTimestamp === 'number' ? customTimestamp : Date.now();

  const g5h = parseQuotaFraction(quotaData.gemini?.fiveHourFraction ?? quotaData.g5h);
  const gWeekly = parseQuotaFraction(quotaData.gemini?.weeklyFraction ?? quotaData.gWeekly);
  const c5h = parseQuotaFraction(quotaData.claude?.fiveHourFraction ?? quotaData.c5h);
  const cWeekly = parseQuotaFraction(quotaData.claude?.weeklyFraction ?? quotaData.cWeekly);

  const sample = {
    timestamp: now,
    g5h,
    gWeekly,
    c5h,
    cWeekly
  };

  sampleHistory.push(sample);

  // Mantieni il tetto rigido MAX_SAMPLES (FIFO O(1) con shift)
  if (sampleHistory.length > MAX_SAMPLES) {
    sampleHistory.shift();
  }

  return getPredictiveBurnout(now);
}

/**
 * Calcola l'orario formattato HH:MM a partire da minuti residui
 */
function formatExhaustionTime(nowMs, minutesRemaining) {
  if (minutesRemaining === null || minutesRemaining === undefined || !Number.isFinite(minutesRemaining) || minutesRemaining < 0) {
    return null;
  }
  const targetDate = new Date(nowMs + (minutesRemaining * 60 * 1000));
  const hh = String(targetDate.getHours()).padStart(2, '0');
  const mm = String(targetDate.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Calcola il burn-rate e il Time-To-Exhaustion (TTE) matematico
 */
function getPredictiveBurnout(customNow = null) {
  const now = typeof customNow === 'number' ? customNow : Date.now();
  const n = sampleHistory.length;

  // Stato iniziale nominale se campioni insufficienti
  if (n < 2) {
    const curG = n === 1 ? sampleHistory[0].g5h : 1.0;
    const curC = n === 1 ? sampleHistory[0].c5h : 1.0;
    return {
      burnRateHourly: { gemini: 0, claude: 0 },
      burnRatePercentPerHour: { gemini: '0.00%', claude: '0.00%' },
      estimatedMinutesRemaining: { gemini: null, claude: null },
      projectedExhaustionTime: { gemini: null, claude: null },
      status: curG < 0.15 ? 'critical' : 'optimal',
      confidence: 'calcolo in corso',
      sampleCount: n,
      currentQuota: {
        gemini5h: curG,
        geminiWeekly: n === 1 ? sampleHistory[0].gWeekly : 1.0,
        claude5h: curC,
        claudeWeekly: n === 1 ? sampleHistory[0].cWeekly : 1.0
      },
      updatedAt: new Date(now).toISOString()
    };
  }

  const s0 = sampleHistory[0];
  const sLast = sampleHistory[n - 1];
  const deltaMs = sLast.timestamp - s0.timestamp;

  // Floating-point guard su delta temporale nullo o non valido
  if (deltaMs <= 0 || !Number.isFinite(deltaMs)) {
    return {
      burnRateHourly: { gemini: 0, claude: 0 },
      burnRatePercentPerHour: { gemini: '0.00%', claude: '0.00%' },
      estimatedMinutesRemaining: { gemini: null, claude: null },
      projectedExhaustionTime: { gemini: null, claude: null },
      status: 'optimal',
      confidence: 'calcolo in corso',
      sampleCount: n,
      currentQuota: {
        gemini5h: sLast.g5h,
        geminiWeekly: sLast.gWeekly,
        claude5h: sLast.c5h,
        claudeWeekly: sLast.cWeekly
      },
      updatedAt: new Date(now).toISOString()
    };
  }

  // Delta consumo (quota iniziale - quota attuale)
  const deltaGemini = s0.g5h - sLast.g5h;
  const deltaClaude = s0.c5h - sLast.c5h;

  // Se delta <= 0 (nessun consumo o ricarica quota): burnRate = 0
  let burnRateGemini = 0;
  if (deltaGemini > 0) {
    const rawRateG = (deltaGemini / deltaMs) * 3600000; // Quota consumata per ora (0.0 -> 1.0)
    burnRateGemini = (Number.isFinite(rawRateG) && rawRateG > 0) ? Number(rawRateG.toFixed(4)) : 0;
  }

  let burnRateClaude = 0;
  if (deltaClaude > 0) {
    const rawRateC = (deltaClaude / deltaMs) * 3600000;
    burnRateClaude = (Number.isFinite(rawRateC) && rawRateC > 0) ? Number(rawRateC.toFixed(4)) : 0;
  }

  // Calcolo Time-To-Exhaustion (TTE in minuti)
  let tteGemini = null;
  if (burnRateGemini > 0) {
    const ratePerMinute = burnRateGemini / 60;
    if (ratePerMinute > 0) {
      const minutes = Math.round(sLast.g5h / ratePerMinute);
      if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 10080) { // Max 7 giorni
        tteGemini = minutes;
      }
    }
  }

  let tteClaude = null;
  if (burnRateClaude > 0) {
    const ratePerMinute = burnRateClaude / 60;
    if (ratePerMinute > 0) {
      const minutes = Math.round(sLast.c5h / ratePerMinute);
      if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 10080) {
        tteClaude = minutes;
      }
    }
  }

  // Orari proiettati di esaurimento
  const projectedGemini = formatExhaustionTime(sLast.timestamp, tteGemini);
  const projectedClaude = formatExhaustionTime(sLast.timestamp, tteClaude);

  // Livello di confidenza
  const isReliable = (deltaMs >= CONFIDENCE_MIN_TIME_MS) && (n >= CONFIDENCE_MIN_SAMPLES);
  const confidence = isReliable ? 'stima affidabile' : 'calcolo in corso';

  // Valutazione Status: 'burnout_imminent' | 'critical' | 'moderate' | 'optimal'
  let status = 'optimal';
  const curG = sLast.g5h;

  if ((tteGemini !== null && tteGemini <= 20) || (curG < 0.10 && burnRateGemini > 0)) {
    status = 'burnout_imminent';
  } else if ((tteGemini !== null && tteGemini <= 60) || (curG < 0.25)) {
    status = 'critical';
  } else if ((tteGemini !== null && tteGemini <= 120) || (curG < 0.50)) {
    status = 'moderate';
  } else {
    status = 'optimal';
  }

  return {
    burnRateHourly: {
      gemini: burnRateGemini,
      claude: burnRateClaude
    },
    burnRatePercentPerHour: {
      gemini: `${(burnRateGemini * 100).toFixed(2)}%`,
      claude: `${(burnRateClaude * 100).toFixed(2)}%`
    },
    estimatedMinutesRemaining: {
      gemini: tteGemini,
      claude: tteClaude
    },
    projectedExhaustionTime: {
      gemini: projectedGemini,
      claude: projectedClaude
    },
    status,
    confidence,
    sampleCount: n,
    deltaWindowSeconds: Math.round(deltaMs / 1000),
    currentQuota: {
      gemini5h: curG,
      geminiWeekly: sLast.gWeekly,
      claude5h: sLast.c5h,
      claudeWeekly: sLast.cWeekly
    },
    updatedAt: new Date(now).toISOString()
  };
}

/**
 * Resetta la cronologia dei campioni (utile per test o cambio sessione)
 */
function resetBurnoutHistory() {
  sampleHistory = [];
}

/**
 * Restituisce i campioni attuali in sola lettura
 */
function getSampleHistory() {
  return [...sampleHistory];
}

module.exports = {
  recordQuotaSample,
  getPredictiveBurnout,
  resetBurnoutHistory,
  getSampleHistory,
  parseQuotaFraction,
  formatExhaustionTime,
  MAX_SAMPLES,
  CONFIDENCE_MIN_TIME_MS,
  CONFIDENCE_MIN_SAMPLES
};
