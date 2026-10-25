// ============================================================
// peer-service.ts — Service & Repository Layer Modul Peer Group PME/PMI
//
// Fitur:
//   - Filter dinamis parameter, rumah sakit, alat, metode, tanggal
//   - Agregasi rentang tanggal (single_date, latest, average)
//   - Integrasi ISO 13528:2022 Algorithm A & Sigma Metrik
//   - Snapshot hasil & audit log
//   - Distribusi laporan individual dengan otorisasi ketat multi-tenant
// ============================================================

import { db } from "@/lib/db";
import type { SessionData } from "@/lib/session";
import { genID, logA, parseNumSafe, dateToISO } from "@/lib/utils-server";
import {
  computeDescriptiveStats,
  computeAlgorithmA,
  evaluateParticipants,
  type ParticipantEvaluation,
  type DescriptiveStats,
  type RobustStats,
} from "./stats-engine";

// ------------------------------------------------------------
// Helper: Normalisasi Sinonim / Alias Nama Parameter Lab Klinik
// ------------------------------------------------------------
export function getParameterAliases(param: string): string[] {
  if (!param) return [];
  const clean = param.trim();
  const upper = clean.toUpperCase();

  const synonymGroups: string[][] = [
    ["CREATININ", "KREATININ", "CREATININE"],
    ["KOLESTEROL TOTAL", "KHOLESTEROL TOTAL", "CHOLESTEROL TOTAL", "CHOL TOTAL", "KOLESTEROL"],
    ["WBC", "WBC-C", "LEUKOSIT", "WHITE BLOOD CELL"],
    ["CALSIUM", "CALSIUM ION", "KALSIUM", "KALSIUM ION", "CALCIUM"],
    ["GLUKOSA", "GLUCOSE", "GULA DARAH"],
    ["ASAM URAT", "URIC ACID"],
    ["TRIGLISERID", "TRIGLISERIDA", "TRIGLYCERIDE"],
    ["HEMOGLOBIN", "HB"],
    ["TROMBOSIT", "PLATELET", "PLT"],
    ["HEMATOKRIT", "HT", "HCT"],
    ["BILIRUBIN TOTAL", "BIL TOTAL"],
    ["BILIRUBIN DIREK", "BIL DIREK", "BILIRUBIN DIRECT"],
    ["PROTEIN TOTAL", "TOTAL PROTEIN"],
    ["HBA1C", "HB A1C"],
    ["NATRIUM ION", "NATRIUM", "SODIUM"],
    ["KALIUM ION", "KALIUM", "POTASSIUM"],
    ["KLORIDA ION", "KLORIDA", "CHLORIDE"],
    ["ALP(ALKALIN PHOSPATASE)", "ALP", "ALKALIN PHOSFATASE", "ALKALINE PHOSPHATASE"],
    ["GGT (GAMMA GT)", "GGT", "GAMMA GT"],
    ["CK-MB", "CKMB"],
    ["CK-NAC", "CKNAC"],
    ["SGOT", "AST"],
    ["SGPT", "ALT"],
    ["UREUM", "UREA", "BUN"],
    ["ALBUMIN", "ALB"],
    ["HDL", "HDL KOLESTEROL", "HDL CHOLESTEROL"],
    ["LDL", "LDL KOLESTEROL", "LDL CHOLESTEROL"],
    ["RBC", "ERITROSIT", "ERYTHROCYTE"]
  ];

  for (const group of synonymGroups) {
    if (group.some((syn) => syn.toUpperCase() === upper)) {
      const set = new Set<string>([clean, ...group]);
      return Array.from(set);
    }
  }

  return [clean];
}

// ------------------------------------------------------------
// Helper: Verifikasi Hak Akses Superadmin
// ------------------------------------------------------------
function requireSuperadmin(session: SessionData | null) {
  if (!session) {
    throw new Error("Unauthorized: Sesi tidak valid atau telah berakhir");
  }
  if (session.role !== "superadmin" || session.isSecondary) {
    throw new Error("Forbidden: Menu Peer Group PME/PMI hanya dapat diakses oleh SUPERADMIN");
  }
}

// ------------------------------------------------------------
// 1. Opsi Filter Dinamis Peer Group (Khusus Superadmin)
// ------------------------------------------------------------
export async function getPeerGroupFilterOptions(args: any[], session: SessionData | null) {
  requireSuperadmin(session);

  // Ambil daftar user/rumah sakit aktif
  const users = await db.users.findMany({
    where: { status: "active" },
    select: {
      username: true,
      fullName: true,
      role: true,
    },
    orderBy: { fullName: "asc" },
  });

  // Ambil nama profil RS dari tabel KopSurat jika ada
  const kopList = await db.kopSurat.findMany({
    where: { key: "namaRS" },
    select: { ownerUsername: true, value: true },
  });
  const hospitalNameMap = new Map<string, string>();
  kopList.forEach((k) => {
    if (k.value && k.value.trim()) {
      hospitalNameMap.set(k.ownerUsername, k.value.trim());
    }
  });

  const hospitalOptions = users.map((u) => {
    const rsName = hospitalNameMap.get(u.username);
    return {
      username: u.username,
      displayName: rsName ? `${rsName} (@${u.username})` : `${u.fullName} (@${u.username})`,
      fullName: u.fullName,
      hospitalName: rsName || u.fullName,
      role: u.role,
    };
  });

  // Ambil parameter unik dari tabel inputqc
  const distinctParams = await db.inputQC.findMany({
    distinct: ["parameter"],
    select: { parameter: true },
    orderBy: { parameter: "asc" },
  });
  const parameters = distinctParams.map((p) => p.parameter).filter(Boolean);

  // Ambil alat unik
  const distinctAlat = await db.inputQC.findMany({
    distinct: ["namaAlat"],
    select: { namaAlat: true },
    where: { namaAlat: { not: null } },
  });
  const analyzers = distinctAlat.map((a) => a.namaAlat!).filter(Boolean).sort();

  // Ambil metode unik dari lotQC dan masterMetode
  const distinctMethods = await db.lotQC.findMany({
    distinct: ["methode"],
    select: { methode: true },
    where: { methode: { not: null } },
  });
  const masterMethods = await db.masterMetode.findMany({
    select: { namaMetode: true },
  });
  const methodSet = new Set<string>();
  distinctMethods.forEach((m) => {
    if (m.methode && m.methode.trim() && m.methode.trim() !== "-") {
      methodSet.add(m.methode.trim());
    }
  });
  masterMethods.forEach((m) => {
    if (m.namaMetode && m.namaMetode.trim()) {
      methodSet.add(m.namaMetode.trim());
    }
  });
  const methods = Array.from(methodSet).sort();

  // Ambil lot unik dari lotQC dan inputQC
  const distinctLotsQC = await db.lotQC.findMany({
    distinct: ["noLot"],
    select: { noLot: true },
    where: { noLot: { not: "" } },
  });
  const distinctLotsInput = await db.inputQC.findMany({
    distinct: ["noLot"],
    select: { noLot: true },
    where: { noLot: { not: "" } },
  });
  const lotSet = new Set<string>();
  distinctLotsQC.forEach((l) => { if (l.noLot && l.noLot.trim()) lotSet.add(l.noLot.trim()); });
  distinctLotsInput.forEach((l) => { if (l.noLot && l.noLot.trim()) lotSet.add(l.noLot.trim()); });
  const lots = Array.from(lotSet).sort();

  return {
    ok: true,
    hospitals: hospitalOptions,
    parameters,
    analyzers,
    methods,
    lots,
  };
}

// ------------------------------------------------------------
// 1b. Ambil Detail Filter Berdasarkan Parameter Tertentu (Live Helper)
// ------------------------------------------------------------
export async function getPeerGroupFilterDetails(args: any[], session: SessionData | null) {
  requireSuperadmin(session);
  const param = String(args[0] || "").trim();
  const selectedHospitals: string[] = Array.isArray(args[1]) ? args[1] : [];

  if (!param) {
    return { ok: false, msg: "Parameter wajib diisi" };
  }

  const paramAliases = getParameterAliases(param);
  const whereQC: any = {
    parameter: { in: paramAliases, mode: "insensitive" },
  };
  if (selectedHospitals.length > 0) {
    whereQC.ownerUsername = { in: selectedHospitals };
  }

  // Cari rentang tanggal aktual
  const dateAgg = await db.inputQC.aggregate({
    where: whereQC,
    _min: { tanggal: true },
    _max: { tanggal: true },
    _count: { id: true },
  });

  // Cari alat yang dipakai untuk parameter ini
  const distinctAlat = await db.inputQC.findMany({
    where: whereQC,
    distinct: ["namaAlat"],
    select: { namaAlat: true },
  });
  const analyzers = distinctAlat.map((a) => a.namaAlat!).filter(Boolean).sort();

  // Cari lot yang dipakai untuk parameter ini
  const distinctLots = await db.inputQC.findMany({
    where: whereQC,
    distinct: ["noLot"],
    select: { noLot: true, lotID: true },
  });
  const lotNos = Array.from(new Set(distinctLots.map((l) => l.noLot).filter(Boolean) as string[])).sort();

  // Cari metode yang terkait dengan lot-lot ini
  const lotIds = distinctLots.map((l) => l.lotID).filter(Boolean) as string[];
  const methodSet = new Set<string>();
  if (lotIds.length > 0 || lotNos.length > 0) {
    const orCond: any[] = [];
    if (lotIds.length > 0) orCond.push({ id: { in: lotIds } });
    if (lotNos.length > 0) orCond.push({ noLot: { in: lotNos } });
    const lotsWithMethod = await db.lotQC.findMany({
      where: { OR: orCond },
      select: { methode: true },
    });
    lotsWithMethod.forEach((l) => {
      if (l.methode && l.methode.trim() && l.methode.trim() !== "-") {
        methodSet.add(l.methode.trim());
      }
    });
  }

  return {
    ok: true,
    parameter: param,
    count: dateAgg._count.id,
    minDate: dateAgg._min.tanggal || null,
    maxDate: dateAgg._max.tanggal || null,
    analyzers,
    lots: lotNos,
    methods: Array.from(methodSet).sort(),
  };
}

// ------------------------------------------------------------
// 2. Jalankan Analisis Peer Group (Preview Sebelum Simpan)
// ------------------------------------------------------------
export async function runPeerGroupAnalysis(args: any[], session: SessionData | null) {
  requireSuperadmin(session);

  const payload = args[0] || {};
  const parameter = String(payload.parameter || "").trim();
  const level = String(payload.level || "L1").toUpperCase(); // L1, L2, L3
  const startDate = String(payload.startDate || "");
  const endDate = String(payload.endDate || "");
  const aggregationRule = String(payload.aggregationRule || "latest"); // latest | average | single_date
  const singleDate = payload.singleDate ? String(payload.singleDate) : null;
  const targetType = String(payload.targetType || "robust_mean"); // robust_mean | reference_value | pme_target
  const assignedValueCustom = parseNumSafe(payload.assignedValue);
  const assignedValueSource = payload.assignedValueSource || "";
  const sdpaType = String(payload.sdpaType || "robust_sd"); // robust_sd | fixed_sdpa | tea_derived
  const sdpaValueCustom = parseNumSafe(payload.sdpaValue);
  const sdpaSource = payload.sdpaSource || "";
  const selectedHospitals: string[] = Array.isArray(payload.hospitals) ? payload.hospitals : [];

  if (!parameter) {
    return { ok: false, msg: "Parameter pemeriksaan wajib dipilih" };
  }
  if (!startDate || !endDate) {
    return { ok: false, msg: "Rentang tanggal evaluasi wajib diisi" };
  }
  if (selectedHospitals.length === 0) {
    return { ok: false, msg: "Minimal 1 rumah sakit/laboratorium peserta harus dipilih" };
  }

  const paramAliases = getParameterAliases(parameter);

  // Build query filter untuk inputqc
  const whereQC: any = {
    parameter: { in: paramAliases, mode: "insensitive" },
    ownerUsername: { in: selectedHospitals },
    tanggal: { gte: startDate, lte: endDate },
  };

  // Filter opsional: alat, metode & lot jika dispesifikasikan
  const analyzerFilter = payload.analyzer ? String(payload.analyzer).trim() : "";
  const methodFilter = payload.method ? String(payload.method).trim() : "";
  const lotFilter = payload.controlLot ? String(payload.controlLot).trim() : "";

  if (analyzerFilter) {
    whereQC.namaAlat = { equals: analyzerFilter, mode: "insensitive" };
  }
  if (lotFilter) {
    whereQC.noLot = { equals: lotFilter, mode: "insensitive" };
  }
  if (payload.validationOnly) {
    whereQC.validated = true;
  }

  // Jika filter metode dipilih, cari lot-lot yang memiliki metode tersebut
  if (methodFilter) {
    const matchingLots = await db.lotQC.findMany({
      where: {
        ownerUsername: { in: selectedHospitals },
        methode: { equals: methodFilter, mode: "insensitive" },
      },
      select: { id: true, noLot: true },
    });
    const lotIdsWithMethod = matchingLots.map((l) => l.id);
    const lotNosWithMethod = matchingLots.map((l) => l.noLot).filter(Boolean) as string[];

    whereQC.OR = [
      { lotID: { in: lotIdsWithMethod } },
      { noLot: { in: lotNosWithMethod } },
    ];
  }

  // Ambil seluruh data QC yang cocok
  const qcRows = await db.inputQC.findMany({
    where: whereQC,
    orderBy: { tanggal: "asc" },
  });

  // Ambil metadata nama RS
  const users = await db.users.findMany({
    where: { username: { in: selectedHospitals } },
    select: { username: true, fullName: true },
  });
  const kopList = await db.kopSurat.findMany({
    where: { ownerUsername: { in: selectedHospitals }, key: "namaRS" },
    select: { ownerUsername: true, value: true },
  });
  const hospitalNameMap = new Map<string, string>();
  users.forEach((u) => hospitalNameMap.set(u.username, u.fullName));
  kopList.forEach((k) => {
    if (k.value && k.value.trim()) hospitalNameMap.set(k.ownerUsername, k.value.trim());
  });

  // Ambil referensi TEa dan metode dari LotQC masing-masing RS
  const lots = await db.lotQC.findMany({
    where: {
      ownerUsername: { in: selectedHospitals },
    },
    select: {
      id: true,
      ownerUsername: true,
      paramID: true,
      noLot: true,
      namaAlat: true,
      methode: true,
      satuan: true,
      tea: true,
    },
  });
  const lotMap = new Map(lots.map((l) => [l.id, l]));

  // Ambil master TEa rujukan jika ada
  const masterTea = await db.daftarTEa.findFirst({
    where: { parameter: { in: paramAliases, mode: "insensitive" } },
  });

  // Kelompokkan hasil QC per rumah sakit
  const hospitalQCs = new Map<string, any[]>();
  selectedHospitals.forEach((u) => hospitalQCs.set(u, []));
  qcRows.forEach((r) => {
    const list = hospitalQCs.get(r.ownerUsername) || [];
    list.push(r);
    hospitalQCs.set(r.ownerUsername, list);
  });

  // Proses agregasi per peserta sesuai aturan yang dipilih
  const participantDataList: any[] = [];
  const isAllLevel = level === "ALL" || level === "SEMUA";
  const levelsToEval = isAllLevel ? ["L1", "L2", "L3"] : [level];

  for (const username of selectedHospitals) {
    const rows = hospitalQCs.get(username) || [];
    const hospitalName = hospitalNameMap.get(username) || username;

    if (rows.length === 0) {
      participantDataList.push({
        hospitalUsername: username,
        hospitalName,
        level: isAllLevel ? "ALL" : level,
        usedValue: null,
        originalValue: null,
        sourceCount: 0,
        date: null,
        validationStatus: "excluded",
        exclusionReason: "Tidak ada data QC pada periode yang dipilih",
        unit: null,
        analyzer: null,
        method: null,
        controlLot: null,
        tea: null,
        cvLab: null,
      });
      continue;
    }

    let addedAnyLevel = false;

    for (const curLvl of levelsToEval) {
      const curLevelKey = curLvl === "L3" ? "level3" : curLvl === "L2" ? "level2" : "level1";
      const validLevelRows = rows.filter((r) => {
        const v = parseNumSafe(r[curLevelKey]);
        return v !== null && v !== 0;
      });

      if (validLevelRows.length === 0) continue;

      let chosenRow: any = null;
      let usedVal: number | null = null;
      let dateStr: string | null = null;

      if (aggregationRule === "single_date") {
        const targetDate = singleDate || startDate;
        const onDateRows = validLevelRows.filter((r) => r.tanggal === targetDate);
        if (onDateRows.length > 0) {
          chosenRow = onDateRows[onDateRows.length - 1];
          const sum = onDateRows.reduce((a, c) => a + parseNumSafe(c[curLevelKey])!, 0);
          usedVal = sum / onDateRows.length;
          dateStr = targetDate;
        } else {
          continue;
        }
      } else if (aggregationRule === "average") {
        chosenRow = validLevelRows[validLevelRows.length - 1];
        const sum = validLevelRows.reduce((a, c) => a + parseNumSafe(c[curLevelKey])!, 0);
        usedVal = sum / validLevelRows.length;
        dateStr = `${startDate} s/d ${endDate}`;
      } else {
        // latest
        chosenRow = validLevelRows[validLevelRows.length - 1];
        usedVal = parseNumSafe(chosenRow[curLevelKey]);
        dateStr = chosenRow.tanggal;
      }

      // Ambil metadata alat, metode, satuan, dan lot
      let lot = chosenRow ? lotMap.get(chosenRow.lotID) : null;
      if (!lot && chosenRow) {
        lot = lots.find(
          (l) =>
            l.ownerUsername === username &&
            (l.id === chosenRow.lotID || (chosenRow.noLot && l.noLot?.toLowerCase() === chosenRow.noLot?.toLowerCase()))
        ) || null;
      }
      const unit = lot?.satuan || null;
      const analyzer = chosenRow?.namaAlat || lot?.namaAlat || null;
      const method = (lot?.methode && lot.methode !== "-") ? lot.methode : null;
      const controlLot = chosenRow?.noLot || lot?.noLot || null;
      const tea = lot?.tea || (masterTea ? parseNumSafe(masterTea.nilaiTEa) : null);

      let cvLab: number | null = null;
      if (validLevelRows.length >= 2) {
        const vals = validLevelRows.map((r) => parseNumSafe(r[curLevelKey])!).filter((v) => v !== null);
        const desc = computeDescriptiveStats(vals);
        cvLab = desc.cv;
      }

      participantDataList.push({
        hospitalUsername: username,
        hospitalName,
        level: curLvl,
        usedValue: usedVal !== null ? Math.round(usedVal * 10000) / 10000 : null,
        originalValue: parseNumSafe(chosenRow[curLevelKey]),
        sourceCount: validLevelRows.length,
        date: dateStr,
        unit,
        analyzer,
        method,
        controlLot,
        tea,
        teaSource: lot?.tea ? "Lot QC Laboratorium" : masterTea ? "Daftar TEa Referensi" : null,
        cvLab: cvLab !== null ? Math.round(cvLab * 100) / 100 : null,
        validationStatus: "valid",
        exclusionReason: null,
      });
      addedAnyLevel = true;
    }

    if (!addedAnyLevel) {
      participantDataList.push({
        hospitalUsername: username,
        hospitalName,
        level: isAllLevel ? "ALL" : level,
        usedValue: null,
        originalValue: null,
        sourceCount: rows.length,
        date: rows[rows.length - 1].tanggal,
        validationStatus: "excluded",
        exclusionReason: isAllLevel
          ? `Data QC ada (${rows.length} entri), tetapi nilai semua level (L1, L2, L3) kosong/nol`
          : `Data QC ada (${rows.length} entri), tetapi nilai ${level} kosong/nol`,
        unit: null,
        analyzer: rows[0].namaAlat,
        method: null,
        controlLot: rows[0].noLot,
        tea: null,
        cvLab: null,
      });
    }
  }

  // Kumpulkan nilai-nilai valid
  const validParticipants = participantDataList.filter((p) => p.validationStatus === "valid" && p.usedValue !== null);
  const excludedParticipants = participantDataList.filter((p) => p.validationStatus !== "valid" || p.usedValue === null);
  const validValues = validParticipants.map((p) => p.usedValue as number);

  // 1. Hitung Statistik Deskriptif & Robust
  const descStats = computeDescriptiveStats(validValues);
  const robustStats = computeAlgorithmA(validValues);

  let finalEvaluations: any[] = [];
  let targetValFinal: number | null = null;
  let targetSourceStr = "";
  let sdpaValFinal: number | null = null;
  let sdpaSourceStr = "";
  let isFormalPme = false;

  if (!isAllLevel) {
    // Mode Single Level (L1 / L2 / L3)
    if (targetType === "reference_value" && assignedValueCustom !== null) {
      targetValFinal = assignedValueCustom;
      targetSourceStr = assignedValueSource || "Nilai Acuan Independen / Kalibrator";
    } else if (targetType === "pme_target" && assignedValueCustom !== null) {
      targetValFinal = assignedValueCustom;
      targetSourceStr = assignedValueSource || "Target Penyelenggara PME";
    } else {
      targetValFinal = robustStats.robustMean;
      targetSourceStr = "Nilai Konsensus Robust Kelompok (ISO 13528 Algorithm A)";
    }

    if (sdpaType === "fixed_sdpa" && sdpaValueCustom !== null && sdpaValueCustom > 0) {
      sdpaValFinal = sdpaValueCustom;
      sdpaSourceStr = sdpaSource || "SDPA Ditetapkan Secara Independen (Kriteria Formal PME)";
      isFormalPme = true;
    } else if (sdpaType === "tea_derived" && targetValFinal !== null) {
      const teaRef = masterTea ? parseNumSafe(masterTea.nilaiTEa) : null;
      if (teaRef && teaRef > 0) {
        sdpaValFinal = Math.round(((teaRef / 100) * targetValFinal * 10000) / 3) / 10000;
        sdpaSourceStr = `Diturunkan dari TEa (${teaRef}% / 3) Berdasarkan Target Acuan`;
        isFormalPme = true;
      }
    }
    if (sdpaValFinal === null) {
      sdpaValFinal = robustStats.robustSd;
      sdpaSourceStr = "Robust SD Kelompok — Digunakan untuk Skor Relatif Peer Group";
      isFormalPme = false;
    }

    const evals = evaluateParticipants({
      participants: participantDataList,
      targetValue: targetValFinal,
      targetSource: targetSourceStr,
      sdpaValue: sdpaValFinal,
      sdpaSource: sdpaSourceStr,
      isFormalPme,
      robustMean: robustStats.robustMean,
      robustSd: robustStats.robustSd,
    });
    evals.forEach((e, idx) => {
      (e as any).level = participantDataList[idx]?.level || level;
    });
    finalEvaluations = evals;
  } else {
    // Mode "ALL" (Semua Level)
    targetValFinal = robustStats.robustMean;
    targetSourceStr = "Multi-Level Konsensus Robust (ISO 13528 Algorithm A)";
    sdpaValFinal = robustStats.robustSd;
    sdpaSourceStr = "Multi-Level Robust SD Kelompok";
    isFormalPme = false;

    // Hitung konsensus per level untuk evaluasi akurat
    const levelConfigs: Record<string, { rob: RobustStats; target: number | null; sdpa: number | null }> = {};
    for (const lvl of ["L1", "L2", "L3"]) {
      const valsLvl = validParticipants.filter((p) => p.level === lvl).map((p) => p.usedValue as number);
      const rob = computeAlgorithmA(valsLvl);
      levelConfigs[lvl] = {
        rob,
        target: rob.robustMean,
        sdpa: rob.robustSd || (rob.robustMean ? rob.robustMean * 0.05 : 0.001),
      };
    }

    const evaluatedList: any[] = [];
    for (const lvl of ["L1", "L2", "L3"]) {
      const partLvl = validParticipants.filter((p) => p.level === lvl);
      if (partLvl.length === 0) continue;
      const cfgLvl = levelConfigs[lvl];
      const evals = evaluateParticipants({
        participants: partLvl,
        targetValue: cfgLvl.target,
        targetSource: `Konsensus Robust ${lvl}`,
        sdpaValue: cfgLvl.sdpa,
        sdpaSource: `Robust SD ${lvl}`,
        isFormalPme: false,
        robustMean: cfgLvl.rob.robustMean,
        robustSd: cfgLvl.rob.robustSd,
      });
      evals.forEach((e) => {
        (e as any).level = lvl;
        (e as any).levelTarget = cfgLvl.target;
        (e as any).levelSdpa = cfgLvl.sdpa;
      });
      evaluatedList.push(...evals);
    }

    // Masukkan peserta yang excluded
    if (excludedParticipants.length > 0) {
      const excEvals = evaluateParticipants({
        participants: excludedParticipants,
        targetValue: null,
        targetSource: "-",
        sdpaValue: null,
        sdpaSource: "-",
        isFormalPme: false,
        robustMean: null,
        robustSd: null,
      });
      excEvals.forEach((e, idx) => {
        (e as any).level = excludedParticipants[idx]?.level || "ALL";
      });
      evaluatedList.push(...excEvals);
    }

    finalEvaluations = evaluatedList;
  }

  // 5. Hitung Multi-Tier Benchmark Grouping (Model Laporan Standar Uji PME)
  const validEvaluations = finalEvaluations.filter((e) => e.validationStatus === "valid" && e.usedValue !== null);

  // Pasang Tiers ke setiap evaluasi peserta
  finalEvaluations.forEach((item) => {
    const itemLevel = (item as any).level || level;
    // Sub-populasi peserta di level yang sama
    const peerSubset = isAllLevel
      ? validEvaluations.filter((e) => (e as any).level === itemLevel)
      : validEvaluations;

    const tierAllN = peerSubset.length;
    const itemTarget = (item as any).levelTarget !== undefined ? (item as any).levelTarget : targetValFinal;
    const itemSdpa = (item as any).levelSdpa !== undefined ? (item as any).levelSdpa : sdpaValFinal;

    const zAll = item.zScore !== null ? item.zScore : item.peerRelativeScore;
    const katAll = zAll !== null ? (Math.abs(zAll) <= 2 ? "OK" : Math.abs(zAll) <= 3 ? "Peringatan" : "Tindakan") : "-";
    const ketAll = zAll !== null ? (Math.abs(zAll) <= 2 ? "Memuaskan" : Math.abs(zAll) <= 3 ? "Meragukan" : "Tidak Memuaskan") : "Tidak dianalisa";

    // Kelompok Metode (pada level yang sama)
    const mKey = item.method ? item.method.trim().toLowerCase() : "";
    let mStat: { n: number; target: number | null; sdpa: number | null } | null = null;
    let mZ: number | null = null;
    let mKat = "-";
    let mKet = "Tidak dianalisa";

    if (mKey) {
      const methodVals = peerSubset.filter((e) => e.method && e.method.trim().toLowerCase() === mKey && e.usedValue !== null).map((e) => e.usedValue as number);
      if (methodVals.length >= 6) {
        const rob = computeAlgorithmA(methodVals);
        mStat = {
          n: methodVals.length,
          target: rob.robustMean !== null ? Math.round(rob.robustMean * 100) / 100 : null,
          sdpa: rob.robustSd !== null ? Math.round(rob.robustSd * 100) / 100 : null,
        };
        if (mStat.target !== null && mStat.sdpa !== null && mStat.sdpa > 0 && item.usedValue !== null) {
          mZ = Math.round(((item.usedValue - mStat.target) / mStat.sdpa) * 100) / 100;
          mKat = Math.abs(mZ) <= 2 ? "OK" : Math.abs(mZ) <= 3 ? "Peringatan" : "Tindakan";
          mKet = Math.abs(mZ) <= 2 ? "Memuaskan" : Math.abs(mZ) <= 3 ? "Meragukan" : "Tidak Memuaskan";
        }
      } else {
        mStat = { n: methodVals.length, target: null, sdpa: null };
      }
    }

    // Kelompok Alat (pada level yang sama)
    const aKey = item.analyzer ? item.analyzer.trim().toLowerCase() : "";
    let aStat: { n: number; target: number | null; sdpa: number | null } | null = null;
    let aZ: number | null = null;
    let aKat = "-";
    let aKet = "Tidak dianalisa";

    if (aKey) {
      const analyzerVals = peerSubset.filter((e) => e.analyzer && e.analyzer.trim().toLowerCase() === aKey && e.usedValue !== null).map((e) => e.usedValue as number);
      if (analyzerVals.length >= 6) {
        const rob = computeAlgorithmA(analyzerVals);
        aStat = {
          n: analyzerVals.length,
          target: rob.robustMean !== null ? Math.round(rob.robustMean * 100) / 100 : null,
          sdpa: rob.robustSd !== null ? Math.round(rob.robustSd * 100) / 100 : null,
        };
        if (aStat.target !== null && aStat.sdpa !== null && aStat.sdpa > 0 && item.usedValue !== null) {
          aZ = Math.round(((item.usedValue - aStat.target) / aStat.sdpa) * 100) / 100;
          aKat = Math.abs(aZ) <= 2 ? "OK" : Math.abs(aZ) <= 3 ? "Peringatan" : "Tindakan";
          aKet = Math.abs(aZ) <= 2 ? "Memuaskan" : Math.abs(aZ) <= 3 ? "Meragukan" : "Tidak Memuaskan";
        }
      } else {
        aStat = { n: analyzerVals.length, target: null, sdpa: null };
      }
    }

    (item as any).tiers = {
      all: {
        n: tierAllN,
        target: itemTarget !== null ? Math.round(itemTarget * 100) / 100 : null,
        sdpa: itemSdpa !== null ? Math.round(itemSdpa * 100) / 100 : null,
        zScore: zAll !== null ? Math.round(zAll * 100) / 100 : null,
        kategori: katAll,
        keterangan: ketAll,
      },
      method: {
        n: mStat ? mStat.n : (item.method ? 1 : 0),
        target: mStat?.target || null,
        sdpa: mStat?.sdpa || null,
        zScore: mZ,
        kategori: mKat,
        keterangan: mKet,
      },
      analyzer: {
        n: aStat ? aStat.n : (item.analyzer ? 1 : 0),
        target: aStat?.target || null,
        sdpa: aStat?.sdpa || null,
        zScore: aZ,
        kategori: aKat,
        keterangan: aKet,
      },
    };
  });

  return {
    ok: true,
    config: {
      parameter,
      level,
      startDate,
      endDate,
      aggregationRule,
      singleDate,
      analyzer: analyzerFilter || null,
      method: methodFilter || null,
      controlLot: lotFilter || null,
      targetType,
      assignedValue: targetValFinal,
      assignedValueSource: targetSourceStr,
      sdpaType,
      sdpaValue: sdpaValFinal,
      sdpaSource: sdpaSourceStr,
      isFormalPme,
    },
    stats: {
      totalSelected: selectedHospitals.length,
      totalWithData: validValues.length,
      totalValid: validValues.length,
      totalExcluded: selectedHospitals.length - new Set(validParticipants.map((p) => p.hospitalUsername)).size,
      descriptive: descStats,
      robust: robustStats,
    },
    evaluations: finalEvaluations,
  };
}

// ------------------------------------------------------------
// 3. Simpan Snapshot & Terbitkan Laporan (Superadmin)
// ------------------------------------------------------------
export async function saveAndPublishPeerGroup(args: any[], session: SessionData | null) {
  requireSuperadmin(session);

  const payload = args[0] || {};
  const analysisResult = payload.analysisResult;
  const recipientUsernames: string[] = Array.isArray(payload.recipients) ? payload.recipients : [];

  if (!analysisResult || !analysisResult.config || !analysisResult.evaluations) {
    return { ok: false, msg: "Hasil analisis tidak valid untuk disimpan" };
  }

  const cfg = analysisResult.config;
  const stats = analysisResult.stats;
  const evals: ParticipantEvaluation[] = analysisResult.evaluations;

  const configId = genID("PG");

  // Simpan PeerGroupConfig
  await db.peerGroupConfig.create({
    data: {
      id: configId,
      title: payload.title || `Evaluasi Peer Group PME/PMI: ${cfg.parameter} (${cfg.level}) - ${cfg.startDate} s/d ${cfg.endDate}`,
      parameter: cfg.parameter,
      level: cfg.level,
      startDate: cfg.startDate,
      endDate: cfg.endDate,
      aggregationRule: cfg.aggregationRule,
      singleDate: cfg.singleDate || null,
      targetType: cfg.targetType,
      assignedValue: cfg.assignedValue,
      assignedValueSource: cfg.assignedValueSource,
      sdpaType: cfg.sdpaType,
      sdpaValue: cfg.sdpaValue,
      sdpaSource: cfg.sdpaSource,
      selectedHospitals: JSON.stringify(recipientUsernames),
      status: "published",
      createdBy: session!.username,
    },
  });

  // Simpan PeerGroupSummaryStats
  await db.peerGroupSummaryStats.create({
    data: {
      id: genID("PGSTAT"),
      configId,
      totalSelected: stats.totalSelected,
      totalWithData: stats.totalWithData,
      totalValid: stats.totalValid,
      totalExcluded: stats.totalExcluded,
      mean: stats.descriptive.mean,
      median: stats.descriptive.median,
      sd: stats.descriptive.sd,
      cv: stats.descriptive.cv,
      min: stats.descriptive.min,
      max: stats.descriptive.max,
      range: stats.descriptive.range,
      q1: stats.descriptive.q1,
      q3: stats.descriptive.q3,
      iqr: stats.descriptive.iqr,
      mad: stats.descriptive.mad,
      robustMean: stats.robust.robustMean,
      robustSd: stats.robust.robustSd,
      niqr: stats.descriptive.niqr,
      uncertainty: stats.robust.uncertainty,
      targetValue: cfg.assignedValue,
      targetSource: cfg.assignedValueSource,
      sdpaValue: cfg.sdpaValue,
      sdpaSource: cfg.sdpaSource,
      statStatus: stats.robust.statStatus,
      notes: stats.robust.notes,
    },
  });

  // Simpan Items
  for (const item of evals) {
    await db.peerGroupSnapshotItem.create({
      data: {
        id: genID("PGITEM"),
        configId,
        hospitalUsername: item.hospitalUsername,
        hospitalName: item.hospitalName,
        parameter: cfg.parameter,
        level: cfg.level,
        originalQcValue: item.originalValue,
        usedQcValue: item.usedValue,
        diffTarget: item.diffTarget,
        zScore: item.zScore,
        zScoreAbs: item.zScoreAbs,
        peerRelativeScore: item.peerRelativeScore,
        peerRelativeAbs: item.peerRelativeAbs,
        evalCategory: item.evalCategory,
        biasAbs: item.biasAbs,
        biasPct: item.biasPct,
        cvLab: item.cvLab,
        tea: item.tea,
        teaSource: item.teaSource,
        sigma: item.sigma,
        sigmaCategory: item.sigmaCategory,
        isValid: item.isValid,
        validationStatus: item.validationStatus,
        exclusionReason: item.exclusionReason,
        recommendation: item.recommendation,
      },
    });
  }

  // Buat Delivery Laporan ke masing-masing rumah sakit penerima terpilih
  const summaryJson = JSON.stringify({
    config: cfg,
    stats,
  });

  let deliveredCount = 0;
  for (const recipient of recipientUsernames) {
    const item = evals.find((e) => e.hospitalUsername === recipient);
    if (!item) continue;

    await db.peerGroupReportDelivery.create({
      data: {
        id: genID("PGRPT"),
        configId,
        recipientUsername: recipient,
        recipientName: item.hospitalName,
        sentBy: session!.username,
        status: "sent",
        version: 1,
        summarySnapshot: summaryJson,
        itemSnapshot: JSON.stringify(item),
      },
    });
    deliveredCount++;
  }

  await logA(
    session!.username,
    "PEER_GROUP_PUBLISH",
    `Menerbitkan Laporan Peer Group: ${cfg.parameter} (${cfg.level}) kepada ${deliveredCount} rumah sakit`
  );

  return {
    ok: true,
    configId,
    deliveredCount,
    msg: `Laporan Peer Group berhasil diterbitkan dan dikirim ke ${deliveredCount} rumah sakit.`,
  };
}

// ------------------------------------------------------------
// 4. Menu User: "Laporan Analisa Peer Group" (Otorisasi Tertutup)
// ------------------------------------------------------------
export async function getMyPeerGroupReports(args: any[], session: SessionData | null) {
  if (!session) {
    return { ok: false, msg: "Unauthorized" };
  }

  const isSuperadmin = session.role === "superadmin" && !session.isSecondary;
  const where: any = {};

  if (!isSuperadmin) {
    // Pengguna Rumah Sakit HANYA boleh melihat laporan yang dikirimkan ke username miliknya
    where.recipientUsername = session.username;
  }

  const reports = await db.peerGroupReportDelivery.findMany({
    where,
    orderBy: { sentDate: "desc" },
    take: 100,
  });

  // Hubungkan dengan config title
  const configIds = Array.from(new Set(reports.map((r) => r.configId)));
  const configs = await db.peerGroupConfig.findMany({
    where: { id: { in: configIds } },
    select: { id: true, title: true, parameter: true, level: true, startDate: true, endDate: true },
  });
  const configMap = new Map(configs.map((c) => [c.id, c]));

  const data = reports.map((r) => {
    const c = configMap.get(r.configId);
    let itemData: any = {};
    try {
      if (r.itemSnapshot) itemData = JSON.parse(r.itemSnapshot);
    } catch {}

    return {
      id: r.id,
      configId: r.configId,
      title: c?.title || `Evaluasi Peer Group ${c?.parameter || ""}`,
      parameter: c?.parameter || itemData?.parameter || "",
      level: c?.level || itemData?.level || "",
      period: c ? `${c.startDate} s/d ${c.endDate}` : "",
      recipientUsername: r.recipientUsername,
      recipientName: r.recipientName,
      sentDate: r.sentDate,
      status: r.status,
      readDate: r.readDate,
      evalCategory: itemData?.evalCategory || "-",
      zScore: itemData?.zScore !== null && itemData?.zScore !== undefined ? itemData.zScore : null,
      peerRelativeScore: itemData?.peerRelativeScore !== null && itemData?.peerRelativeScore !== undefined ? itemData.peerRelativeScore : null,
      sigma: itemData?.sigma !== null && itemData?.sigma !== undefined ? itemData.sigma : null,
    };
  });

  return {
    ok: true,
    isSuperadmin,
    data,
  };
}

// ------------------------------------------------------------
// 5. Detail Satu Laporan Individual Peer Group
// ------------------------------------------------------------
export async function getPeerGroupReportDetail(args: any[], session: SessionData | null) {
  if (!session) {
    return { ok: false, msg: "Unauthorized" };
  }

  const reportId = String(args[0] || "");
  if (!reportId) {
    return { ok: false, msg: "ID Laporan wajib diisi" };
  }

  const delivery = await db.peerGroupReportDelivery.findUnique({
    where: { id: reportId },
  });

  if (!delivery) {
    return { ok: false, msg: "Laporan tidak ditemukan" };
  }

  const isSuperadmin = session.role === "superadmin" && !session.isSecondary;

  // Keamanan: Cek kepemilikan laporan
  if (!isSuperadmin && delivery.recipientUsername !== session.username) {
    return { ok: false, msg: "Akses ditolak: Anda tidak memiliki hak akses atas laporan ini" };
  }

  // Tandai sebagai "read" jika dibuka pertama kali oleh pemiliknya
  if (delivery.status === "sent" && !isSuperadmin) {
    await db.peerGroupReportDelivery.update({
      where: { id: reportId },
      data: { status: "read", readDate: new Date() },
    });
  }

  const config = await db.peerGroupConfig.findUnique({
    where: { id: delivery.configId },
  });
  const summaryStats = await db.peerGroupSummaryStats.findUnique({
    where: { configId: delivery.configId },
  });

  let myItem: any = null;
  try {
    if (delivery.itemSnapshot) myItem = JSON.parse(delivery.itemSnapshot);
  } catch {}

  let allItems: any[] = [];
  if (isSuperadmin) {
    // Superadmin dapat melihat seluruh item peserta
    allItems = await db.peerGroupSnapshotItem.findMany({
      where: { configId: delivery.configId },
      orderBy: { hospitalName: "asc" },
    });
  } else {
    // Pengguna RS hanya melihat data ringkasan agregat + data miliknya sendiri (data RS lain disamarkan)
    allItems = [myItem];
  }

  // Ambil kop surat instansi penerima
  const kop = await db.kopSurat.findMany({
    where: { ownerUsername: delivery.recipientUsername },
  });
  const kopObj: Record<string, string> = {};
  kop.forEach((k) => {
    kopObj[k.key] = k.value || "";
  });

  // Ambil kop surat instansi penyelenggara (admin / sentBy)
  const adminKop = await db.kopSurat.findMany({
    where: { ownerUsername: delivery.sentBy || "admin" },
  });
  const penyelenggaraKop: Record<string, string> = {};
  adminKop.forEach((k) => {
    penyelenggaraKop[k.key] = k.value || "";
  });

  return {
    ok: true,
    delivery: {
      id: delivery.id,
      sentDate: delivery.sentDate,
      status: delivery.status,
      readDate: delivery.readDate,
      recipientUsername: delivery.recipientUsername,
      recipientName: delivery.recipientName,
    },
    config,
    summaryStats,
    myItem,
    allItems,
    kop: kopObj,
    penyelenggaraKop,
  };
}

// ============================================================
// 6. Opsi Filter & Tabulasi PG QC Analisis (Khusus Superadmin)
// ============================================================

export async function getPgTabulasiFilterOptions(args: any[], session: SessionData | null) {
  requireSuperadmin(session);

  // Ambil daftar seluruh user aktif
  const users = await db.users.findMany({
    select: {
      username: true,
      fullName: true,
      role: true,
    },
    orderBy: { fullName: "asc" },
  });

  // Nama instansi dari KopSurat
  const kopList = await db.kopSurat.findMany({
    where: { key: "namaRS" },
    select: { ownerUsername: true, value: true },
  });
  const hospitalNameMap = new Map<string, string>();
  kopList.forEach((k) => {
    if (k.value && k.value.trim()) {
      hospitalNameMap.set(k.ownerUsername, k.value.trim());
    }
  });

  const hospitalOptions = users.map((u) => {
    const rsName = hospitalNameMap.get(u.username);
    return {
      username: u.username,
      displayName: rsName ? `${rsName} (@${u.username})` : `${u.fullName} (@${u.username})`,
      fullName: u.fullName,
      hospitalName: rsName || u.fullName,
      role: u.role,
    };
  });

  // Parameter yang pernah diinput di inputQC
  const distinctParams = await db.inputQC.findMany({
    distinct: ["parameter"],
    select: { parameter: true },
    where: { parameter: { not: "" } },
    orderBy: { parameter: "asc" },
  });
  const parameters = distinctParams
    .map((p) => p.parameter.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  // Nama alat yang pernah digunakan di inputQC
  const distinctAlat = await db.inputQC.findMany({
    distinct: ["namaAlat"],
    select: { namaAlat: true },
    where: { namaAlat: { not: null, not: "" } },
    orderBy: { namaAlat: "asc" },
  });
  const analyzers = distinctAlat
    .map((a) => (a.namaAlat ? a.namaAlat.trim() : ""))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  // Nomor Lot QC yang pernah digunakan di inputQC
  const distinctLots = await db.inputQC.findMany({
    distinct: ["noLot"],
    select: { noLot: true },
    where: { noLot: { not: null, not: "" } },
    orderBy: { noLot: "asc" },
  });
  const lots = distinctLots
    .map((l) => (l.noLot ? l.noLot.trim() : ""))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  return {
    ok: true,
    hospitals: hospitalOptions,
    parameters,
    analyzers,
    lots,
  };
}

export async function runPgTabulasiAnalysis(args: any[], session: SessionData | null) {
  requireSuperadmin(session);

  const payload = args[0] || {};
  const {
    startDate,
    endDate,
    usernames = [],
    parameters = [],
    analyzers = [],
    lots = [],
  } = payload;

  if (!startDate || !endDate) {
    return { ok: false, msg: "Rentang tanggal evaluasi (Mulai & Selesai) wajib diisi" };
  }

  const selectedUsers: string[] = Array.isArray(usernames) ? usernames.filter(Boolean) : [];
  if (selectedUsers.length === 0) {
    return { ok: false, msg: "Pilih minimal satu akun laboratorium/peserta" };
  }

  const selectedParams: string[] = Array.isArray(parameters) ? parameters.filter(Boolean) : [];
  if (selectedParams.length === 0) {
    return { ok: false, msg: "Pilih minimal satu parameter pemeriksaan" };
  }

  const selectedAnalyzers: string[] = Array.isArray(analyzers) ? analyzers.filter(Boolean) : [];
  const selectedLots: string[] = Array.isArray(lots) ? lots.filter(Boolean) : [];

  // Bangun alias parameter
  const allAliases: string[] = [];
  const aliasToCanonical = new Map<string, string>();
  for (const p of selectedParams) {
    const aliases = getParameterAliases(p);
    for (const al of aliases) {
      allAliases.push(al);
      aliasToCanonical.set(al.toUpperCase(), p);
    }
  }

  // Siapkan query inputQC
  const whereClause: any = {
    ownerUsername: { in: selectedUsers },
    parameter: { in: Array.from(new Set(allAliases)) },
    tanggal: {
      gte: startDate,
      lte: endDate,
    },
  };

  if (selectedAnalyzers.length > 0) {
    whereClause.namaAlat = { in: selectedAnalyzers };
  }
  if (selectedLots.length > 0) {
    whereClause.noLot = { in: selectedLots };
  }

  const inputRows = await db.inputQC.findMany({
    where: whereClause,
    orderBy: [
      { ownerUsername: "asc" },
      { parameter: "asc" },
      { tanggal: "asc" },
    ],
  });

  if (inputRows.length === 0) {
    return {
      ok: true,
      period: { startDate, endDate },
      summary: {
        totalRows: 0,
        totalHospitals: 0,
        totalParameters: 0,
        totalAnalyzers: 0,
        totalLots: 0,
        sigmaDistribution: { worldClass: 0, excellent: 0, good: 0, marginal: 0, poor: 0, unacceptable: 0 },
      },
      rows: [],
      msg: "Tidak ditemukan data QC pada filter yang dipilih",
    };
  }

  // Ambil metadata instansi user
  const users = await db.users.findMany({
    where: { username: { in: selectedUsers } },
    select: { username: true, fullName: true },
  });
  const kopList = await db.kopSurat.findMany({
    where: { ownerUsername: { in: selectedUsers }, key: "namaRS" },
    select: { ownerUsername: true, value: true },
  });
  const userMap = new Map<string, string>();
  users.forEach((u) => userMap.set(u.username, u.fullName));
  kopList.forEach((k) => {
    if (k.value && k.value.trim()) userMap.set(k.ownerUsername, k.value.trim());
  });

  // Ambil daftar master TEa rujukan
  const masterTeas = await db.daftarTEa.findMany();
  const teaMap = new Map<string, number>();
  masterTeas.forEach((t) => {
    const aliases = getParameterAliases(t.parameter);
    const val = parseNumSafe(t.nilaiTEa);
    if (val !== null && val > 0) {
      aliases.forEach((a) => teaMap.set(a.toUpperCase(), val));
    }
  });

  // Ambil LotQC untuk user yang dipilih
  const lotRows = await db.lotQC.findMany({
    where: { ownerUsername: { in: selectedUsers } },
  });

  // Kelompokkan inputQC berdasarkan (ownerUsername, canonicalParam, namaAlat, noLot)
  interface GroupBucket {
    username: string;
    hospitalName: string;
    parameter: string;
    namaAlat: string;
    noLot: string;
    l1Values: number[];
    l2Values: number[];
    l3Values: number[];
    lotIDs: Set<string>;
  }

  const groups = new Map<string, GroupBucket>();

  for (const r of inputRows) {
    const rawParam = (r.parameter || "").trim();
    const canonicalParam = aliasToCanonical.get(rawParam.toUpperCase()) || rawParam;
    const alat = (r.namaAlat || "-").trim();
    const lot = (r.noLot || "-").trim();
    const key = `${r.ownerUsername}:::${canonicalParam.toUpperCase()}:::${alat}:::${lot}`;

    if (!groups.has(key)) {
      groups.set(key, {
        username: r.ownerUsername,
        hospitalName: userMap.get(r.ownerUsername) || r.ownerUsername,
        parameter: canonicalParam,
        namaAlat: alat,
        noLot: lot,
        l1Values: [],
        l2Values: [],
        l3Values: [],
        lotIDs: new Set<string>(),
      });
    }

    const g = groups.get(key)!;
    if (r.lotID) g.lotIDs.add(r.lotID);

    const v1 = parseNumSafe(r.level1);
    if (v1 !== null && v1 !== 0) g.l1Values.push(v1);

    const v2 = parseNumSafe(r.level2);
    if (v2 !== null && v2 !== 0) g.l2Values.push(v2);

    const v3 = parseNumSafe(r.level3);
    if (v3 !== null && v3 !== 0) g.l3Values.push(v3);
  }

  // Helper evaluasi Sigma
  function classifySigma(sigmaVal: number) {
    if (sigmaVal >= 6.0) {
      return { label: "World Class (Enam Sigma)", badgeClass: "badge-world-class", color: "#059669", rank: 6 };
    } else if (sigmaVal >= 5.0) {
      return { label: "Excellent", badgeClass: "badge-excellent", color: "#0284c7", rank: 5 };
    } else if (sigmaVal >= 4.0) {
      return { label: "Good", badgeClass: "badge-good", color: "#16a34a", rank: 4 };
    } else if (sigmaVal >= 3.0) {
      return { label: "Marginal", badgeClass: "badge-marginal", color: "#d97706", rank: 3 };
    } else if (sigmaVal >= 2.0) {
      return { label: "Poor", badgeClass: "badge-poor", color: "#ea580c", rank: 2 };
    } else {
      return { label: "Unacceptable", badgeClass: "badge-unacceptable", color: "#dc2626", rank: 1 };
    }
  }

  const tableRows: any[] = [];
  const uniqueHospitals = new Set<string>();
  const uniqueParameters = new Set<string>();
  const uniqueAnalyzers = new Set<string>();
  const uniqueLots = new Set<string>();
  const sigmaDistribution = {
    worldClass: 0,
    excellent: 0,
    good: 0,
    marginal: 0,
    poor: 0,
    unacceptable: 0,
  };

  // Iterasi setiap grup dan hitung statistik L1, L2, L3
  for (const g of Array.from(groups.values())) {
    // Cari referensi LotQC
    let matchedLot = lotRows.find((l) => {
      if (l.ownerUsername !== g.username) return false;
      if (g.lotIDs.has(l.id)) return true;
      if (g.noLot !== "-" && l.noLot === g.noLot) return true;
      return false;
    });

    const teaDefault = teaMap.get(g.parameter.toUpperCase()) || 10.0;
    const teaLot = matchedLot ? parseNumSafe(matchedLot.tea) : null;
    const finalTEa = teaLot !== null && teaLot > 0 ? teaLot : teaDefault;

    const levelConfigs = [
      {
        levelLabel: "Level 1",
        levelKey: "L1",
        vals: g.l1Values,
        targetLot: matchedLot ? parseNumSafe(matchedLot.targetL1) || parseNumSafe(matchedLot.meanL1) : null,
      },
      {
        levelLabel: "Level 2",
        levelKey: "L2",
        vals: g.l2Values,
        targetLot: matchedLot ? parseNumSafe(matchedLot.targetL2) || parseNumSafe(matchedLot.meanL2) : null,
      },
      {
        levelLabel: "Level 3",
        levelKey: "L3",
        vals: g.l3Values,
        targetLot: matchedLot ? parseNumSafe(matchedLot.targetL3) || parseNumSafe(matchedLot.meanL3) : null,
      },
    ];

    for (const lc of levelConfigs) {
      if (lc.vals.length === 0) continue;

      const n = lc.vals.length;
      const sum = lc.vals.reduce((a, b) => a + b, 0);
      const mean = sum / n;

      let sd = 0;
      if (n > 1) {
        const variance = lc.vals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1);
        sd = Math.sqrt(variance);
      }

      const cv = mean > 0 ? (sd / mean) * 100 : 0;
      const targetVal = lc.targetLot !== null && lc.targetLot > 0 ? lc.targetLot : mean;
      const biasPct = targetVal > 0 ? ((mean - targetVal) / targetVal) * 100 : 0;
      const te = Math.abs(biasPct) + 1.65 * cv;
      const sigma = cv > 0 ? (finalTEa - Math.abs(biasPct)) / cv : 0;
      const roundedSigma = Math.round(sigma * 100) / 100;
      const classification = classifySigma(roundedSigma);

      if (roundedSigma >= 6.0) sigmaDistribution.worldClass++;
      else if (roundedSigma >= 5.0) sigmaDistribution.excellent++;
      else if (roundedSigma >= 4.0) sigmaDistribution.good++;
      else if (roundedSigma >= 3.0) sigmaDistribution.marginal++;
      else if (roundedSigma >= 2.0) sigmaDistribution.poor++;
      else sigmaDistribution.unacceptable++;

      uniqueHospitals.add(g.username);
      uniqueParameters.add(g.parameter);
      if (g.namaAlat !== "-") uniqueAnalyzers.add(g.namaAlat);
      if (g.noLot !== "-") uniqueLots.add(g.noLot);

      tableRows.push({
        id: `${g.username}_${g.parameter}_${g.namaAlat}_${g.noLot}_${lc.levelKey}`,
        username: g.username,
        hospitalName: g.hospitalName,
        parameter: g.parameter,
        namaAlat: g.namaAlat,
        noLot: g.noLot,
        level: lc.levelLabel,
        levelKey: lc.levelKey,
        n,
        target: Math.round(targetVal * 1000) / 1000,
        targetSource: lc.targetLot !== null && lc.targetLot > 0 ? "Lot QC" : "Rerata Internal",
        mean: Math.round(mean * 1000) / 1000,
        sd: Math.round(sd * 10000) / 10000,
        cv: Math.round(cv * 100) / 100,
        biasPct: Math.round(biasPct * 100) / 100,
        tea: Math.round(finalTEa * 100) / 100,
        te: Math.round(te * 100) / 100,
        sigma: roundedSigma,
        sigmaPerformance: classification,
      });
    }
  }

  // Urutkan baris: RS -> Parameter -> Alat -> Lot -> Level
  tableRows.sort((a, b) => {
    const c1 = a.hospitalName.localeCompare(b.hospitalName);
    if (c1 !== 0) return c1;
    const c2 = a.parameter.localeCompare(b.parameter);
    if (c2 !== 0) return c2;
    const c3 = a.namaAlat.localeCompare(b.namaAlat);
    if (c3 !== 0) return c3;
    const c4 = a.noLot.localeCompare(b.noLot);
    if (c4 !== 0) return c4;
    return a.levelKey.localeCompare(b.levelKey);
  });

  return {
    ok: true,
    period: { startDate, endDate },
    summary: {
      totalRows: tableRows.length,
      totalHospitals: uniqueHospitals.size,
      totalParameters: uniqueParameters.size,
      totalAnalyzers: uniqueAnalyzers.size,
      totalLots: uniqueLots.size,
      sigmaDistribution,
    },
    rows: tableRows,
  };
}
