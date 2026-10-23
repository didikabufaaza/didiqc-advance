// ============================================================
// stats-engine.ts — Mesin Statistik Deskriptif & Robust (ISO 13528:2022)
//
// Menerapkan:
//   1. Statistik Deskriptif Klasik (Mean, Median, SD, CV%, IQR, MAD)
//   2. Statistik Robust Algorithm A (ISO 13528:2022 Annex C.3)
//   3. Ketidakpastian Nilai Konsensus u(x*) (ISO 13528:2022 Clause 7.7.3)
//   4. Perhitungan Z-Score Formal PME vs Skor Relatif Peer Group
//   5. Evaluasi Sigma Metrik Laboratorium Medis (TEa, Bias%, CV%)
//
// Murni perhitungan matematis & analitik tanpa ketergantungan vendor DB.
// ============================================================

export interface DescriptiveStats {
  n: number;
  mean: number | null;
  median: number | null;
  sd: number | null;
  cv: number | null;
  min: number | null;
  max: number | null;
  range: number | null;
  q1: number | null;
  q3: number | null;
  iqr: number | null;
  mad: number | null;
  niqr: number | null;
}

export interface RobustStats {
  robustMean: number | null;
  robustSd: number | null;
  iterations: number;
  converged: boolean;
  uncertainty: number | null; // u(x*)
  statStatus: "valid" | "warning_n_small" | "invalid";
  notes: string;
}

export interface PeerGroupStatsResult {
  descriptive: DescriptiveStats;
  robust: RobustStats;
  targetValue: number | null;
  targetSource: string;
  sdpaValue: number | null;
  sdpaSource: string;
  isFormalPmeApplicable: boolean;
}

export interface ParticipantEvaluation {
  hospitalUsername: string;
  hospitalName: string;
  originalValue: number | null;
  usedValue: number | null;
  diffTarget: number | null;
  zScore: number | null; // Formal Z-score
  zScoreAbs: number | null;
  peerRelativeScore: number | null; // Relative score vs robust stats
  peerRelativeAbs: number | null;
  evalCategory: "memuaskan" | "peringatan" | "tindakan_korektif" | "belum_dapat_dievaluasi";
  biasAbs: number | null;
  biasPct: number | null;
  cvLab: number | null;
  tea: number | null;
  teaSource: string | null;
  sigma: number | null;
  sigmaCategory: string;
  isValid: boolean;
  validationStatus: "valid" | "review" | "excluded";
  exclusionReason: string | null;
  recommendation: string;
}

// ------------------------------------------------------------
// Helper: Sorting & Quantile (Linear Interpolation)
// ------------------------------------------------------------
function sortAsc(arr: number[]): number[] {
  return [...arr].sort((a, b) => a - b);
}

export function computeQuantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

export function computeMedian(arr: number[]): number | null {
  if (!arr.length) return null;
  const sorted = sortAsc(arr);
  return computeQuantile(sorted, 0.5);
}

// ------------------------------------------------------------
// 1. STATISTIK DESKRIPTIF KLASIK
// ------------------------------------------------------------
export function computeDescriptiveStats(values: number[]): DescriptiveStats {
  const clean = values.filter((v) => typeof v === "number" && !isNaN(v) && isFinite(v));
  const n = clean.length;
  if (n === 0) {
    return {
      n: 0,
      mean: null,
      median: null,
      sd: null,
      cv: null,
      min: null,
      max: null,
      range: null,
      q1: null,
      q3: null,
      iqr: null,
      mad: null,
      niqr: null,
    };
  }

  const sorted = sortAsc(clean);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const range = max - min;

  const sum = clean.reduce((acc, v) => acc + v, 0);
  const mean = sum / n;

  const median = computeQuantile(sorted, 0.5);
  const q1 = computeQuantile(sorted, 0.25);
  const q3 = computeQuantile(sorted, 0.75);
  const iqr = q1 !== null && q3 !== null ? q3 - q1 : null;
  const niqr = iqr !== null ? 0.7413 * iqr : null;

  // Sample SD (n - 1)
  let sd: number | null = null;
  let cv: number | null = null;
  if (n > 1) {
    const variance = clean.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (n - 1);
    sd = Math.sqrt(variance);
    if (mean !== 0) {
      cv = (sd / Math.abs(mean)) * 100;
    }
  }

  // Median Absolute Deviation (MAD)
  let mad: number | null = null;
  if (median !== null) {
    const absDiffs = clean.map((v) => Math.abs(v - median));
    mad = computeMedian(absDiffs);
  }

  return {
    n,
    mean: mean !== null ? round(mean, 4) : null,
    median: median !== null ? round(median, 4) : null,
    sd: sd !== null ? round(sd, 4) : null,
    cv: cv !== null ? round(cv, 2) : null,
    min: min !== null ? round(min, 4) : null,
    max: max !== null ? round(max, 4) : null,
    range: range !== null ? round(range, 4) : null,
    q1: q1 !== null ? round(q1, 4) : null,
    q3: q3 !== null ? round(q3, 4) : null,
    iqr: iqr !== null ? round(iqr, 4) : null,
    mad: mad !== null ? round(mad, 4) : null,
    niqr: niqr !== null ? round(niqr, 4) : null,
  };
}

// ------------------------------------------------------------
// 2. STATISTIK ROBUST ALGORITHM A (ISO 13528:2022 Annex C.3)
// ------------------------------------------------------------
export function computeAlgorithmA(
  values: number[],
  maxIterations = 50,
  tol = 1e-6
): RobustStats {
  const clean = values.filter((v) => typeof v === "number" && !isNaN(v) && isFinite(v));
  const p = clean.length;

  if (p < 2) {
    return {
      robustMean: p === 1 ? clean[0] : null,
      robustSd: null,
      iterations: 0,
      converged: false,
      uncertainty: null,
      statStatus: "invalid",
      notes: "Jumlah data tidak memadai (n < 2). Algorithm A membutuhkan minimal 2 peserta.",
    };
  }

  // Inisialisasi awal x* dan s* (ISO 13528:2022 C.3.1)
  let xStar = computeMedian(clean)!;
  const absDevs = clean.map((x) => Math.abs(x - xStar));
  let sStar = 1.4826 * (computeMedian(absDevs) || 0);

  // Jika s* awal = 0 (misal banyak nilai identik), gunakan nIQR atau SD biasa sebagai fallback
  if (sStar === 0) {
    const desc = computeDescriptiveStats(clean);
    sStar = desc.niqr || desc.sd || 0;
  }

  // Jika seluruh data seragam sempurna (variansi 0)
  if (sStar === 0) {
    return {
      robustMean: round(xStar, 4),
      robustSd: 0,
      iterations: 0,
      converged: true,
      uncertainty: 0,
      statStatus: p >= 5 ? "valid" : "warning_n_small",
      notes: "Seluruh data peserta identik (variansi nol).",
    };
  }

  let iter = 0;
  let converged = false;

  for (iter = 1; iter <= maxIterations; iter++) {
    const delta = 1.5 * sStar;
    // Winsorization
    const xTransformed = clean.map((x) => {
      if (x < xStar - delta) return xStar - delta;
      if (x > xStar + delta) return xStar + delta;
      return x;
    });

    const sumX = xTransformed.reduce((acc, x) => acc + x, 0);
    const newXStar = sumX / p;

    const sumSq = xTransformed.reduce((acc, x) => acc + Math.pow(x - newXStar, 2), 0);
    const newSStar = 1.134 * Math.sqrt(sumSq / (p - 1));

    // Cek konvergensi
    const diffX = Math.abs(newXStar - xStar);
    const diffS = Math.abs(newSStar - sStar);
    const scale = sStar > 0 ? sStar : 1;

    xStar = newXStar;
    sStar = newSStar;

    if (diffX < tol * scale && diffS < tol * scale) {
      converged = true;
      break;
    }
  }

  // Ketidakpastian nilai konsensus u(x*) = 1.25 * (s* / sqrt(p)) (ISO 13528:2022 formula 16)
  const uncertainty = sStar !== null ? 1.25 * (sStar / Math.sqrt(p)) : null;

  let statStatus: "valid" | "warning_n_small" | "invalid" = "valid";
  let notes = `Algorithm A konvergen dalam ${iter} iterasi.`;

  if (p < 5) {
    statStatus = "warning_n_small";
    notes = `Peringatan: Jumlah peserta kecil (n = ${p} < 5). Ketidakpastian konsensus dapat menjadi signifikan.`;
  } else if (p < 10) {
    notes += ` Jumlah peserta (n = ${p}) cukup untuk evaluasi peer group internal.`;
  } else {
    notes += ` Jumlah peserta memadai (n = ${p}).`;
  }

  if (!converged) {
    notes += ` Iterasi mencapai batas maksimum (${maxIterations}) sebelum konvergen penuh.`;
  }

  return {
    robustMean: round(xStar, 4),
    robustSd: round(sStar, 4),
    iterations: iter,
    converged,
    uncertainty: uncertainty !== null ? round(uncertainty, 4) : null,
    statStatus,
    notes,
  };
}

// ------------------------------------------------------------
// 3. EVALUASI INDIVIDUAL: Z-SCORE FORMAL, SKOR RELATIF, & SIGMA
// ------------------------------------------------------------
export function evaluateParticipants(params: {
  participants: Array<{
    hospitalUsername: string;
    hospitalName: string;
    usedValue: number | null;
    originalValue?: number | null;
    unit?: string | null;
    analyzer?: string | null;
    method?: string | null;
    controlLot?: string | null;
    reagentLot?: string | null;
    sourceCount?: number;
    date?: string | null;
    validationStatus?: "valid" | "review" | "excluded";
    exclusionReason?: string | null;
    cvLab?: number | null; // Dari riwayat IQC aktual laboratorium
    tea?: number | null;
    teaSource?: string | null;
  }>;
  targetValue: number | null;
  targetSource: string;
  sdpaValue: number | null;
  sdpaSource: string;
  isFormalPme: boolean;
  robustMean: number | null;
  robustSd: number | null;
}): ParticipantEvaluation[] {
  const {
    participants,
    targetValue,
    sdpaValue,
    isFormalPme,
    robustMean,
    robustSd,
  } = params;

  return participants.map((p) => {
    const val = p.usedValue;
    const isExcluded = p.validationStatus === "excluded";
    const isValidVal = typeof val === "number" && !isNaN(val) && isFinite(val) && !isExcluded;

    let diffTarget: number | null = null;
    let zScore: number | null = null;
    let zScoreAbs: number | null = null;
    let peerRelativeScore: number | null = null;
    let peerRelativeAbs: number | null = null;
    let evalCategory: "memuaskan" | "peringatan" | "tindakan_korektif" | "belum_dapat_dievaluasi" =
      "belum_dapat_dievaluasi";
    let recommendation = "";

    // 1. Skor Relatif Peer Group: (val - robustMean) / robustSd
    if (isValidVal && robustMean !== null && robustSd !== null && robustSd > 0) {
      const relScore = (val! - robustMean) / robustSd;
      peerRelativeScore = round(relScore, 2);
      peerRelativeAbs = round(Math.abs(relScore), 2);
    }

    // 2. Z-Score Formal PME: (val - Target) / SDPA (HANYA jika formal PME memenuhi syarat)
    if (isValidVal && isFormalPme && targetValue !== null && sdpaValue !== null && sdpaValue > 0) {
      diffTarget = round(val! - targetValue, 4);
      const z = (val! - targetValue) / sdpaValue;
      zScore = round(z, 2);
      zScoreAbs = round(Math.abs(z), 2);
    }

    // Skor rujukan untuk kategori evaluasi: utamakan Z-Score formal jika ada, jika tidak pakai Skor Relatif
    const primaryScore = zScoreAbs !== null ? zScoreAbs : peerRelativeAbs;

    if (isValidVal && primaryScore !== null) {
      if (primaryScore <= 2.0) {
        evalCategory = "memuaskan";
        recommendation = "Hasil mutu memuaskan. Pertahankan kendali proses IQC dan pemeliharaan alat.";
      } else if (primaryScore < 3.0) {
        evalCategory = "peringatan";
        recommendation =
          "Hasil dalam zona peringatan (2.0 < |Z| < 3.0). Periksa tren grafik Levey-Jennings, kalibrasi, dan lakukan re-run kontrol.";
      } else {
        evalCategory = "tindakan_korektif";
        recommendation =
          "Hasil di luar batas toleransi (|Z| >= 3.0). Wajib dilakukan investigasi segera: periksa reagen, kondisi alat, re-kalibrasi, dan tindakan korektif.";
      }
    } else if (isExcluded) {
      evalCategory = "belum_dapat_dievaluasi";
      recommendation = `Data dikecualikan dari penilaian peer group (${p.exclusionReason || "alasan teknis"}).`;
    } else {
      evalCategory = "belum_dapat_dievaluasi";
      recommendation = "Hasil QC tidak tersedia atau penyebaran kelompok tidak mencukupi untuk penilaian.";
    }

    // 3. Evaluasi Bias, Imprecision, TEa, dan Sigma Metrik Medis
    let biasAbs: number | null = null;
    let biasPct: number | null = null;
    let sigma: number | null = null;
    let sigmaCategory = "Belum Terhitung";

    // Acuan bias: Target independen jika ada, jika tidak pakai Robust Mean konsensus
    const refTarget = targetValue !== null ? targetValue : robustMean;
    if (isValidVal && refTarget !== null && refTarget !== 0) {
      biasAbs = round(Math.abs(val! - refTarget), 4);
      biasPct = round((Math.abs(val! - refTarget) / Math.abs(refTarget)) * 100, 2);
    }

    const tea = typeof p.tea === "number" && p.tea > 0 ? p.tea : null;
    const cvLab = typeof p.cvLab === "number" && p.cvLab > 0 ? p.cvLab : null;

    if (tea !== null && biasPct !== null && cvLab !== null && cvLab > 0) {
      // Rumus Sigma Metrik: Sigma = (TEa% - |Bias%|) / CV%
      const rawSigma = (tea - biasPct) / cvLab;
      sigma = round(rawSigma, 2);

      if (rawSigma >= 6.0) sigmaCategory = "World Class (>=6σ)";
      else if (rawSigma >= 5.0) sigmaCategory = "Excellent (5.0–5.9σ)";
      else if (rawSigma >= 4.0) sigmaCategory = "Good (4.0–4.9σ)";
      else if (rawSigma >= 3.0) sigmaCategory = "Marginal (3.0–3.9σ)";
      else if (rawSigma >= 2.0) sigmaCategory = "Poor (2.0–2.9σ)";
      else sigmaCategory = "Unacceptable (<2.0σ)";
    } else {
      if (!tea) sigmaCategory = "TEa belum tersedia";
      else if (!cvLab) sigmaCategory = "CV analitik lab belum tersedia";
      else sigmaCategory = "Belum dapat dihitung";
    }

    return {
      hospitalUsername: p.hospitalUsername,
      hospitalName: p.hospitalName,
      originalValue: p.originalValue !== undefined ? p.originalValue : val,
      usedValue: val,
      diffTarget,
      zScore,
      zScoreAbs,
      peerRelativeScore,
      peerRelativeAbs,
      evalCategory,
      biasAbs,
      biasPct,
      cvLab,
      tea,
      teaSource: p.teaSource || null,
      sigma,
      sigmaCategory,
      isValid: isValidVal,
      validationStatus: p.validationStatus || (isValidVal ? "valid" : "review"),
      exclusionReason: p.exclusionReason || null,
      recommendation,
    };
  });
}

// ------------------------------------------------------------
// Helper: Rounding presisi numerik terukur
// ------------------------------------------------------------
function round(val: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round((val + Number.EPSILON) * factor) / factor;
}
