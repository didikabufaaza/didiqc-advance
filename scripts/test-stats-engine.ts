// Unit test independen untuk stats-engine.ts (ISO 13528:2022 verification)
import {
  computeDescriptiveStats,
  computeAlgorithmA,
  evaluateParticipants,
} from "../src/lib/backend/peer-group/stats-engine";

function runTest() {
  console.log("=== 1. TEST STATISTIK DESKRIPTIF ===");
  const testData = [98, 102, 100, 105, 99, 101, 103, 97, 100, 150]; // Ada 1 pencilan (150)
  const desc = computeDescriptiveStats(testData);
  console.log("Descriptive:", desc);
  if (desc.n !== 10 || desc.min !== 97 || desc.max !== 150) {
    throw new Error("Descriptive test failed on min/max/n");
  }

  console.log("\n=== 2. TEST ALGORITHM A (ISO 13528:2022) ===");
  const robust = computeAlgorithmA(testData);
  console.log("Robust Algorithm A:", robust);
  // Dengan pencilan 150, Mean biasa = 105.5, tapi Robust Mean harus berada sekitar 100-102
  if (!robust.robustMean || robust.robustMean > 105 || robust.robustMean < 98) {
    throw new Error("Robust mean did not suppress outlier properly: " + robust.robustMean);
  }
  console.log(`Robust Mean: ${robust.robustMean} vs Ordinary Mean: ${desc.mean}`);
  console.log(`Robust SD: ${robust.robustSd} vs Ordinary SD: ${desc.sd}`);
  console.log(`Uncertainty u(x*): ${robust.uncertainty}`);

  console.log("\n=== 3. TEST EVALUASI INDIVIDUAL, Z-SCORE FORMAL VS SKOR RELATIF ===");
  const participants = [
    {
      hospitalUsername: "rs_a",
      hospitalName: "RSUD A",
      usedValue: 100,
      tea: 10,
      cvLab: 2.5,
    },
    {
      hospitalUsername: "rs_b",
      hospitalName: "RS B",
      usedValue: 106,
      tea: 10,
      cvLab: 3.0,
    },
    {
      hospitalUsername: "rs_c",
      hospitalName: "RS C",
      usedValue: 125,
      tea: 10,
      cvLab: 4.0,
    },
    {
      hospitalUsername: "rs_d",
      hospitalName: "RS D (Excluded)",
      usedValue: 200,
      validationStatus: "excluded" as const,
      exclusionReason: "Salah alat / salah satuan",
    },
  ];

  // Evaluasi 1: Peer group internal (tanpa formal SDPA)
  const evalInternal = evaluateParticipants({
    participants,
    targetValue: robust.robustMean,
    targetSource: "Robust Mean Kelompok",
    sdpaValue: null,
    sdpaSource: "",
    isFormalPme: false,
    robustMean: robust.robustMean,
    robustSd: robust.robustSd,
  });
  console.log("Evaluasi Internal (Skor Relatif):");
  evalInternal.forEach((e) => {
    console.log(
      `  - ${e.hospitalName}: val=${e.usedValue}, SkorRelatif=${e.peerRelativeScore}, Z-Score Formal=${e.zScore}, Kategori=${e.evalCategory}, Sigma=${e.sigma} (${e.sigmaCategory})`
    );
  });

  // Verifikasi bahwa Z-Score formal = null saat isFormalPme = false
  if (evalInternal[0].zScore !== null) {
    throw new Error("Formal Z-score must be null when isFormalPme is false!");
  }

  // Evaluasi 2: Formal PME (dengan assigned value & SDPA yang ditetapkan)
  const evalFormal = evaluateParticipants({
    participants,
    targetValue: 100,
    targetSource: "Nilai Acuan Kalibrator PME",
    sdpaValue: 4.0,
    sdpaSource: "SDPA Ditetapkan Berdasarkan TEa/3",
    isFormalPme: true,
    robustMean: robust.robustMean,
    robustSd: robust.robustSd,
  });
  console.log("\nEvaluasi Formal PME:");
  evalFormal.forEach((e) => {
    console.log(
      `  - ${e.hospitalName}: val=${e.usedValue}, Z-Score Formal=${e.zScore}, Kategori=${e.evalCategory}, Sigma=${e.sigma} (${e.sigmaCategory})`
    );
  });

  if (evalFormal[0].zScore !== 0) {
    throw new Error("RSUD A formal Z-score should be 0 ((100-100)/4)");
  }
  if (evalFormal[1].zScore !== 1.5) {
    throw new Error("RS B formal Z-score should be 1.5 ((106-100)/4)");
  }

  console.log("\nALL STATS ENGINE TESTS PASSED SUCCESSFULLY!");
}

runTest();
