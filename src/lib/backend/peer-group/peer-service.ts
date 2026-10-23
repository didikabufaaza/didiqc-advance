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
    where: { noLot: { not: null } },
  });
  const distinctLotsInput = await db.inputQC.findMany({
    distinct: ["noLot"],
    select: { noLot: true },
    where: { noLot: { not: null } },
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

  const whereQC: any = {
    parameter: { equals: param, mode: "insensitive" },
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
  const lotsWithMethod = await db.lotQC.findMany({
    where: {
      OR: [
        { id: { in: lotIds } },
        { noLot: { in: lotNos } },
      ],
    },
    select: { methode: true },
  });
  const methodSet = new Set<string>();
  lotsWithMethod.forEach((l) => {
    if (l.methode && l.methode.trim() && l.methode.trim() !== "-") {
      methodSet.add(l.methode.trim());
    }
  });

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

  // Build query filter untuk inputqc
  const whereQC: any = {
    parameter: { equals: parameter, mode: "insensitive" },
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
    where: { parameter: { equals: parameter, mode: "insensitive" } },
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
  const levelKey = level === "L3" ? "level3" : level === "L2" ? "level2" : "level1";

  for (const username of selectedHospitals) {
    const rows = hospitalQCs.get(username) || [];
    const hospitalName = hospitalNameMap.get(username) || username;

    if (rows.length === 0) {
      participantDataList.push({
        hospitalUsername: username,
        hospitalName,
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

    // Ambil baris yang memiliki nilai pada level yang diminta
    const validLevelRows = rows.filter((r) => {
      const v = parseNumSafe(r[levelKey]);
      return v !== null && v !== 0;
    });

    if (validLevelRows.length === 0) {
      participantDataList.push({
        hospitalUsername: username,
        hospitalName,
        usedValue: null,
        originalValue: null,
        sourceCount: rows.length,
        date: rows[rows.length - 1].tanggal,
        validationStatus: "excluded",
        exclusionReason: `Data QC ada (${rows.length} entri), tetapi nilai ${level} kosong/nol`,
        unit: null,
        analyzer: rows[0].namaAlat,
        method: null,
        controlLot: rows[0].noLot,
        tea: null,
        cvLab: null,
      });
      continue;
    }

    // Terapkan aturan agregasi
    let chosenRow: any = null;
    let usedVal: number | null = null;
    let dateStr: string | null = null;

    if (aggregationRule === "single_date") {
      const targetDate = singleDate || startDate;
      const onDateRows = validLevelRows.filter((r) => r.tanggal === targetDate);
      if (onDateRows.length > 0) {
        chosenRow = onDateRows[onDateRows.length - 1];
        const sum = onDateRows.reduce((a, c) => a + parseNumSafe(c[levelKey])!, 0);
        usedVal = sum / onDateRows.length;
        dateStr = targetDate;
      } else {
        participantDataList.push({
          hospitalUsername: username,
          hospitalName,
          usedValue: null,
          originalValue: null,
          sourceCount: validLevelRows.length,
          date: targetDate,
          validationStatus: "excluded",
          exclusionReason: `Tidak ada data QC pada tanggal spesifik ${targetDate}`,
          unit: null,
          analyzer: validLevelRows[0].namaAlat,
          controlLot: validLevelRows[0].noLot,
          tea: null,
          cvLab: null,
        });
        continue;
      }
    } else if (aggregationRule === "average") {
      chosenRow = validLevelRows[validLevelRows.length - 1];
      const sum = validLevelRows.reduce((a, c) => a + parseNumSafe(c[levelKey])!, 0);
      usedVal = sum / validLevelRows.length;
      dateStr = `${startDate} s/d ${endDate}`;
    } else {
      // "latest"
      chosenRow = validLevelRows[validLevelRows.length - 1];
      usedVal = parseNumSafe(chosenRow[levelKey]);
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

    // Hitung CV analitik laboratorium aktual (imprecision) dari kumpulan baris peserta ini
    let cvLab: number | null = null;
    if (validLevelRows.length >= 2) {
      const vals = validLevelRows.map((r) => parseNumSafe(r[levelKey])!).filter(Boolean);
      const m = vals.reduce((a, c) => a + c, 0) / vals.length;
      if (m > 0) {
        const vSum = vals.reduce((a, c) => a + Math.pow(c - m, 2), 0) / (vals.length - 1);
        cvLab = (Math.sqrt(vSum) / m) * 100;
      }
    }

    participantDataList.push({
      hospitalUsername: username,
      hospitalName,
      usedValue: usedVal !== null ? Math.round(usedVal * 10000) / 10000 : null,
      originalValue: parseNumSafe(chosenRow[levelKey]),
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
  }

  // Kumpulkan nilai-nilai valid untuk perhitungan statistik kelompok
  const validValues = participantDataList
    .filter((p) => p.validationStatus === "valid" && p.usedValue !== null)
    .map((p) => p.usedValue as number);

  // 1. Hitung Statistik Deskriptif
  const descStats = computeDescriptiveStats(validValues);

  // 2. Hitung Statistik Robust Algorithm A (ISO 13528:2022)
  const robustStats = computeAlgorithmA(validValues);

  // 3. Tentukan Target (Assigned Value) & SDPA
  let targetVal: number | null = null;
  let targetSourceStr = "";
  if (targetType === "reference_value" && assignedValueCustom !== null) {
    targetVal = assignedValueCustom;
    targetSourceStr = assignedValueSource || "Nilai Acuan Independen / Kalibrator";
  } else if (targetType === "pme_target" && assignedValueCustom !== null) {
    targetVal = assignedValueCustom;
    targetSourceStr = assignedValueSource || "Target Penyelenggara PME";
  } else {
    targetVal = robustStats.robustMean;
    targetSourceStr = "Nilai Konsensus Robust Kelompok (ISO 13528 Algorithm A)";
  }

  let sdpaVal: number | null = null;
  let sdpaSourceStr = "";
  let isFormalPme = false;

  if (sdpaType === "fixed_sdpa" && sdpaValueCustom !== null && sdpaValueCustom > 0) {
    sdpaVal = sdpaValueCustom;
    sdpaSourceStr = sdpaSource || "SDPA Ditetapkan Secara Independen (Kriteria Formal PME)";
    isFormalPme = true;
  } else if (sdpaType === "tea_derived" && targetVal !== null) {
    // Estimasi SDPA berbasis TEa (mis. TEa / 3)
    const teaRef = masterTea ? parseNumSafe(masterTea.nilaiTEa) : null;
    if (teaRef && teaRef > 0) {
      sdpaVal = Math.round(((teaRef / 100) * targetVal * 10000) / 3) / 10000;
      sdpaSourceStr = `Diturunkan dari TEa (${teaRef}% / 3) Berdasarkan Target Acuan`;
      isFormalPme = true;
    }
  }

  if (sdpaVal === null) {
    // Fallback: gunakan Robust SD kelompok hanya sebagai penyebaran relatif peer group
    sdpaVal = robustStats.robustSd;
    sdpaSourceStr = "Robust SD Kelompok — Digunakan untuk Skor Relatif Peer Group (Bukan SDPA Formal PME)";
    isFormalPme = false;
  }

  // 4. Hitung Evaluasi Peserta (Z-Score Formal vs Skor Relatif vs Sigma Metrik)
  const evaluations = evaluateParticipants({
    participants: participantDataList,
    targetValue: targetVal,
    targetSource: targetSourceStr,
    sdpaValue: sdpaVal,
    sdpaSource: sdpaSourceStr,
    isFormalPme,
    robustMean: robustStats.robustMean,
    robustSd: robustStats.robustSd,
  });

  // 5. Hitung Multi-Tier Benchmark Grouping (Model Laporan Standar Uji PME)
  // Tier 1: Seluruh Peserta
  const validEvaluations = evaluations.filter((e) => e.validationStatus === "valid" && e.usedValue !== null);
  const tierAllN = validEvaluations.length;

  // Tier 2: Kelompok Metode
  const methodGroups = new Map<string, number[]>();
  validEvaluations.forEach((e) => {
    if (e.method && e.usedValue !== null) {
      const key = e.method.trim().toLowerCase();
      const list = methodGroups.get(key) || [];
      list.push(e.usedValue);
      methodGroups.set(key, list);
    }
  });
  const methodStatsMap = new Map<string, { n: number; target: number | null; sdpa: number | null }>();
  methodGroups.forEach((vals, key) => {
    if (vals.length >= 6) {
      const rob = computeAlgorithmA(vals);
      methodStatsMap.set(key, {
        n: vals.length,
        target: rob.robustMean !== null ? Math.round(rob.robustMean * 100) / 100 : null,
        sdpa: rob.robustSd !== null ? Math.round(rob.robustSd * 100) / 100 : null,
      });
    } else {
      methodStatsMap.set(key, { n: vals.length, target: null, sdpa: null });
    }
  });

  // Tier 3: Kelompok Alat
  const analyzerGroups = new Map<string, number[]>();
  validEvaluations.forEach((e) => {
    if (e.analyzer && e.usedValue !== null) {
      const key = e.analyzer.trim().toLowerCase();
      const list = analyzerGroups.get(key) || [];
      list.push(e.usedValue);
      analyzerGroups.set(key, list);
    }
  });
  const analyzerStatsMap = new Map<string, { n: number; target: number | null; sdpa: number | null }>();
  analyzerGroups.forEach((vals, key) => {
    if (vals.length >= 6) {
      const rob = computeAlgorithmA(vals);
      analyzerStatsMap.set(key, {
        n: vals.length,
        target: rob.robustMean !== null ? Math.round(rob.robustMean * 100) / 100 : null,
        sdpa: rob.robustSd !== null ? Math.round(rob.robustSd * 100) / 100 : null,
      });
    } else {
      analyzerStatsMap.set(key, { n: vals.length, target: null, sdpa: null });
    }
  });

  // Pasang Tiers ke setiap evaluasi peserta
  evaluations.forEach((item) => {
    const zAll = item.zScore !== null ? item.zScore : item.peerRelativeScore;
    const katAll = zAll !== null ? (Math.abs(zAll) <= 2 ? "OK" : Math.abs(zAll) <= 3 ? "Peringatan" : "Tindakan") : "-";
    const ketAll = zAll !== null ? (Math.abs(zAll) <= 2 ? "Memuaskan" : Math.abs(zAll) <= 3 ? "Meragukan" : "Tidak Memuaskan") : "Tidak dianalisa";

    // Kelompok Metode
    const mKey = item.method ? item.method.trim().toLowerCase() : "";
    const mStat = methodStatsMap.get(mKey);
    let mZ: number | null = null;
    let mKat = "-";
    let mKet = "Tidak dianalisa";
    if (mStat && mStat.n >= 6 && mStat.target !== null && mStat.sdpa !== null && mStat.sdpa > 0 && item.usedValue !== null) {
      mZ = Math.round(((item.usedValue - mStat.target) / mStat.sdpa) * 100) / 100;
      mKat = Math.abs(mZ) <= 2 ? "OK" : Math.abs(mZ) <= 3 ? "Peringatan" : "Tindakan";
      mKet = Math.abs(mZ) <= 2 ? "Memuaskan" : Math.abs(mZ) <= 3 ? "Meragukan" : "Tidak Memuaskan";
    }

    // Kelompok Alat
    const aKey = item.analyzer ? item.analyzer.trim().toLowerCase() : "";
    const aStat = analyzerStatsMap.get(aKey);
    let aZ: number | null = null;
    let aKat = "-";
    let aKet = "Tidak dianalisa";
    if (aStat && aStat.n >= 6 && aStat.target !== null && aStat.sdpa !== null && aStat.sdpa > 0 && item.usedValue !== null) {
      aZ = Math.round(((item.usedValue - aStat.target) / aStat.sdpa) * 100) / 100;
      aKat = Math.abs(aZ) <= 2 ? "OK" : Math.abs(aZ) <= 3 ? "Peringatan" : "Tindakan";
      aKet = Math.abs(aZ) <= 2 ? "Memuaskan" : Math.abs(aZ) <= 3 ? "Meragukan" : "Tidak Memuaskan";
    }

    (item as any).tiers = {
      all: {
        n: tierAllN,
        target: targetVal !== null ? Math.round(targetVal * 100) / 100 : null,
        sdpa: sdpaVal !== null ? Math.round(sdpaVal * 100) / 100 : null,
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
      assignedValue: targetVal,
      assignedValueSource: targetSourceStr,
      sdpaType,
      sdpaValue: sdpaVal,
      sdpaSource: sdpaSourceStr,
      isFormalPme,
    },
    stats: {
      totalSelected: selectedHospitals.length,
      totalWithData: validValues.length,
      totalValid: validValues.length,
      totalExcluded: selectedHospitals.length - validValues.length,
      descriptive: descStats,
      robust: robustStats,
    },
    evaluations,
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
