// Test integrasi backend peer-service.ts
import {
  getPeerGroupFilterOptions,
  runPeerGroupAnalysis,
} from "../src/lib/backend/peer-group/peer-service";

async function main() {
  console.log("=== TEST BACKEND PEER SERVICE ===");
  const mockSuperadminSession: any = {
    username: "admin",
    role: "superadmin",
    fullName: "Admin Utama",
    isSecondary: false,
  };

  // 1. Test getFilterOptions
  const opts = await getPeerGroupFilterOptions([], mockSuperadminSession);
  console.log("Filter options ok:", opts.ok);
  console.log("Total hospitals available:", opts.hospitals.length);
  console.log("Sample hospitals:", opts.hospitals.slice(0, 3));
  console.log("Parameters count:", opts.parameters.length);
  console.log("Sample params:", opts.parameters.slice(0, 5));

  // 2. Test runPeerGroupAnalysis dengan data nyata di NeonDB
  // Ambil parameter yang punya banyak data (misal: 'SGPT' atau 'GLUKOSA' atau 'TRIGLISERID')
  const testParam = opts.parameters.includes("SGPT") ? "SGPT" : opts.parameters[0];
  const allHospitals = opts.hospitals.map((h: any) => h.username);

  console.log(`\nTesting runPeerGroupAnalysis for parameter: ${testParam}...`);
  const analysis = await runPeerGroupAnalysis(
    [
      {
        parameter: testParam,
        level: "L1",
        startDate: "2020-01-01",
        endDate: "2027-12-31",
        aggregationRule: "latest",
        targetType: "robust_mean",
        sdpaType: "robust_sd",
        hospitals: allHospitals,
      },
    ],
    mockSuperadminSession
  );

  console.log("Analysis success:", analysis.ok);
  if (!analysis.ok) {
    console.error("Analysis error:", (analysis as any).msg);
    process.exit(1);
  }

  console.log("Stats summary:", {
    totalSelected: analysis.stats?.totalSelected,
    totalWithData: analysis.stats?.totalWithData,
    totalValid: analysis.stats?.totalValid,
    totalExcluded: analysis.stats?.totalExcluded,
    robustMean: analysis.stats?.robust?.robustMean,
    robustSd: analysis.stats?.robust?.robustSd,
    uncertainty: analysis.stats?.robust?.uncertainty,
    statStatus: analysis.stats?.robust?.statStatus,
  });

  console.log("Participant evaluations count:", analysis.evaluations?.length);
  console.log("Sample evaluations:", analysis.evaluations?.slice(0, 3));

  console.log("\nBACKEND PEER SERVICE TEST PASSED 100%!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
